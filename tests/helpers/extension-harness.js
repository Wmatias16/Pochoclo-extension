const path = require('node:path');

const providerErrors = require('../../providers/errors.js');
const providerRegistry = require('../../providers/registry.js');
const providerDiagnostics = require('../../diagnostics/provider-logger.js');
const providerSessionRuntime = require('../../runtime/provider-session-runtime.js');
const providerSettingsStore = require('../../storage/settings.js');
const transcriptionStore = require('../../storage/transcriptions.js');
const chunkProcessor = require('../../runtime/chunk-processor.js');
const offscreenBridge = require('../../runtime/offscreen-bridge.js');
const transcriptionSummarizer = require('../../runtime/transcription-summarizer.js');

const BACKGROUND_PATH = path.resolve(__dirname, '..', '..', 'background.js');
const OFFSCREEN_PATH = path.resolve(__dirname, '..', '..', 'offscreen.js');

function createStorageArea(initial = {}) {
  const store = { ...initial };
  const changeListeners = new Set();

  function readKey(key) {
    return store[key];
  }

  function buildResult(keys) {
    if (Array.isArray(keys)) {
      return keys.reduce((acc, key) => {
        acc[key] = readKey(key);
        return acc;
      }, {});
    }

    if (typeof keys === 'string') {
      return { [keys]: readKey(keys) };
    }

    if (keys && typeof keys === 'object') {
      return Object.keys(keys).reduce((acc, key) => {
        acc[key] = readKey(key) === undefined ? keys[key] : readKey(key);
        return acc;
      }, {});
    }

    return { ...store };
  }

  return {
    store,
    get(keys, callback) {
      const result = buildResult(keys);
      if (typeof callback === 'function') {
        callback(result);
      }
      return Promise.resolve(result);
    },
    set(items, callback) {
      const changes = {};
      Object.entries(items || {}).forEach(([key, value]) => {
        changes[key] = {
          oldValue: store[key],
          newValue: value
        };
      });
      Object.assign(store, items || {});
      if (Object.keys(changes).length > 0) {
        Array.from(changeListeners).forEach((listener) => listener(changes, 'local'));
      }
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      list.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(store, key)) {
          changes[key] = {
            oldValue: store[key],
            newValue: undefined
          };
        }
        delete store[key];
      });
      if (Object.keys(changes).length > 0) {
        Array.from(changeListeners).forEach((listener) => listener(changes, 'local'));
      }
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.resolve();
    },
    __addChangeListener(listener) {
      changeListeners.add(listener);
    },
    __removeChangeListener(listener) {
      changeListeners.delete(listener);
    },
    __emitChange(changes, areaName = 'local') {
      Array.from(changeListeners).forEach((listener) => listener(changes, areaName));
    },
    __getChangeListenerCount() {
      return changeListeners.size;
    }
  };
}

