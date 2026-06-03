// ─────────────────────────────────────────────────────────────────────────
// REGRESSION / XFAIL DOCUMENTATION — core mixed/1-dim arity Scope crash.
//
// This test does NOT fix guardrail's core. It DOCUMENTS a known, high-risk
// defect so it stays tracked: when a Constraint's value Submetric has a
// SINGLE-DIMENSION `per`, guardrail's Scope.attach cascade mis-collects the
// Submetric's observation — the value resolves to `undefined` and
// authhelpers.getNextValue throws synchronously on `undefined.delta.reduce`.
// A `per` of two or more dimensions collects cleanly. (The same root cause is
// what makes MIXED-arity constraints in one Scope crash.)
//
// BudgetGate sidesteps this by (a) one constraint per Scope and (b) always
// compiling the synthetic contract with a constant pad dimension so every
// Submetric is >= 2-dim. This test asserts the UNDERLYING bug is still present
// in the raw Scope path, so:
//   - it is tracked, not silently forgotten;
//   - if someone ever fixes the core items-bus routing, this test FAILS and
//     forces a conscious update (the sidestep can then be simplified).
//
// The crash surfaces as an out-of-band 'unhandledRejection' (the throw happens
// inside the Constraint applicator's Promise.then, with no local catch), so we
// capture it via a temporary 'unhandledRejection' listener.
// ─────────────────────────────────────────────────────────────────────────

import {
  ContractBuilder,
  Selector,
  Translation,
  SelectorSet,
  Scope,
  lookslike,
  constructContractPolicyTests,
  type MetricDao,
  type ReadCallbackMap,
} from '../index.js';

// A DAO that returns a constant for every read.
function constantDao(value: number): MetricDao {
  return {
    async executeReadRequest(_category: string, keyObject: ReadCallbackMap): Promise<any[]> {
      const entries = Object.entries(keyObject);
      for (const [, rec] of entries) rec.resolve(rec.callback(value));
      return Promise.all(entries.map(([, rec]) => rec.promise));
    },
    async executeCommitRequest(): Promise<any> {
      return [];
    },
  };
}

// Build a one-policy, one-constraint contract whose value Submetric has
// `nDims` partition dimensions, then drive a Scope read-only. Returns whether
// the attach cascade crashed (synchronous out-of-band throw) and the outcome.
async function evaluateRawSingleConstraint(
  nDims: number,
): Promise<{ crashed: boolean; outcome: 'success' | 'break' | undefined }> {
  const dimNames = Array.from({ length: nDims }, (_, i) => `dim${i}`);
  const dimSelectors = dimNames.map((n) => new Selector(n, 'request', (r: any) => r[n]));
  const deltaSel = new Selector('delta', 'request', (r: any) => r.delta);
  const setT = new Translation('S', (...a: any[]) => a[a.length - 1], deltaSel);

  const builder = new ContractBuilder('regression');
  builder.selectors = new SelectorSet(...dimSelectors, deltaSel, setT);
  const contract = builder
    .when(lookslike({}), 'all')
    .set('[translation:S]')
    .toLessThanOrEqualTo(5)
    .per(...dimNames.map((n) => `[request:${n}]`))
    .as('c')
    .create();

  const bindings = (constructContractPolicyTests(contract.policies as any)[0] ?? [])[1] ?? [];
  const request: any = { delta: 1, uuid: `regression:${nDims}:${Math.random()}` };
  dimNames.forEach((n, i) => (request[n] = `v${i}`));

  const outputSet = new Set<string>(bindings.map((b: any) => b.constraint.name));
  const scope = new Scope(request, constantDao(3), {
    state: 'ANALYSIS',
    constraints: outputSet,
    remaining: outputSet.size,
  });

  let outcome: 'success' | 'break' | undefined;
  scope.subscribe('success', () => {
    if (outcome === undefined) outcome = 'success';
  });
  scope.subscribe('break', () => {
    if (outcome === undefined) outcome = 'break';
  });

  const finalSet = bindings.reduce(
    (all: SelectorSet, b: any) => all.merge(b.scope),
    new SelectorSet(),
  );

  // Capture the out-of-band crash. The Constraint applicator throws inside a
  // Promise.then with no local catch, so it surfaces as 'unhandledRejection'.
  // We temporarily own that event (suppressing the default crash) so the test
  // process survives and we can ASSERT the bug is still present.
  let crashed = false;
  const onRejection = (err: any) => {
    if (/reading 'delta'|Cannot read properties of undefined/.test(String(err))) {
      crashed = true;
    }
  };
  const priorRejection = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', onRejection);

  try {
    scope.attach(finalSet);
  } catch {
    // A future variant of the bug could throw synchronously; count it too.
    crashed = true;
  }

  // Drive a couple of read rounds; let the cascade (and its rejection) flush.
  let prev = -1;
  for (let round = 0; round < 6 && !crashed; round += 1) {
    await new Promise((r) => setTimeout(r, 0));
    const count = scope.pendingReadCategoryCount(request.uuid);
    if (count === 0 && round > 0) break;
    if (count === prev && round > 0) break;
    prev = count;
    if (count > 0) {
      try {
        await scope.execRead(request);
      } catch {
        crashed = true;
      }
    }
  }
  // Give the unhandledRejection a few macrotasks to fire.
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 1));

  process.removeListener('unhandledRejection', onRejection);
  for (const l of priorRejection) process.on('unhandledRejection', l as any);

  return { crashed, outcome };
}

export default async (
  test: (name: string, body: (validator: any) => any) => any,
) => {
  await test('XFAIL(core): a 1-dimension `per` constraint still crashes the raw Scope (bug tracked, NOT fixed)', async (validator: any) => {
    const oneDim = await evaluateRawSingleConstraint(1);
    return validator
      .expect({ crashed: oneDim.crashed, outcome: oneDim.outcome })
      // Documents the bug: 1-dim crashes, never produces an outcome. If a
      // future core fix makes this { crashed: false, outcome: 'success' },
      // this test FAILS — update the sidestep then.
      .toLookLike({ crashed: true, outcome: undefined });
  });

  await test('control: a 2-dimension `per` constraint evaluates cleanly on the raw Scope', async (validator: any) => {
    const twoDim = await evaluateRawSingleConstraint(2);
    return validator
      .expect({ crashed: twoDim.crashed, outcome: twoDim.outcome })
      .toLookLike({ crashed: false, outcome: 'success' });
  });
};
