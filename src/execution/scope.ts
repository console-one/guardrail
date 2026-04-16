import { Eventual } from '../primitives/eventual';
import { InputMap } from '../primitives/inputset';
import { MetricDao } from '../metric-dao/interface';
import { SelectorSet } from '../selectors/selectorset';

// The per-request evaluation context. Holds:
//   - an event bus keyed by name, each topic backed by an Eventual
//     (many-to-many, replay-all)
//   - in-flight metric read requests, batched per category, resolved
//     via the injected MetricDao
//   - staged metric commits, flushed atomically on execCommit()
//
// `Scope` ported from the source as a single class. The 380-line
// god-object nature is known tech debt: it conflates pub/sub, metric
// I/O, and transactional staging. A future rewrite should split it
// into `PubSub`, `Barrier`, and `TxStage`. Not done in this pass to
// avoid introducing behavioural drift.

const toNumber = (val: any): number => {
  return typeof val === 'number' ? val : Array.isArray(val) ? toNumber(val[0]) : Number(val);
};

function unpack(arr: any, collector: (a: any, b: any) => any): any {
  if (Array.isArray(arr) && arr.length > 0) {
    let index = 0;
    let total = arr[index];
    while (index + 1 < arr.length) {
      index += 1;
      total = collector(total, unpack(arr[index], collector));
    }
    return total;
  } else if (typeof arr === 'string') {
    return arr;
  } else if (Array.isArray(arr)) {
    return '';
  } else {
    throw new Error('Cannot unpack array value of ' + arr + ' to string');
  }
}

export class Scope {
  each: { [key: string]: Eventual<any> };
  request: any;
  collectors: any[];
  vars: any;
  cache: any;
  factory: MetricDao;
  openMetricRequests: any;
  stagedMetricCommits: any;
  blocked: any;

  constructor(request: any, factory: MetricDao, vars: any) {
    this.each = {};
    this.collectors = [];
    this.setup('items');
    this.request = request;
    this.vars = vars ?? {};
    this.cache = {};
    this.stagedMetricCommits = {};
    this.openMetricRequests = {};
    this.factory = factory;
    this.blocked = {};
  }

  async getInfo(key: string): Promise<any> {
    if (!this.factory.getInfo) return { key };
    const resp = await this.factory.getInfo(this.cache, key, () => ({ key }));
    return typeof resp === 'string' ? { key: resp } : resp;
  }

  async setupkey(req: string, category: string, key: string, cb: any): Promise<void> {
    if (this.openMetricRequests[req].queries[category][key] === undefined) {
      let toResolve: any;
      let toReject: any;
      const promised = new Promise((resolve, reject) => {
        toResolve = resolve;
        toReject = reject;
      });
      this.openMetricRequests[req].queries[category][key] = {
        callback: cb,
        promise: promised,
        resolve: toResolve,
        reject: toReject
      };
    }
  }

  async getMetric(req: string, category: string, keyArr: any, cb: any): Promise<any> {
    if (this.openMetricRequests[req] === undefined) {
      this.openMetricRequests[req] = { status: 'LOADING', queries: {} };
    }

    let key = unpack(keyArr, (a: any, b: any) => a + '||' + b);
    if (this.openMetricRequests[req].queries[category] === undefined) {
      this.openMetricRequests[req].queries[category] = {};
    }

    if (typeof key === 'string' && this.openMetricRequests[req]?.queries[category][key] === undefined) {
      this.setupkey(req, category, key, cb);
      this.publish(`unblocked-input-key:${req}:${category}`, -1);
    } else {
      this.blocked[`unblocked-input-key:${req}:${category}`] =
        this.blocked[`unblocked-input-key:${req}:${category}`] === undefined
          ? 1
          : this.blocked[`unblocked-input-key:${req}:${category}`] + 1;
      key = await Promise.all(key).then((k: any[]) => k.join('||'));
      this.blocked[`unblocked-input-key:${req}:${category}`] += 1;
      this.publish(
        `unblocked-input-key:${req}:${category}`,
        this.blocked[`unblocked-input-key:${req}:${category}`]
      );
    }

    return this.openMetricRequests[req].queries[category][key].promise;
  }

