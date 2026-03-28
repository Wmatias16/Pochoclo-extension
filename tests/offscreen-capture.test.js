const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const chunkProcessor = require('../runtime/chunk-processor.js');
const offscreenBridge = require('../runtime/offscreen-bridge.js');
const liveProviderSessionRuntime = require('../runtime/live-provider-session-runtime.js');

const OFFSCREEN_PATH = path.resolve(__dirname, '..', 'offscreen.js');
const LARGE_CHUNK_BODY = 'audio-payload-'.repeat(16);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (predicate()) {
      return;
    }
    await wait(10);
  }

  throw new Error('Timed out waiting for condition.');
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

function createChromeForOffscreen(options = {}) {
  const listeners = [];
  const sentMessages = [];

  return {
    __sentMessages: sentMessages,
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      sendMessage(message, callback) {
        sentMessages.push(message);

        if (message && message.target === 'background' && message.action === 'processChunk') {
          const responsePromise = Promise.resolve().then(() => options.onProcessChunk(message));
          if (typeof callback === 'function') {
            responsePromise.then((response) => callback(response));
            return undefined;
          }
          return responsePromise;
        }

        const responsePromise = new Promise((resolve) => {
          let handled = false;
          const sendResponse = (response) => {
            handled = true;
            resolve(response);
          };

          for (const listener of listeners) {
            const result = listener(message, {}, sendResponse);
            if (result === true) {
              handled = true;
              break;
            }
            if (result !== undefined) {
              handled = true;
              resolve(result);
              break;
            }
          }

          if (!handled) {
            resolve(undefined);
          }
        });

        if (typeof callback === 'function') {
          responsePromise.then((response) => callback(response));
          return undefined;
        }

        return responsePromise;
      }
    }
  };
}

class FakeAudioContext {
  static instances = [];

  constructor() {
    this.destination = {};
    this.sampleRate = 16000;
    this.processorNodes = [];
    this.mediaStreamSources = [];
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    const node = {
      connected: [],
      connect() {
        node.connected.push(arguments[0]);
        return undefined;
      },
      disconnect(target) {
        if (!target) {
          node.connected = [];
          return undefined;
        }
        node.connected = node.connected.filter((entry) => entry !== target);
        return undefined;
      }
    };
    this.mediaStreamSources.push(node);
    return node;
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
    const processor = {
      onaudioprocess: null,
      connect() {
        return undefined;
      },
      disconnect() {
        return undefined;
      },
      emitAudio(samples) {
        if (typeof processor.onaudioprocess === 'function') {
          processor.onaudioprocess({
            inputBuffer: {
              numberOfChannels: 1,
              getChannelData() {
                return Float32Array.from(samples);
              }
            }
          });
        }
      }
    };
    this.processorNodes.push(processor);
    return processor;
  }

  close() {
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static instances = [];

  constructor(stream, options = {}) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.intervalId = null;
    this.chunkCounter = 0;
    this.startTimeslice = null;
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice) {
    this.startTimeslice = timeslice;
    this.state = 'recording';

    if (Number.isFinite(timeslice) && timeslice <= 100) {
      this.intervalId = setInterval(() => {
        if (this.state !== 'recording') {
          return;
        }

        this.chunkCounter += 1;
        if (typeof this.ondataavailable === 'function') {
          this.ondataavailable({
            data: new Blob([`${LARGE_CHUNK_BODY}${this.chunkCounter}`], { type: 'audio/webm' })
          });
        }
      }, timeslice);
    }
  }

  emitChunk(body = LARGE_CHUNK_BODY, type = 'audio/webm;codecs=opus') {
    if (this.state !== 'recording') {
      return;
    }

    if (typeof this.ondataavailable !== 'function') {
      return;
    }

    this.chunkCounter += 1;
    this.ondataavailable({
      data: new Blob([`${body}-${this.chunkCounter}`], { type })
    });
  }

