/**
 * @fileoverview Latest-intent ownership for observation/gene UI mutations.
 *
 * A field choice may wait on network or direct-AnnData IO. This owner makes
 * that wait abortable, prevents an older choice from publishing after a newer
 * choice, and exposes exact settlement boundaries to dataset replacement,
 * session capture, and destruction.
 *
 * A field choice that ends without showing its field, other than for a newer
 * choice or a dataset replaced, is said, never dropped in silence: the owner
 * records why it refused one (`suspensionReason`, a session being saved or
 * restored) or retired one (`retirementOf`), and `describeUnshownField`
 * words it.
 *
 * @module ui/modules/field-interaction-owner
 */

import { cancelled, cancellationKind, isCancellation } from '../../../utils/abort.js';

const tokenControllers = new WeakMap();
const intentOwners = new WeakMap();
/** Why a token was retired by something other than a newer choice. */
const tokenRetirements = new WeakMap();

function requireReason(reason, label) {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError(`${label} must name why, as a non-empty string.`);
  }
  return reason;
}

/**
 * What to say when the field `name` was chosen and is not shown.
 *
 * @param {string} name - The field or gene chosen
 * @param {string} reason - Why, as a clause (`a session is being restored`)
 * @returns {string}
 */
export function describeUnshownField(name, reason) {
  requireReason(reason, 'An unshown field');
  return `${name} is not shown: ${reason}. Choose it again when that has ended.`;
}

/**
 * Why a field choice that ended in a cancellation is not shown, as a clause
 * for `describeUnshownField`, or null when there is nothing to say: a newer
 * choice took its place, the person stopped it (Cancel), or the dataset it
 * was made in was replaced (the new one says so itself).
 *
 * @param {FieldInteractionOwner} owner
 * @param {object} token - The choice's token (`run`)
 * @param {unknown} error - The cancellation it ended with
 * @param {string|null} changed - What changed under it, as a clause, when
 *   its dataset is still shown; null when that dataset was replaced
 * @returns {string|null}
 */
export function unshownChoiceReason(owner, token, error, changed) {
  if (!isCancellation(error)) throw new TypeError('Only a cancelled field choice is unshown.');
  if (!owner.isCurrent(token)) return owner.retirementOf(token);
  if (cancellationKind(error) === 'user' || changed === null) return null;
  return requireReason(changed, 'A field choice change');
}

function requireOperation(operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Field interaction operation must be a function.');
  }
  return operation;
}

function requireTask(task) {
  if (
    task === null
    || (typeof task !== 'object' && typeof task !== 'function')
    || typeof task.then !== 'function'
  ) {
    throw new TypeError('Field interaction task must be a Promise.');
  }
  return task;
}

function collectOwnedFailures(outcomes, failures) {
  for (const outcome of outcomes) {
    if (
      outcome.status === 'rejected'
      && !isCancellation(outcome.reason)
      && !failures.includes(outcome.reason)
    ) {
      failures.push(outcome.reason);
    }
  }
}

function throwExactFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

function throwOwnedFailures(outcomes, message) {
  const failures = [];
  collectOwnedFailures(outcomes, failures);
  throwExactFailures(failures, message);
}

class FieldInteractionOwner {
  constructor() {
    this._revision = 0;
    this._currentToken = null;
    this._currentTask = null;
    this._tasks = new Set();
    this._settlers = new Set();
    this._suspensionReasons = [];
    this._destroyed = false;
    this._destroyPromise = null;
  }

  _abortToken(token, reason = null) {
    if (token === null) return;
    const controller = tokenControllers.get(token);
    if (controller === undefined || controller.signal.aborted) return;
    if (reason !== null) tokenRetirements.set(token, reason);
    controller.abort(cancelled('superseded', 'Field interaction was superseded by a newer intent.'));
  }

  beginIntent() {
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    if (this._suspensionReasons.length > 0) {
      throw cancelled('superseded', 'Field interaction was superseded by a newer intent.');
    }
    this._abortToken(this._currentToken);
    const intent = Object.freeze({
      revision: ++this._revision
    });
    intentOwners.set(intent, this);
    this._currentToken = null;
    this._currentTask = null;
    return intent;
  }

  isIntentCurrent(intent) {
    return (
      this._destroyed === false
      && intent !== null
      && intentOwners.get(intent) === this
      && intent.revision === this._revision
    );
  }

  assertIntentCurrent(intent) {
    if (this.isIntentCurrent(intent)) return;
    throw cancelled('superseded', 'Field interaction was superseded by a newer intent.');
  }

  run(operation) {
    requireOperation(operation);
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    if (this._suspensionReasons.length > 0) {
      throw cancelled('superseded', 'Field interaction was superseded by a newer intent.');
    }

    this._abortToken(this._currentToken);
    const controller = new AbortController();
    const token = Object.freeze({
      revision: ++this._revision,
      signal: controller.signal
    });
    tokenControllers.set(token, controller);
    this._currentToken = token;

    let operationResult;
    try {
      operationResult = operation(token);
    } catch (error) {
      operationResult = Promise.reject(error);
    }
    const task = Promise.resolve(operationResult);
    this._currentTask = task;
    this._track(task, true);
    return task;
  }

