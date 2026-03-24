const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildDefaultProviderSettings } = require('../storage/settings.js');
const popupSummaryUi = require('../popup-summary-ui.js');
const { createStorageArea } = require('./helpers/extension-harness.js');

const POPUP_PATH = path.resolve(__dirname, '..', 'popup.js');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class FakeClassList {
  constructor(element, initial = []) {
    this.element = element;
    this.tokens = new Set(initial.filter(Boolean));
    this.sync();
  }

  sync() {
    this.element.className = Array.from(this.tokens).join(' ');
  }

  add(...tokens) {
    tokens.filter(Boolean).forEach((token) => this.tokens.add(token));
    this.sync();
  }

  remove(...tokens) {
    tokens.forEach((token) => this.tokens.delete(token));
    this.sync();
  }

  toggle(token, force) {
    if (force === true) {
      this.tokens.add(token);
    } else if (force === false) {
      this.tokens.delete(token);
    } else if (this.tokens.has(token)) {
      this.tokens.delete(token);
    } else {
      this.tokens.add(token);
    }
    this.sync();
    return this.tokens.has(token);
  }

  contains(token) {
    return this.tokens.has(token);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument, options = {}) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = options.id || '';
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this._textContent = '';
    this._innerHTML = '';
    this.className = '';
    this.classList = new FakeClassList(this, options.classNames || []);
    ownerDocument.__registerElement(this);
  }

  set textContent(value) {
    this._textContent = value == null ? '' : String(value);
    this._innerHTML = escapeHtml(this._textContent);
  }

  get textContent() {
    return this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = value == null ? '' : String(value);
    if (this._innerHTML === '') {
      this.children = [];
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  after(node) {
    if (!this.parentNode) {
      return;
    }

    const index = this.parentNode.children.indexOf(this);
    if (index === -1) {
      this.parentNode.children.push(node);
    } else {
      this.parentNode.children.splice(index + 1, 0, node);
    }
    node.parentNode = this.parentNode;
  }

  remove() {
    if (!this.parentNode) {
      return;
    }

    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(listener);
  }

  dispatchEvent(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.forEach((listener) => listener({ target: this, currentTarget: this, ...event }));
  }

  querySelector(selector) {
    return this.ownerDocument.__querySelectorWithin(this, selector);
  }

  insertAdjacentText(position, text) {
    if (position === 'beforeend') {
      this.textContent = `${this.textContent}${text}`;
    }
  }

  getContext(type) {
    if (type !== '2d') {
      return null;
    }

    return {
      clearRect() {},
      createLinearGradient() {
        return { addColorStop() {} };
      },
      save() {},
      beginPath() {},
      arc() {},
      clip() {},
      fill() {},
      restore() {},
      roundRect() {}
    };
  }
}

class FakeInputElement extends FakeElement {}
class FakeCanvasElement extends FakeElement {}

class FakeDocument {
  constructor() {
    this.elementsById = new Map();
    this.allElements = new Set();
    this.body = new FakeElement('body', this, { id: 'body' });
  }

  __registerElement(element) {
    this.allElements.add(element);
    if (element.id) {
      this.elementsById.set(element.id, element);
    }
  }

  __querySelectorWithin(root, selector) {
    if (!selector.startsWith('.')) {
      return null;
    }

    const className = selector.slice(1);
    const queue = [...root.children];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate.classList.contains(className)) {
        return candidate;
      }
      queue.push(...candidate.children);
    }
    return null;
  }

  createElement(tagName) {
    if (tagName === 'input') {
      return new FakeInputElement(tagName, this);
    }

    if (tagName === 'canvas') {
      return new FakeCanvasElement(tagName, this);
    }

    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelector(selector) {
    if (!selector.startsWith('.')) {
      return null;
    }

    const className = selector.slice(1);
    for (const element of this.allElements) {
      if (element.classList.contains(className)) {
        return element;
      }
    }
    return null;
  }
}

function createProviderSettings() {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = 'sk-openai';
  return settings;
}

function mountElement(document, id, tagName = 'div', options = {}) {
  const element = tagName === 'input'
    ? new FakeInputElement(tagName, document, { id, classNames: options.classNames })
    : (tagName === 'canvas'
      ? new FakeCanvasElement(tagName, document, { id, classNames: options.classNames })
      : new FakeElement(tagName, document, { id, classNames: options.classNames }));

  if (options.parent) {
    options.parent.appendChild(element);
  } else {
    document.body.appendChild(element);
  }

  if (options.hidden) {
    element.hidden = true;
  }
  if (options.disabled) {
    element.disabled = true;
  }
  if (options.textContent) {
    element.textContent = options.textContent;
  }
  if (options.value) {
    element.value = options.value;
  }
  if (options.style) {
    Object.assign(element.style, options.style);
  }
  return element;
}

