// ─────────────────────────────────────────────────────────────────────────
// BudgetGate — reserve / confirm / rollback lifecycle with a fail-closed
// hard barrier, per-constraint single Scope (arity-bug sidestep), and
// external-counter binding.
//
// Covers the consumer's requirements:
//   - reserve → confirm-with-actual leaves counter at base + actual
//   - reserve → rollback returns counter to base
//   - FAIL-CLOSED: a hanging metric read REJECTS within a bounded time and
//     does not admit / does not commit
//   - budget boundary: current + delta == limit admits (<=); > limit rejects
//   - mixed arities (2-dim calls/tokens + 1-dim inflight) in ONE gate does
//     NOT crash
// ─────────────────────────────────────────────────────────────────────────

import {
  BudgetGate,
  MemoryMetricDao,
  type BudgetConstraintSpec,
  type RejectReason,
  type ReserveResult,
  type MetricDao,
  type ReadCallbackMap,
  type CommitObservable,
  type CommitCallbacks,
} from '../index.js';

// Narrowing helper — pulls the reject reason out of a ReserveResult. Uses an
// `in` check because this package compiles with strict:false, which weakens
// discriminated-union narrowing on the boolean `ok` discriminant.
function rejectReason(r: ReserveResult): RejectReason | undefined {
  return 'reason' in r ? (r as { reason: RejectReason }).reason : undefined;
}

