// Persistence boundary. Everything the framework needs to read or write
// from durable storage goes through this interface. Implement it
// against Redis, Postgres, DynamoDB, an in-memory map, or whatever your
// system wants — guardrail itself imports nothing from any transport
// layer.

export type ReadCallback = (rawValue: any) => any;

export interface ReadCallbackRecord {
  callback: ReadCallback;
  promise: Promise<any>;
  resolve: (value: any) => void;
  reject: (err: any) => void;
}

export type ReadCallbackMap = { [partitionKey: string]: ReadCallbackRecord };

export interface CommitObservable {
  metric: string;
  name: string;
  value: any;
  delta: any;
  partition: any[];
  granularity: any[];
  outcome?: boolean;
}

export interface CommitCallbacks {
  resolve(value: any, index?: number): void;
  reject(err: any, index?: number): void;
}

// Called in batch by Scope.execRead once all pending metric reads for
// a category have been registered. The implementation should read every
// composite partition key in `keyObject`, wrap each raw value through
// that record's `callback`, and then call the record's `resolve`.
//
// Called atomically by Scope.execCommit when every constraint has
// published 'success'. `observables` is the full staged delta batch;
// writes are all-or-nothing. On success, call `callbacks.resolve(v, index)`
// per entry; on failure, `callbacks.reject`.
export interface MetricDao {
  getInfo?(cache: { [key: string]: any }, key: string, defaultTo?: () => any): Promise<any>;
  setInfo?(cache: { [key: string]: any }, key: string, value: string): Promise<any>;

  executeReadRequest(category: string, keyObject: ReadCallbackMap): Promise<any[]>;

  executeCommitRequest(
    observables: CommitObservable[],
    callbacks: CommitCallbacks
  ): Promise<any>;
}
