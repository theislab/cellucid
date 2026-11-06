/**
 * Session files read whole and written again in the spec's own process, with
 * the app's own modules, so a spec can hand-edit one (a value, a step) and
 * still give the page a file whose framing and digests are valid.
 */
import {
  readHistoryFile, sessionHeaderOf, writeHistoryFile,
} from '../../../assets/js/app/session/history-file.js';

/** Every tracker, step and value of a session file: `{manifest, history, values}`. */
export function readWholeSession(bytes) {
  return readHistoryFile(new Blob([bytes]));
}

/** A session file of `readWholeSession`'s parts, as bytes: its stamps, scope and page chrome as they were. */
export async function writeWholeSession({ manifest, history, values }) {
  const blob = await writeHistoryFile({
    header: sessionHeaderOf(manifest), app: manifest.app, actions: manifest.actions, scope: manifest.scope,
    chrome: manifest.chrome, history, valueOf: hash => values.get(hash),
  });
  return Buffer.from(await blob.arrayBuffer());
}