  stop() {
    if (this.state === 'inactive') {
      return;
    }

    this.state = 'inactive';

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (Number.isFinite(this.startTimeslice) && this.startTimeslice <= 100 && typeof this.ondataavailable === 'function') {
      this.chunkCounter += 1;
      this.ondataavailable({
        data: new Blob([`${LARGE_CHUNK_BODY}final-${this.chunkCounter}`], { type: 'audio/webm' })
      });
    }

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

function getBatchRecorders() {
  return FakeMediaRecorder.instances.filter((instance) => instance.startTimeslice !== 250);
}

test('offscreen batch capture keeps queueing MediaRecorder chunks while the first background response is still pending', async () => {
  let firstChunkRelease;
  let processChunkCalls = 0;
  let enqueueCount = 0;

  const trackingChunkProcessor = {
    createSerialProcessor(processItem, hooks) {
      const processor = chunkProcessor.createSerialProcessor(processItem, hooks);
      return {
        ...processor,
        enqueue(item) {
          enqueueCount += 1;
          return processor.enqueue(item);
        }
      };
    }
  };

  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => {
      processChunkCalls += 1;
      if (processChunkCalls === 1) {
        await new Promise((resolve) => {
          firstChunkRelease = resolve;
        });
      }
      return { ok: true };
    }
  });

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge
  };

  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
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
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { liveAudioFormat: null, requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaChunkProcessor', trackingChunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      streamId: 'stream-1',
      sessionContext: {
        sessionId: 'session-1',
        chunkIntervalMs: 20
      }
    });

    assert.equal(started.ok, true);

    await waitFor(() => FakeAudioContext.instances.length > 0, 100);
    const audioContext = FakeAudioContext.instances[0];
    assert.equal(audioContext.processorNodes.length, 0);

    await waitFor(() => getBatchRecorders().length >= 1, 100);
    const firstChunkRecorder = getBatchRecorders()[0];
    assert.equal(!!firstChunkRecorder, true);

    firstChunkRecorder.emitChunk('batch-pending-1');
    await waitFor(() => getBatchRecorders().length >= 2, 200);
    const secondChunkRecorder = getBatchRecorders()[1];
    secondChunkRecorder.emitChunk('batch-pending-2');

    await waitFor(() => enqueueCount >= 2, 600);

    assert.equal(processChunkCalls, 1);
    assert.equal(enqueueCount >= 2, true);

    firstChunkRelease();

    const stopped = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop'
    });

    assert.deepEqual(stopped, { ok: true });
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }
});

test('offscreen batch capture stays on MediaRecorder/WebM through pause/resume without ScriptProcessorNode heartbeats', async () => {
  const sentMessages = [];
  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => ({ ok: true })
  });
  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message, callback) => {
    sentMessages.push(message);
    return originalSendMessage(message, callback);
  };

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge,
    DateNow: Date.now
  };

  let nowValue = 1_000;
  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
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
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { liveAudioFormat: null, requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);
  Date.now = () => nowValue;

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      streamId: 'stream-heartbeat',
      sessionContext: {
        sessionId: 'session-heartbeat',
        chunkIntervalMs: 20
      }
    });

    assert.equal(started.ok, true);

    await waitFor(() => FakeAudioContext.instances.length > 0, 100);
    assert.equal(FakeAudioContext.instances[0].processorNodes.length, 0);

    await waitFor(() => getBatchRecorders().length >= 1, 100);
    const firstChunkRecorder = getBatchRecorders()[0];
    assert.equal(!!firstChunkRecorder, true);
    firstChunkRecorder.emitChunk('batch-before-pause');
    await waitFor(() => sentMessages.filter((message) => message && message.target === 'background' && message.action === 'processChunk').length >= 1, 500);
    await waitFor(() => getBatchRecorders().length >= 2, 200);
    const pausedChunkRecorder = getBatchRecorders()[1];

    const paused = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause' });
    assert.equal(paused.ok, true);

    pausedChunkRecorder.emitChunk('ignored-while-paused');
    await wait(30);

    const resumed = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume' });
    assert.equal(resumed.ok, true);
    assert.equal(FakeAudioContext.instances[0].processorNodes.length, 0);

    await waitFor(() => getBatchRecorders().length >= 3, 200);
    const resumedChunkRecorder = getBatchRecorders()[2];

    nowValue += 200;
    resumedChunkRecorder.emitChunk('batch-after-resume');
    await waitFor(
      () => sentMessages.filter((message) => message && message.target === 'background' && message.action === 'processChunk').length >= 2,
      500
    );

    const heartbeats = sentMessages.filter(
      (message) => message && message.target === 'background' && message.action === 'audioActivity'
    );
    assert.equal(heartbeats.length, 0);

    const stopped = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop'
    });
    assert.deepEqual(stopped, { ok: true });
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Date.now = originals.DateNow;
    Object.entries(originals)
      .filter(([key]) => key !== 'DateNow')
      .forEach(([key, value]) => {
        setGlobalValue(key, value);
      });
  }
});

