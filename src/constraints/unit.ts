import { SelectorSet } from '../selectors/selectorset.js';
import { Submetric } from './submetric.js';

// A Unit is the template form of a metric observation: "the `set`
// value, partitioned by `per` dimensions". It's data — declarable,
// serializable, versionable. Calling `toSubmetric(selectorSet)` binds
// the string references to concrete selectors and yields an executable
// Submetric.
export class Unit {
  constructor(public per: string[], public set: string, public name: string) {}

  toSubmetric(selectorSet: SelectorSet): Submetric {
    const granularity = this.per.map(i => selectorSet.get(i));
    const set = selectorSet.get(this.set);
    if (set === null || set === undefined) {
      throw new Error(
        `Unit '${this.name}' references missing selector '${this.set}' (set). ` +
          `Make sure you call contractBuilder.define(...) or add it to the SelectorSet before compiling.`
      );
    }
    for (let i = 0; i < granularity.length; i++) {
      if (granularity[i] === undefined) {
        throw new Error(
          `Unit '${this.name}' references missing granularity selector '${this.per[i]}'. ` +
            `Make sure every .per(...) dimension is defined in the SelectorSet.`
        );
      }
    }
    return new Submetric(granularity as any, set as any, this.name);
  }
}
