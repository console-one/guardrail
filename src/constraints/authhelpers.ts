import { Queue } from '../primitives/queue.js';
import { StandardRapidTestGenerator, AssessableJSON } from '../vendor/assessable/index.js';
import { ContractPolicyType } from './contracttype.js';
import { SelectorSet } from '../selectors/selectorset.js';
import { Submetric } from './submetric.js';

// Compile time: for each policy in the contract, bind every
// Constrainable → Constraint, register its inputs/outputs in a fresh
// SelectorSet, and run the BFS to discover the constraint's transitive
// scope. The result is an array of [assessable, bindings] pairs —
// ready for the request-time dispatcher.
export function constructContractPolicyTests(contractPolicies: ContractPolicyType[]): any[] {
  const out: any[] = [];
  for (const policy of contractPolicies) {
    const selectorSet = new SelectorSet(...policy.selectors.byIndex);
    const bindings = policy.constrainables
      .map(c => c.toConstraint(selectorSet))
      .map(constraint => ({
        io: constraint.update(selectorSet),
        constraint: constraint,
        scope: constraint.listContribution(selectorSet)
      }));
    out.push([policy.assessable, bindings]);
  }
  return out;
}

export function buildLinearAssessableHandler(assessables: AssessableJSON[]) {
  const standard = new StandardRapidTestGenerator();
  return assessables.map(a => standard.test(a));
}

// Request time: runs each assessable in order against the incoming
// request; returns the bindings for the first match.
export const permissionsApplicator = (contractPolicyTests: any[]) => {
  const assessables = buildLinearAssessableHandler(contractPolicyTests.map(i => i[0]));
  return async function selectConstraintsForMatchingPolicy(request: any) {
    for (let i = 0; i < assessables.length; i += 1) {
      const tester = assessables[i];
      const matched = await tester(request);
      if (matched) return contractPolicyTests[i][1];
    }
    throw new Error('Rejected: no policy matched the request');
  };
};

// Walk a starting set of selectors breadth-first and register every
// transitive `.selectables` child in the SelectorSet. Sibling of
// listContribution but operates only on the `.selectables` chain
// without calling `update()` on each node — used at constraint binding
// time to seed the scope before the full BFS runs.
export const updateToDependentSet = (selectorSet: SelectorSet, mySelectors: any[]) => {
  const unanalyzed: any = new Queue();
  const analyzed = new Set<string>();

  function analyzeDependencies(item: any) {
    if (item.selectables !== undefined) {
      item.selectables
        .filter((s: any) => !analyzed.has(s.name) && s !== undefined && s !== null)
        .forEach((s: any) => unanalyzed.push(s));
      drain();
    }
  }

  function drain() {
    while (unanalyzed.length > 0) {
      const selectable = unanalyzed.shift();
      if (analyzed.has(selectable.name)) continue;
      analyzed.add(selectable.name);
      if (!selectorSet.has(selectable.name)) selectorSet.set(selectable);
      analyzeDependencies(selectable);
    }
  }

  mySelectors.forEach(selector => unanalyzed.push(selector));
  drain();
  return selectorSet;
};

// -- helpers used inside Submetric and Constraint applicator bodies --

export const getPartition = (columns: any) => columns.partition;
export const getValue = (observed: any) => observed.value;
export const getNextValue = (observed: any) => {
  return observed.delta.reduce((t: number, d: number) => d + t, observed.value);
};
export const toName = (lim: number | Submetric) => {
  return typeof lim === 'number' ? lim : (lim as any).name;
};

// -- request lifecycle helpers --

export const createCommitID = async (requestScope: any) => {
  return `${requestScope.request.uuid}:commit#${new Date().getTime()}`;
};

export const attachConstraintHandlers = (
  requestScope: any,
  commitID: string,
  executeMethod: (args: any) => any,
  rejectMethod: (...args: any[]) => any
) => {
  requestScope.subscribe('break', (...data: any[]) => {
    if (requestScope.vars?.state !== 'SHORTED') requestScope.publish('cancel', ...data);
    requestScope.vars.state = 'SHORTED';
    rejectMethod(requestScope.request);
  });

  requestScope.subscribe('success', (...observations: any[]) => {
    const observed = observations[0];
    if (requestScope.vars.constraints.has(observed.name)) {
      requestScope.vars.constraints.delete(observed.name);
      const wasNonZero = requestScope.vars.remaining > 0;
      requestScope.vars.remaining -= 1;
      requestScope.stage(commitID, observed);

      if (requestScope.vars.remaining === 0 && wasNonZero) {
        requestScope
          .execCommit(commitID)
          .then(async () => executeMethod(requestScope.request))
          .catch((err: any) => rejectMethod(err));
      }
    }
  });
};
