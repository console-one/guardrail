# guardrail

Declarative temporal constraint evaluation for API authorization. Identity-keyed resource budgets with automatic dependency discovery and atomic transactional commit.

Extracted from `web-server/server/src/core/observables/`. Standalone — no dependency on the parent monorepo.

## Install

```bash
npm install
npm run build
```

## Quick start

```ts
import {
  ContractBuilder,
  C1APIAuthorizer,
  MemoryMetricDao,
  Selector,
  Translation,
  SelectorSet,
  lookslike,
} from 'guardrail'

// 1. Declare selectors — how to project values out of a request
const Model  = new Selector('model',      'request', (r: any) => r.model)
const Tokens = new Selector('gpt-tokens', 'request', (r: any) => r.prompt.length / 3)
const Day    = new Selector('day',        'request', (r: any) => new Date(r.timestamp).toISOString().slice(0, 10))
const User   = new Selector('user',       'request', (r: any) => r.user)

const selectors = new SelectorSet(
  Model, Tokens, Day, User,
  new Translation('tokens', (_m, t) => t, Model, Tokens)
)

// 2. Build a contract — declarative multi-horizon budgets per policy
const builder = new ContractBuilder('openai/gpt')
builder.selectors = selectors

const contract = builder
  .when(lookslike({ model: 'gpt-4.0' }), 'GPT-4-Policy')
    .set('[translation:tokens]')
    .toLessThan(50000)
    .per('[request:user]', '[request:day]')
    .as('gpt4-daily')
    .andSet('[translation:tokens]')
    .toLessThan(10000)
    .per('[request:user]', '[request:day]')
    .as('gpt4-burst')
  .elseWhen(lookslike({ model: 'gpt-3.5' }), 'GPT-35-Policy')
    .set('[translation:tokens]')
    .toLessThan(100000)
    .per('[request:user]', '[request:day]')
    .as('gpt35-daily')
  .create()

// 3. Wrap a handler with the authorizer
const dao = new MemoryMetricDao() // swap for your own MetricDao in prod
const handle = new C1APIAuthorizer(dao)
  .addPolicies('openai/gpt', ...contract.policies)
  .createAPIWrapper('openai/gpt', async (request) => {
    // Your real business logic — runs only if every constraint passed.
    return callOpenAI(request)
  })

// 4. Call it
const response = await handle({
  model: 'gpt-4.0',
  prompt: 'Hello, world.',
  user: 'alice',
  timestamp: Date.now(),
})
```

Run the built-in smoke test:

```bash
npm run build
node dist/smoke.js
```

## How it works

At compile time, the contract's declarative policies are compiled into a reactive evaluation graph:

1. **`Constrainable → Constraint`** — every `.set().toLessThan().per()` clause becomes a `Constrainable` (unbound), which binds to a fresh `SelectorSet` at compile time to produce a `Constraint` (bound). The constraint is a vertex peer of `Translation` (same `sourceName`, same `Selectable` shape) so it sits in the dependency graph alongside selectors and translations.
2. **BFS dependency discovery** — `constraint.listContribution(selectorSet)` walks the graph breadth-first from the constraint, registering every transitive dependency (selectors, translations, submetric reads). You declare "tokens < 1000 per user per day" and the BFS figures out it needs the `tokens` translation, the `user` selector, the `day` selector, and the metric read. Add a new dimension and the next compile picks it up automatically.
3. **Scope merge** — at request time, every matching constraint contributes its minimal scope, and the authorizer merges them into one final `SelectorSet` per request. Merges dedupe on composite key `(name, selectorPath, sourceName)`, so overlapping subgraphs combine stably.

At request time:

1. The matching policy is picked via assessable-based structural pattern matching (`lookslike`).
2. `scope.attach(mergedSelectorSet)` wires every selector in the merged graph. Request selectors publish synchronously; translations subscribe to the `items` bus and fire when all inputs resolve via `InputSetCollector`; submetrics call `scope.getMetric(...)` to register pending reads.
3. `scope.execRead()` flushes pending metric reads to the `MetricDao` in batch, per category.
4. Each `Constraint` fires when its value Submetric (and limit Submetric, if any) have resolved, publishes `'success'` or `'break'` to the scope's event bus.
5. **All-pass** → atomic commit via `MetricDao.executeCommitRequest` → handler runs.
6. **Any break** → the handler never runs, no commit, no metric deltas persist.

