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

test('offscreen capture keeps emitting chunks while the first background response is still pending', async () => {
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
    await waitFor(() => audioContext.processorNodes.length > 0, 100);
    const processorNode = audioContext.processorNodes[0];
    const loudSamples = [0.25, -0.2, 0.15, -0.1, 0.05, -0.04, 0.03, -0.02];
    for (let index = 0; index < 12; index += 1) {
      processorNode.emitAudio(loudSamples);
      await wait(5);
    }

    await waitFor(() => enqueueCount >= 2, 600);

    assert.equal(processChunkCalls, 1);
    assert.equal(enqueueCount >= 2, true);

    const sessionRecorder = FakeMediaRecorder.instances.find((instance) => instance.startTimeslice === 1000);
    assert.equal(!!sessionRecorder, true);

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

test('offscreen throttles audioActivity heartbeats and resets them across pause/resume', async () => {
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
    const processorNode = FakeAudioContext.instances[0].processorNodes[0];
    const loudSamples = [0.2, -0.18, 0.15, -0.1];

    processorNode.emitAudio(loudSamples);
    nowValue += 500;
    processorNode.emitAudio(loudSamples);
    nowValue += 2_600;
    processorNode.emitAudio(loudSamples);

    const heartbeatsBeforePause = sentMessages.filter(
      (message) => message && message.target === 'background' && message.action === 'audioActivity'
    );
    assert.equal(heartbeatsBeforePause.length, 2);
    assert.deepEqual(
      heartbeatsBeforePause.map((message) => message.at),
      [1_000, 4_100]
    );

    const paused = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause' });
    assert.equal(paused.ok, true);

    nowValue += 300;
    processorNode.emitAudio(loudSamples);
    assert.equal(
      sentMessages.filter((message) => message && message.target === 'background' && message.action === 'audioActivity').length,
      2
    );

    const resumed = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume' });
    assert.equal(resumed.ok, true);

    nowValue += 200;
    const resumedProcessorNode = FakeAudioContext.instances[0].processorNodes.at(-1);
    resumedProcessorNode.emitAudio(loudSamples);

    const heartbeatsAfterResume = sentMessages.filter(
      (message) => message && message.target === 'background' && message.action === 'audioActivity'
    );
    assert.equal(heartbeatsAfterResume.length, 3);
    assert.equal(heartbeatsAfterResume[2].at, 4_600);

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

test('offscreen uses RMS threshold so isolated spikes do not count as activity', async () => {
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
    PochoclaChunkProcessor: global.PochoclaChunkProcessor,
    PochoclaOffscreenBridge: global.PochoclaOffscreenBridge,
    DateNow: Date.now
  };

  let nowValue = 9_000;
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
  Date.now = () => nowValue;

  delete require.cache[require.resolve(OFFSCREEN_PATH)];
  require(OFFSCREEN_PATH);

  try {
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      streamId: 'stream-rms',
      sessionContext: {
        sessionId: 'session-rms',
        chunkIntervalMs: 20
      }
    });

    assert.equal(started.ok, true);

    await waitFor(() => FakeAudioContext.instances.length > 0, 100);
    const processorNode = FakeAudioContext.instances[0].processorNodes[0];

    processorNode.emitAudio([0.14, 0, 0, 0, 0, 0, 0, 0]);
    processorNode.emitAudio([0.13, 0, 0, 0, 0, 0, 0, 0]);

    const spikeHeartbeats = sentMessages.filter(
      (message) => message && message.target === 'background' && message.action === 'audioActivity'
    );
    assert.equal(spikeHeartbeats.length, 0);

    nowValue += 3_000;
    processorNode.emitAudio([0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08]);

    const rmsHeartbeats = sentMessages.filter(
      (message) => message && message.target === 'background' && message.action === 'audioActivity'
    );
    assert.equal(rmsHeartbeats.length, 1);
    assert.equal(rmsHeartbeats[0].at, 12_000);

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

test('offscreen syncs accepted chunk totals and keeps draining progress visible after stop without counting silent chunks', async () => {
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
    const processorNode = FakeAudioContext.instances[0].processorNodes[0];

    processorNode.emitAudio([0, 0, 0, 0, 0, 0, 0, 0]);
    await wait(30);
    assert.equal(
      sentMessages.filter((message) => message && message.action === 'syncTranscriptionProgress').length,
      0
    );

    processorNode.emitAudio([0.2, -0.18, 0.15, -0.1, 0.08, -0.06, 0.04, -0.02]);
    await wait(30);
    processorNode.emitAudio([0.22, -0.2, 0.16, -0.1, 0.07, -0.05, 0.03, -0.02]);
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

test('offscreen promoteBatchFallback stops live pipeline and resumes chunk capture without tearing shared media down', async () => {
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
    assert.equal(audioContext.processorNodes.length >= 2, true);

    const chunkProcessorNode = audioContext.processorNodes.at(-1);
    chunkProcessorNode.emitAudio([0.2, -0.18, 0.15, -0.1, 0.08, -0.05, 0.03, -0.02]);
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
