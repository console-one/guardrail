import {
  ContractBuilder,
  C1APIAuthorizer,
  MemoryMetricDao,
  Selector,
  Translation,
  SelectorSet,
  lookslike
} from './index';

// Smoke test — exercises the full happy path: declare a contract,
// compile it, gate a request, commit. Must exit 0 to pass.

const estimateTokens = (str: string) => str.length / 3;

function buildSelectors() {
  const model = new Selector('model', 'request', (r: any) => r.model);
  const gptTokens = new Selector('gpt-tokens', 'request', (r: any) => estimateTokens(r.prompt));
  const day = new Selector('day', 'request', (r: any) => {
    const d = new Date(r.timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const hour = new Selector('hour', 'request', (r: any) => {
    const d = new Date(r.timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours())}`;
  });
  const user = new Selector('user', 'request', (r: any) => r.user);
  const tokens = new Translation('tokens', (..._args: any[]) => _args[1], model, gptTokens);

  return new SelectorSet(model, gptTokens, day, hour, user, tokens);
}

function buildContract(limit: number) {
  const builder = new ContractBuilder('openai/gpt');
  builder.selectors = buildSelectors();
  return builder
    .when(lookslike({ model: 'gpt-4.0' }), 'GPT-4-Used')
    .set('[translation:tokens]')
    .toLessThan(limit)
    .per('[request:user]', '[request:day]')
    .as('gpt4-user-daily')
    .andSet('[translation:tokens]')
    .toLessThan(limit)
    .per('[request:user]', '[request:hour]')
    .as('gpt4-user-hourly')
    .elseWhen(lookslike({ model: 'gpt-3.5' }), 'GPT-35-Used')
    .set('[translation:tokens]')
    .toLessThan(limit)
    .per('[request:user]', '[request:day]')
    .as('gpt35-user-daily')
    .create();
}

async function main() {
  console.log('[smoke] guardrail — transactional temporal constraint applicator');
  console.log('[smoke]');

  // --- 1. Happy path: GPT-4 request within budget ---
  {
    const dao = new MemoryMetricDao();
    const contract = buildContract(10000);
    const wrapped = new C1APIAuthorizer(dao)
      .addPolicies('openai/gpt', ...contract.policies)
      .createAPIWrapper('openai/gpt', () => ({ status: 200, body: 'ok' }));

    const resp: any = await wrapped({
      model: 'gpt-4.0',
      prompt: 'Hello, world.',
      user: 'alice',
      timestamp: Date.now()
    });

    if (resp?.status !== 200) throw new Error(`expected status 200, got ${JSON.stringify(resp)}`);
    console.log('[smoke] ✓ GPT-4 request within budget → permitted');
  }

  // --- 2. Policy routing: gpt-3.5 routes to elseWhen branch ---
  {
    const dao = new MemoryMetricDao();
    const contract = buildContract(10000);
    let called = false;
    const wrapped = new C1APIAuthorizer(dao)
      .addPolicies('openai/gpt', ...contract.policies)
      .createAPIWrapper('openai/gpt', () => {
        called = true;
        return { status: 200, body: 'gpt-3.5 handler' };
      });

    const resp: any = await wrapped({
      model: 'gpt-3.5',
      prompt: 'hi',
      user: 'bob',
      timestamp: Date.now()
    });

    if (!called) throw new Error('handler was not called for gpt-3.5');
    if (resp?.body !== 'gpt-3.5 handler') throw new Error(`expected gpt-3.5 handler body, got ${JSON.stringify(resp)}`);
    console.log('[smoke] ✓ elseWhen dispatches gpt-3.5 to its own policy');
  }

  // --- 3. Metric commit actually persists to the DAO ---
  {
    const dao = new MemoryMetricDao();
    const contract = buildContract(10000);
    const wrapped = new C1APIAuthorizer(dao)
      .addPolicies('openai/gpt', ...contract.policies)
      .createAPIWrapper('openai/gpt', () => ({ status: 200, body: 'ok' }));

    await wrapped({
      model: 'gpt-4.0',
      prompt: 'abc',
      user: 'alice',
      timestamp: Date.now()
    });

    const snapshot = dao.__debugSnapshot();
    const wrote = Object.values(snapshot).some(store => Object.keys(store).length > 0);
    if (!wrote) throw new Error('expected commit to persist to the DAO, but snapshot is empty');
    console.log('[smoke] ✓ successful commit persists metric deltas to the DAO');
  }

  // --- 4. Rejection: no policy matches ---
  {
    const dao = new MemoryMetricDao();
    const contract = buildContract(10000);
    let handlerCalled = false;
    const wrapped = new C1APIAuthorizer(dao)
      .addPolicies('openai/gpt', ...contract.policies)
      .createAPIWrapper('openai/gpt', () => {
        handlerCalled = true;
        return { status: 200, body: 'ok' };
      });

    let rejected = false;
    try {
      await wrapped({
        model: 'claude',
        prompt: 'hi',
        user: 'carol',
        timestamp: Date.now()
      });
    } catch (err) {
      rejected = true;
      if (!/Rejected/.test(String(err))) throw new Error(`expected "Rejected" in error, got ${String(err)}`);
    }

    if (!rejected) throw new Error('expected unmatched request to be rejected');
    if (handlerCalled) throw new Error('handler should not run when no policy matches');
    console.log('[smoke] ✓ unmatched request is rejected before the handler runs');
  }

  console.log('[smoke]');
  console.log('[smoke] OK');
}

main().catch(err => {
  console.error('[smoke] FAIL', err);
  process.exit(1);
});