The novel property: the constraint *is* a node in the evaluation graph, not a post-hoc check. It benefits from the same dependency resolution and caching as the data flow itself, and the transactional commit guarantees that constraints are either all-enforced or none-enforced — you can't end up with a partially-updated metric state.

## Surface

**Top-level exports** (`src/index.ts`):

- **Builders**: `ContractBuilder`, `LimitBuilder`, `LimitBuilderExtension`, `ResourceRelationBuilder`, `GranularitySpecifier`
- **Execution**: `C1APIAuthorizer`, `Scope`
- **Reactive graph**: `Selector`, `Selectable`, `SelectorSet`, `Translation`, `Structure`, `Contributor`, `listContribution`
- **Constraints**: `Unit`, `Submetric`, `Constrainable`, `Constraint`, `ContractPolicyType`, `ResourceRelation`, `ResourceRelationType`, `ResourceRelations`
- **Persistence boundary**: `MetricDao` (interface), `MemoryMetricDao` (reference impl), plus the supporting types `ReadCallback`, `ReadCallbackRecord`, `ReadCallbackMap`, `CommitObservable`, `CommitCallbacks`
- **Primitives**: `Eventual`, `toEventual`, `InputMap`, `InputSetCollector`, `Queue`
- **Pattern matching**: `lookslike`, `and`, `or`, `StandardRapidTestGenerator`, `AssessableJSON`, `Requirement`
- **Helpers**: `constructContractPolicyTests`, `buildLinearAssessableHandler`, `permissionsApplicator`, `createCommitID`, `attachConstraintHandlers`, `updateToDependentSet`, `getPartition`, `getValue`, `getNextValue`, `toName`

## Layout

```
src/
├── index.ts                    # public surface
├── smoke.ts                    # runtime happy-path verification
├── primitives/
│   ├── eventual.ts             # many-to-many, replay-all broadcaster
│   ├── inputset.ts             # wait-for-N-named-inputs barrier
│   └── queue.ts                # BFS frontier
├── selectors/
│   ├── selectable.ts           # Selector / Selectable / Structure
│   ├── selectorset.ts          # the dependency graph itself
│   ├── translation.ts          # computed vertex
│   └── contributor.ts          # listContribution BFS
├── constraints/
│   ├── unit.ts                 # template form (per + set + name)
│   ├── submetric.ts            # bound form (reads the DAO)
│   ├── resourcerelation.ts     # LESS_THAN / LESS_THAN_OR_EQUAL_TO
│   ├── constraint.ts           # Constrainable + Constraint
│   ├── contracttype.ts         # ContractPolicyType
│   └── authhelpers.ts          # compile pipeline + request lifecycle glue
├── builders/
│   ├── contract.ts             # ContractBuilder — the DSL entry point
│   ├── limit.ts                # LimitBuilder + LimitBuilderExtension
│   ├── granularity.ts          # GranularitySpecifier — .per(...)
│   └── resourcerelation.ts     # ResourceRelationBuilder — .toLessThan / .toLessThanOrEqualTo
├── execution/
│   ├── scope.ts                # per-request evaluation context
│   └── authorizer.ts           # C1APIAuthorizer — top-level API gate
├── metric-dao/
│   └── interface.ts            # MetricDao + supporting types
├── adapters/
│   └── memory-metric-dao.ts    # in-memory reference implementation
└── vendor/
    └── assessable/
        └── index.ts            # minimal structural JSON matcher
```

## Known tech debt

- **`Scope` is a god object.** It conflates pub/sub, metric I/O, and transactional staging. A clean rewrite would split it into `PubSub` + `Barrier` + `TxStage`.
- **`InputSetCollector` has no timeout or error propagation.** If a metric read hangs, the collector hangs forever. Production use should wrap the DAO with a timeout.
- **`Eventual` has no unsubscribe.** Listeners are additive; a long-lived `Scope` registering listeners in a loop leaks. Fine for per-request use where the Scope is discarded after commit.
