const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const CONTENT_PATH = path.resolve(__dirname, '..', 'content.js');

function setGlobalValue(key, value) {
  if (value === undefined) {
    try {
      delete global[key];
    } catch (error) {
      Object.defineProperty(global, key, {
        configurable: true,
        writable: true,
        value: undefined
      });
    }
    return;
  }

  Object.defineProperty(global, key, {
    configurable: true,
    writable: true,
    value
  });
}

function createNode(tagName, ownerDocument) {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    ownerDocument,
    id: '',
    className: '',
    textContent: '',
    children: [],
    parentNode: null,
    shadowRoot: null,
    attributes: {},
    listeners: new Map(),
    style: {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) {
        return;
      }
      const siblings = this.parentNode.children;
      const index = siblings.indexOf(this);
      if (index >= 0) {
        siblings.splice(index, 1);
      }
      this.parentNode = null;
    },
    attachShadow() {
      const shadow = createNode('#shadow-root', ownerDocument);
      shadow.host = this;
      shadow.__pochocloMounted = false;
      this.shadowRoot = shadow;
      return shadow;
    },
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
    dispatchEvent(event) {
      const listeners = this.listeners.get(event && event.type) || [];
      listeners.forEach((listener) => listener(event));
    },
    click() {
      this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {} });
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
}

function createDocumentStub() {
  const document = {
    body: null,
    documentElement: null,
    createElement(tagName) {
      return createNode(tagName, document);
    },
    getElementById(id) {
      function search(node) {
        if (!node) {
          return null;
        }
        if (node.id === id) {
          return node;
        }
        for (const child of node.children || []) {
          const match = search(child);
          if (match) {
            return match;
          }
        }
        if (node.shadowRoot) {
          const match = search(node.shadowRoot);
          if (match) {
            return match;
          }
        }
        return null;
      }

      return search(document.body) || search(document.documentElement);
    }
  };

  document.documentElement = createNode('html', document);
  document.body = createNode('body', document);
  document.documentElement.appendChild(document.body);
  return document;
}

function createRuntimeStub() {
  const listeners = [];
  const sentMessages = [];

  return {
    __listeners: listeners,
    __sentMessages: sentMessages,
    __emit(message) {
      listeners.forEach((listener) => listener(message, {}, () => {}));
    },
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      }
    },
    sendMessage(message, callback) {
      sentMessages.push(message);
      const response = message.action === 'getRecordingIndicatorState'
        ? { ok: true, state: null }
        : { ok: true };

      if (typeof callback === 'function') {
        callback(response);
        return undefined;
      }

      return Promise.resolve(response);
    },
    lastError: null
  };
}

function loadContentModule() {
  delete require.cache[require.resolve(CONTENT_PATH)];
  return require(CONTENT_PATH);
}

test('recording indicator mounts in shadow root, updates elapsed time, and stops on click', async () => {
  const content = loadContentModule();
  const document = createDocumentStub();
  const runtime = createRuntimeStub();
  let nowValue = 10_000;
  const intervalCallbacks = [];

  const controller = content.createRecordingIndicatorController({
    document,
    runtime,
    now: () => nowValue,
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    clearInterval() {}
  });

  controller.applyState({
    status: 'recording',
    indicatorVisible: true,
    elapsedMs: 65_000,
    tabId: 12,
    sessionId: 'session-12'
  });

  const host = controller.getHost();
  assert.ok(host);
  assert.equal(host.id, 'pochoclo-recording-indicator');
  assert.ok(controller.getShadowRoot());

  const button = controller.getShadowRoot().children.find((child) => child.className === 'indicator');
  assert.ok(button);
  assert.equal(controller.getElapsedText(), '01:05');

  nowValue += 4_000;
  intervalCallbacks[0]();
  assert.equal(controller.getElapsedText(), '01:09');

  button.click();
  assert.deepEqual(runtime.__sentMessages.at(-1), { action: 'stopCapture' });
});

test('recording indicator removes stale UI when state hides indicator and syncs initial state from background', async () => {
  const content = loadContentModule();
  const document = createDocumentStub();
  const listeners = [];
  const runtime = {
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      }
    },
    sendMessage(message, callback) {
      const response = message.action === 'getRecordingIndicatorState'
        ? {
          ok: true,
          state: {
            status: 'recording',
            indicatorVisible: true,
            elapsedMs: 2_000,
            tabId: 8,
            sessionId: 'session-8'
          }
        }
        : { ok: true };

      if (typeof callback === 'function') {
        callback(response);
        return undefined;
      }

      return Promise.resolve(response);
    },
    lastError: null
  };

  const controller = content.createRecordingIndicatorController({
    document,
    runtime,
    now: () => 5_000,
    setInterval() {
      return 1;
    },
    clearInterval() {}
  });

  await controller.init();
  await controller.syncState();
  assert.ok(controller.getHost());
  assert.equal(controller.getElapsedText(), '00:02');

  listeners[0]({
    type: 'recording-state-changed',
    state: {
      status: 'idle',
      indicatorVisible: false,
      elapsedMs: 0,
      tabId: 8,
      sessionId: null
    }
  });

  assert.equal(controller.getHost(), null);
  assert.equal(document.getElementById('pochoclo-recording-indicator'), null);
});

test('content module auto-inits only when document and chrome runtime exist', () => {
  const originals = {
    document: global.document,
    chrome: global.chrome
  };

  try {
    setGlobalValue('document', createDocumentStub());
    setGlobalValue('chrome', { runtime: createRuntimeStub() });
    const content = loadContentModule();
    assert.equal(typeof content.initRecordingIndicator, 'function');
  } finally {
    delete require.cache[require.resolve(CONTENT_PATH)];
    Object.entries(originals).forEach(([key, value]) => setGlobalValue(key, value));
  }
});

test('content script browser auto-init uses globalThis fallbacks without injected deps', async () => {
  const document = createDocumentStub();
  const listeners = [];
  const sentMessages = [];

  const sandbox = {
    console,
    document,
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          }
        },
        sendMessage(message, callback) {
          sentMessages.push(message);
          const response = message.action === 'getRecordingIndicatorState'
            ? {
              ok: true,
              state: {
                status: 'recording',
                indicatorVisible: true,
                elapsedMs: 4_000,
                tabId: 99,
                sessionId: 'session-global'
              }
            }
            : { ok: true };

          if (typeof callback === 'function') {
            callback(response);
            return undefined;
          }

          return Promise.resolve(response);
        }
      }
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    Date,
    Promise
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(fs.readFileSync(CONTENT_PATH, 'utf8'), sandbox, { filename: CONTENT_PATH });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof sandbox.PochocloRecordingIndicator.initRecordingIndicator, 'function');
  assert.equal(sentMessages[0].action, 'getRecordingIndicatorState');
  assert.ok(document.getElementById('pochoclo-recording-indicator'));
  assert.equal(listeners.length, 1);
});
