const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const chunkProcessor = require('../runtime/chunk-processor.js');
const offscreenBridge = require('../runtime/offscreen-bridge.js');

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