  track(task) {
    return this._track(task, false);
  }

  _track(task, isCurrentTask) {
    requireTask(task);
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    if (this._tasks.has(task)) {
      if (isCurrentTask) {
        for (const settler of this._settlers) {
          if (settler.kind === 'current') {
            settler.pending.add(task);
          }
        }
      }
      return task;
    }
    this._tasks.add(task);
    for (const settler of this._settlers) {
      if (settler.kind === 'all' || isCurrentTask) {
        settler.pending.add(task);
      }
    }
    const release = (rejected, reason) => {
      this._tasks.delete(task);
      if (this._currentTask === task) {
        this._currentTask = null;
      }
      for (const settler of this._settlers) {
        if (!settler.pending.delete(task) || !rejected) continue;
        if (
          !isCancellation(reason)
          && !settler.failures.includes(reason)
        ) {
          settler.failures.push(reason);
        }
      }
    };
    void task.then(
      () => release(false, null),
      error => release(true, error)
    );
    return task;
  }

  isCurrent(token) {
    return (
      this._destroyed === false
      && token !== null
      && token === this._currentToken
      && tokenControllers.has(token)
      && token.signal.aborted === false
    );
  }

  assertCurrent(token) {
    if (this.isCurrent(token)) return;
    const reason = token?.signal?.reason;
    if (isCancellation(reason)) {
      throw reason;
    }
    throw cancelled('superseded', 'Field interaction was superseded by a newer intent.');
  }

  isSuspended() {
    return this._destroyed === false && this._suspensionReasons.length > 0;
  }

  /**
   * Why a field choice is refused now (the latest suspension held), or null.
   * @returns {string|null}
   */
  suspensionReason() {
    if (!this.isSuspended()) return null;
    return this._suspensionReasons[this._suspensionReasons.length - 1].reason;
  }

  /**
   * @param {string} reason - Why choices are refused meanwhile, as a clause
   *   (`a session is being saved`), said to whoever chooses a field then
   * @returns {() => void} Release
   */
  acquireSuspension(reason) {
    requireReason(reason, 'A field interaction suspension');
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    // Freeze admission while preserving work that already owns the current
    // token or intent. The caller drains that work before reading shared state.
    const hold = { reason };
    this._suspensionReasons.push(hold);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const at = this._suspensionReasons.indexOf(hold);
      if (at >= 0) this._suspensionReasons.splice(at, 1);
    };
  }

  /**
   * Suspend, and retire the choice under way, which is told `reason`
   * (`retirementOf`).
   *
   * @param {string} reason
   * @returns {() => void} Release
   */
  acquireRetiringSuspension(reason) {
    const release = this.acquireSuspension(reason);
    this.invalidate(reason);
    return release;
  }

  /**
   * Why `token` was retired by something other than a newer choice or a
   * dataset replaced (`invalidate(reason)`), or null.
   *
   * @param {object} token
   * @returns {string|null}
   */
  retirementOf(token) {
    return tokenRetirements.get(token) ?? null;
  }

  /**
   * Retire the choice under way. `reason` (a clause) is what it is told
   * (`retirementOf`); none for a dataset replaced, whose new view says it.
   *
   * @param {string|null} [reason]
   */
  invalidate(reason = null) {
    if (reason !== null) requireReason(reason, 'A field interaction retirement');
    if (this._destroyed) return;
    this._abortToken(this._currentToken, reason);
    this._revision += 1;
    this._currentToken = null;
    this._currentTask = null;
  }

  async settleCurrent() {
    return this._settleTasks(
      'current',
      this._currentTask === null ? [] : [this._currentTask],
      'Current field interactions failed while settling.'
    );
  }

  async settleAll() {
    return this._settleTasks(
      'all',
      [...this._tasks],
      'Field interactions failed while settling.'
    );
  }

  async _settleTasks(kind, tasks, failureMessage) {
    const settler = {
      failures: [],
      kind,
      pending: new Set(tasks)
    };
    this._settlers.add(settler);
    try {
      while (true) {
        if (settler.pending.size > 0) {
          await Promise.allSettled([...settler.pending]);
          continue;
        }
        // Keep admission open through one checkpoint so work started by a
        // terminal handler cannot settle and disappear between snapshots.
        await Promise.resolve();
        if (settler.pending.size === 0) {
          break;
        }
      }
    } finally {
      this._settlers.delete(settler);
    }
    throwExactFailures(
      settler.failures,
      failureMessage
    );
  }

  destroy() {
    if (this._destroyPromise !== null) return this._destroyPromise;
    this._destroyed = true;
    this._abortToken(this._currentToken);
    this._revision += 1;
    this._currentToken = null;
    this._currentTask = null;
    const tasks = [...this._tasks];
    this._destroyPromise = Promise.allSettled(tasks).then(outcomes => {
      throwOwnedFailures(
        outcomes,
        'Field interaction destruction failed.'
      );
    });
    void this._destroyPromise.catch(() => {});
    return this._destroyPromise;
  }
}

export function createFieldInteractionOwner() {
  return new FieldInteractionOwner();
}
