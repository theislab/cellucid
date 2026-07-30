import assert from 'node:assert/strict';
import test from 'node:test';

let moduleGeneration = 0;

class FakeAttributeElement {
  constructor(name, attributes = {}) {
    this.name = name;
    this.calls = [];
    this.parentNode = null;
    this._attributes = new Map(
      Object.entries(attributes).map(([key, value]) => [key, String(value)])
    );
    this._failures = [];
  }

  get nextSibling() {
    const siblings = this.parentNode?.children;
    if (!Array.isArray(siblings)) return null;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  get previousSibling() {
    const siblings = this.parentNode?.children;
    if (!Array.isArray(siblings)) return null;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  failNext(method, attribute, error) {
    this._failures.push({ method, attribute, error });
  }

  _throwOwnedFailure(method, attribute) {
    const index = this._failures.findIndex(
      failure => (
        failure.method === method &&
        failure.attribute === attribute
      )
    );
    if (index < 0) return;
    const [{ error }] = this._failures.splice(index, 1);
    throw error;
  }

  getAttribute(name) {
    this._throwOwnedFailure('getAttribute', name);
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  hasAttribute(name) {
    this._throwOwnedFailure('hasAttribute', name);
    return this._attributes.has(name);
  }

  removeAttribute(name) {
    this.calls.push({ method: 'removeAttribute', name });
    this._throwOwnedFailure('removeAttribute', name);
    this._attributes.delete(name);
  }

  setAttribute(name, value) {
    this.calls.push({ method: 'setAttribute', name, value: String(value) });
    this._throwOwnedFailure('setAttribute', name);
    this._attributes.set(name, String(value));
  }
}

class FakeContainerElement extends FakeAttributeElement {
  constructor(name, attributes = {}) {
    super(name, attributes);
    this.children = [];
    this.documentHost = null;
    this._notifyMutation = null;
  }

  _detach(element) {
    const parent = element.parentNode;
    if (parent === null) return;
    if (!Array.isArray(parent.children)) {
      throw new Error('Fake parent must expose an exact children array');
    }
    const index = parent.children.indexOf(element);
    if (index < 0) {
      throw new Error(`Cannot detach missing fake child ${element.name}`);
    }
    parent.children.splice(index, 1);
    element.parentNode = null;
  }

  appendChild(element) {
    this._detach(element);
    this.children.push(element);
    element.parentNode = this;
    this._notifyMutation?.({
      addedNodes: [element],
      removedNodes: []
    });
    return element;
  }

  insertBefore(element, nextSibling) {
    if (nextSibling.parentNode !== this) {
      throw new Error('Fake insertion sibling must belong to its parent');
    }
    this._detach(element);
    const index = this.children.indexOf(nextSibling);
    if (index < 0) {
      throw new Error('Fake insertion sibling must remain present');
    }
    this.children.splice(index, 0, element);
    element.parentNode = this;
    this._notifyMutation?.({
      addedNodes: [element],
      removedNodes: []
    });
    return element;
  }

  removeChild(element) {
    if (element.parentNode !== this) {
      throw new Error(`Cannot remove missing fake child ${element?.name ?? ''}`);
    }
    this._detach(element);
    this._notifyMutation?.({
      addedNodes: [],
      removedNodes: [element]
    });
    return element;
  }

  querySelector(selector) {
    if (selector !== '[role="document"]') return null;
    return this.documentHost;
  }
}

function attributeSnapshot(element) {
  return Object.fromEntries(element._attributes);
}

function installFakeDocument(t, initialChildren = []) {
  const previousDocument = globalThis.document;
  const previousMutationObserver = globalThis.MutationObserver;
  const previousReportError = globalThis.reportError;
  const reportedErrors = [];

  class FakeMutationObserver {
    static instances = new Set();

    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      this.target = null;
      this.disconnectCalls = 0;
      FakeMutationObserver.instances.add(this);
    }

    observe(target, options) {
      assert.deepEqual(options, { childList: true });
      this.target = target;
      this.connected = true;
    }

    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
      this.target = null;
    }

    static notify(target, record) {
      for (const observer of [...FakeMutationObserver.instances]) {
        if (!observer.connected || observer.target !== target) continue;
        observer.callback([record], observer);
      }
    }
  }

  const body = new FakeContainerElement('body');
  for (const element of initialChildren) {
    body.children.push(element);
    element.parentNode = body;
  }
  body._notifyMutation = record => {
    FakeMutationObserver.notify(body, record);
  };

  globalThis.document = { body };
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.reportError = error => {
    reportedErrors.push(error);
  };

  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousMutationObserver === undefined) {
      delete globalThis.MutationObserver;
    } else {
      globalThis.MutationObserver = previousMutationObserver;
    }
    if (previousReportError === undefined) delete globalThis.reportError;
    else globalThis.reportError = previousReportError;
  });

  return {
    body,
    FakeMutationObserver,
    reportedErrors
  };
}

