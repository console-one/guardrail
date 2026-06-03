// ─────────────────────────────────────────────────────────────────────────
// BudgetGate — a reserve / confirm / rollback lifecycle on top of guardrail's
// existing constraint + MetricDao machinery.
//
// WHY THIS EXISTS (and how it differs from C1APIAuthorizer)
//
//   C1APIAuthorizer.createAPIWrapper is a one-shot pipeline: it checks a set
//   of constraints and, on success, commits the SAME delta it checked, then
//   runs the wrapped handler. That shape can't express a budget whose
//   lifecycle is three distinct phases:
//
//     RESERVE  — at admit time, check feasibility against an ESTIMATE
//                (e.g. +1 call, +estimatedTokens, +1 inflight) and stage
//                that estimate so concurrent admits see it.
//     CONFIRM  — after the work runs, finalize with the ACTUAL cost, which
//                may differ from the estimate (correct estimate → actual).
//     ROLLBACK — if the work was abandoned, release the reservation.
//
//   It also can't be driven FAIL-CLOSED: createAPIWrapper's drain swallows a
//   read that never settles, leaving a constraint's outcome simply unreported
//   (treated as "not over budget" → silently admits). A budget gate that
//   protects a real resource needs the opposite default: a metric read that
//   does not settle MUST reject.
//
// FOUR GUARANTEES (mapping to the consumer's requirements)
//
//   1. HARD FAIL-CLOSED BARRIER. Every constraint's metric read is raced
//      against `readTimeoutMs`. If ANY read rejects or does not settle in
//      time, reserve() returns REJECT and stages nothing. There is no code
//      path where an unsettled read admits.
//
//   2. RESERVE → CONFIRM (with corrected actual) → ROLLBACK, each atomic via
//      the caller's MetricDao.executeCommitRequest (all-or-nothing batch).
//
//   3. ARITY-BUG SIDESTEP. guardrail's Scope mis-routes its shared `items`
//      event bus when one Scope holds constraints whose `per` arities differ
//      (a value Submetric resolves to undefined → authhelpers.getNextValue
//      throws on `undefined.reduce`). We never put two constraints in one
//      Scope: each constraint is evaluated in its OWN single-constraint Scope,
//      so every selector in that Scope shares one arity. The core items-bus
//      routing is left untouched (fixing it is high-risk).
//
//   4. EXTERNAL-COUNTER BINDING. Each constraint binds to an explicit
//      (category, partition) the gate reads and writes DIRECTLY. The
//      single-constraint Scope is pointed at that exact counter via a thin
//      read-rebinding proxy over the caller's DAO, so guardrail evaluates the
//      relation against the SAME counter the gate commits to. `deriveCounterKey`
//      additionally exposes guardrail's derived metricKey deterministically for
//      callers who prefer to align their own direct commits to it.
//
// HOW THE PER-CONSTRAINT SCOPE IS BUILT
//
//   Each constraint compiles to a one-policy, one-constraint Contract via the
//   SAME ContractBuilder DSL the rest of guardrail uses (Selector / Translation
//   / Unit → Submetric / Constraint). We evaluate it through a Scope read-only
//   (drive the read pipeline, listen for the constraint's success/break) — we
//   never run it through C1APIAuthorizer, because that commits on success and
//   the gate must stage its own reserve/confirm/rollback deltas separately. The
//   constraint's relation is guardrail's own ResourceRelation.predicate, so the
//   admit decision is guardrail's, not a re-implemented comparison.
//
// This module adds NOTHING to guardrail's core. It only composes the existing
// ContractBuilder / Selector / Translation / Scope / ResourceRelations pieces
// behind a new lifecycle surface.
// ─────────────────────────────────────────────────────────────────────────

import { Selector } from '../selectors/selectable.js';
import { Translation } from '../selectors/translation.js';
import { SelectorSet } from '../selectors/selectorset.js';
import { ContractBuilder } from '../builders/contract.js';
import {
  ResourceRelation,
  ResourceRelations,
  ResourceRelationType
} from '../constraints/resourcerelation.js';
import { constructContractPolicyTests } from '../constraints/authhelpers.js';
import { Scope } from '../execution/scope.js';
import { lookslike } from '../vendor/assessable/index.js';
import {
  MetricDao,
  ReadCallbackMap,
  CommitObservable,
  CommitCallbacks
} from '../metric-dao/interface.js';

// ── Public types ───────────────────────────────────────────────────────

