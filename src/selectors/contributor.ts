import { Queue } from '../primitives/queue';
import { Selectable } from './selectable';
import { SelectorSet } from './selectorset';

// A Contributor is any node that can add itself — and its transitive
// dependencies — to a SelectorSet. Every vertex in the reactive graph
// that participates in dependency discovery implements this.
export interface Contributor {
  update(selectorSet: SelectorSet): {
    name: string;
    input: Selectable[];
    output: Selectable[];
  };
  listContribution(selectorSet: SelectorSet): SelectorSet;
}

// BFS over the selector graph. Starting from `initial`, walk every node,
// call its `update(selectorSet)` if it exposes one, enqueue every child
// in `.selectables`, and register each unvisited child in the
// SelectorSet. The returned set is the transitive closure of everything
// the initial nodes need to evaluate.
//
// This is the core of the automatic dependency discovery. Declare a
// constraint — "tokens < 1000 per user per day" — and this BFS figures
// out it needs the `tokens` translation, the `user` selector, the
// `day` selector, and the metric read. Add a new dimension and the
// traversal picks up the new dependencies on the next compile. You
// never manually wire dependencies.
export const listContribution = (selectorSet: SelectorSet, initial: any[]): SelectorSet => {
  const q = new Queue();
  const listed: { [name: string]: any } = {};

  initial.forEach(v => q.push(v));

  function push2q(selector: any) {
    if (selector !== undefined && selector.name !== undefined && listed[selector.name] === undefined) {
      listed[selector.name] = selector;
      q.push(selector);
      selectorSet.set(selector);
    }
  }

  while (q.length > 0) {
    const selector: any = q.shift();
    if (selector !== undefined && typeof selector.update === 'function') {
      selector.update(selectorSet);
    }
    if (selector !== undefined && selector.selectables !== undefined) {
      selector.selectables.forEach((s: any) => push2q(s));
    }
  }

  return selectorSet;
};
