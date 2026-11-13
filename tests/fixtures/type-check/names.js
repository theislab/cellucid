// A name that is not defined, a shorthand of no variable, a use before the declaration.
export const first = missingName; // expect TS2304
export const second = { undeclared }; // expect TS18004
export const third = later; // expect TS2448
const later = 1;
