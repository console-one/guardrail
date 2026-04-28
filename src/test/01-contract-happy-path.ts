// ─────────────────────────────────────────────────────────────────────────
// End-to-end happy path: declare a contract, wire it through C1APIAuthorizer,
// invoke it. Verifies the within-budget request goes through.
// ─────────────────────────────────────────────────────────────────────────

import {
  ContractBuilder,
  C1APIAuthorizer,
  MemoryMetricDao,
  Selector,
  Translation,
  SelectorSet,
  lookslike,
} from '../index.js';

const estimateTokens = (s: string) => s.length / 3;

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
      .set('[translation:tokens]').toLessThan(limit)
      .per('[request:user]', '[request:day]').as('gpt4-user-daily')
      .andSet('[translation:tokens]').toLessThan(limit)
      .per('[request:user]', '[request:hour]').as('gpt4-user-hourly')
    .elseWhen(lookslike({ model: 'gpt-3.5' }), 'GPT-35-Used')
      .set('[translation:tokens]').toLessThan(limit)
      .per('[request:user]', '[request:day]').as('gpt35-user-daily')
    .create();
}

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('GPT-4 request within budget returns the wrapped handler result', async (validator: any) => {
    const dao = new MemoryMetricDao();
    const contract = buildContract(10000);
    const wrapped = new C1APIAuthorizer(dao)
      .addPolicies('openai/gpt', ...contract.policies)
      .createAPIWrapper('openai/gpt', () => ({ status: 200, body: 'ok' }));
    const resp: any = await wrapped({
      model: 'gpt-4.0',
      prompt: 'Hello, world.',
      user: 'alice',
      timestamp: Date.now(),
    });
    return validator.expect({
      status: resp.status,
      body: resp.body,
    }).toLookLike({ status: 200, body: 'ok' });
  });

  await test('elseWhen branch dispatches gpt-3.5 to its own policy', async (validator: any) => {
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
      model: 'gpt-3.5', prompt: 'hi', user: 'bob', timestamp: Date.now(),
    });
    return validator.expect({
      called,
      body: resp.body,
    }).toLookLike({ called: true, body: 'gpt-3.5 handler' });
  });

  await test('successful commit persists metric deltas to the DAO', async (validator: any) => {
    const dao = new MemoryMetricDao();
    const contract = buildContract(10000);
    const wrapped = new C1APIAuthorizer(dao)
      .addPolicies('openai/gpt', ...contract.policies)
      .createAPIWrapper('openai/gpt', () => ({ status: 200, body: 'ok' }));
    await wrapped({
      model: 'gpt-4.0', prompt: 'abc', user: 'alice', timestamp: Date.now(),
    });
    const snapshot = (dao as any).__debugSnapshot();
    const persisted = Object.values(snapshot).some(
      (store: any) => Object.keys(store).length > 0,
    );
    return validator.expect(persisted).toLookLike(true);
  });

  await test('unmatched request rejects before the handler runs', async (validator: any) => {
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
    let rejectedAsExpected = false;
    try {
      await wrapped({
        model: 'claude', prompt: 'hi', user: 'carol', timestamp: Date.now(),
      });
    } catch (err) {
      rejected = true;
      rejectedAsExpected = /Rejected/.test(String(err));
    }
    return validator.expect({
      rejected,
      rejectedAsExpected,
      handlerCalled,
    }).toLookLike({ rejected: true, rejectedAsExpected: true, handlerCalled: false });
  });
};