// A counter reader mirroring how a real consumer reads a single counter
// through the MetricDao batch API.
async function readCounter(
  dao: MetricDao,
  category: string,
  partition: (string | number)[],
): Promise<number> {
  const key = partition.join('||');
  let resolve!: (v: any) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<any>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  await dao.executeReadRequest(category, {
    [key]: { callback: (raw: any) => raw, promise, resolve, reject },
  });
  const v = await promise;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function seed(
  dao: MetricDao,
  category: string,
  partition: (string | number)[],
  amount: number,
): Promise<void> {
  await dao.executeCommitRequest(
    [
      {
        metric: category,
        name: category,
        value: amount,
        delta: amount,
        partition,
        granularity: [],
      },
    ],
    { resolve: () => undefined, reject: () => undefined },
  );
}

// The summarizer-shaped spec set: 2-dim calls + 2-dim tokens + 1-dim inflight.
// (BudgetGate auto-pads the 1-dim inflight internally; the caller declares it
// 1-dim.)
function summarizerSpecs(): BudgetConstraintSpec[] {
  return [
    { name: 'calls', category: 'summarizer.calls', partition: ['alice', 1000], limit: 5, reserve: 1 },
    { name: 'tokens', category: 'summarizer.tokens', partition: ['alice', 1000], limit: 1000, reserve: 100 },
    { name: 'inflight', category: 'summarizer.inflight', partition: ['alice'], limit: 1, reserve: 1 },
  ];
}

export default async (
  test: (name: string, body: (validator: any) => any) => any,
) => {
  await test('reserve → confirm-with-actual leaves the counter at base + actual', async (validator: any) => {
    const dao = new MemoryMetricDao();
    const gate = new BudgetGate(dao, summarizerSpecs());

    const reserved = await gate.reserve();
    const afterReserveTokens = await readCounter(dao, 'summarizer.tokens', ['alice', 1000]);

    // Confirm with an ACTUAL token count different from the reserved estimate.
    if (reserved.ok) {
      await gate.confirm(reserved.reservation, [{ name: 'tokens', actual: 250 }]);
    }

    const finalTokens = await readCounter(dao, 'summarizer.tokens', ['alice', 1000]);
    const finalCalls = await readCounter(dao, 'summarizer.calls', ['alice', 1000]);

    return validator
      .expect({
        reserved: reserved.ok,
        afterReserveTokens, // == reserve estimate
        finalTokens, // == actual (250), NOT the 100 estimate
        finalCalls, // confirm with no correction keeps the reserved +1
      })
      .toLookLike({
        reserved: true,
        afterReserveTokens: 100,
        finalTokens: 250,
        finalCalls: 1,
      });
  });

  await test('reserve → rollback returns every counter to its base', async (validator: any) => {
    const dao = new MemoryMetricDao();
    const gate = new BudgetGate(dao, summarizerSpecs());

    const reserved = await gate.reserve();
    const afterReserveInflight = await readCounter(dao, 'summarizer.inflight', ['alice']);

    if (reserved.ok) await gate.rollback(reserved.reservation);

    const tokens = await readCounter(dao, 'summarizer.tokens', ['alice', 1000]);
    const calls = await readCounter(dao, 'summarizer.calls', ['alice', 1000]);
    const inflight = await readCounter(dao, 'summarizer.inflight', ['alice']);

    return validator
      .expect({ reserved: reserved.ok, afterReserveInflight, tokens, calls, inflight })
      .toLookLike({ reserved: true, afterReserveInflight: 1, tokens: 0, calls: 0, inflight: 0 });
  });

  await test('FAIL-CLOSED: a hanging metric read REJECTS within bounded time and commits nothing', async (validator: any) => {
    // A DAO whose reads never settle. Commits are recorded so we can prove
    // nothing was staged.
    let commitCount = 0;
    const hangingDao: MetricDao = {
      async executeReadRequest(_category: string, _keyObject: ReadCallbackMap): Promise<any[]> {
        return new Promise<any[]>(() => {
          /* never resolves */
        });
      },
      async executeCommitRequest(
        observables: CommitObservable[],
        callbacks: CommitCallbacks,
      ): Promise<any> {
        commitCount += observables.length;
        observables.forEach((_, i) => callbacks.resolve(1, i));
        return observables.map(() => 1);
      },
    };

    const gate = new BudgetGate(
      hangingDao,
      [{ name: 'calls', category: 'c.calls', partition: ['x'], limit: 5, reserve: 1 }],
      { readTimeoutMs: 150 },
    );

    const start = Date.now();
    const result = await gate.reserve();
    const elapsed = Date.now() - start;

    return validator
      .expect({
        admitted: result.ok,
        rejectKind: rejectReason(result)?.kind ?? null,
        commitCount,
        boundedTime: elapsed < 2000, // far under any default; ~150ms
      })
      .toLookLike({ admitted: false, rejectKind: 'read-timeout', commitCount: 0, boundedTime: true });
  });

  await test('FAIL-CLOSED: a read that REJECTS (errors) does not admit', async (validator: any) => {
    let commitCount = 0;
    const erroringDao: MetricDao = {
      async executeReadRequest(_category: string, keyObject: ReadCallbackMap): Promise<any[]> {
        for (const rec of Object.values(keyObject)) rec.reject(new Error('store offline'));
        return Promise.all(Object.values(keyObject).map((r) => r.promise));
      },
      async executeCommitRequest(
        observables: CommitObservable[],
        callbacks: CommitCallbacks,
      ): Promise<any> {
        commitCount += observables.length;
        observables.forEach((_, i) => callbacks.resolve(1, i));
        return observables.map(() => 1);
      },
    };

    const gate = new BudgetGate(
      erroringDao,
      [{ name: 'calls', category: 'c.calls', partition: ['x'], limit: 5, reserve: 1 }],
      { readTimeoutMs: 200 },
    );

    const result = await gate.reserve();

    return validator
      .expect({
        admitted: result.ok,
        // A rejecting read manifests either as the constraint never reporting
        // (read-failed) or as a timeout — both are fail-closed, never admit.
        rejected: !result.ok,
        commitCount,
      })
      .toLookLike({ admitted: false, rejected: true, commitCount: 0 });
  });

  await test('budget boundary: current + reserve == limit admits (<=)', async (validator: any) => {
    const dao = new MemoryMetricDao();
    await seed(dao, 'b.calls', ['x'], 4); // current 4, reserve 1, limit 5 → 5 <= 5
    const gate = new BudgetGate(dao, [
      { name: 'calls', category: 'b.calls', partition: ['x'], limit: 5, reserve: 1 },
    ]);
    const result = await gate.reserve();
    const persisted = await readCounter(dao, 'b.calls', ['x']);
    return validator
      .expect({ admitted: result.ok, persisted })
      .toLookLike({ admitted: true, persisted: 5 });
  });

  await test('budget boundary: current + reserve > limit rejects and stages nothing', async (validator: any) => {
    const dao = new MemoryMetricDao();
    await seed(dao, 'b.calls', ['x'], 5); // current 5, reserve 1, limit 5 → 6 > 5
    const gate = new BudgetGate(dao, [
      { name: 'calls', category: 'b.calls', partition: ['x'], limit: 5, reserve: 1 },
    ]);
    const result = await gate.reserve();
    const persisted = await readCounter(dao, 'b.calls', ['x']);
    const reason = rejectReason(result);
    return validator
      .expect({
        admitted: result.ok,
        rejectKind: reason?.kind ?? null,
        current: reason && reason.kind === 'over-budget' ? reason.current : null,
        persisted, // unchanged — nothing staged on reject
      })
      .toLookLike({ admitted: false, rejectKind: 'over-budget', current: 5, persisted: 5 });
  });

  await test('mixed arities in one gate (2-dim calls/tokens + 1-dim inflight) do NOT crash', async (validator: any) => {
    const dao = new MemoryMetricDao();
    const gate = new BudgetGate(dao, summarizerSpecs());
    // The very act of evaluating a 1-dim inflight constraint alongside the
    // 2-dim ones used to crash guardrail's Scope. BudgetGate auto-pads, so
    // this must resolve cleanly.
    const result = await gate.reserve();
    const inflight = await readCounter(dao, 'summarizer.inflight', ['alice']);
    return validator
      .expect({ admitted: result.ok, inflight })
      .toLookLike({ admitted: true, inflight: 1 });
  });

  await test('a later constraint over budget rejects even when earlier ones pass', async (validator: any) => {
    const dao = new MemoryMetricDao();
    // calls fine (0+1<=5), but tokens over (seed 980 + 100 reserve > 1000).
    await seed(dao, 'summarizer.tokens', ['alice', 1000], 980);
    const gate = new BudgetGate(dao, summarizerSpecs());
    const result = await gate.reserve();
    const calls = await readCounter(dao, 'summarizer.calls', ['alice', 1000]);
    return validator
      .expect({
        admitted: result.ok,
        which: rejectReason(result)?.constraint ?? null,
        callsStaged: calls, // 0 — reject stages nothing, even for passing constraints
      })
      .toLookLike({ admitted: false, which: 'tokens', callsStaged: 0 });
  });

  await test('deriveCounterKey reproduces guardrail\'s derived metricKey', async (validator: any) => {
    return validator
      .expect(BudgetGate.deriveCounterKey('[translation:tokens]', ['[request:user]', '[request:day]']))
      .toLookLike('[translation:tokens].[request:user],[request:day]');
  });
};
