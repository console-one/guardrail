import { Selectable, Selector } from './selectable';

// A computed vertex. Its value is derived from its child selectables
// via the selectorApplicator function. The execution layer wires each
// Translation to an InputSetCollector so the applicator fires exactly
// once — when every dependency has resolved, regardless of order.
export class Translation extends Selector {
  selectables: Selectable[];

  constructor(methodName: string, method: any, ...selectables: Selectable[]) {
    super(methodName, 'translation', method, undefined);
    this.selectables = selectables;
  }
}
