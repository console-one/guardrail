// Named binary predicate used in constraint evaluation. Constraints
// look like `metric RELATION limit` and this is the RELATION slot.
// Registering a new relation is a one-liner:
//
//   new ResourceRelation('LESS_THAN_STRICT', (a, b) => a < b);
//
// and it becomes available by name via `ResourceRelations[name]`.
// Registration-by-name means the entire contract configuration stays
// JSON-serializable — the predicate lives in code, the contract
// references it by string.

export enum ResourceRelationType {
  LESS_THAN = 'LESS_THAN',
  LESS_THAN_OR_EQUAL_TO = 'LESS_THAN_OR_EQUAL_TO'
}

export const ResourceRelations: { [key: string]: ResourceRelation } = {};

export class ResourceRelation {
  constructor(
    public name: string,
    public predicate: (a: any, b: any) => boolean
  ) {
    ResourceRelations[this.name] = this;
  }

  toString() {
    return this.name;
  }
}

new ResourceRelation(ResourceRelationType.LESS_THAN, (a, b) => a < b);
new ResourceRelation(ResourceRelationType.LESS_THAN_OR_EQUAL_TO, (a, b) => a <= b);
