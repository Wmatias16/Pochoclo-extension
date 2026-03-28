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
    hidden: false,
    clientWidth: 0,
    clientHeight: 0,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (ownerDocument && typeof ownerDocument.__notifyMutation === 'function') {
        ownerDocument.__notifyMutation({ addedNodes: [child], removedNodes: [], target: this });
      }
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
      if (ownerDocument && typeof ownerDocument.__notifyMutation === 'function') {
        ownerDocument.__notifyMutation({ addedNodes: [], removedNodes: [this], target: this.parentNode });
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
    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      this.listeners.set(type, listeners.filter((entry) => entry !== listener));
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
    },
    getBoundingClientRect() {
      return {
        width: this.clientWidth || 0,
        height: this.clientHeight || 0
      };
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
    },
    __observers: new Set(),
    __notifyMutation(record) {
      document.__observers.forEach((observer) => {
        if (observer.__active) {
          observer.__callback([record]);
        }
      });
    }
  };

  document.documentElement = createNode('html', document);
  document.body = createNode('body', document);
  document.documentElement.appendChild(document.body);
  return document;
}

function createMutationObserverStub(document) {
  return class MutationObserverStub {
    constructor(callback) {
      this.__callback = callback;
      this.__active = false;
    }

    observe() {
      this.__active = true;
      document.__observers.add(this);
    }

    disconnect() {
      this.__active = false;
      document.__observers.delete(this);
    }
  };
}

function createVideoNode(document, options = {}) {
  const video = document.createElement('video');
  video.paused = options.paused ?? true;
  video.ended = options.ended ?? false;
  video.currentTime = options.currentTime ?? 0;
  video.duration = options.duration ?? 0;
  video.clientWidth = options.width ?? 0;
  video.clientHeight = options.height ?? 0;
  video.hidden = options.hidden ?? false;
  if (options.style) {
    Object.assign(video.style, options.style);
  }
  return video;
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
  assert.equal(listeners.length, 2);
});

test('video discovery finds videos in document and open shadow roots', () => {
  const content = loadContentModule();
  const document = createDocumentStub();

  const bodyVideo = createVideoNode(document, { paused: true, width: 320, height: 180 });
  document.body.appendChild(bodyVideo);

  const host = document.createElement('div');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const shadowVideo = createVideoNode(document, { paused: true, width: 640, height: 360 });
  shadowRoot.appendChild(shadowVideo);
  document.body.appendChild(host);

  const tracker = content.createActiveVideoTracker({ document });
  tracker.refreshCandidates();

  assert.equal(tracker.getCandidateSummaries().length, 2);
  assert.deepEqual(tracker.getSelectorHeuristic(), ['playing', 'visible', 'largest', 'mostRecent']);
});

test('selection heuristic picks playing video over paused', () => {
  const content = loadContentModule();
  const document = createDocumentStub();

  const pausedVideo = createVideoNode(document, { paused: true, width: 1280, height: 720, currentTime: 12, duration: 300 });
  const playingVideo = createVideoNode(document, { paused: false, width: 320, height: 180, currentTime: 48, duration: 300 });
  document.body.appendChild(pausedVideo);
  document.body.appendChild(playingVideo);

  const tracker = content.createActiveVideoTracker({ document });
  const snapshot = tracker.getActiveVideoSnapshot();

  assert.deepEqual(snapshot, {
    hasVideo: true,
    currentTimeSec: 48,
    durationSec: 300,
    paused: false
  });
});

test('selection heuristic picks larger paused video when multiple are paused', () => {
  const content = loadContentModule();
  const document = createDocumentStub();

  const smallerVideo = createVideoNode(document, { paused: true, width: 320, height: 180, currentTime: 10, duration: 300 });
  const largerVideo = createVideoNode(document, { paused: true, width: 1280, height: 720, currentTime: 22, duration: 300 });
  document.body.appendChild(smallerVideo);
  document.body.appendChild(largerVideo);

  const tracker = content.createActiveVideoTracker({ document });
  const bestCandidate = tracker.getBestCandidate() || tracker.refreshCandidates();

  assert.equal(bestCandidate.element, largerVideo);
});

test('selection heuristic picks the playing video when another larger video is paused', () => {
  const content = loadContentModule();
  const document = createDocumentStub();

  const playingVideo = createVideoNode(document, { paused: false, width: 320, height: 180, currentTime: 33, duration: 300 });
  const pausedVideo = createVideoNode(document, { paused: true, width: 1920, height: 1080, currentTime: 200, duration: 300 });
  document.body.appendChild(pausedVideo);
  document.body.appendChild(playingVideo);

  const tracker = content.createActiveVideoTracker({ document });
  const snapshot = tracker.getActiveVideoSnapshot();

  assert.deepEqual(snapshot, {
    hasVideo: true,
    currentTimeSec: 33,
    durationSec: 300,
    paused: false
  });
});

test('getActiveVideoTime runtime handler returns correct snapshot', () => {
  const content = loadContentModule();
  const document = createDocumentStub();
  const runtime = createRuntimeStub();
  const video = createVideoNode(document, { paused: true, width: 854, height: 480, currentTime: 91.5, duration: 600 });
  document.body.appendChild(video);

  const tracker = content.createActiveVideoTracker({ document, runtime });
  tracker.init();

  let response;
  runtime.__listeners.at(-1)({ action: 'getActiveVideoTime' }, {}, (payload) => {
    response = payload;
  });

  assert.deepEqual(response, {
    hasVideo: true,
    currentTimeSec: 91.5,
    durationSec: 600,
    paused: true
  });
});

test('getActiveVideoTime returns hasVideo false when no video exists', () => {
  const content = loadContentModule();
  const document = createDocumentStub();

  const tracker = content.createActiveVideoTracker({ document });

  assert.deepEqual(tracker.getActiveVideoSnapshot(), { hasVideo: false });
  assert.equal(tracker.getCandidateSummaries().length, 0);
});

test('dynamic video insertion is detected by MutationObserver', () => {
  const content = loadContentModule();
  const document = createDocumentStub();
  const MutationObserver = createMutationObserverStub(document);

  const tracker = content.createActiveVideoTracker({ document, MutationObserver });
  tracker.init();
  assert.equal(tracker.getCandidateSummaries().length, 0);

  const video = createVideoNode(document, { paused: false, width: 640, height: 360, currentTime: 15, duration: 120 });
  document.body.appendChild(video);

  const snapshot = tracker.getActiveVideoSnapshot();
  assert.deepEqual(snapshot, {
    hasVideo: true,
    currentTimeSec: 15,
    durationSec: 120,
    paused: false
  });
});

test('video removal updates candidates', () => {
  const content = loadContentModule();
  const document = createDocumentStub();
  const MutationObserver = createMutationObserverStub(document);

  const video = createVideoNode(document, { paused: true, width: 640, height: 360, currentTime: 10, duration: 100 });
  document.body.appendChild(video);

  const tracker = content.createActiveVideoTracker({ document, MutationObserver });
  tracker.init();
  assert.equal(tracker.getCandidateSummaries().length, 1);

  video.remove();

  assert.equal(tracker.getCandidateSummaries().length, 0);
  assert.deepEqual(tracker.getActiveVideoSnapshot(), { hasVideo: false });
});