/**
 * Declares one budget constraint and the durable counter that backs it.
 *
 * The counter is identified by an explicit (category, partition) — the
 * SAME coordinates the gate reads at reserve time and writes at
 * reserve/confirm/rollback. This is the "external-counter binding": you tell
 * guardrail exactly where the number lives instead of letting guardrail derive
 * an opaque key. If you instead want to align YOUR direct commits to
 * guardrail's derived key, call `BudgetGate.deriveCounterKey`.
 */
export interface BudgetConstraintSpec {
  /** Stable identifier, surfaced in the decision so callers can map a
   *  rejection back to which budget bit. */
  name: string;
  /** MetricDao category the counter lives under. */
  category: string;
  /** Composite partition (the columns under that category). */
  partition: (string | number)[];
  /** The ceiling. With the default relation the admit rule is
   *  `current + reserve <= limit`. */
  limit: number;
  /** The delta to stage on reserve (the admit-time estimate). */
  reserve: number;
  /** Relation against the limit. Default LESS_THAN_OR_EQUAL_TO (`current +
   *  reserve <= limit`). LESS_THAN gives strict `<`. */
  relation?: ResourceRelationType;
}

export interface BudgetGateOptions {
  /** Hard barrier. A constraint's metric read that does not settle within
   *  this many ms causes reserve() to REJECT (fail-closed). Default 2000. */
  readTimeoutMs?: number;
  /** Injected for tests. Defaults to setTimeout/clearTimeout. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (handle: any) => void;
  };
}

export type RejectReason =
  | { kind: 'over-budget'; constraint: string; current: number; reserve: number; limit: number }
  | { kind: 'read-failed'; constraint: string; error: string }
  | { kind: 'read-timeout'; constraint: string; timeoutMs: number };

/** A successful reservation. Hand this to confirm() or rollback(). */
export interface Reservation {
  /** The deltas that were staged, per constraint, so confirm/rollback can
   *  finalize or undo precisely. */
  readonly staged: { spec: BudgetConstraintSpec; reserved: number }[];
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: RejectReason };

/** Correction at confirm time: the ACTUAL amount consumed for a named
 *  constraint. The gate commits `actual - reserved` so the counter lands at
 *  base + actual regardless of the reserve estimate. Omitted constraints keep
 *  their reserved amount. */
export interface ConfirmCorrection {
  /** Constraint name (matches BudgetConstraintSpec.name). */
  name: string;
  /** Actual consumed. Counter ends at base + actual for this constraint. */
  actual: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const DEFAULT_READ_TIMEOUT_MS = 2000;

function relationFor(t: ResourceRelationType | undefined): ResourceRelation {
  const name = t ?? ResourceRelationType.LESS_THAN_OR_EQUAL_TO;
  const rel = ResourceRelations[name];
  if (rel === undefined) {
    throw new Error(`BudgetGate: unknown relation '${name}'`);
  }
  return rel;
}

const partitionKey = (partition: (string | number)[]): string => partition.join('||');

// A read-rebinding proxy. For the duration of a single-constraint Scope
// evaluation we point guardrail's read at the caller's exact (category,
// partition): whatever synthetic category the Submetric derives, every
// executeReadRequest is forwarded to the REAL category with the REAL
// partition key, so the Scope evaluates the relation against the same counter
// the gate commits to. Reads only — commits are never routed through here
// (the gate stages reserve/confirm/rollback itself).
class RebindReadDao implements MetricDao {
  // Set true if the inner read rejected — surfaced so the gate can report a
  // precise `read-failed` rather than masquerading the error as over-budget.
  errored = false;

  constructor(
    private readonly inner: MetricDao,
    private readonly realCategory: string,
    private readonly realPartitionKey: string,
    // The value handed to the Scope when the inner read REJECTS. Chosen large
    // enough that `current + reserve <= limit` is false, so the constraint
    // BREAKS (fail-closed) — and, crucially, a numeric value so guardrail's
    // Constraint vertex never sees `undefined` (which would crash its
    // getNextValue). A read error therefore can NEVER admit and can NEVER
    // crash the process.
    private readonly failClosedValue: number = Number.MAX_SAFE_INTEGER
  ) {}

  async executeReadRequest(_category: string, keyObject: ReadCallbackMap): Promise<any[]> {
    // The synthetic Scope only ever asks for one key; redirect it to the
    // real counter. Wrap each record so an inner-read REJECTION is converted
    // into a fail-closed RESOLVE (a numeric sentinel). This keeps the Scope's
    // observation pipeline alive — the Constraint fires `break` instead of the
    // applicator throwing on an undefined observation.
    const rebound: ReadCallbackMap = {};
    for (const rec of Object.values(keyObject)) {
      const self = this;
      rebound[this.realPartitionKey] = {
        callback: rec.callback,
        promise: rec.promise,
        resolve: rec.resolve,
        reject(_err: any) {
          self.errored = true;
          rec.resolve(rec.callback(self.failClosedValue));
        }
      };
    }
    try {
      return await this.inner.executeReadRequest(this.realCategory, rebound);
    } catch (err) {
      // Some DAOs reject the batch promise itself rather than per-record.
      this.errored = true;
      for (const rec of Object.values(rebound)) {
        try {
          rec.resolve(rec.callback(this.failClosedValue));
        } catch {
          /* best-effort */
        }
      }
      throw err;
    }
  }

