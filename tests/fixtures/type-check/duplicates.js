// The same name declared twice.
const twice = 1; // expect TS2451
const twice = 2; // expect TS2451

export const record = {
  key: 1,
  key: 2, // expect TS1117
};

export class Doubled {
  method() {} // expect TS2393
  method() {} // expect TS2393
}

export const kept = twice;