test('offscreen only enables batch PCM capture behind an explicit pcm16 provider capability gate', async () => {
  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => ({ ok: true })
  });

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge
  };

  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
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
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { liveAudioFormat: 'pcm16', requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      streamId: 'stream-rms',
      sessionContext: {
        sessionId: 'session-rms',
        activeProvider: 'openai',
        chunkIntervalMs: 20
      }
    });

    assert.equal(started.ok, true);

    await waitFor(() => FakeAudioContext.instances.length > 0, 100);
    assert.equal(FakeAudioContext.instances[0].processorNodes.length > 0, true);
    assert.equal(getBatchRecorders().length, 0);

    const stopped = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop'
    });
    assert.deepEqual(stopped, { ok: true });
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }
});

test('offscreen syncs accepted batch chunk totals from recorded blobs and keeps draining progress visible after stop', async () => {
  const sentMessages = [];
  let processChunkCalls = 0;
  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => {
      processChunkCalls += 1;
      await wait(30);
      return { ok: true };
    }
  });
  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message, callback) => {
    sentMessages.push(message);
    if (message && message.target === 'background' && message.action === 'syncTranscriptionProgress') {
      const response = { ok: true };
      if (typeof callback === 'function') {
        callback(response);
        return undefined;
      }
      return Promise.resolve(response);
    }
    return originalSendMessage(message, callback);
  };

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge
  };

  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
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
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { liveAudioFormat: null, requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      streamId: 'stream-progress',
      sessionContext: {
        sessionId: 'session-progress',
        chunkIntervalMs: 20
      }
    });
    assert.equal(started.ok, true);

    await waitFor(() => FakeAudioContext.instances.length > 0, 100);
    assert.equal(FakeAudioContext.instances[0].processorNodes.length, 0);
    await waitFor(() => getBatchRecorders().length >= 1, 100);
    await waitFor(() => getBatchRecorders().length >= 2, 200);
    assert.equal(
      sentMessages.filter((message) => message && message.action === 'syncTranscriptionProgress').length,
      0
    );

    const secondChunkRecorder = getBatchRecorders()[1];
    secondChunkRecorder.emitChunk('batch-progress-1');
    await waitFor(() => getBatchRecorders().length >= 3, 200);
    const thirdChunkRecorder = getBatchRecorders()[2];
    thirdChunkRecorder.emitChunk('batch-progress-2');
    await waitFor(
      () => sentMessages.filter((message) => message && message.action === 'syncTranscriptionProgress').length >= 2,
      500
    );

    const activeSnapshots = sentMessages.filter((message) => message && message.action === 'syncTranscriptionProgress' && message.status === 'active');
    assert.equal(activeSnapshots.length >= 2, true);
    assert.deepEqual(activeSnapshots.map((message) => message.totalChunks), [1, 2]);
    assert.equal(activeSnapshots.every((message) => message.sessionId === 'session-progress'), true);

    const stopPromise = chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stop'
    });

    await waitFor(
      () => sentMessages.some((message) => message && message.action === 'syncTranscriptionProgress' && message.status === 'draining'),
      500
    );

    const drainingSnapshots = sentMessages.filter(
      (message) => message && message.action === 'syncTranscriptionProgress' && message.status === 'draining'
    );
    assert.equal(drainingSnapshots.length >= 1, true);
    assert.equal(drainingSnapshots.every((message) => message.totalChunks === 2), true);
    assert.equal(drainingSnapshots.every((message) => message.sessionId === 'session-progress'), true);

    const stopped = await stopPromise;
    assert.deepEqual(stopped, { ok: true });
    assert.equal(processChunkCalls >= 2, true);
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }
});

