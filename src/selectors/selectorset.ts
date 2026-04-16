import { Selectable } from './selectable.js';

// The SelectorSet is the dependency graph. Every node is indexed three
// ways — by name, by selector path, and by composite key — so lookups
// and merges are O(1) and merges dedupe on structural identity.
//
// Two properties matter for stability:
//
//   1. The composite key `(name, selectorPath, sourceName)` means the
//      same selector registered twice is a no-op. listContribution can
//      run over overlapping subgraphs and the union is stable.
//
//   2. `merge(other)` produces a union SelectorSet without mutating
//      either operand. Multiple constraints can contribute their own
//      minimal closures and the authorizer merges them per request to
//      form the final evaluation scope — without the constraints ever
//      knowing about each other.
export class SelectorSet {
  byIndex: Selectable<any>[];
  byName: { [key: string]: number[] };
  bySourcePath: { [key: string]: number[] };
  byBoth: { [key: string]: any };
  unresolvedAliases: { [key: string]: number[] };

  constructor(...selectors: Selectable<any>[]) {
    this.byIndex = [];
    this.byName = {};
    this.bySourcePath = {};
    this.unresolvedAliases = {};
    this.byBoth = {};

    for (const selector of selectors) {
      this._set(selector);
    }
  }

  named(name: string): Selectable<any> | undefined {
    if (this.byName[name] === undefined || this.byName[name].length < 1) {
      if (this.bySourcePath[name] !== undefined && this.bySourcePath[name].length === 1) {
        return this.byIndex[this.bySourcePath[name][0]];
      }
      return undefined;
    }
    return this.byIndex[this.byName[name][0]];
  }

  private _set(selector: Selectable<any>) {
    if (this.byName[selector.name] === undefined) this.byName[selector.name] = [];
    if (this.bySourcePath[selector.selectorPath] === undefined) this.bySourcePath[selector.selectorPath] = [];

    const k =
      (selector.name ?? '') + ':' + (selector.selectorPath ?? '') + ':' + (selector.sourceName ?? '');

    if (this.byBoth[k] !== undefined) return;
    this.byBoth[k] = selector;

    this.byName[selector.name].push(this.byIndex.length);
    this.bySourcePath[selector.selectorPath].push(this.byIndex.length);
    this.byIndex.push(selector);

    if (!selector.resolved && selector.parentAlias && this.has(selector.parentAlias)) {
      (selector as any).parent = this.named(selector.parentAlias);
    }
    if (this.unresolvedAliases[selector.name] !== undefined) {
      for (const child of this.unresolvedAliases[selector.name].map(num => this.byIndex[num])) {
        (child as any).parent = selector;
      }
      delete this.unresolvedAliases[selector.name];
    }
  }

  set(alias: any, selector?: Selectable<any>): this {
    if (selector === undefined) this._set(alias);
    else this._set(selector);
    return this;
  }

  get(selectorName: string, sourceName?: string): Selectable<any> | undefined {
    if (this.byName[selectorName] === undefined) {
      if (this.bySourcePath[selectorName] !== undefined && this.bySourcePath[selectorName].length === 1) {
        return this.byIndex[this.bySourcePath[selectorName][0]];
      }
      return undefined;
    }
    if (sourceName === undefined) return this.byIndex[this.byName[selectorName][0]];
    return this.byName[selectorName]
      .map(i => this.byIndex[i])
      .find(item => item.name === sourceName);
  }

  has(selectorName: string, sourceName?: string): boolean {
    if (this.byName[selectorName] === undefined) {
      return this.bySourcePath[selectorName] !== undefined && this.bySourcePath[selectorName].length === 1;
    }
    if (sourceName === undefined) return true;
    return !!this.byName[selectorName]
      .map(i => this.byIndex[i])
      .find(item => item.name === sourceName);
  }

  merge(selectorSet: SelectorSet): SelectorSet {
    const union = new SelectorSet();
    for (const item of this.byIndex) union.set(item);
    for (const item of selectorSet.byIndex) union.set(item);
    return union;
  }

  static make(...selectors: Selectable<any>[]): SelectorSet {
    return new SelectorSet(...selectors);
  }
}
