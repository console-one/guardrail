// Filesystem-backed MetricDao.
//
// Same external semantics as MemoryMetricDao — counters per (category,
// partition-key tuple) — but persisted across process restarts via
// @console-one/source's FilesystemPartitionMap. Useful for single-process
// production use where Redis/SQLite is overkill but data MUST survive
// daemon restart (the rate-budget use case in officespace-publisher).
//
// Sliding-window or per-call timestamp queries are NOT in this adapter's
// scope — the MetricDao interface is counter-shaped. Callers wanting
// sliding semantics encode the bucket in the partition tuple, e.g.
//   partition: ['user', 'window-2026-04-30T15:00Z-aligned-5h']
// and rotate the bucket-id as the window slides.
//
// Storage layout under the supplied root directory:
//   <root>/counters/<category>/<partition-key>.json   numeric counters
//   <root>/info/<info-key>.json                       optional info store
//                                                     (only used if get/setInfo called)
//
// No cross-process coordination — last writer wins on concurrent writes
// from separate processes. For multi-process deployments, back the DAO
// with Redis or Postgres.

import path from 'node:path';
import {
  ColumnKey,
  FilesystemPartitionMap,
  type PartitionMap,
} from '@console-one/source';
import {
  type MetricDao,
  type ReadCallbackMap,
  type CommitObservable,
  type CommitCallbacks,
} from '../metric-dao/interface.js';

export interface FilesystemMetricDaoOpts {
  /** Numeric counter store. Keyed by ColumnKey(category, partitionJoined). */
  counters: PartitionMap<number>;
  /** Optional info-key store. Keyed by ColumnKey(infoKey). When omitted,
   *  getInfo / setInfo become no-ops returning undefined. */
  info?: PartitionMap<string>;
}

export class FilesystemMetricDao implements MetricDao {
  private counters: PartitionMap<number>;
  private info: PartitionMap<string>;

  constructor(opts: FilesystemMetricDaoOpts) {
    this.counters = opts.counters;
    this.info = opts.info ?? noopStringStore();
  }

  /**
   * Convenience factory: instantiate FS-backed adapters under a single
   * root directory. Counters in `<rootDir>/counters/`, info in
   * `<rootDir>/info/`. Recreates fresh adapter instances pointing at the
   * same on-disk paths to recover prior state.
   */
  static atRoot(rootDir: string): FilesystemMetricDao {
    return new FilesystemMetricDao({
      counters: new FilesystemPartitionMap<number>(
        path.join(rootDir, 'counters'),
        { serialize: (v) => String(v), deserialize: (raw) => Number(raw) },
      ),
      info: new FilesystemPartitionMap<string>(
        path.join(rootDir, 'info'),
        { serialize: (v) => v, deserialize: (raw) => raw },
      ),
    });
  }

  async setInfo(
    cache: { [key: string]: any },
    key: string,
    value: string,
  ): Promise<any> {
    await this.info.set(ColumnKey.from(key), value);
    cache[key] = value;
    return value;
  }

  async getInfo(
    cache: { [key: string]: any },
    key: string,
    defaultTo?: () => any,
  ): Promise<any> {
    if (cache[key] === undefined) {
      const stored = await this.info.get(ColumnKey.from(key));
      if (stored !== undefined) {
        cache[key] = stored;
      } else if (defaultTo !== undefined) {
        await this.setInfo(cache, key, defaultTo());
      }
    }
    return cache[key];
  }

  async executeReadRequest(
    category: string,
    keyObject: ReadCallbackMap,
  ): Promise<any[]> {
    const entries = Object.entries(keyObject);
    for (const [partKey, record] of entries) {
      const col = ColumnKey.from(category, partKey);
      const stored = await this.counters.get(col);
      const numeric = stored ?? 0;
      try {
        record.resolve(record.callback(Number.isFinite(numeric) ? numeric : 0));
      } catch (err) {
        record.reject(err);
      }
    }
    return Promise.all(entries.map(([, record]) => record.promise));
  }

  async executeCommitRequest(
    observables: CommitObservable[],
    callbacks: CommitCallbacks,
  ): Promise<any> {
    try {
      const results: any[] = [];
      for (let index = 0; index < observables.length; index += 1) {
        const observable = observables[index];
        const partKey = observable.partition.join('||');
        const col = ColumnKey.from(observable.metric, partKey);
        const current = await this.counters.get(col);
        const currentNum = current ?? 0;
        const deltaNum = toNumber(observable.delta);
        const next = currentNum + deltaNum;
        await this.counters.set(col, next);
        results.push(next);
        callbacks.resolve(next, index);
      }
      return results;
    } catch (err) {
      callbacks.reject(err);
      throw err;
    }
  }

  /**
   * Inspection helper — not part of MetricDao. Returns every (category,
   * partitionKey) → count entry currently stored. Useful for tests and
   * debugging. Cost is O(N) over all stored counters.
   */
  async __debugSnapshot(): Promise<{ [category: string]: { [partitionKey: string]: number } }> {
    const out: { [category: string]: { [partitionKey: string]: number } } = {};
    const allKeys = await this.counters.listKeys();
    for (const keyStr of allKeys) {
      // ColumnKey.toString() joins parts with '/'; we built keys as
      // (category, partitionJoined) so a single split('/') gives [cat, part].
      const slashIdx = keyStr.indexOf('/');
      if (slashIdx < 0) continue;
      const category = keyStr.slice(0, slashIdx);
      const partKey = keyStr.slice(slashIdx + 1);
      const col = ColumnKey.from(category, partKey);
      const v = await this.counters.get(col);
      if (v === undefined) continue;
      if (!out[category]) out[category] = {};
      out[category][partKey] = v;
    }
    return out;
  }
}

function toNumber(v: any): number {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.reduce<number>((acc, x) => acc + toNumber(x), 0);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function noopStringStore(): PartitionMap<string> {
  return {
    async set() { /* no-op */ },
    async get() { return undefined; },
    async getAll() { return []; },
    async has() { return false; },
    async delete() { /* no-op */ },
    async listKeys() { return []; },
  };
}
