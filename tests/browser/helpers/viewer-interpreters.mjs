/**
 * The interpreters of the specs that run the viewer against the real Python
 * and R packages (`CELLUCID_PYTHON`, `CELLUCID_RSCRIPT`, and `CELLUCID_R`, the
 * `R` that runs IRkernel).
 *
 * A machine that names none skips those specs. The CI job that exists to run
 * them sets `CELLUCID_REQUIRE_VIEWERS=1`, and there an interpreter that is
 * not named is a failure: a spec that skips where it is the gate checks
 * nothing.
 */

/** The interpreter `variable` names, or null where it names none and none is required. */
export function viewerInterpreter(variable, env = process.env) {
  const interpreter = env[variable] ?? null;
  if (interpreter === null && env.CELLUCID_REQUIRE_VIEWERS === '1') {
    throw new Error(`${variable} names no interpreter, and CELLUCID_REQUIRE_VIEWERS=1 asks for one`);
  }
  return interpreter;
}