function buildPopupDom() {
  const document = new FakeDocument();

  const viewRecorder = mountElement(document, 'viewRecorder', 'div', { classNames: ['active'] });
  const viewHistory = mountElement(document, 'viewHistory');
  mountElement(document, 'viewDetail');
  mountElement(document, 'settingsPanel');

  const progressContainer = mountElement(document, 'transcriptionProgress', 'div', {
    parent: viewRecorder,
    style: { display: 'none' }
  });
  mountElement(document, 'progressText', 'span', { parent: progressContainer, textContent: 'Transcribiendo...' });
  mountElement(document, 'progressRatio', 'span', { parent: progressContainer, textContent: '0/0 clips procesados' });

  const transcriptBox = mountElement(document, 'transcriptBox', 'div', { parent: viewRecorder });
  mountElement(document, 'transcriptText', 'span', { parent: transcriptBox });
  mountElement(document, 'placeholder', 'div', { parent: transcriptBox, style: { display: 'flex' } });

  mountElement(document, 'btnRecord', 'button');
  mountElement(document, 'btnPause', 'button', { disabled: true });
  mountElement(document, 'btnReset', 'button', { disabled: true });
  mountElement(document, 'btnCopy', 'button', { disabled: true });
  mountElement(document, 'timer', 'div', { textContent: '00:00' });
  mountElement(document, 'timerLabel', 'div', { textContent: 'Presioná grabar para iniciar' });
  mountElement(document, 'statusBadge', 'span', { textContent: 'Listo' });
  mountElement(document, 'ringOuter', 'div');
  mountElement(document, 'ringGlow', 'div');
  mountElement(document, 'centerDot', 'div');
  mountElement(document, 'visualizerCanvas', 'canvas');
  mountElement(document, 'btnBack', 'button');
  mountElement(document, 'btnHistory', 'button');
  mountElement(document, 'toast', 'div');
  mountElement(document, 'detailTitle', 'input');
  mountElement(document, 'detailMeta', 'div');
  mountElement(document, 'detailUrl', 'div');
  mountElement(document, 'detailAudit', 'div');
  mountElement(document, 'detailText', 'div');
  mountElement(document, 'detailSummarySection', 'section');
  mountElement(document, 'detailSummaryStatus', 'div');
  mountElement(document, 'detailSummaryBadge', 'div', { hidden: true });
  mountElement(document, 'detailSummaryCard', 'div', { hidden: true });
  mountElement(document, 'detailSummaryText', 'p', { hidden: true });
  mountElement(document, 'detailSummaryKeyPoints', 'ul', { hidden: true });
  mountElement(document, 'detailSummaryError', 'div', { hidden: true });
  mountElement(document, 'btnDetailSummarize', 'button');
  mountElement(document, 'btnSaveTitle', 'button');
  mountElement(document, 'btnDetailCopy', 'button');
  mountElement(document, 'btnDetailDelete', 'button');
  mountElement(document, 'historyList', 'div', { parent: viewHistory });
  mountElement(document, 'historyEmpty', 'div', { parent: viewHistory });
  mountElement(document, 'historyCount', 'span', { parent: viewHistory, textContent: '0' });
  mountElement(document, 'btnSettings', 'button');
  mountElement(document, 'langSelect', 'select', { value: 'es' });
  mountElement(document, 'defaultProviderSelect', 'select', { value: 'openai' });
  mountElement(document, 'providerCards', 'div');
  mountElement(document, 'providerLiveChip', 'span');
  mountElement(document, 'sessionMeta', 'div', { hidden: true });
  mountElement(document, 'btnSaveProviders', 'button');
  mountElement(document, 'providerSettingsSaved', 'span');
  mountElement(document, 'providerSettingsHint', 'div');

  return document;
}