function createChromeMock(storageArea) {
  const runtimeListeners = [];
  const alarmListeners = [];
  const notificationButtonListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  const sentMessages = [];
  const actionCalls = [];
  const createdAlarms = new Map();
  const clearedAlarms = [];
  const createdNotifications = [];
  const clearedNotifications = [];
  const tabMessages = [];
  let hasOffscreenDocument = false;

  function cloneMessage(message) {
    return JSON.parse(JSON.stringify(message));
  }

  function deliverMessage(message, sender = {}) {
    const clonedMessage = cloneMessage(message);
    return new Promise((resolve) => {
      let settled = false;
      let handled = false;

      const sendResponse = (response) => {
        if (!settled) {
          settled = true;
          resolve(response);
        }
      };

      for (const listener of runtimeListeners) {
        const result = listener(clonedMessage, sender, sendResponse);
        if (result === true) {
          handled = true;
          break;
        }
        if (result !== undefined) {
          handled = true;
          if (!settled) {
            settled = true;
            resolve(result);
          }
          break;
        }
        if (settled) {
          handled = true;
          break;
        }
      }

      if (!handled && !settled) {
        resolve(undefined);
      }
    });
  }

  const chrome = {
    __listeners: runtimeListeners,
    __sentMessages: sentMessages,
    __actionCalls: actionCalls,
    __createdAlarms: createdAlarms,
    __clearedAlarms: clearedAlarms,
    __createdNotifications: createdNotifications,
    __clearedNotifications: clearedNotifications,
    __tabMessages: tabMessages,
    __deliverRuntimeMessage(message, sender) {
      return deliverMessage(message, sender);
    },
    __dispatchAlarm(alarm) {
      alarmListeners.forEach((listener) => listener(alarm));
    },
    __dispatchNotificationButton(notificationId, buttonIndex) {
      notificationButtonListeners.forEach((listener) => listener(notificationId, buttonIndex));
    },
    __dispatchStartup() {
      startupListeners.forEach((listener) => listener());
    },
    __dispatchInstalled(details = { reason: 'update' }) {
      installedListeners.forEach((listener) => listener(details));
    },
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      onStartup: {
        addListener(listener) {
          startupListeners.push(listener);
        }
      },
      onInstalled: {
        addListener(listener) {
          installedListeners.push(listener);
        }
      },
      async getContexts(query = {}) {
        if (!hasOffscreenDocument) {
          return [];
        }

        if (
          Array.isArray(query.contextTypes)
          && query.contextTypes.length > 0
          && !query.contextTypes.includes('OFFSCREEN_DOCUMENT')
        ) {
          return [];
        }

        return [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'offscreen.html' }];
      },
      sendMessage(message, callback) {
        const clonedMessage = cloneMessage(message);
        sentMessages.push(clonedMessage);
        const pending = deliverMessage(clonedMessage);
        if (typeof callback === 'function') {
          pending.then((response) => callback(response));
          return undefined;
        }
        return pending;
      }
    },
    offscreen: {
      async createDocument() {
        hasOffscreenDocument = true;
      },
      async closeDocument() {
        hasOffscreenDocument = false;
      }
    },
    tabCapture: {
      getMediaStreamId({ targetTabId }, callback) {
        callback(`stream-${targetTabId}`);
      }
    },
    downloads: {
      download() {
        return undefined;
      }
    },
    action: {
      async setBadgeText(payload) {
        actionCalls.push({ method: 'setBadgeText', payload });
      },
      async setBadgeBackgroundColor(payload) {
        actionCalls.push({ method: 'setBadgeBackgroundColor', payload });
      },
      async setTitle(payload) {
        actionCalls.push({ method: 'setTitle', payload });
      },
      async setIcon(payload) {
        actionCalls.push({ method: 'setIcon', payload });
      }
    },
    alarms: {
      onAlarm: {
        addListener(listener) {
          alarmListeners.push(listener);
        }
      },
      async create(name, info) {
        createdAlarms.set(name, { name, ...(info || {}) });
      },
      async clear(name) {
        clearedAlarms.push(name);
        return createdAlarms.delete(name);
      }
    },
    notifications: {
      onButtonClicked: {
        addListener(listener) {
          notificationButtonListeners.push(listener);
        }
      },
      async create(notificationId, options) {
        createdNotifications.push({ notificationId, options });
        return notificationId;
      },
      async clear(notificationId) {
        clearedNotifications.push(notificationId);
        return true;
      }
    },
    tabs: {
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: cloneMessage(message) });
        return { ok: true };
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
    }
  };

  return chrome;
}

class FakeAudioContext {
  constructor() {
    this.destination = {};
    this.sampleRate = 16000;
  }

  createMediaStreamSource() {
    return {
      connect() {
        return undefined;
      }
    };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 32,
      getByteFrequencyData(buffer) {
        buffer.fill(8);
      }
    };
  }

  createScriptProcessor() {
    return {
      onaudioprocess: null,
      connect() {
        return undefined;
      },
      disconnect() {
        return undefined;
      }
    };
  }

  close() {
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  constructor() {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') {
      return;
    }

    this.state = 'inactive';
    queueMicrotask(() => {
      if (typeof this.onstop === 'function') {
        this.onstop();
      }
    });
  }

  pause() {
    if (this.state === 'recording') {
      this.state = 'paused';
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = 'recording';
    }
  }
}

