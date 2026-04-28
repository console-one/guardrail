import { Contributor, listContribution } from './contributor.js';
import { SelectorSet } from './selectorset.js';

// A Selectable is a named vertex in the reactive dependency graph. It
// names a value and knows how to extract that value from some source.
//
// Required fields — every vertex in the graph carries these:
//   - name              graph identity; event bus route key
//   - sourceName        'request' or 'translation' (Scope.attach branches on this)
//   - selectorPath      the field/path the extractor reads from
//   - selectorApplicator the extractor function or bound operation
//
// Optional fields — Selector-style chain plumbing. Selector implements
// these to support sub-selector composition (`.as()`, `.select()`,
// `.from()`). Submetric and Constraint are vertex peers that implement
// Selectable without the chain methods — they don't compose chains,
// they're computed leaves of the graph.
export interface Selectable<K = any> {
  selectorPath: string;
  sourceName: string;
  selectorApplicator: K;
  name: string;
  selectables?: Selectable<K>[];
  as?(val: string): Selectable<K>;
  select?(selectorPath: string, structure: Structure): Selectable<K>;
  from?(selector: Selectable<K>): Selectable<K>;
  ranges?: Selectable[];
  byName?: { [key: string]: number };
  toJSON?: () => any;
  alias?: string;
  parent?: Selectable<K>;
  parentAlias?: string;
  parentRef?: Selectable<K> | string;
  resolved?: boolean;
}

export class Selector<K = any> implements Selectable<K>, Contributor {
  _parent?: Selectable<K>;
  parentAlias?: string;
  alias?: string;

  ranges: Selectable[];
  byName: { [key: string]: number };

  constructor(
    public selectorPath: string,
    public sourceName: string,
    public selectorApplicator: K,
    parent?: Selectable<K> | string
  ) {
    this.byName = {};
    this.ranges = [];
    if (typeof parent === 'string') {
      this.parentAlias = parent;
    } else if (parent !== undefined) {
      this.parent = parent;
    }
  }

  set parent(value: Selectable<K>) {
    if (this._parent !== undefined) {
      throw new Error(`Cannot set parent of selector ${this.name} twice`);
    }
    if (value === undefined) throw new Error('Setting parent to undefined');
    value.byName[this.name] = value.ranges.length;
    value.ranges.push(this as Selectable<any>);
    this._parent = value;
  }

  get parent(): Selectable<K> {
    return this._parent as Selectable<K>;
  }

  get resolved(): boolean {
    return !(this.parentAlias !== undefined && this._parent === undefined);
  }

  get parentRef(): Selectable<K> | string {
    return (this._parent ?? this.parentAlias) as Selectable<K> | string;
  }

  clone(): Selector<K> {
    const copy = new Selector<K>(this.selectorPath, this.sourceName, this.selectorApplicator);
    if (this.parentAlias !== undefined) copy.parentAlias = this.parentAlias;
    if (this._parent !== undefined) copy.parent = this._parent;
    if (this.alias !== undefined) copy.alias = this.alias;
    if (this.ranges.length > 0) copy.ranges = this.ranges.map(i => i);
    return copy;
  }

  get name(): string {
    return this.alias !== undefined ? this.alias : `[${this.sourceName}:${this.selectorPath}]`;
  }

  as(name: string): Selector<K> {
    const cloned = this.clone();
    cloned.parentAlias = name;
    return cloned;
  }

  select(selectorPath: string, structure: Structure | ((data: any) => any)): Selector<any> {
    if (typeof structure === 'function') {
      structure = Structure.Identity(structure);
    }
    return new Selector(selectorPath, structure.name, structure.selectorApplicator, this);
  }

  from(selector: Selectable<K>): Selectable<K> {
    let active: Selectable<K> = this;
    while (active.parent !== undefined) {
      active = active.parent;
    }
    (active as any).parent = selector;
    return active;
  }

  transform(name: string, fn: any): Selector<any> {
    const s = new Selector(name, 'runtime', fn, this);
    s.parentAlias = this.alias;
    return s;
  }

  update(selectorSet: SelectorSet) {
    selectorSet.set(this as any);
    return {
      name: this.name,
      input: this._parent ? [this._parent] : [],
      output: (this as any).selectables ?? []
    };
  }

  listContribution(selectorSet: SelectorSet): SelectorSet {
    const seed = selectorSet.get(this.name);
    return listContribution(selectorSet, seed !== undefined ? [seed] : [this]);
  }
}

export class Structure {
  constructor(public name: string, public selectorApplicator: any) {}

  select(path: string): Selector {
    return new Selector(path, this.name, this.selectorApplicator);
  }

  toJSON() {
    return {
      name: this.name,
      selectorApplicator: this.selectorApplicator?.toJSON
        ? this.selectorApplicator.toJSON()
        : this.selectorApplicator
    };
  }

  static fromJSON(obj: any): Structure {
    const applicator = obj.selectorApplicator?.fromJSON
      ? obj.selectorApplicator.fromJSON()
      : obj.selectorApplicator;
    return new Structure(obj.name, applicator);
  }

  static make(name: string, selectorApplicator: any): Structure {
    return new Structure(name, selectorApplicator);
  }

  static Identity = (receiver: (handler: any) => any): Structure => Structure.make('*', receiver);
}
