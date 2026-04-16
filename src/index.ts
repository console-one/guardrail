// Public surface for @console-one/guardrail.
//
// Named re-exports only, not `export * from`. This makes the package's
// API explicit and prevents accidental exposure of internal helpers.

// Primitives
export { Eventual, toEventual } from './primitives/eventual';
export { InputMap, InputSetCollector } from './primitives/inputset';
export { Queue } from './primitives/queue';

// Reactive dependency graph
export { Selectable, Selector, Structure } from './selectors/selectable';
export { SelectorSet } from './selectors/selectorset';
export { Translation } from './selectors/translation';
export { Contributor, listContribution } from './selectors/contributor';

// Constraints
export { Unit } from './constraints/unit';
export { Submetric } from './constraints/submetric';
export {
  ResourceRelation,
  ResourceRelationType,
  ResourceRelations
} from './constraints/resourcerelation';
export { Constrainable, Constraint } from './constraints/constraint';
export { ContractPolicyType } from './constraints/contracttype';
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
} from './constraints/authhelpers';

// Contract builder DSL
export { ContractBuilder } from './builders/contract';
export { LimitBuilder, LimitBuilderExtension } from './builders/limit';
export { ResourceRelationBuilder } from './builders/resourcerelation';
export { GranularitySpecifier } from './builders/granularity';

// Execution
export { Scope } from './execution/scope';
export { C1APIAuthorizer } from './execution/authorizer';

// Persistence boundary
export { MetricDao, ReadCallback, ReadCallbackRecord, ReadCallbackMap, CommitObservable, CommitCallbacks } from './metric-dao/interface';
export { MemoryMetricDao } from './adapters/memory-metric-dao';

// Vendored structural pattern matching
export { lookslike, and, or, StandardRapidTestGenerator, AssessableJSON, Requirement } from './vendor/assessable';