  async execRead(req: any): Promise<any> {
    const results: any[] = [];
    const id: string = typeof req === 'string' ? req : req.uuid;

    const addMetricKey = (id: string, category: string) => {
      const keyCallbacks = this.openMetricRequests[id].queries[category];
      results.push(
        this.factory.executeReadRequest(category, keyCallbacks).then((...next: any[]) => {
          return [category, next];
        })
      );
      this.publish(`unblocked-key:${id}:${category}`, true);
    };

    if (this.openMetricRequests[id] === undefined) this.openMetricRequests[id] = { queries: {} };

    for (const category of Object.keys(this.openMetricRequests[id].queries)) {
      if (
        this.blocked[id] === undefined ||
        this.blocked[id][category] === undefined ||
        this.blocked[id][category] === 0
      ) {
        addMetricKey(id, category);
      } else if (
        this.blocked[`unblocked-input-key:${id}:${category}`] !== undefined &&
        this.blocked[`unblocked-input-key:${id}:${category}`] > 0
      ) {
        this.subscribe(`unblocked-input-key:${id}:${category}`, (num: number) => {
          if (num === 0) addMetricKey(id, category);
        });
      } else {
        addMetricKey(id, category);
      }
    }

    return Promise.all(results)
      .then(data => {
        this.openMetricRequests[id].status = 'DONE';
        return data;
      })
      .catch(err => {
        this.openMetricRequests[id].status = 'ERROR';
        throw err;
      });
  }

  stage(req: string, observable: any) {
    const metric = observable.metric ?? observable?.trace?.metric ?? observable.name;

    if (this.stagedMetricCommits[req] === undefined) {
      this.stagedMetricCommits[req] = { metrics: {} };
      this.stagedMetricCommits[req].onComplete = [
        () => (this.stagedMetricCommits[req].running = false)
      ];
      this.stagedMetricCommits[req].onError = [
        () => (this.stagedMetricCommits[req].running = false)
      ];
    }
    if (this.stagedMetricCommits[req].metrics[metric] === undefined) {
      this.stagedMetricCommits[req].metrics[metric] = {};
    }
    if (this.stagedMetricCommits[req].metrics[metric][observable.name] === undefined) {
      this.stagedMetricCommits[req].metrics[metric][observable.name] = {
        metric: metric,
        name: observable.name,
        value: observable.value,
        delta: observable.delta,
        partition: observable.partition,
        granularity: observable.granularity,
        outcome: observable.outcome
      };
    } else if (this.stagedMetricCommits[req].metrics[metric][observable.name].delta !== undefined) {
      const accum = this.stagedMetricCommits[req].metrics[metric][observable.name];
      accum.delta += toNumber(observable.delta);
      accum.value = toNumber(observable.delta) + toNumber(accum.value);
      accum.outcome = toNumber(accum).valueOf() > 0;
      this.stagedMetricCommits[req].metrics[metric][observable.name] = accum;
    }

    return this.stagedMetricCommits[req].metrics[metric][observable.name];
  }