class FakeOffscreenCanvasContext {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.fillStyle = '#000000';
  }

  clearRect() {}

  beginPath() {}

  arc() {}

  fill() {}

  getImageData(x, y, width, height) {
    return {
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height
    };
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext(type) {
    if (type !== '2d') {
      return null;
    }

    return new FakeOffscreenCanvasContext(this.width, this.height);
  }
}

function createAdapter(providerId, behavior = {}) {
  const adapter = {
    async summarizeText(input, deps) {
      if (typeof behavior.summarizeText === 'function') {
        return behavior.summarizeText(input, deps);
      }

      return {
        summary: `${providerId} summary`,
        key_points: [`${providerId} point 1`, `${providerId} point 2`, `${providerId} point 3`]
      };
    },
    async transcribe(input, deps) {
      if (typeof behavior.transcribe === 'function') {
        return behavior.transcribe(input, deps);
      }

      return { text: `${providerId}-ok` };
    }
  };

  if (typeof behavior.preflight === 'function') {
    adapter.preflight = behavior.preflight;
  }

  return adapter;
}

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

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function createHarness(options = {}) {
  const storageArea = createStorageArea({
    audioLanguage: 'es',
    ...(options.initialStorage || {})
  });
  const chrome = createChromeMock(storageArea);
  const fetchImpl = options.fetchImpl || (async (url) => {
    if (typeof options.fetchResponseForUrl === 'function') {
      return options.fetchResponseForUrl(url);
    }

    return { ok: true, status: 200 };
  });
  const adapterBehaviors = options.adapterBehaviors || {};
  const originals = {
    chrome: global.chrome,
    fetch: global.fetch,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    OffscreenCanvas: global.OffscreenCanvas,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    PochoclaProviderErrors: global.PochoclaProviderErrors,
    PochoclaProviderDiagnostics: global.PochoclaProviderDiagnostics,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaProviderSettings: global.PochoclaProviderSettings,
    PochoclaTranscriptionStorage: global.PochoclaTranscriptionStorage,
    PochoclaProviderSessionRuntime: global.PochoclaProviderSessionRuntime,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge,
    PochoclaTranscriptionSummarizer: global.PochoclaTranscriptionSummarizer,
    PochoclaOpenAIAdapter: global.PochoclaOpenAIAdapter,
    PochoclaDeepgramAdapter: global.PochoclaDeepgramAdapter,
    PochoclaAssemblyAIAdapter: global.PochoclaAssemblyAIAdapter,
    PochoclaGroqAdapter: global.PochoclaGroqAdapter,
    PochoclaGoogleAdapter: global.PochoclaGoogleAdapter,
    PochoclaWhisperLocalAdapter: global.PochoclaWhisperLocalAdapter
  };

  const unrefSetTimeout = (...args) => {
    const timer = originals.setTimeout(...args);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  };

  const unrefSetInterval = (...args) => {
    const timer = originals.setInterval(...args);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  };

  setGlobalValue('chrome', chrome);
  setGlobalValue('fetch', fetchImpl);
  setGlobalValue('navigator', {
    mediaDevices: {
      async getUserMedia() {
        return {
          getTracks() {
            return [{ stop() {} }];
          }
        };
      }
    }
  });
  setGlobalValue('AudioContext', FakeAudioContext);
  setGlobalValue('MediaRecorder', FakeMediaRecorder);
  setGlobalValue('OffscreenCanvas', FakeOffscreenCanvas);
  setGlobalValue('setTimeout', unrefSetTimeout);
  setGlobalValue('clearTimeout', originals.clearTimeout);
  setGlobalValue('setInterval', unrefSetInterval);
  setGlobalValue('clearInterval', originals.clearInterval);
  setGlobalValue('PochoclaProviderErrors', providerErrors);
  setGlobalValue('PochoclaProviderDiagnostics', providerDiagnostics);
  setGlobalValue('PochoclaProviderRegistry', providerRegistry);
  setGlobalValue('PochoclaProviderSettings', providerSettingsStore);
  setGlobalValue('PochoclaTranscriptionStorage', transcriptionStore);
  setGlobalValue('PochoclaProviderSessionRuntime', providerSessionRuntime);
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);
  setGlobalValue('PochoclaTranscriptionSummarizer', transcriptionSummarizer);
  setGlobalValue('PochoclaOpenAIAdapter', createAdapter('openai', adapterBehaviors.openai));
  setGlobalValue('PochoclaDeepgramAdapter', createAdapter('deepgram', adapterBehaviors.deepgram));
  setGlobalValue('PochoclaAssemblyAIAdapter', createAdapter('assemblyai', adapterBehaviors.assemblyai));
  setGlobalValue('PochoclaGroqAdapter', createAdapter('groq', adapterBehaviors.groq));
  setGlobalValue('PochoclaGoogleAdapter', createAdapter('google', adapterBehaviors.google));
  setGlobalValue('PochoclaWhisperLocalAdapter', createAdapter('whisperLocal', adapterBehaviors.whisperLocal));

  loadFresh(OFFSCREEN_PATH);
  loadFresh(BACKGROUND_PATH);

  const popupSender = { url: 'chrome-extension://test-extension-id/popup.html' };

  async function startCapture(input = {}) {
    return chrome.runtime.sendMessage({
      target: 'background',
      action: 'startCapture',
      tabId: input.tabId || 1,
      tabTitle: input.tabTitle || 'Harness tab',
      tabUrl: input.tabUrl || 'https://example.com/watch?v=harness',
      providerOverride: input.providerOverride
    });
  }

  async function stopCapture() {
    return chrome.runtime.sendMessage({
      target: 'background',
      action: 'stopCapture'
    });
  }

  async function saveProviderSettings(providerSettings) {
    return chrome.__deliverRuntimeMessage({
      target: 'background',
      action: 'saveProviderSettings',
      providerSettings
    }, popupSender);
  }

  async function getProviderSettings() {
    return chrome.__deliverRuntimeMessage({
      target: 'background',
      action: 'getProviderSettings'
    }, popupSender);
  }

  async function getTranscriptSession() {
    const { transcriptSession } = await storageArea.get('transcriptSession');
    return transcriptSession || null;
  }

  async function getTranscript() {
    const { transcript } = await storageArea.get('transcript');
    return transcript || null;
  }

  async function getSavedTranscriptions() {
    const { savedTranscriptions } = await storageArea.get('savedTranscriptions');
    return savedTranscriptions || [];
  }

  async function getTranscriptions() {
    return chrome.runtime.sendMessage({
      target: 'background',
      action: 'getTranscriptions'
    });
  }

  async function dispatchChunk(input = {}) {
    const session = await getTranscriptSession();
    return offscreenBridge.dispatchChunkToBackground({
      blob: input.blob || new Blob([input.body || 'audio-chunk']),
      sessionContext: {
        sessionId: input.sessionId || (session && session.id) || null,
        chunkIndex: Number.isFinite(Number(input.chunkIndex)) ? Number(input.chunkIndex) : 0
      },
      sendMessage: chrome.runtime.sendMessage
    });
  }

  async function summarizeTranscription(id) {
    return chrome.runtime.sendMessage({
      target: 'background',
      action: 'summarizeTranscription',
      id
    });
  }

  function dispose() {
    delete require.cache[require.resolve(BACKGROUND_PATH)];
    delete require.cache[require.resolve(OFFSCREEN_PATH)];

    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }

  return {
    chrome,
    storageArea,
    startCapture,
    stopCapture,
    saveProviderSettings,
    getProviderSettings,
    getTranscriptSession,
    getTranscript,
    getSavedTranscriptions,
    getTranscriptions,
    dispatchChunk,
    summarizeTranscription,
    dispatchAlarm(alarm) {
      chrome.__dispatchAlarm(alarm);
    },
    dispatchNotificationButton(notificationId, buttonIndex) {
      chrome.__dispatchNotificationButton(notificationId, buttonIndex);
    },
    dispatchStartup() {
      chrome.__dispatchStartup();
    },
    dispatchInstalled(details) {
      chrome.__dispatchInstalled(details);
    },
    sendRuntimeMessageAs(message, sender) {
      return chrome.__deliverRuntimeMessage(message, sender);
    },
    dispose
  };
}

module.exports = {
  createHarness,
  createStorageArea
};
