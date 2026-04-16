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

1. **`Constrainable → Constraint`** — every `.set().toLessThan().per()` clause becomes a `Constrainable` (unbound), which binds to a fresh `SelectorSet` at compile time to produce a `Constraint` (bound). The constraint extends `Translation`, so it becomes a vertex in the dependency graph.
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

## What was intentionally dropped during extraction

The following lived in or around `core/observables/` in the source but were left out of the standalone package because they carried heavy coupling to the parent monorepo. They can be added back as optional subpath exports later.

- **`core/clients/redis/cli`** — The original `C1APIAuthorizer.create()` / `.singleton()` factories built a Redis-backed DAO by default via `cli()`. Dropped: consumers now inject a `MetricDao` implementation explicitly. The in-memory adapter is in `src/adapters/memory-metric-dao.ts`; production deployments implement the interface against whatever durable store they use. Re-adding a Redis adapter would be a ~50-line subpath module.
- **`core/process/workflow`** — Only referenced from an empty `metric.ts` stub in the source. Nothing to port.
- **`core/generics/globallogger`** — `Constraint` called `GlobalLogger.DefaultLogger()` for debug output. The legacy logger pulls in filesystem and transport layers. Dropped in favour of silence; add a pluggable logger in a follow-up if you need runtime tracing.
- **`core/generics/queue`** — Legacy `Queue` class, inlined as `src/primitives/queue.ts`. The legacy class had more surface than what guardrail uses; the inlined version is ~15 lines.
- **`core/testing/*`** (`AssessableJSON`, `lookslike`, `and`, `or`, `StandardRapidTestGenerator`) — Full legacy assessable framework (~800 lines of pluggable operators, reporters, and classifiers). Vendored as `src/vendor/assessable/index.ts` (~100 lines) covering the four operators guardrail actually uses: `IS`, `IS_TYPE`, `EXISTS`, `IS_IN`. If you need the full upstream, `@console-one/assessable` is a separate extraction.
- **Empty source files**: `observable.ts`, `observed.ts`, `metric.ts`, `generics/subscription.ts` were 0 bytes at the source commit. The design documentation referred to a "Subscription" primitive but the live primitive is `Eventual`; `Subscription` was either renamed or never filled in. Nothing to port.
- **`policies/openai/generate.ts`** — Example policy file in the source, but only stub imports (`JobFactory`, `InputMap`) and an empty body. Not useful as a template; the DSL example in the `smoke.ts` file replaces it.
- **`test/contractvalidation.ts`** — The legacy in-tree test used a custom `validator.expect(...).toLookLike(...)` harness bound to the parent monorepo's test runner. The port is in `src/smoke.ts` using plain assertions, which is the extraction playbook's preferred bar.

## Behavioural corrections carried over from the source

- **`ResourceRelationType.LESS_THAN_OR_EQUAL_TO`** — The legacy `resourcerelation.ts` declared both `LESS_THAN` and `LESS_THAN_OR_EQUAL_TO` with the same predicate `(a, b) => a < b`. Fixed in the port to use `<=` for LTE.
- **`Unit.toSubmetric`** — The legacy threw a bare `Error("Undefined selectables!")` preceded by a `console.error(this)` dump. The port throws descriptive errors naming the missing `per` or `set` reference.
- **`Scope.debugMode`** — Legacy defaulted to `true`, which produced noisy `console.log` output on every request. Dropped the field; no debug output.
- **`C1APIAuthorizer.create(metricDao)`** — The legacy had `singleton()` and `create()` no-arg factories that silently built a Redis-backed DAO. The port requires an injected DAO; there is no default. Pass `new MemoryMetricDao()` for local development.
- **Scheduling in `createAPIWrapper`** — The legacy used `process.nextTick(...)` to drive `execRead`. The port uses a bounded `setTimeout(0)` drain loop that re-runs `execRead` until the query table is stable, because the `process.nextTick` timing assumed a cascade order that doesn't always hold under microtask interleaving. Bounded to 8 rounds to prevent infinite loops.

## Known tech debt (carried over from the source)

- **`Scope` is a god object.** At ~380 lines it conflates pub/sub, metric I/O, and transactional staging. A clean rewrite would split it into `PubSub` + `Barrier` + `TxStage`. Left intact during extraction to avoid behavioural drift.
- **Dead `'submetric'` case in `Scope.attach()`.** `Submetric` extends `Translation`, so its `sourceName` is `'translation'` — the `'submetric'` case never fires in practice. Kept for parity with the source.
- **`InputSetCollector` has no timeout or error propagation.** If a metric read hangs, the collector hangs forever. Production use should wrap the DAO with a timeout.
- **`Eventual` has no unsubscribe.** Listeners are additive; a long-lived `Scope` registering listeners in a loop leaks. Fine for per-request use where the Scope is discarded after commit.

## Origin

Extracted on 2026-04-14 from `console-one-workspace/web-server/server/src/core/observables/` at commit `2962816ed487df0a3c029401b94d7db32fc27ff2` (branch `flounder`). Source files were copied, not symlinked, and all cross-boundary imports were rewritten to point at `vendor/` or replaced with injected interfaces. The parent repo was not modified.