  execCommit(req: string): Promise<any> {
    if (this.stagedMetricCommits[req] === undefined) {
      this.stagedMetricCommits[req] = { metrics: {} };
      this.stagedMetricCommits[req].onComplete = [
        () => (this.stagedMetricCommits[req].running = false)
      ];
      this.stagedMetricCommits[req].onError = [
        () => (this.stagedMetricCommits[req].running = false)
      ];
    } else if (this.stagedMetricCommits[req] && this.stagedMetricCommits[req].running) {
      return new Promise((resolve, reject) => {
        this.stagedMetricCommits[req].onComplete.push(resolve);
        this.stagedMetricCommits[req].onError.push(reject);
      });
    } else {
      this.stagedMetricCommits[req].running = true;
    }

    const observables: any[] = [];
    let pass = true;
    const failures: any[] = [];
    for (const metric of Object.keys(this.stagedMetricCommits[req].metrics)) {
      for (const observable of Object.values(this.stagedMetricCommits[req].metrics[metric])) {
        const observed: any = observable;
        observed.metric = observed.metric ?? `metric:${metric}`;
        if (observed.outcome !== undefined) {
          if (!observed.outcome) failures.push(observed);
          pass = pass && observed.outcome;
        }
        observables.push(observed);
      }
    }

    if (pass) {
      const stagedMetricCommits = this.stagedMetricCommits;
      const awaitingPass = new Set<number>();
      let done = false;
      for (let i = 0; i < observables.length; i++) awaitingPass.add(i);
      return new Promise((resolve, reject) => {
        this.factory.executeCommitRequest(observables, {
          reject(err: any) {
            if (!done) {
              done = true;
              stagedMetricCommits[req].running = false;
              stagedMetricCommits[req].onError.forEach((cb: any) => cb(err));
              reject(err);
            }
          },
          resolve(value: any, index?: number) {
            if (!done) {
              if (index === undefined) {
                done = true;
                stagedMetricCommits[req].running = false;
                stagedMetricCommits[req].onComplete.forEach((cb: any) => cb(value));
                resolve(value);
              } else {
                awaitingPass.delete(index);
                if (awaitingPass.size === 0) {
                  done = true;
                  stagedMetricCommits[req].running = false;
                  stagedMetricCommits[req].onComplete.forEach((cb: any) => cb(value));
                  resolve(value);
                }
              }
            }
          }
        });
      });
    } else {
      return new Promise((_resolve, reject) => {
        reject(JSON.stringify(failures, null, 2));
      });
    }
  }

  setup(name: string, ...value: any[]) {
    if (this.each[name] === undefined) {
      this.each[name] = new Eventual();
    }
    if (value.length > 0) this.each[name].setItem(...value);
  }

  attach(selectorSet: SelectorSet) {
    return selectorSet.byIndex.reduce(
      (counts: any, selector) => {
        this.publish('keys', selector.name);
        switch (selector.sourceName) {
          case 'translation':
          case 'translate': {
            const translationReqs = new InputMap((selector.selectables ?? []).map(s => s.name));
            const setCollector = translationReqs.createSetCollector();

            setCollector.subscribe((...inputs: any[]) => {
              const items: any[] = [];
              for (const item of inputs) items.push(item);
              Promise.resolve((selector.selectorApplicator as any).apply(this, [...items])).then(
                (selectorValue: any) => {
                  selectorValue = Array.isArray(selectorValue) ? selectorValue : [selectorValue];
                  this.publish(selector.name, selectorValue);
                  this.publish('items', { key: selector.name, value: selectorValue });
                }
              );
            });

            counts.general += 1;
            this.subscribe('items', setCollector.publish);
            break;
          }
          case 'submetric':
            // Dead branch in the source: Submetric extends Translation
            // so its sourceName is 'translation'. Kept for parity.
            this.getMetric(
              this.request.uuid,
              selector.selectorPath,
              selector.name,
              selector.selectorApplicator
            ).then((...result: any[]) => this.publish(selector.name, ...result));
            break;
          case 'request':
            Promise.resolve((selector.selectorApplicator as any).apply(this, [this.request])).then(
              (selectorValue: any) => {
                selectorValue = Array.isArray(selectorValue) ? selectorValue : [selectorValue];
                this.publish(selector.name, ...selectorValue);
                this.publish('items', { key: selector.name, value: selectorValue });
              }
            );
            break;
          default:
            break;
        }
        return counts;
      },
      { general: 0 }
    );
  }

  publish(cbMethod: string, ...data: any[]) {
    if (typeof cbMethod !== 'string') throw new Error('cbMethod: ' + cbMethod);
    if (this.each[cbMethod] === undefined) this.each[cbMethod] = new Eventual();
    else if (data[0] instanceof Eventual && data.length === 1) {
      data[0].setListener((...item: any[]) => this.each[cbMethod].setItem(...item));
      return;
    }
    this.each[cbMethod].setItem(...data);
  }

  subscribe(cbMethod: string, handler: (...args: any[]) => void) {
    if (typeof cbMethod !== 'string') throw new Error('cbMethod: ' + cbMethod);
    if (this.each[cbMethod] === undefined) this.each[cbMethod] = new Eventual();
    this.each[cbMethod].setListener((...data: any[]) => {
      handler(...data);
    });
  }
}