  async executeCommitRequest(
    observables: CommitObservable[],
    callbacks: CommitCallbacks
  ): Promise<any> {
    // The gate never commits through the proxy, but forward defensively.
    return this.inner.executeCommitRequest(observables, callbacks);
  }
}

// ── BudgetGate ─────────────────────────────────────────────────────────

// One constraint compiled to a one-policy, one-constraint contract plus the
// names we listen for at evaluation time.
interface CompiledConstraint {
  spec: BudgetConstraintSpec;
  bindings: any[];
  constraintName: string;
}

export class BudgetGate {
  private readonly readTimeoutMs: number;
  private readonly scheduler: NonNullable<BudgetGateOptions['scheduler']>;
  private readonly compiled: CompiledConstraint[];

  constructor(
    private readonly dao: MetricDao,
    private readonly specs: BudgetConstraintSpec[],
    options: BudgetGateOptions = {}
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle)
    };
    this.compiled = this.specs.map(spec => this.compileConstraint(spec));
  }

  // Compile ONE constraint to its own single-constraint contract via the
  // canonical ContractBuilder DSL — the exact path the happy-path test uses,
  // just with a single policy and a single constraint.
  //
  // ARITY-BUG SIDESTEP (verified empirically — see the 1-dim crash regression
  // test): guardrail's Constraint vertex mis-collects its value Submetric's
  // observation when the Submetric's `per` is 1-DIMENSIONAL — the value
  // resolves to undefined and authhelpers.getNextValue throws synchronously
  // inside Scope.attach (it can't even be caught by the drain). A `per` of 2+
  // dimensions collects cleanly. So we ALWAYS compile the synthetic contract
  // with TWO dimensions: the real partition dim plus a CONSTANT pad dim. This
  // is the same shape the observatory-app gate used by hand for its 1-dim
  // inflight counter; here it is automatic and invisible. The pad never
  // reaches storage because the read is rebound to the caller's real
  // (category, partition) by RebindReadDao.
  private compileConstraint(spec: BudgetConstraintSpec): CompiledConstraint {
    const SET = '[translation:budgetSet]';
    const DIM = '[request:budgetDim]';
    const PAD = '[request:budgetPad]';
    const dim = new Selector('budgetDim', 'request', (r: any) => r.partitionValue);
    const pad = new Selector('budgetPad', 'request', (_r: any) => '_pad_');
    const delta = new Selector('budgetDelta', 'request', (r: any) => r.delta);
    const setT = new Translation('budgetSet', (...a: any[]) => a[a.length - 1], delta);

    const builder = new ContractBuilder(`budget/${spec.name}`);
    builder.selectors = new SelectorSet(dim, pad, delta, setT);

    const relation = relationFor(spec.relation);
    const rrb = builder.when(lookslike({}), 'budget').set(SET);
    const gran =
      relation.name === ResourceRelationType.LESS_THAN
        ? rrb.toLessThan(spec.limit)
        : rrb.toLessThanOrEqualTo(spec.limit);
    const contract = gran.per(DIM, PAD).as(spec.name).create();

    const tests = constructContractPolicyTests(contract.policies as any);
    // The single policy always matches (lookslike({})), so its bindings are
    // tests[0][1] — resolve them eagerly at compile time.
    const policyBindings = (tests[0] && tests[0][1]) ?? [];
    const constraintName: string =
      policyBindings.length > 0 ? policyBindings[0].constraint.name : spec.name;

    return { spec, bindings: policyBindings, constraintName };
  }

  /**
   * Deterministically reproduces guardrail's derived metricKey for a counter
   * declared as `set` partitioned by `per`. guardrail's Submetric reads/writes
   * under `${set}.${per.join(',')}` (submetric.ts). Callers who want their own
   * direct commits to line up with a contract-driven Scope can use this to
   * build the BudgetConstraintSpec.category. (With BudgetGate you usually don't
   * need it — the gate rebinds the read to whatever category you give — but it
   * documents the convention and is handy for callers that also run a real
   * Contract elsewhere.)
   */
  static deriveCounterKey(set: string, per: string[]): string {
    return `${set}.${per.join(',')}`;
  }

