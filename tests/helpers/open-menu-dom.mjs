/**
 * The Session panel's "Open…" button and its File… / Folder… menu, as
 * plain objects for the dataset connection contracts: what
 * `initDatasetConnections` reads from `dom` (`userDataOpenBtn`,
 * `userDataOpenMenu`, `userDataFileItem`, `userDataFolderItem`,
 * `userDataFileInput`, `userDataFolderInput`). `activate()` on an item clicks
 * it, which opens that item's file input.
 */
function createFakeDocument() {
  return {
    activeElement: null,
    addEventListener() {},
  };
}

function createElement(ownerDocument) {
  const listeners = new Map();
  return {
    disabled: false,
    hidden: true,
    ownerDocument,
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setAttribute() {},
    contains(node) {
      return node === this;
    },
    focus() {
      ownerDocument.activeElement = this;
    },
    activate() {
      return listeners.get('click')?.();
    },
  };
}

function createInput() {
  const listeners = new Map();
  return {
    disabled: false,
    value: '',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    click() {},
  };
}

/**
 * @param {{fileInput?: Object, folderInput?: Object}} [inputs] - The two file
 *   inputs; a plain one stands in for an input the test does not use.
 */
export function createOpenMenuDom({ fileInput = createInput(), folderInput = createInput() } = {}) {
  const ownerDocument = createFakeDocument();
  return {
    userDataOpenBtn: createElement(ownerDocument),
    userDataOpenMenu: createElement(ownerDocument),
    userDataFileItem: createElement(ownerDocument),
    userDataFolderItem: createElement(ownerDocument),
    userDataFileInput: fileInput,
    userDataFolderInput: folderInput,
  };
}
