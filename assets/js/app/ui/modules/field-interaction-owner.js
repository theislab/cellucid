/**
 * @fileoverview Latest-intent ownership for observation/gene UI mutations.
 *
 * A field choice may wait on network or direct-AnnData IO. This owner makes
 * that wait abortable, prevents an older choice from publishing after a newer
 * choice, and exposes exact settlement boundaries to dataset replacement,
 * session capture, and destruction.
 *
 * @module ui/modules/field-interaction-owner
 */

export const FIELD_INTERACTION_SUPERSEDED_CODE =
  'CELLUCID_FIELD_INTERACTION_SUPERSEDED';

const tokenControllers = new WeakMap();
const intentOwners = new WeakMap();

export function createFieldInteractionSupersededError() {
  const error = new Error(
    'Field interaction was superseded by a newer intent.'
  );
  error.name = 'AbortError';
  error.code = FIELD_INTERACTION_SUPERSEDED_CODE;
  return error;
}

export function isFieldInteractionSupersededError(error) {
  return error?.code === FIELD_INTERACTION_SUPERSEDED_CODE;
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
      && !isFieldInteractionSupersededError(outcome.reason)
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
    this._suspensionCount = 0;
    this._destroyed = false;
    this._destroyPromise = null;
  }

  _abortToken(token) {
    if (token === null) return;
    const controller = tokenControllers.get(token);
    if (controller === undefined || controller.signal.aborted) return;
    controller.abort(createFieldInteractionSupersededError());
  }

  beginIntent() {
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    if (this._suspensionCount > 0) {
      throw createFieldInteractionSupersededError();
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
    throw createFieldInteractionSupersededError();
  }

  run(operation) {
    requireOperation(operation);
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    if (this._suspensionCount > 0) {
      throw createFieldInteractionSupersededError();
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
          !isFieldInteractionSupersededError(reason)
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
    if (isFieldInteractionSupersededError(reason)) {
      throw reason;
    }
    throw createFieldInteractionSupersededError();
  }

  isSuspended() {
    return this._destroyed === false && this._suspensionCount > 0;
  }

  acquireSuspension() {
    if (this._destroyed) {
      throw new Error('Field interaction owner has been destroyed.');
    }
    // Freeze admission while preserving work that already owns the current
    // token or intent. The caller drains that work before reading shared state.
    this._suspensionCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._suspensionCount = Math.max(0, this._suspensionCount - 1);
    };
  }

  acquireRetiringSuspension() {
    const release = this.acquireSuspension();
    this.invalidate();
    return release;
  }

  invalidate() {
    if (this._destroyed) return;
    this._abortToken(this._currentToken);
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
