// ─────────────────────────────────────────────────────────────────────────
// Filesystem-backed MetricDao adapter:
//   - cold read returns 0
//   - commit + read round-trips
//   - per-(category, partition) keys don't collide
//   - state survives "restart" (fresh DAO instance pointing at same root)
//   - getInfo / setInfo round-trip on durable info store
// ─────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FilesystemMetricDao } from '../adapters/filesystem-metric-dao.js';
import {
  type CommitObservable,
  type CommitCallbacks,
  type ReadCallbackMap,
} from '../metric-dao/interface.js';

function freshTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-fs-metric-'));
}

function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makeReadKeys(partKeys: string[]): ReadCallbackMap {
  const map: ReadCallbackMap = {};
  for (const k of partKeys) {
    let resolveFn: (v: any) => void = () => undefined;
    let rejectFn: (e: any) => void = () => undefined;
    const promise = new Promise<any>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    map[k] = {
      callback: (raw: any) => raw, // identity
      promise,
      resolve: resolveFn,
      reject: rejectFn,
    };
  }
  return map;
}

function noopCommitCallbacks(): CommitCallbacks {
  return {
    resolve: () => undefined,
    reject: () => undefined,
  };
}

export default async (
  test: (name: string, body: (validator: any) => any) => any,
) => {
  await test('cold read on never-written counter returns 0', async (validator: any) => {
    const root = freshTmp();
    try {
      const dao = FilesystemMetricDao.atRoot(root);
      const reads = makeReadKeys(['alice||2026-04-30']);
      const results = await dao.executeReadRequest('test-cat', reads);
      return validator.expect(results).toLookLike([0]);
    } finally {
      rmTmp(root);
    }
  });

  await test('commit then read round-trips the count', async (validator: any) => {
    const root = freshTmp();
    try {
      const dao = FilesystemMetricDao.atRoot(root);
      const observables: CommitObservable[] = [
        {
          metric: 'claude-max-inference',
          name: 'count',
          value: 1,
          delta: 1,
          partition: ['alice', 'window-A'],
          granularity: [],
        },
        {
          metric: 'claude-max-inference',
          name: 'count',
          value: 1,
          delta: 1,
          partition: ['alice', 'window-A'],
          granularity: [],
        },
      ];
      await dao.executeCommitRequest(observables, noopCommitCallbacks());

      const reads = makeReadKeys(['alice||window-A']);
      const results = await dao.executeReadRequest(
        'claude-max-inference',
        reads,
      );
      return validator.expect(results).toLookLike([2]);
    } finally {
      rmTmp(root);
    }
  });

  await test('different partitions and categories do not collide', async (validator: any) => {
    const root = freshTmp();
    try {
      const dao = FilesystemMetricDao.atRoot(root);
      await dao.executeCommitRequest(
        [
          {
            metric: 'cat-A',
            name: 'count',
            value: 1,
            delta: 5,
            partition: ['alice', 'win-1'],
            granularity: [],
          },
          {
            metric: 'cat-A',
            name: 'count',
            value: 1,
            delta: 7,
            partition: ['alice', 'win-2'],
            granularity: [],
          },
          {
            metric: 'cat-B',
            name: 'count',
            value: 1,
            delta: 3,
            partition: ['alice', 'win-1'],
            granularity: [],
          },
        ],
        noopCommitCallbacks(),
      );
      const a1 = await dao.executeReadRequest(
        'cat-A',
        makeReadKeys(['alice||win-1']),
      );
      const a2 = await dao.executeReadRequest(
        'cat-A',
        makeReadKeys(['alice||win-2']),
      );
      const b1 = await dao.executeReadRequest(
        'cat-B',
        makeReadKeys(['alice||win-1']),
      );
      return validator
        .expect({ a1: a1[0], a2: a2[0], b1: b1[0] })
        .toLookLike({ a1: 5, a2: 7, b1: 3 });
    } finally {
      rmTmp(root);
    }
  });

  await test('state survives restart (fresh DAO at same root)', async (validator: any) => {
    const root = freshTmp();
    try {
      const dao1 = FilesystemMetricDao.atRoot(root);
      await dao1.executeCommitRequest(
        [
          {
            metric: 'rate',
            name: 'count',
            value: 1,
            delta: 42,
            partition: ['user-x', 'window-y'],
            granularity: [],
          },
        ],
        noopCommitCallbacks(),
      );
      // Drop dao1 reference; create dao2 pointing at same root.
      const dao2 = FilesystemMetricDao.atRoot(root);
      const reads = await dao2.executeReadRequest(
        'rate',
        makeReadKeys(['user-x||window-y']),
      );
      // And further increment via dao2 to confirm reads-as-current state.
      await dao2.executeCommitRequest(
        [
          {
            metric: 'rate',
            name: 'count',
            value: 1,
            delta: 8,
            partition: ['user-x', 'window-y'],
            granularity: [],
          },
        ],
        noopCommitCallbacks(),
      );
      const reads2 = await dao2.executeReadRequest(
        'rate',
        makeReadKeys(['user-x||window-y']),
      );
      return validator
        .expect({ initial: reads[0], afterIncrement: reads2[0] })
        .toLookLike({ initial: 42, afterIncrement: 50 });
    } finally {
      rmTmp(root);
    }
  });

  await test('getInfo / setInfo round-trip across DAO restart', async (validator: any) => {
    const root = freshTmp();
    try {
      const dao1 = FilesystemMetricDao.atRoot(root);
      const cache: any = {};
      await dao1.setInfo(cache, 'last-rotation-ts', '2026-04-30T15:00:00Z');

      // Restart
      const dao2 = FilesystemMetricDao.atRoot(root);
      const cache2: any = {};
      const got = await dao2.getInfo(cache2, 'last-rotation-ts');
      return validator
        .expect(got)
        .toLookLike('2026-04-30T15:00:00Z');
    } finally {
      rmTmp(root);
    }
  });
};
