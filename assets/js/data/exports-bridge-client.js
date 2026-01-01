const MESSAGE_NS = 'cellucid-datasets-bridge';

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function safeWindowOrigin() {
  try {
    return window?.location?.origin || null;
  } catch {
    return null;
  }
}

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function withTimeout(promise, timeoutMs, onTimeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(onTimeoutMessage || `Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class ExportsBridgeClient {
  /**
   * @param {object} options
   * @param {string} options.bridgeUrl - Absolute URL to `bridge.html` on the datasets host.
   * @param {number} [options.readyTimeoutMs=15000]
   * @param {number} [options.requestTimeoutMs=30000]
   */
  constructor(options) {
    const { bridgeUrl, readyTimeoutMs = 15000, requestTimeoutMs = 30000 } = options || {};
    if (typeof bridgeUrl !== 'string' || !bridgeUrl) {
      throw new Error('ExportsBridgeClient: missing bridgeUrl');
    }

    const origin = safeOrigin(bridgeUrl);
    if (!origin) {
      throw new Error(`ExportsBridgeClient: invalid bridgeUrl: ${bridgeUrl}`);
    }

    this.bridgeUrl = bridgeUrl;
    this.bridgeOrigin = origin;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;

    this._iframe = null;
    this._readyPromise = null;
    this._seq = 0;
    this._pending = new Map();
    this._lastReady = null;

    this._onMessage = this._onMessage.bind(this);
  }

  _ensureIframe() {
    if (this._iframe) return this._iframe;
    if (typeof document === 'undefined') {
      throw new Error('ExportsBridgeClient: document is unavailable (not in a browser?)');
    }

    const iframe = document.createElement('iframe');
    iframe.src = this.bridgeUrl;
    iframe.style.display = 'none';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('aria-hidden', 'true');

    // Defense-in-depth: keep the bridge constrained (but allow same-origin fetch inside the iframe).
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

    const mount = document.body || document.documentElement;
    mount.appendChild(iframe);
    this._iframe = iframe;
    return iframe;
  }

  _onMessage(event) {
    if (!event || event.origin !== this.bridgeOrigin) return;
    if (!this._iframe || event.source !== this._iframe.contentWindow) return;

    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.ns !== MESSAGE_NS) return;

    if (msg.kind === 'ready') {
      this._lastReady = msg;
      return;
    }

    if (msg.kind === 'response' && typeof msg.id === 'string') {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      try {
        pending.resolve(msg);
      } catch (err) {
        pending.reject(err);
      }
    }
  }

  async ensureReady() {
    if (this._readyPromise) return this._readyPromise;

    if (typeof window === 'undefined') {
      throw new Error('ExportsBridgeClient: window is unavailable (not in a browser?)');
    }

    window.addEventListener('message', this._onMessage);
    this._ensureIframe();

    const startedAt = nowMs();

    // The bridge posts `{kind:'ready'}` immediately. We just wait for it to arrive.
    const waitForReady = async () => {
      while (nowMs() - startedAt < this.readyTimeoutMs) {
        if (this._lastReady?.kind === 'ready') return this._lastReady;
        await new Promise(r => setTimeout(r, 25));
      }
      throw new Error(
        `Datasets bridge did not become ready (${this.bridgeUrl}). ` +
        `Make sure GitHub Pages serves \`bridge.html\` and \`bridge.js\` at that URL.`
      );
    };

    this._readyPromise = withTimeout(waitForReady(), this.readyTimeoutMs + 250, 'Datasets bridge ready timeout');
    return this._readyPromise;
  }

  /**
   * @param {string} url - Absolute URL to fetch (must be under the datasets host exports root).
   * @param {RequestInit} [init]
   * @param {'arrayBuffer'|'json'|'text'} [responseType]
   */
  async fetch(url, init, responseType = 'arrayBuffer') {
    await this.ensureReady();

    if (!this._iframe?.contentWindow) {
      throw new Error('Datasets bridge iframe is not available');
    }

    const id = `${Date.now()}-${++this._seq}`;
    const request = {
      ns: MESSAGE_NS,
      kind: 'fetch',
      id,
      url,
      responseType,
      init: init || {},
      appOrigin: safeWindowOrigin(),
    };

    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Datasets bridge request timed out: ${url}`));
      }, this.requestTimeoutMs);
      this._pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });

    // Send request to bridge origin only.
    this._iframe.contentWindow.postMessage(request, this.bridgeOrigin);
    return responsePromise;
  }
}

