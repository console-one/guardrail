import {
  attachConstraintHandlers,
  constructContractPolicyTests,
  createCommitID,
  permissionsApplicator
} from '../constraints/authhelpers.js';
import { ContractPolicyType } from '../constraints/contracttype.js';
import { MetricDao } from '../metric-dao/interface.js';
import { Scope } from './scope.js';
import { SelectorSet } from '../selectors/selectorset.js';

// Top-level API gate. Wraps a request handler with the constraint
// pipeline: request arrives → matching policy selected → constraints
// evaluated → either the handler runs and the commit writes, or the
// request is rejected and no metrics persist.
//
//   const authorizer = new C1APIAuthorizer(metricDao);
//   authorizer.addPolicies('openai/gpt', ...contract.policies);
//   const wrapped = authorizer.createAPIWrapper('openai/gpt', request => {
//     return { status: 200, body: 'ok' };
//   });
//   const response = await wrapped({ model: 'gpt-4', user: 'alice', ... });
export class C1APIAuthorizer {
  counter: number;
  instanceID: string;
  policies: { [key: string]: ContractPolicyType[] };
  metricDao: MetricDao;

  constructor(metricDao: MetricDao) {
    this.counter = 0;
    this.instanceID = `C1Authorizer:${new Date().getTime()}`;
    this.policies = {};
    this.metricDao = metricDao;
  }

  addPolicies(name: string, ...contractPolicies: ContractPolicyType[]): this {
    if (this.policies[name] === undefined) {
      this.policies[name] = [];
    }
    for (const policy of contractPolicies) {
      this.policies[name].push(policy);
    }
    return this;
  }

  private _wrapWithUUID(request: any): any {
    request.uuid = request.uuid ?? this.instanceID + `.r#${this.counter}`;
    this.counter += 1;
    return request;
  }

  createAPIWrapper(name: string, method: (request: any) => any) {
    const policies = this.policies[name] ?? [];
    const contractPolicyTests = constructContractPolicyTests(policies);
    const selectConstraintsForMatchingPolicy = permissionsApplicator(contractPolicyTests);

    return async (request: any) => {
      request = this._wrapWithUUID(request);

      const constraints = await selectConstraintsForMatchingPolicy(request);
      const outputSet = new Set<string>([...constraints.map((c: any) => c.constraint.name)]);

      const requestScope = new Scope(request, this.metricDao, {
        state: 'ANALYSIS',
        constraints: outputSet,
        remaining: outputSet.size
      });

      const commitID = await createCommitID(requestScope);

      const resolvers: any[] = [];
      const rejectors: any[] = [];
      const returnThis = new Promise((resolve, reject) => {
        resolvers.push(resolve);
        rejectors.push(reject);
      });

      attachConstraintHandlers(
        requestScope,
        commitID,
        () => {
          const result = method(request);
          resolvers.forEach(r => r(result));
          return result;
        },
        (...args: any[]) => {
          rejectors.forEach(r => r(...args));
        }
      );

      const finalSelectorSet = constraints.reduce(
        (all: SelectorSet, c: any) => all.merge(c.scope),
        new SelectorSet()
      );

      await requestScope.attach(finalSelectorSet);

      // Drive the read pipeline. The translation → submetric cascade
      // runs across multiple microtask rounds: request selectors
      // publish, which fires their translation subscribers, which
      // fires more translations, which eventually reaches submetrics
      // that call `getMetric` and register pending reads. We yield a
      // macrotask so those reads register, call execRead, and repeat
      // until the query table is stable. Bounded to prevent loops.
      const drainReads = async () => {
        let prevCategories = -1;
        for (let round = 0; round < 8; round += 1) {
          await new Promise(r => setTimeout(r, 0));
          const categoryCount = requestScope.pendingReadCategoryCount(request.uuid);
          if (categoryCount === 0 && round > 0) break;
          if (categoryCount === prevCategories && round > 0) break;
          prevCategories = categoryCount;
          if (categoryCount > 0) {
            try {
              await requestScope.execRead(request);
            } catch {
              // Surface via the 'break' path; don't crash the drain.
            }
          }
        }
      };
      drainReads();

      return returnThis;
    };
  }

  static create(metricDao: MetricDao): C1APIAuthorizer {
    return new C1APIAuthorizer(metricDao);
  }
}