async function importFreshOwner() {
  const moduleUrl = new URL(
    '../assets/js/app/ui/components/modal-background-owner.js',
    import.meta.url
  );
  moduleGeneration += 1;
  moduleUrl.searchParams.set('test-generation', String(moduleGeneration));
  return import(moduleUrl.href);
}

test('nested layers keep only the exact top interactive and unwind in order', async t => {
  const background = new FakeAttributeElement('background');
  const lower = new FakeAttributeElement('lower');
  const upper = new FakeAttributeElement('upper');
  const { body, FakeMutationObserver } = installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  const releaseLower = claimModalDocumentLayer(lower);
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });
  body.appendChild(lower);
  assert.deepEqual(attributeSnapshot(lower), {});

  const releaseUpper = claimModalDocumentLayer(upper);
  assert.deepEqual(attributeSnapshot(lower), {
    'aria-hidden': 'true',
    inert: ''
  });
  body.appendChild(upper);
  assert.deepEqual(attributeSnapshot(upper), {});

  body.removeChild(upper);
  assert.equal(releaseUpper(), true);
  assert.deepEqual(attributeSnapshot(lower), {});
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.equal(releaseUpper(), false);

  body.removeChild(lower);
  assert.equal(releaseLower(), true);
  assert.deepEqual(attributeSnapshot(background), {});
  assert.deepEqual(attributeSnapshot(lower), {});
  assert.deepEqual(attributeSnapshot(upper), {});
  assert.equal(
    [...FakeMutationObserver.instances].filter(observer => observer.connected)
      .length,
    0
  );
});

test('dynamic body siblings are suspended and restore exact prior attributes', async t => {
  const background = new FakeAttributeElement('background', {
    'aria-hidden': 'false',
    inert: 'background-owned'
  });
  const overlay = new FakeAttributeElement('overlay');
  const dynamicOwned = new FakeAttributeElement('dynamic-owned', {
    'aria-hidden': 'mixed',
    inert: 'dynamic-owned'
  });
  const dynamicPlain = new FakeAttributeElement('dynamic-plain');
  const { body, FakeMutationObserver, reportedErrors } = installFakeDocument(
    t,
    [background]
  );
  const { claimModalDocumentLayer } = await importFreshOwner();

  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);
  body.appendChild(dynamicOwned);
  body.appendChild(dynamicPlain);

  assert.deepEqual(attributeSnapshot(dynamicOwned), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.deepEqual(attributeSnapshot(dynamicPlain), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.deepEqual(reportedErrors, []);

  body.removeChild(overlay);
  assert.equal(release(), true);
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'false',
    inert: 'background-owned'
  });
  assert.deepEqual(attributeSnapshot(dynamicOwned), {
    'aria-hidden': 'mixed',
    inert: 'dynamic-owned'
  });
  assert.deepEqual(attributeSnapshot(dynamicPlain), {});
  assert.equal(
    [...FakeMutationObserver.instances].filter(observer => observer.connected)
      .length,
    0
  );
});