test('offscreen starts and stops live capture with MediaRecorder streaming blobs into the live runtime', async () => {
  const sentMessages = [];
  const pushCalls = [];
  let flushCalls = 0;
  let stopCalls = 0;

  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => ({ ok: true })
  });
  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message, callback) => {
    sentMessages.push(message);
    return originalSendMessage(message, callback);
  };

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaLiveProviderSessionRuntime: global.PochoclaLiveProviderSessionRuntime,
    PochoclaDeepgramLiveTransport: global.PochoclaDeepgramLiveTransport
  };

  const liveRuntimeStub = {
    createLiveProviderSessionRuntime() {
      return {
        async start() { return { status: 'streaming' }; },
        async pushAudio(blob) {
          pushCalls.push(await blob.text());
          return { status: 'streaming' };
        },
        async flush() {
          flushCalls += 1;
          return { status: 'streaming' };
        },
        async stop() {
          stopCalls += 1;
          return { status: 'stopped' };
        },
        onError() { return () => {}; },
        onFallback() { return () => {}; }
      };
    }
  };

  const liveTransportStub = {
    createDeepgramLiveTransport() {
      return {
        async connect() { return true; },
        async send() { return true; },
        async close() { return true; },
        onMessage() { return () => {}; },
        onError() { return () => {}; },
        onClose() { return () => {}; }
      };
    }
  };

  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
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
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaLiveProviderSessionRuntime', liveRuntimeStub);
  setGlobalValue('PochoclaDeepgramLiveTransport', liveTransportStub);

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'startLiveSession',
      streamId: 'stream-live',
      providerId: 'deepgram',
      providerConfig: { apiKey: 'dg-key', liveEnabled: true },
      sessionContext: {
        sessionId: 'session-live',
        language: 'es',
        activeProvider: 'deepgram'
      }
    });

    assert.equal(started.ok, true);
    const liveRecorder = FakeMediaRecorder.instances.find((instance) => instance.startTimeslice === 250);
    assert.equal(!!liveRecorder, true);

    liveRecorder.ondataavailable({
      data: new Blob(['live-opus-chunk'], { type: 'audio/webm;codecs=opus' })
    });
    await waitFor(() => pushCalls.length === 1, 200);
    assert.deepEqual(pushCalls, ['live-opus-chunk']);

    const flushed = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'flushLiveSession' });
    assert.equal(flushed.ok, true);
    assert.equal(flushCalls, 1);

    const stopped = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stopLiveSession' });
    assert.equal(stopped.ok, true);
    assert.equal(stopCalls, 1);
    assert.equal(flushCalls >= 2, true);
    assert.equal(
      sentMessages.some((message) => message && message.target === 'background' && message.action === 'processChunk'),
      false
    );
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }
});

test('offscreen promoteBatchFallback stops live pipeline and resumes MediaRecorder batch capture without tearing shared media down', async () => {
  const sentMessages = [];
  let processChunkCalls = 0;

  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => {
      processChunkCalls += 1;
      return { ok: true };
    }
  });
  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message, callback) => {
    sentMessages.push(message);
    return originalSendMessage(message, callback);
  };

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaLiveProviderSessionRuntime: global.PochoclaLiveProviderSessionRuntime,
    PochoclaDeepgramLiveTransport: global.PochoclaDeepgramLiveTransport
  };

  let flushCalls = 0;
  let stopCalls = 0;
  const liveRuntimeStub = {
    createLiveProviderSessionRuntime() {
      return {
        async start() { return { status: 'streaming' }; },
        async pushAudio() { return { status: 'streaming' }; },
        async flush() {
          flushCalls += 1;
          return { status: 'streaming' };
        },
        async stop() {
          stopCalls += 1;
          return { status: 'stopped' };
        },
        onError() { return () => {}; },
        onFallback() { return () => {}; }
      };
    }
  };

  const liveTransportStub = {
    createDeepgramLiveTransport() {
      return {
        async connect() { return true; },
        async send() { return true; },
        async close() { return true; },
        onMessage() { return () => {}; },
        onError() { return () => {}; },
        onClose() { return () => {}; }
      };
    }
  };

  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
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
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaLiveProviderSessionRuntime', liveRuntimeStub);
  setGlobalValue('PochoclaDeepgramLiveTransport', liveTransportStub);

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'startLiveSession',
      streamId: 'stream-fallback',
      providerId: 'deepgram',
      providerConfig: { apiKey: 'dg-key', liveEnabled: true },
      sessionContext: {
        sessionId: 'session-fallback',
        language: 'es',
        activeProvider: 'deepgram'
      }
    });

    assert.equal(started.ok, true);
    await waitFor(() => FakeAudioContext.instances.length > 0, 100);
    const audioContext = FakeAudioContext.instances[0];
    const liveRecorder = FakeMediaRecorder.instances.find((instance) => instance.startTimeslice === 250);
    assert.equal(!!liveRecorder, true);

    const promoted = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'promoteBatchFallback',
      sessionId: 'session-fallback',
      sessionContext: {
        sessionId: 'session-fallback',
        language: 'es',
        activeProvider: 'deepgram',
        chunkIntervalMs: 20
      }
    });
    assert.equal(promoted.ok, true);
    assert.equal(stopCalls, 1);
    assert.equal(flushCalls >= 1, true);
    assert.equal(audioContext.processorNodes.length, 1);

    await waitFor(() => getBatchRecorders().length >= 1, 100);
    const batchRecorder = getBatchRecorders()[0];
    assert.equal(!!batchRecorder, true);
    batchRecorder.emitChunk('fallback-batch');
    await waitFor(() => processChunkCalls >= 1, 500);

    assert.equal(
      sentMessages.some((message) => message && message.target === 'background' && message.action === 'processChunk'),
      true
    );

    const stopped = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
    assert.deepEqual(stopped, { ok: true });
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }
});