  /**
   * Evaluate every constraint against its current counter value with a hard,
   * fail-closed barrier, and — only if ALL pass — atomically stage the
   * reserve deltas. Returns a Reservation handle on success, or a structured
   * reject reason on the first failing / unsettled constraint.
   *
   * Fail-closed: a read that rejects or times out yields `read-failed` /
   * `read-timeout`. Nothing is staged on any reject.
   */
  async reserve(): Promise<ReserveResult> {
    // Evaluate each constraint in its OWN single-constraint Scope, behind the
    // hard fail-closed barrier. Each evaluation reads the constraint's counter
    // (rebound to the caller's real (category, partition)) and fires the
    // guardrail relation against current + reserve.
    for (const compiled of this.compiled) {
      let evaluated: ConstraintEval;
      try {
        evaluated = await this.evaluateConstraint(compiled);
      } catch (err) {
        if (err instanceof ReadTimeout) {
          return {
            ok: false,
            reason: {
              kind: 'read-timeout',
              constraint: compiled.spec.name,
              timeoutMs: this.readTimeoutMs
            }
          };
        }
        return {
          ok: false,
          reason: { kind: 'read-failed', constraint: compiled.spec.name, error: String(err) }
        };
      }

      // Fail-closed (read errored): the inner read rejected. The constraint
      // broke on the fail-closed sentinel; report it honestly as read-failed.
      if (evaluated.errored) {
        return {
          ok: false,
          reason: {
            kind: 'read-failed',
            constraint: compiled.spec.name,
            error: 'metric read rejected'
          }
        };
      }

      // Fail-closed: a constraint that never reported an outcome (e.g. the
      // read settled but the success/break cascade never reached it) is
      // treated as a read failure, NOT an admit.
      if (evaluated.outcome === undefined) {
        return {
          ok: false,
          reason: {
            kind: 'read-failed',
            constraint: compiled.spec.name,
            error: 'constraint produced no outcome'
          }
        };
      }

      if (evaluated.outcome === false) {
        return {
          ok: false,
          reason: {
            kind: 'over-budget',
            constraint: compiled.spec.name,
            current: evaluated.current,
            reserve: compiled.spec.reserve,
            limit: compiled.spec.limit
          }
        };
      }
    }

    // All clear — atomically stage the reserve deltas.
    await this.commit(
      this.specs
        .filter(s => s.reserve !== 0)
        .map(s => ({ category: s.category, partition: s.partition, delta: s.reserve }))
    );

    return {
      ok: true,
      reservation: {
        staged: this.specs.map(s => ({ spec: s, reserved: s.reserve }))
      }
    };
  }

  /**
   * Finalize a reservation. For each correction, commit `actual - reserved`
   * so the counter lands at base + actual. Constraints without a correction
   * keep their reserved amount. Atomic.
   */
  async confirm(reservation: Reservation, corrections: ConfirmCorrection[] = []): Promise<void> {
    const byName = new Map(corrections.map(c => [c.name, c.actual]));
    const deltas = reservation.staged
      .map(({ spec, reserved }) => {
        const actual = byName.get(spec.name);
        const delta = actual === undefined ? 0 : actual - reserved;
        return { category: spec.category, partition: spec.partition, delta };
      })
      .filter(d => d.delta !== 0);
    await this.commit(deltas);
  }

  /**
   * Release a reservation: commit the negation of each staged delta so the
   * counters return to their pre-reserve base. Atomic.
   */
  async rollback(reservation: Reservation): Promise<void> {
    const deltas = reservation.staged
      .filter(({ reserved }) => reserved !== 0)
      .map(({ spec, reserved }) => ({
        category: spec.category,
        partition: spec.partition,
        delta: -reserved
      }));
    await this.commit(deltas);
  }

  // ── internals ──────────────────────────────────────────────────────────