test('a transient dynamic reconciliation failure is reported and retried', async t => {
  const background = new FakeAttributeElement('background');
  const overlay = new FakeAttributeElement('overlay');
  const trouble = new FakeAttributeElement('trouble');
  const later = new FakeAttributeElement('later');
  const failure = new Error('transient dynamic suspension failure');
  const { body, FakeMutationObserver, reportedErrors } =
    installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);
  trouble.failNext('setAttribute', 'inert', failure);
  body.appendChild(trouble);

  assert.deepEqual(reportedErrors, [failure]);
  assert.equal(
    [...FakeMutationObserver.instances].filter(observer => observer.connected)
      .length,
    1
  );

  body.appendChild(later);
  assert.deepEqual(attributeSnapshot(trouble), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.deepEqual(attributeSnapshot(later), {
    'aria-hidden': 'true',
    inert: ''
  });

  body.removeChild(overlay);
  assert.equal(release(), true);
  assert.deepEqual(attributeSnapshot(background), {});
  assert.deepEqual(attributeSnapshot(trouble), {});
  assert.deepEqual(attributeSnapshot(later), {});
});

test('a top layer clears pre-existing suspension then restores it exactly', async t => {
  const background = new FakeAttributeElement('background', {
    'aria-hidden': 'background-original',
    inert: 'background-original'
  });
  const overlay = new FakeAttributeElement('overlay', {
    'aria-hidden': 'overlay-original',
    inert: 'overlay-original'
  });
  const { body } = installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);

  assert.deepEqual(attributeSnapshot(overlay), {});
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });

  body.removeChild(overlay);
  assert.equal(release(), true);
  assert.deepEqual(attributeSnapshot(overlay), {
    'aria-hidden': 'overlay-original',
    inert: 'overlay-original'
  });
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'background-original',
    inert: 'background-original'
  });
});

test('release callbacks are identity-bound, idempotent, and safe out of order', async t => {
  const background = new FakeAttributeElement('background');
  const lower = new FakeAttributeElement('lower');
  const upper = new FakeAttributeElement('upper');
  const { body } = installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  const releaseLower = claimModalDocumentLayer(lower);
  assert.throws(
    () => claimModalDocumentLayer(lower),
    /Modal document layer is already registered/
  );
  body.appendChild(lower);
  const releaseUpper = claimModalDocumentLayer(upper);
  body.appendChild(upper);

  assert.equal(releaseLower(), true);
  assert.equal(releaseLower(), false);
  assert.deepEqual(attributeSnapshot(upper), {});
  assert.deepEqual(attributeSnapshot(lower), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });

  body.removeChild(upper);
  assert.equal(releaseUpper(), true);
  assert.equal(releaseUpper(), false);
  assert.deepEqual(attributeSnapshot(background), {});
  assert.deepEqual(attributeSnapshot(lower), {});
});

test('a first-layer claim failure rolls back attributes and observer ownership', async t => {
  const background = new FakeAttributeElement('background');
  const overlay = new FakeAttributeElement('overlay');
  const failure = new Error('one-shot inert suspension failure');
  background.failNext('setAttribute', 'inert', failure);
  const { body, FakeMutationObserver } = installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  assert.throws(
    () => claimModalDocumentLayer(overlay),
    error => error === failure
  );
  assert.deepEqual(attributeSnapshot(background), {});
  assert.deepEqual(attributeSnapshot(overlay), {});
  assert.equal(
    [...FakeMutationObserver.instances].filter(observer => observer.connected)
      .length,
    0
  );

  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);
  body.removeChild(overlay);
  assert.equal(release(), true);
  assert.deepEqual(attributeSnapshot(background), {});
});

