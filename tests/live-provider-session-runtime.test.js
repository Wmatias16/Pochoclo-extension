const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLiveProviderSessionRuntime,
  providerRequiresPCM,
  resolveAudioPipeline,
  transcodeToPCM
} = require('../runtime/live-provider-session-runtime.js');

function createMockTransport({ connectFailures = [], sendFailures = [] } = {}) {
  const state = {
    connectCalls: [],
    sendCalls: [],
    closeCalls: 0
  };

  return {
    state,
    async connect(url, protocols) {
      state.connectCalls.push({ url, protocols });
      const failure = connectFailures.shift();
      if (failure) {
        throw failure;
      }
      return true;
    },
    async send(data) {
      state.sendCalls.push(data);
      const failure = sendFailures.shift();
      if (failure) {
        throw failure;
      }
      return true;
    },
    async close() {
      state.closeCalls += 1;
      return true;
    }
  };
}

test('live runtime flushes pending audio before stopping cleanly', async () => {
  const waits = [];
  const transport = createMockTransport();
  const runtime = createLiveProviderSessionRuntime({
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  await runtime.start({
    providerId: 'deepgram',
    audioFormat: 'webm/opus',
    url: 'wss://example.test/live',
    protocols: ['token'],
    flushPayload: { type: 'flush' },
    transport
  });
  await runtime.pushAudio('audio-1');
  await runtime.stop();

  assert.equal(runtime.getState().status, 'stopped');
  assert.deepEqual(transport.state.sendCalls, ['audio-1', { type: 'flush' }]);
  assert.equal(transport.state.closeCalls, 1);
  assert.deepEqual(waits, []);
});

test('live runtime reconnects once after a transient send failure and resumes streaming', async () => {
  const waits = [];
  const errors = [];
  const transport = createMockTransport({
    sendFailures: [new Error('socket dropped')]
  });
  const runtime = createLiveProviderSessionRuntime({
    wait: async (ms) => {
      waits.push(ms);
    }
  });
  runtime.onError((event) => {
    errors.push(event.reason);
  });

  await runtime.start({
    providerId: 'deepgram',
    audioFormat: 'webm/opus',
    url: 'wss://example.test/live',
    protocols: ['token'],
    transport
  });
  await runtime.pushAudio('audio-1');

  assert.equal(runtime.getState().status, 'streaming');
  assert.equal(runtime.getState().reconnects, 1);
  assert.deepEqual(waits, [1000]);
  assert.equal(transport.state.connectCalls.length, 2);
  assert.deepEqual(transport.state.sendCalls, ['audio-1', 'audio-1']);
  assert.equal(errors.length >= 1, true);
});

test('live runtime emits fallback after bounded reconnects are exhausted', async () => {
  const waits = [];
  const fallbacks = [];
  const transport = createMockTransport({
    sendFailures: [new Error('socket dropped 1'), new Error('socket dropped 2'), new Error('socket dropped 3')]
  });
  const runtime = createLiveProviderSessionRuntime({
    wait: async (ms) => {
      waits.push(ms);
    }
  });
  runtime.onFallback((event) => {
    fallbacks.push(event.reason);
  });

  await runtime.start({
    providerId: 'deepgram',
    audioFormat: 'webm/opus',
    url: 'wss://example.test/live',
    protocols: ['token'],
    transport
  });

  await assert.rejects(
    () => runtime.pushAudio('audio-1'),
    /reconnect/i
  );

  assert.equal(runtime.getState().status, 'error');
  assert.equal(runtime.getState().reconnects, 2);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(fallbacks, ['reconnect_exhausted']);
  assert.equal(transport.state.connectCalls.length, 3);
});

test('live runtime retries startup connect and emits startup fallback after exhaustion', async () => {
  const waits = [];
  const errors = [];
  const fallbacks = [];
  const transport = createMockTransport({
    connectFailures: [new Error('connect 1'), new Error('connect 2'), new Error('connect 3')]
  });
  const runtime = createLiveProviderSessionRuntime({
    wait: async (ms) => {
      waits.push(ms);
    }
  });
  runtime.onError((event) => {
    errors.push(event.reason);
  });
  runtime.onFallback((event) => {
    fallbacks.push(event.reason);
  });

  await assert.rejects(
    () => runtime.start({
      providerId: 'deepgram',
      audioFormat: 'webm/opus',
      url: 'wss://example.test/live',
      protocols: ['token'],
      transport
    }),
    /startup_failed/i
  );

  assert.equal(runtime.getState().status, 'error');
  assert.equal(runtime.getState().reconnects, 2);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(errors, ['startup_connect_failed', 'startup_reconnect_failed', 'startup_reconnect_failed']);
  assert.deepEqual(fallbacks, ['startup_failed']);
  assert.equal(transport.state.connectCalls.length, 3);
});

test('PCM helpers stay inactive until a future provider enables the capability', async () => {
  assert.equal(providerRequiresPCM('deepgram', {
    getProviderDefinition() {
      return { liveAudioFormat: 'webm/opus', requiresPCM: false };
    }
  }), false);

  assert.equal(resolveAudioPipeline({ audioFormat: 'webm/opus', requiresPCM: false }), 'direct');
  assert.equal(resolveAudioPipeline({ audioFormat: 'pcm16', requiresPCM: false }), 'pcm-transcoder');

  await assert.rejects(
    () => transcodeToPCM(new Blob(['audio'])),
    /PCM transcoding not yet implemented/
  );
});