test('offscreen leaves PCM transcoding branch inactive for current live providers', async () => {
  const chrome = createChromeForOffscreen({
    onProcessChunk: async () => ({ ok: true })
  });

  const originals = {
    chrome: global.chrome,
    navigator: global.navigator,
    AudioContext: global.AudioContext,
    MediaRecorder: global.MediaRecorder,
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge,
    PochoclaProviderRegistry: global.PochoclaProviderRegistry,
    PochoclaLiveProviderSessionRuntime: global.PochoclaLiveProviderSessionRuntime,
    PochoclaDeepgramLiveTransport: global.PochoclaDeepgramLiveTransport
  };

  const pushCalls = [];
  const runtimeStartArgs = [];
  const liveRuntimeStub = {
    providerRequiresPCM() {
      return false;
    },
    async transcodeToPCM() {
      throw new Error('should not transcode');
    },
    createLiveProviderSessionRuntime() {
      return {
        async start(config) {
          runtimeStartArgs.push(config);
          return { status: 'streaming' };
        },
        async pushAudio(blob) {
          pushCalls.push(await blob.text());
          return { status: 'streaming' };
        },
        async flush() { return { status: 'streaming' }; },
        async stop() { return { status: 'stopped' }; },
        onConnect() { return () => {}; },
        onReconnect() { return () => {}; },
        onClose() { return () => {}; },
        onError() { return () => {}; },
        onFallback() { return () => {}; }
      };
    }
  };

  const liveTransportStub = {
    createDeepgramLiveTransport() {
      return {
        async connect() { return true; },
        async send() { return true; },
        async close() { return true; },
        onMessage() { return () => {}; },
        onError() { return () => {}; },
        onClose() { return () => {}; }
      };
    }
  };

  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  setGlobalValue('chrome', chrome);
  setGlobalValue('navigator', {
    mediaDevices: {
      async getUserMedia() {
        return { getTracks() { return [{ stop() {} }]; } };
      }
    }
  });
  setGlobalValue('AudioContext', FakeAudioContext);
  setGlobalValue('MediaRecorder', FakeMediaRecorder);
  setGlobalValue('PochoclaChunkProcessor', chunkProcessor);
  setGlobalValue('PochoclaOffscreenBridge', offscreenBridge);
  setGlobalValue('PochoclaProviderRegistry', {
    getProviderDefinition() {
      return { requiresPCM: false };
    }
  });
  setGlobalValue('PochoclaLiveProviderSessionRuntime', liveRuntimeStub);
  setGlobalValue('PochoclaDeepgramLiveTransport', liveTransportStub);

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'startLiveSession',
      streamId: 'stream-no-pcm',
      providerId: 'deepgram',
      providerConfig: { apiKey: 'dg-key', liveEnabled: true },
      sessionContext: {
        sessionId: 'session-no-pcm',
        language: 'es',
        activeProvider: 'deepgram'
      }
    });

    assert.equal(started.ok, true);
    assert.equal(runtimeStartArgs.length, 1);
    assert.equal(runtimeStartArgs[0].audioFormat, 'audio/webm;codecs=opus');
    assert.equal(runtimeStartArgs[0].requiresPCM, false);
    const liveRecorder = FakeMediaRecorder.instances.find((instance) => instance.startTimeslice === 250);
    liveRecorder.ondataavailable({ data: new Blob(['direct-webm'], { type: 'audio/webm;codecs=opus' }) });
    await waitFor(() => pushCalls.length === 1, 200);
    assert.deepEqual(pushCalls, ['direct-webm']);
  } finally {
    delete require.cache[require.resolve(OFFSCREEN_PATH)];
    Object.entries(originals).forEach(([key, value]) => {
      setGlobalValue(key, value);
    });
  }
});
