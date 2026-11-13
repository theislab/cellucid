// What the planted defects of this folder import: one function, one constant, one class.
export function two(a, b) {
  return a + b;
}

export const K = 1;

export class C {
  /** @private */
  hidden() {}

  shown() {
    this.hidden();
  }
}
