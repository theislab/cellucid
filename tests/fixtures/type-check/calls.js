// A call of what is not callable, a `new` of what is not constructable, a class called without `new`.
import { C, K } from './exports.js';

export const called = K(); // expect TS2349
export const made = new K(); // expect TS2351
export const classCalled = C(); // expect TS2348
