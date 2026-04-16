// Minimal FIFO queue. Used by the BFS dependency walker and the
// transitive dependency analyzer. Kept as a dedicated class so call
// sites read as "BFS frontier" rather than "array with mutation
// discipline".
export class Queue<T = any> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  get length(): number {
    return this.items.length;
  }
}
