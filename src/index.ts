// Public surface for @console-one/guardrail.
//
// Named re-exports only, not `export * from`. This makes the package's
// API explicit and prevents accidental exposure of internal helpers.

// Primitives
export { Eventual, toEventual } from './primitives/eventual.js';
export { InputMap, InputSetCollector } from './primitives/inputset.js';
export { Queue } from './primitives/queue.js';

// Reactive dependency graph
export { Selectable, Selector, Structure } from './selectors/selectable.js';
export { SelectorSet } from './selectors/selectorset.js';
export { Translation } from './selectors/translation.js';
export { Contributor, listContribution } from './selectors/contributor.js';

// Constraints
export { Unit } from './constraints/unit.js';
export { Submetric } from './constraints/submetric.js';
export {
  ResourceRelation,
  ResourceRelationType,
  ResourceRelations
} from './constraints/resourcerelation.js';
export { Constrainable, Constraint } from './constraints/constraint.js';
export { ContractPolicyType } from './constraints/contracttype.js';
export {
  constructContractPolicyTests,
  buildLinearAssessableHandler,
  permissionsApplicator,
  createCommitID,
  attachConstraintHandlers,
  updateToDependentSet,
  getPartition,
  getValue,
  getNextValue,
  toName
} from './constraints/authhelpers.js';

// Contract builder DSL
export { ContractBuilder } from './builders/contract.js';
export { LimitBuilder, LimitBuilderExtension } from './builders/limit.js';
export { ResourceRelationBuilder } from './builders/resourcerelation.js';
export { GranularitySpecifier } from './builders/granularity.js';

// Execution
export { Scope } from './execution/scope.js';
export { C1APIAuthorizer } from './execution/authorizer.js';

// Persistence boundary
export { MetricDao, ReadCallback, ReadCallbackRecord, ReadCallbackMap, CommitObservable, CommitCallbacks } from './metric-dao/interface.js';
export { MemoryMetricDao } from './adapters/memory-metric-dao.js';

// Vendored structural pattern matching
export { lookslike, and, or, StandardRapidTestGenerator, AssessableJSON, Requirement } from './vendor/assessable/index.js';