function createPopupChrome(storageArea, responses = {}) {
  const sentMessages = [];

  return {
    __sentMessages: sentMessages,
    runtime: {
      sendMessage(message, callback) {
        sentMessages.push(message);
        const action = message && message.action;
        let response;

        if (typeof responses[action] === 'function') {
          response = responses[action](message);
        } else if (Object.prototype.hasOwnProperty.call(responses, action)) {
          response = responses[action];
        } else {
          response = { ok: true };
        }

        const pending = Promise.resolve(response);
        if (typeof callback === 'function') {
          pending.then((value) => callback(value));
          return undefined;
        }
        return pending;
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageArea.__addChangeListener(listener);
        },
        removeListener(listener) {
          storageArea.__removeChangeListener(listener);
        }
      },
      local: storageArea
    },
    tabs: {
      async query() {
        return [{ id: 1, title: 'Popup test tab', url: 'https://example.com/popup' }];
      }
    }
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadPopupHarness(options = {}) {
  const storageArea = createStorageArea({
    audioLanguage: 'es',
    transcript: { final: '', interim: '' },
    ...(options.initialStorage || {})
  });
  const document = buildPopupDom();
  const providerSettings = options.providerSettings || createProviderSettings();
  const responses = {
    getState: options.stateResponse || { status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0 },
    getProviderSettings: {
      ok: true,
      providerSettings,
      providers: [{ id: 'openai', label: 'OpenAI' }]
    },
    getTranscriptionSession: { ok: true, transcriptSession: null },
    getTranscriptions: [],
    ...(options.runtimeResponses || {})
  };
  const chrome = createPopupChrome(storageArea, responses);

  let nextTimerId = 1;
  let now = 0;
  const timers = new Map();
  const unloadListeners = [];
  const originals = {
    chrome: global.chrome,
    document: global.document,
    window: global.window,
    navigator: global.navigator,
    HTMLElement: global.HTMLElement,
    HTMLInputElement: global.HTMLInputElement,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    PochoclaPopupSummaryUI: global.PochoclaPopupSummaryUI
  };

  function scheduleTimer(callback, delay = 0) {
    nextTimerId += 1;
    timers.set(nextTimerId, {
      callback,
      dueAt: now + Math.max(0, Number(delay) || 0)
    });
    return nextTimerId;
  }

  function advanceTimers(ms) {
    now += ms;
    let executed = true;

    while (executed) {
      executed = false;
      const dueTimers = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);

      dueTimers.forEach(([id, timer]) => {
        if (!timers.has(id)) {
          return;
        }
        timers.delete(id);
        executed = true;
        timer.callback();
      });
    }
  }

  global.chrome = chrome;
  global.document = document;
  global.window = {
    addEventListener(type, listener) {
      if (type === 'unload') {
        unloadListeners.push(listener);
      }
    }
  };
  global.navigator = {
    clipboard: {
      writeText() {
        return Promise.resolve();
      }
    }
  };
  global.HTMLElement = FakeElement;
  global.HTMLInputElement = FakeInputElement;
  global.requestAnimationFrame = (callback) => scheduleTimer(() => callback(now), 16);
  global.cancelAnimationFrame = (id) => timers.delete(id);
  global.setTimeout = (callback, delay) => scheduleTimer(callback, delay);
  global.clearTimeout = (id) => timers.delete(id);
  global.setInterval = () => nextTimerId += 1;
  global.clearInterval = () => {};
  global.PochoclaPopupSummaryUI = popupSummaryUi;

  delete require.cache[require.resolve(POPUP_PATH)];
  require(POPUP_PATH);
  await flushMicrotasks();
  await flushMicrotasks();

  return {
    document,
    storageArea,
    advanceTimers,
    async flush() {
      await flushMicrotasks();
      await flushMicrotasks();
    },
    unload() {
      unloadListeners.forEach((listener) => listener());
    },
    cleanup() {
      delete require.cache[require.resolve(POPUP_PATH)];
      Object.entries(originals).forEach(([key, value]) => {
        global[key] = value;
      });
    }
  };
}

test('popup initial render and reopen read transcriptionProgress from storage', async (t) => {
  const initialProgress = {
    sessionId: 'session-popup',
    totalChunks: 5,
    completedChunks: 2,
    status: 'active',
    updatedAt: 111
  };

  const firstPopup = await loadPopupHarness({
    initialStorage: { transcriptionProgress: initialProgress }
  });
  t.after(() => firstPopup.cleanup());

  assert.equal(firstPopup.document.getElementById('transcriptionProgress').style.display, 'block');
  assert.equal(firstPopup.document.getElementById('progressText').textContent, 'Transcribiendo...');
  assert.equal(firstPopup.document.getElementById('progressRatio').textContent, '2/5 clips procesados');

  const reopenedPopup = await loadPopupHarness({
    initialStorage: { transcriptionProgress: initialProgress }
  });
  t.after(() => reopenedPopup.cleanup());

  assert.equal(reopenedPopup.document.getElementById('transcriptionProgress').style.display, 'block');
  assert.equal(reopenedPopup.document.getElementById('progressRatio').textContent, '2/5 clips procesados');
});

test('popup reacts to live storage updates, keeps progress visible while draining, and handles zero totals safely', async (t) => {
  const popup = await loadPopupHarness({
    initialStorage: {
      transcriptionProgress: {
        sessionId: 'session-live',
        totalChunks: 0,
        completedChunks: 0,
        status: 'active',
        updatedAt: 10
      }
    }
  });
  t.after(() => popup.cleanup());

  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'none');
  assert.equal(popup.document.getElementById('progressRatio').textContent, '0/0 clips procesados');

  await popup.storageArea.set({
    transcriptionProgress: {
      sessionId: 'session-live',
      totalChunks: 5,
      completedChunks: 3,
      status: 'draining',
      updatedAt: 20
    }
  });
  await popup.flush();

  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'block');
  assert.equal(popup.document.getElementById('progressText').textContent, 'Transcribiendo...');
  assert.equal(popup.document.getElementById('progressRatio').textContent, '3/5 clips procesados');

  await popup.storageArea.set({
    transcriptionProgress: {
      sessionId: 'session-live',
      totalChunks: 5,
      completedChunks: 5,
      status: 'idle',
      updatedAt: 30
    }
  });
  await popup.flush();

  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'block');
  assert.equal(popup.document.getElementById('progressText').textContent, '✓ 5/5 clips procesados');
  assert.equal(popup.document.getElementById('progressRatio').textContent, '5/5 clips procesados');
});