  // Evaluate ONE constraint in its own single-constraint Scope, read-only.
  // The read is rebound to the caller's real (category, partition) so the
  // guardrail Constraint vertex fires its relation against the SAME counter
  // the gate commits to. Single constraint per Scope ⇒ uniform `per` arity ⇒
  // the mixed-arity items-bus mis-route can't occur. Wrapped in the hard
  // barrier: a read that never settles rejects with ReadTimeout (fail-closed).
  private async evaluateConstraint(compiled: CompiledConstraint): Promise<ConstraintEval> {
    const { spec, bindings, constraintName } = compiled;
    const reboundDao = new RebindReadDao(this.dao, spec.category, partitionKey(spec.partition));

    const request: any = {
      partitionValue: partitionKey(spec.partition),
      delta: spec.reserve,
      uuid: `budget:${spec.name}:${partitionKey(spec.partition)}:${Math.random()}`
    };

    const outputSet = new Set<string>(bindings.map((b: any) => b.constraint.name));
    const scope = new Scope(request, reboundDao, {
      state: 'ANALYSIS',
      constraints: outputSet,
      remaining: outputSet.size
    });

    const result: ConstraintEval = { outcome: undefined, current: 0, errored: false };
    const observe = (o: any, ok: boolean) => {
      if (!o || o.name !== constraintName || result.outcome !== undefined) return;
      result.outcome = ok;
      // The Constraint's observation `value` is the projected current+delta;
      // recover `current` for the over-budget reason detail.
      const projected = typeof o.value === 'number' ? o.value : undefined;
      if (projected !== undefined) result.current = projected - spec.reserve;
    };
    scope.subscribe('success', (...obs: any[]) => observe(obs[0], true));
    scope.subscribe('break', (...obs: any[]) => observe(obs[0], false));

    const finalSet = bindings.reduce(
      (all: SelectorSet, b: any) => all.merge(b.scope),
      new SelectorSet()
    );

    scope.attach(finalSet);

    await this.barrier(
      spec.name,
      this.drainRead(scope, request, () => result.outcome !== undefined)
    );

    // A read error is reported even when the constraint BROKE on the
    // fail-closed sentinel — the caller maps it to `read-failed`, not
    // `over-budget`, so the rejection reason is honest.
    result.errored = reboundDao.errored;
    return result;
  }

  // Bounded read drain (modeled on authorizer.ts drainReads), with an early
  // exit once `done()` is satisfied. NOT the barrier — the caller wraps this
  // in barrier() so a never-settling inner DAO read can still time out.
  private async drainRead(scope: Scope, request: any, done: () => boolean): Promise<void> {
    let prevCategories = -1;
    for (let round = 0; round < 8; round += 1) {
      if (done()) return;
      await new Promise<void>(r => this.scheduler.setTimeout(() => r(), 0));
      const categoryCount = scope.pendingReadCategoryCount(request.uuid);
      if (categoryCount === 0 && round > 0) break;
      if (categoryCount === prevCategories && round > 0) break;
      prevCategories = categoryCount;
      if (categoryCount > 0) {
        // execRead resolves to the DAO's read promises. For a hung DAO this
        // promise never settles — the barrier upstream is what bounds it.
        await scope.execRead(request).catch(() => undefined);
      }
    }
    // A couple of macrotasks for the success/break cascade to flush.
    for (let i = 0; i < 4 && !done(); i += 1) {
      await new Promise<void>(r => this.scheduler.setTimeout(() => r(), 0));
    }
  }

  // The hard fail-closed barrier. Races `work` against the timeout; if the
  // timeout wins, rejects with ReadTimeout. This is what makes a never-settling
  // metric read REJECT instead of silently admit.
  private barrier<T>(constraintName: string, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const handle = this.scheduler.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new ReadTimeout(constraintName, this.readTimeoutMs));
      }, this.readTimeoutMs);
      work.then(
        v => {
          if (done) return;
          done = true;
          this.scheduler.clearTimeout(handle);
          resolve(v);
        },
        err => {
          if (done) return;
          done = true;
          this.scheduler.clearTimeout(handle);
          reject(err);
        }
      );
    });
  }

  // Atomic batch commit through the caller's real DAO. All-or-nothing.
  private async commit(
    deltas: { category: string; partition: (string | number)[]; delta: number }[]
  ): Promise<void> {
    if (deltas.length === 0) return;
    const observables: CommitObservable[] = deltas.map(d => ({
      metric: d.category,
      name: d.category,
      value: d.delta,
      delta: d.delta,
      partition: d.partition,
      granularity: []
    }));
    await new Promise<void>((resolve, reject) => {
      this.dao
        .executeCommitRequest(observables, {
          resolve: () => undefined,
          reject: err => reject(err)
        })
        .then(() => resolve())
        .catch(reject);
    });
  }
}

class ReadTimeout extends Error {
  constructor(public readonly constraintName: string, public readonly timeoutMs: number) {
    super(`BudgetGate: metric read for '${constraintName}' did not settle within ${timeoutMs}ms`);
    this.name = 'ReadTimeout';
  }
}

// Outcome of one constraint evaluation.
//   outcome === true   admitted (current + reserve within budget)
//   outcome === false  rejected (over budget)
//   outcome === undefined  never reported (treated as read-failed, fail-closed)
interface ConstraintEval {
  outcome: boolean | undefined;
  current: number;
  errored: boolean;
}
