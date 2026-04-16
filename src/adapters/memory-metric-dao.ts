import {
  MetricDao,
  ReadCallbackMap,
  CommitObservable,
  CommitCallbacks
} from '../metric-dao/interface.js';

// In-memory reference implementation. Good for tests, smoke runs, and
// local development. Not suitable for multi-process workloads — there's
// no cross-process coordination. Production deployments should
// implement `MetricDao` against whatever durable store they use.
//
// Storage model mirrors the legacy Redis hash layout: one map per
// metric category, keyed by composite partition string
// (e.g. "jim||2024-07-11").
export class MemoryMetricDao implements MetricDao {
  private categories: Map<string, Map<string, number>> = new Map();
  private info: Map<string, string> = new Map();

  private createInfoKey(key: string): string {
    return `metricinfo:${key}`;
  }

  async setInfo(cache: { [key: string]: any }, key: string, value: string): Promise<any> {
    this.info.set(this.createInfoKey(key), value);
    cache[key] = value;
    return value;
  }

  async getInfo(cache: { [key: string]: any }, key: string, defaultTo?: () => any): Promise<any> {
    if (cache[key] === undefined) {
      const data = this.info.get(this.createInfoKey(key));
      if (data !== undefined && data !== null) cache[key] = data;
      else if (defaultTo !== undefined) await this.setInfo(cache, key, defaultTo());
    }
    return cache[key];
  }

  async executeReadRequest(category: string, keyObject: ReadCallbackMap): Promise<any[]> {
    const infoKey = this.createInfoKey(category);
    if (!this.categories.has(infoKey)) this.categories.set(infoKey, new Map());
    const store = this.categories.get(infoKey)!;

    const entries = Object.entries(keyObject);
    for (const [key, record] of entries) {
      const raw = store.get(key);
      const numeric = raw === undefined ? 0 : Number(raw);
      try {
        record.resolve(record.callback(Number.isFinite(numeric) ? numeric : 0));
      } catch (err) {
        record.reject(err);
      }
    }

    return Promise.all(entries.map(([, record]) => record.promise));
  }

  async executeCommitRequest(observables: CommitObservable[], callbacks: CommitCallbacks): Promise<any> {
    try {
      const results: any[] = [];
      for (let index = 0; index < observables.length; index += 1) {
        const observable = observables[index];
        const infoKey = this.createInfoKey(observable.metric);
        if (!this.categories.has(infoKey)) this.categories.set(infoKey, new Map());
        const store = this.categories.get(infoKey)!;
        const pathKey = observable.partition.join('||');
        const current = store.get(pathKey);
        const currentNum = current === undefined ? 0 : Number(current);
        const deltaNum = this.toNumber(observable.delta);
        const next = currentNum + deltaNum;
        store.set(pathKey, next);
        results.push(next);
        callbacks.resolve(next, index);
      }
      return results;
    } catch (err) {
      callbacks.reject(err);
      throw err;
    }
  }

  private toNumber(val: any): number {
    if (typeof val === 'number') return val;
    if (Array.isArray(val)) return val.reduce((acc: number, v: any) => acc + this.toNumber(v), 0);
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
  }

  // Inspection helpers — not part of the MetricDao interface.
  __debugSnapshot(): { [category: string]: { [partitionKey: string]: number } } {
    const out: { [category: string]: { [partitionKey: string]: number } } = {};
    for (const [cat, store] of this.categories.entries()) {
      out[cat] = Object.fromEntries(store.entries());
    }
    return out;
  }

  __reset(): void {
    this.categories.clear();
    this.info.clear();
  }
}
