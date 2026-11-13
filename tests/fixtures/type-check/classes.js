// A `@private` member reached from outside, and `this` before `super()`.
import { C } from './exports.js';

export const reached = new C().hidden(); // expect TS2341

export class Early extends C {
  constructor() {
    this.early = 1; // expect TS17009
    super();
  }
}
