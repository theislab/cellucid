// Unreachable code and an unused label.
export function stopped() {
  return 1;
  stopped(); // expect TS7027
}

export function labelled() {
  unused: // expect TS7028
  for (;;) break;
}
