import { listContribution } from '../selectors/contributor.js';
import { ResourceRelation } from './resourcerelation.js';
import { Selectable } from '../selectors/selectable.js';
import { SelectorSet } from '../selectors/selectorset.js';
import { Submetric } from './submetric.js';
import { Unit } from './unit.js';
import {
  updateToDependentSet,
  getNextValue,
  getPartition,
  getValue,
  toName
} from './authhelpers.js';

// Unbound form: declarative, serializable, not yet wired into any
// SelectorSet. Produced by the contract builder and held inside a
// PolicyType until compilation.
export class Constrainable {
  constructor(
    public value: Unit,
    public relation: ResourceRelation,
    public limit: number | Unit,
    public name?: string
  ) {}

  toConstraint(selectorSet: SelectorSet): Constraint {
    return new Constraint(
      this.value.toSubmetric(selectorSet),
      this.relation,
      typeof this.limit === 'number' ? this.limit : this.limit.toSubmetric(selectorSet),
      this.name ?? ''
    );
  }
}

// Bound form. Vertex peer of Translation — both have sourceName
// 'translation' so Scope.attach handles them through the translation
// branch (InputSetCollector wires the value Submetric and any limit
// Submetric; applicator fires when both have resolved).
//
// On fire:
//   projected = value + delta
//   outcome   = relation(projected, limit)
//   publish('success', obs) | publish('break', obs)
//
// The constraint does not "check" anything. It's a vertex that fires
// when its inputs arrive and declares an outcome to the Scope's event
// bus. The Scope listens, counts successes, commits or rejects.
export class Constraint implements Selectable {
  readonly name: string;
  readonly sourceName = 'translation';
  readonly selectorPath: string;
  readonly selectorApplicator: (inputsPromise: any) => Promise<any>;
  readonly selectables: Selectable[];

  constructor(
    public value: Submetric,
    public relation: ResourceRelation,
    public limit: number | Submetric,
    public alias: string
  ) {
    this.name = `${toName(value)}:${relation.name}:${toName(limit)}`;
    this.selectorPath = this.name;
    this.selectables = [
      ...(typeof value === 'number' ? [] : [value as Selectable]),
      ...(typeof limit === 'number' ? [] : [limit as Selectable])
    ];

    const constraintName = this.name;
    this.selectorApplicator = async function (this: any, inputsPromise: any) {
      return Promise.all(inputsPromise).then(async (inputs: any[]) => {
        const appliedLimit = typeof limit === 'number' ? limit : getValue(await inputs[1]);
        const appliedDelta = getNextValue(await inputs[0]);
        const partitionedInputs = getPartition(await inputs[0]);
        const result = {
          name: constraintName,
          granularity: value.per,
          partition: partitionedInputs,
          outcome: relation.predicate(appliedDelta, appliedLimit),
          trace: inputs[0],
          value: appliedDelta
        };

        if (result.outcome) this.publish('success', result);
        else this.publish('break', result);

        return result;
      });
    };
  }

  update(selectorSet: SelectorSet) {
    const inputIo = this.value.update(selectorSet);
    const inputSelectors: any[] = [this.value, ...inputIo.output];

    if (typeof this.limit !== 'number') {
      this.limit.update(selectorSet);
      const selected = selectorSet.get(this.limit.name);
      if (selected !== undefined) inputSelectors.push(selected);
    }
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
    const valueNode = selectorSet.get(this.value.name);
    const selfNode = selectorSet.get(this.name);
    const seeds: any[] = [];
    if (valueNode !== undefined) seeds.push(valueNode);
    if (selfNode !== undefined) seeds.push(selfNode);
    return listContribution(selectorSet, seeds);
  }
}

export { listContribution };