test('popup keeps completed label visible after storage cleanup and resets on new session start', async (t) => {
  const popup = await loadPopupHarness({
    initialStorage: {
      transcriptionProgress: {
        sessionId: 'session-done',
        totalChunks: 4,
        completedChunks: 3,
        status: 'draining',
        updatedAt: 10
      }
    }
  });
  t.after(() => popup.cleanup());

  assert.equal(popup.storageArea.__getChangeListenerCount(), 1);

  await popup.storageArea.set({
    transcriptionProgress: {
      sessionId: 'session-done',
      totalChunks: 4,
      completedChunks: 4,
      status: 'done',
      updatedAt: 20
    }
  });
  await popup.flush();

  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'block');
  assert.equal(popup.document.getElementById('progressText').textContent, '✓ 4/4 clips procesados');
  assert.equal(popup.document.getElementById('progressRatio').textContent, '4/4 clips procesados');

  await popup.storageArea.remove('transcriptionProgress');
  await popup.flush();

  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'block');
  assert.equal(popup.document.getElementById('progressText').textContent, '✓ 4/4 clips procesados');

  await popup.storageArea.set({
    transcriptionProgress: {
      sessionId: 'session-next',
      totalChunks: 0,
      completedChunks: 0,
      status: 'active',
      updatedAt: 30
    }
  });
  await popup.flush();

  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'none');
  assert.equal(popup.document.getElementById('progressText').textContent, 'Transcribiendo...');
  assert.equal(popup.document.getElementById('progressRatio').textContent, '0/0 clips procesados');

  popup.unload();
  assert.equal(popup.storageArea.__getChangeListenerCount(), 0);
});

test('popup stop clears live transcript and progress, then navigates to refreshed history', async (t) => {
  const savedTranscriptions = [{
    id: 'tx-stop-1',
    title: 'Reunión finalizada',
    text: 'Texto final completo',
    url: 'https://example.com/reunion',
    date: Date.now(),
    duration: 42,
    language: 'es',
    resolvedProvider: 'openai',
    status: 'completed',
    providerAudit: null
  }];

  let getStateCalls = 0;
  const popup = await loadPopupHarness({
    stateResponse: () => {
      getStateCalls += 1;
      return getStateCalls <= 3
        ? { status: 'recording', startTime: Date.now() - 2000, pausedAt: 0, pausedDuration: 0 }
        : { status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0 };
    },
    initialStorage: {
      transcript: { final: 'Texto parcial pegado en popup', interim: 'interim visible' },
      transcriptionProgress: {
        sessionId: 'session-stop',
        totalChunks: 3,
        completedChunks: 2,
        status: 'draining',
        updatedAt: 20
      }
    },
    runtimeResponses: {
      stopCapture: { ok: true },
      getTranscriptions: () => savedTranscriptions,
      getTranscriptionSession: { ok: true, transcriptSession: null }
    }
  });
  t.after(() => popup.cleanup());

  popup.document.getElementById('btnRecord').dispatchEvent('click');
  for (let index = 0; index < 8; index += 1) {
    await popup.flush();
  }

  assert.equal(popup.document.getElementById('transcriptText').textContent, '');
  assert.equal(popup.document.getElementById('placeholder').style.display, 'flex');
  assert.equal(popup.document.getElementById('btnCopy').disabled, true);
  assert.equal(popup.document.getElementById('transcriptionProgress').style.display, 'none');
  assert.equal(popup.document.getElementById('progressText').textContent, 'Transcribiendo...');
  assert.equal(popup.document.getElementById('progressRatio').textContent, '0/0 clips procesados');
  assert.equal(popup.document.getElementById('viewRecorder').classList.contains('active'), false);
  assert.equal(popup.document.getElementById('viewHistory').classList.contains('active'), true);
  assert.equal(popup.document.getElementById('historyCount').textContent, '1');
  assert.equal(popup.document.getElementById('historyList').children.length, 1);
  assert.match(popup.document.getElementById('historyList').children[0].innerHTML, /Reunión finalizada/);
  assert.equal(popup.document.getElementById('statusBadge').textContent, 'Finalizado');
  assert.equal(popup.document.getElementById('timerLabel').textContent, 'Grabación finalizada');
});
