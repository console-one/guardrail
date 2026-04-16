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

export class Eventual<Item = any> {
  values: any[];
  listeners: ((...cb: any[]) => void)[];

  constructor(...values: any[]) {
    this.values = values;
    this.listeners = [];
  }

  setItem(...item: any) {
    this.values.push(item);
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i](...item);
    }
  }

  setListener(fn: (...cb: any[]) => void) {
    for (const value of this.values) {
      fn(...value);
    }
    this.listeners.push(fn);
  }
}

export const toEventual = (cb: (publish: (...data: any[]) => void) => any): Eventual => {
  const eventual = new Eventual();
  cb(eventual.setItem.bind(eventual));
  return eventual;
};
