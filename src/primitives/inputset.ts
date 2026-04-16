import { Eventual } from './eventual.js';

// Declares N required inputs by name and fires its subscribers exactly
// once — when the Nth input arrives — with the full aggregated row.
// Inputs may arrive in any order. Late inputs after firing are ignored.
//
// This is the synchronization barrier at every Translation vertex. When
// a translation depends on three selectors, an InputSetCollector waits
// for all three to publish before the translation's applicator fires.

export class InputMap {
  public readonly map: { [key: string]: number };
  public readonly columns: string[];
  public readonly name?: string;

  constructor(declarations: string[], name?: string) {
    const map: { [key: string]: number } = {};
    const columns: string[] = [];
    for (let i = 0; i < declarations.length; i++) {
      map[declarations[i]] = i;
      columns.push(declarations[i]);
    }
    this.map = map;
    this.columns = columns;
    if (name !== undefined) this.name = name;
  }

  createSetCollector(): InputSetCollector {
    if (this.name !== undefined) return new InputSetCollector(this.columns, this.map, this.name);
    return new InputSetCollector(this.columns, this.map);
  }

  static make(declarations: string[], name?: string): InputMap {
    return new InputMap(declarations, name);
  }
}

export class InputSetCollector {
  private values: Array<[any, number]>;
  private awaiting: Set<string>;
  private awaitingCount: number;
  private map: { [key: string]: number };
  private columns: string[];
  private result: { trace: number[]; data: any[] } | undefined;
  private eventual: Eventual<any>;
  public readonly name?: string;
  public done: boolean;

  constructor(columns: string[], map: { [key: string]: number } = {}, name?: string) {
    this.columns = columns;
    this.map = map ?? {};
    if (this.columns.length > Object.keys(this.map).length) {
      for (let i = 0; i < this.columns.length; i++) {
        this.map[this.columns[i]] = i;
      }
    }
    if (name !== undefined) this.name = name;
    this.values = new Array(this.columns.length);
    this.awaiting = new Set([...Object.keys(this.map)]);
    this.awaitingCount = this.values.length;
    this.result = undefined;
    this.eventual = new Eventual();
    this.publish = this.publish.bind(this);
    this.done = false;
  }

  private tryDequeue() {
    if (!this.done && this.awaitingCount < 1) {
      this.result = {
        trace: this.values.map(v => v[1]),
        data: this.values.map(v => v[0])
      };
      this.eventual.setItem(...this.result.data);
    }
    return this.result;
  }

  publish(paramValue: { key: string; value: any }) {
    if (!this.done && this.awaiting.has(paramValue.key)) {
      this.awaitingCount -= 1;
      this.awaiting.delete(paramValue.key);
      this.values[this.map[paramValue.key]] = [paramValue.value, new Date().getTime()];
      return this.tryDequeue();
    }
    return undefined;
  }

  subscribe(cb: (...data: any[]) => void) {
    if (this.result !== undefined) {
      cb(...this.result.data);
    } else {
      this.eventual.setListener(cb);
    }
  }

  static make(declarations: string[], map: { [key: string]: number }, name?: string): InputSetCollector {
    return new InputSetCollector(declarations, map, name);
  }
}
