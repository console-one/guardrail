// Many-to-many, order-independent data-to-function broadcaster.
//
// N values broadcast to M listeners regardless of registration order:
//   - setItem(...v)      publishes a value; all existing listeners fire now
//   - setListener(fn)    registers a listener; every prior value replays now
//
// Replay semantics are "all prior values", not "just the latest". A
// subscriber that registers late sees every value published before it,
// and a value published before any subscribers exist still fires every
// listener that registers afterward. This eliminates the class of timing
// bugs you get when a downstream subscriber races an upstream publisher.
//
// Generic parameter `TArgs` is the tuple of arguments setItem accepts
// (and listeners receive). Default `unknown[]` means heterogeneous
// values; consumers wanting to lock down a topic to a specific shape
// can supply a tuple type, e.g. `Eventual<[string, number]>`.

export class Eventual<TArgs extends readonly unknown[] = unknown[]> {
  values: TArgs[];
  listeners: Array<(...args: TArgs) => void>;

  constructor(...values: TArgs[]) {
    this.values = values;
    this.listeners = [];
  }

  setItem(...item: TArgs) {
    this.values.push(item);
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i](...item);
    }
  }

  setListener(fn: (...args: TArgs) => void) {
    for (const value of this.values) {
      fn(...value);
    }
    this.listeners.push(fn);
  }
}

export const toEventual = <TArgs extends readonly unknown[] = unknown[]>(
  cb: (publish: (...data: TArgs) => void) => void
): Eventual<TArgs> => {
  const eventual = new Eventual<TArgs>();
  cb(eventual.setItem.bind(eventual));
  return eventual;
};