test('a nested claim failure restores the previous top layer transactionally', async t => {
  const background = new FakeAttributeElement('background');
  const trouble = new FakeAttributeElement('trouble');
  const lower = new FakeAttributeElement('lower');
  const rejectedUpper = new FakeAttributeElement('rejected-upper');
  const failure = new Error('nested suspension failure');
  const { body, FakeMutationObserver } = installFakeDocument(
    t,
    [background, trouble]
  );
  const { claimModalDocumentLayer } = await importFreshOwner();

  const releaseLower = claimModalDocumentLayer(lower);
  body.appendChild(lower);
  trouble.failNext('setAttribute', 'inert', failure);

  assert.throws(
    () => claimModalDocumentLayer(rejectedUpper),
    error => error === failure
  );
  assert.deepEqual(attributeSnapshot(lower), {});
  assert.deepEqual(attributeSnapshot(rejectedUpper), {});
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.deepEqual(attributeSnapshot(trouble), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.equal(
    [...FakeMutationObserver.instances].filter(observer => observer.connected)
      .length,
    1
  );

  body.removeChild(lower);
  assert.equal(releaseLower(), true);
  assert.deepEqual(attributeSnapshot(background), {});
  assert.deepEqual(attributeSnapshot(trouble), {});
});

test('a transient final restoration failure is retained and release retries once', async t => {
  const background = new FakeAttributeElement('background');
  const overlay = new FakeAttributeElement('overlay', {
    'aria-hidden': 'overlay-original',
    inert: 'overlay-original'
  });
  const failure = new Error('transient final restoration failure');
  const { body, FakeMutationObserver } = installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);
  assert.deepEqual(attributeSnapshot(overlay), {});
  body.removeChild(overlay);
  background.failNext('removeAttribute', 'aria-hidden', failure);

  assert.throws(() => release(), error => error === failure);
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });
  assert.deepEqual(attributeSnapshot(overlay), {
    'aria-hidden': 'overlay-original',
    inert: 'overlay-original'
  });
  const overlayRestoreCallsAfterFailure = overlay.calls.filter(
    call => (
      call.method === 'setAttribute' &&
      (call.name === 'aria-hidden' || call.name === 'inert')
    )
  ).length;
  assert.equal(overlayRestoreCallsAfterFailure, 2);
  assert.equal(
    [...FakeMutationObserver.instances].filter(observer => observer.connected)
      .length,
    0
  );

  assert.equal(release(), true);
  assert.deepEqual(attributeSnapshot(background), {});
  assert.equal(
    overlay.calls.filter(
      call => (
        call.method === 'setAttribute' &&
        (call.name === 'aria-hidden' || call.name === 'inert')
      )
    ).length,
    overlayRestoreCallsAfterFailure
  );
  assert.equal(release(), false);
});

test('a transient nested-release failure retries reconciliation without removing twice', async t => {
  const background = new FakeAttributeElement('background');
  const lower = new FakeAttributeElement('lower');
  const upper = new FakeAttributeElement('upper');
  const failure = new Error('transient top activation failure');
  const { body } = installFakeDocument(t, [background]);
  const { claimModalDocumentLayer } = await importFreshOwner();

  const releaseLower = claimModalDocumentLayer(lower);
  body.appendChild(lower);
  const releaseUpper = claimModalDocumentLayer(upper);
  body.appendChild(upper);
  body.removeChild(upper);
  lower.failNext('removeAttribute', 'inert', failure);

  assert.throws(() => releaseUpper(), error => error === failure);
  assert.deepEqual(attributeSnapshot(lower), { inert: '' });
  assert.deepEqual(attributeSnapshot(background), {
    'aria-hidden': 'true',
    inert: ''
  });

  assert.equal(releaseUpper(), true);
  assert.deepEqual(attributeSnapshot(lower), {});
  assert.equal(releaseUpper(), false);

  body.removeChild(lower);
  assert.equal(releaseLower(), true);
  assert.deepEqual(attributeSnapshot(background), {});
});

