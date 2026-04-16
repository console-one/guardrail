import { listContribution } from '../selectors/contributor.js';
import { InputMap } from '../primitives/inputset.js';
import { Selectable } from '../selectors/selectable.js';
import { SelectorSet } from '../selectors/selectorset.js';
import { Translation } from '../selectors/translation.js';
import { updateToDependentSet } from './authhelpers.js';

// A bound, executable Unit. Extends Translation — fires when all its
// `per` dimensions AND its `set` value have resolved. On fire:
//   1. Resolves dimensions to concrete values
//   2. Builds the composite metric key: `set.dim1,dim2,...`
//   3. Calls scope.getMetric(uuid, metricKey, partition, cb)
//   4. The callback wraps the raw stored value in an observation:
//        { metric, granularity, partition, value, delta, scope }
//   5. Returns the observation — published via the Scope's 'items' bus
export class Submetric<DimensionType = any, FocusType = any> extends Translation {
  constructor(
    public per: Selectable<DimensionType>[],
    public set: Selectable<FocusType>,
    public alias: string
  ) {
    super(
      set.name + '.' + per.map(n => n.name).join(','),
      async function (this: any, ...inputs: any[]) {
        const granularity = per.map(input => input.name);
        const slice = granularity.concat([set.name]);
        const metricKey = `${set.name}.${granularity.join(',')}`;
        const columns = new InputMap(slice);
        const defaults = new Array(columns.columns.length);

        const cols: any[] = [];
        for (let index = 0; index < columns.columns.length; index += 1) {
          let value = inputs.length > index ? await inputs[index] : await defaults[index];
          value = value === undefined || value === null ? '*' : value;
          cols.push(value);
        }

        try {
          const value = await this.getMetric(
            this.request.uuid,
            metricKey,
            cols.slice(0, -1),
            (data: any) => ({
              metric: metricKey,
              granularity: granularity,
              target: [set.name],
              partition: cols.slice(0, -1),
              value: data === null ? 0 : data,
              delta: inputs.slice(-1)[0],
              scope: this
            })
          );
          return value;
        } catch {
          // Propagate via the scope's break path; don't crash applicator
          return undefined;
        }
      },
      ...per.concat([set as any])
    );
  }

  get name(): string {
    return this.set.name + '.' + this.per.map(n => n.name).join(',');
  }

  update(selectorSet: SelectorSet) {
    const inputSelectors = this.per.concat([this.set as any]);
    updateToDependentSet(selectorSet, inputSelectors);

    const outputSelectors: any[] = [this];
    updateToDependentSet(selectorSet, outputSelectors);

    return {
      name: this.name,
      input: inputSelectors,
      output: outputSelectors
    };
  }

  listContribution(selectorSet: SelectorSet): SelectorSet {
    return listContribution(selectorSet, [...this.per, this.set]);
  }
}