test('modal auxiliaries follow the exact top document and restore placement and attributes', async t => {
  const before = new FakeAttributeElement('before');
  const auxiliary = new FakeAttributeElement('auxiliary', {
    'aria-hidden': 'auxiliary-owned',
    inert: 'auxiliary-owned'
  });
  const after = new FakeAttributeElement('after');
  const lower = new FakeContainerElement('lower');
  const lowerDocument = new FakeContainerElement('lower-document');
  lower.documentHost = lowerDocument;
  const upper = new FakeContainerElement('upper');
  const upperDocument = new FakeContainerElement('upper-document');
  upper.documentHost = upperDocument;
  const { body } = installFakeDocument(
    t,
    [before, after, auxiliary]
  );
  const {
    claimModalDocumentLayer,
    registerModalDocumentAuxiliary
  } = await importFreshOwner();

  const unregister = registerModalDocumentAuxiliary(auxiliary);
  const releaseLower = claimModalDocumentLayer(lower);
  assert.equal(auxiliary.parentNode, lowerDocument);
  assert.deepEqual(attributeSnapshot(auxiliary), {});
  body.appendChild(lower);
  const dynamic = new FakeAttributeElement('dynamic');
  body.appendChild(dynamic);

  const releaseUpper = claimModalDocumentLayer(upper);
  assert.equal(auxiliary.parentNode, upperDocument);
  assert.deepEqual(attributeSnapshot(auxiliary), {});
  body.appendChild(upper);

  body.removeChild(upper);
  assert.equal(releaseUpper(), true);
  assert.equal(auxiliary.parentNode, lowerDocument);
  assert.deepEqual(attributeSnapshot(auxiliary), {});

  body.removeChild(lower);
  assert.equal(releaseLower(), true);
  assert.deepEqual(body.children, [before, after, auxiliary, dynamic]);
  assert.equal(auxiliary.parentNode, body);
  assert.deepEqual(attributeSnapshot(auxiliary), {
    'aria-hidden': 'auxiliary-owned',
    inert: 'auxiliary-owned'
  });
  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
});

test('an auxiliary registered during an active modal is activated and restored exactly', async t => {
  const background = new FakeAttributeElement('background');
  const auxiliary = new FakeAttributeElement('auxiliary', {
    'aria-hidden': 'false',
    inert: 'application-owned'
  });
  const overlay = new FakeContainerElement('overlay');
  const documentHost = new FakeContainerElement('document-host');
  overlay.documentHost = documentHost;
  const { body } = installFakeDocument(t, [background]);
  const {
    claimModalDocumentLayer,
    registerModalDocumentAuxiliary
  } = await importFreshOwner();

  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);
  body.appendChild(auxiliary);
  assert.deepEqual(attributeSnapshot(auxiliary), {
    'aria-hidden': 'true',
    inert: ''
  });

  const unregister = registerModalDocumentAuxiliary(auxiliary);
  assert.equal(auxiliary.parentNode, documentHost);
  assert.deepEqual(attributeSnapshot(auxiliary), {});

  body.removeChild(overlay);
  assert.equal(release(), true);
  assert.equal(auxiliary.parentNode, body);
  assert.deepEqual(attributeSnapshot(auxiliary), {
    'aria-hidden': 'false',
    inert: 'application-owned'
  });
  assert.equal(unregister(), true);
});

test('auxiliary release remains retryable when active-layer reconciliation fails', async t => {
  const background = new FakeAttributeElement('background');
  const auxiliary = new FakeAttributeElement('auxiliary');
  const overlay = new FakeContainerElement('overlay');
  const documentHost = new FakeContainerElement('document-host');
  overlay.documentHost = documentHost;
  const observerFailure = new Error('observer reconciliation failure');
  const releaseFailure = new Error('release reconciliation failure');
  const { body, reportedErrors } = installFakeDocument(
    t,
    [background, auxiliary]
  );
  const {
    claimModalDocumentLayer,
    registerModalDocumentAuxiliary
  } = await importFreshOwner();

  const unregister = registerModalDocumentAuxiliary(auxiliary);
  const release = claimModalDocumentLayer(overlay);
  body.appendChild(overlay);
  assert.equal(auxiliary.parentNode, documentHost);

  background.failNext('setAttribute', 'aria-hidden', observerFailure);
  background.failNext('setAttribute', 'aria-hidden', releaseFailure);
  assert.throws(() => unregister(), error => error === releaseFailure);
  assert.deepEqual(reportedErrors, [observerFailure]);
  assert.equal(auxiliary.parentNode, body);
  assert.throws(
    () => registerModalDocumentAuxiliary(auxiliary),
    /already registered/
  );

  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
  body.removeChild(overlay);
  assert.equal(release(), true);
  assert.deepEqual(attributeSnapshot(background), {});
  assert.deepEqual(attributeSnapshot(auxiliary), {});
});
