const test = require('node:test');
const assert = require('node:assert/strict');

const { createSerialProcessor } = require('../runtime/chunk-processor.js');
const {
  LIVE_BRIDGE_ACTIONS,
  buildFlushLiveSessionMessage,
  buildProcessChunkMessage,
  buildStartLiveSessionMessage,
  buildStopLiveSessionMessage,
  deserializeChunkBlob,
  deserializeLiveAudioChunk,
  dispatchChunkToBackground,
  dispatchLiveAudioChunkToBackground,
  serializeChunkBlob,
  serializeLiveAudioChunk
} = require('../runtime/offscreen-bridge.js');

test('chunk processor preserves order while accepting new work during background execution', async () => {
  const order = [];
  let releaseFirst;

  const processor = createSerialProcessor(async (item) => {
    order.push(`start:${item}`);
    if (item === 1) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    order.push(`end:${item}`);
  });

  processor.enqueue(1);
  processor.enqueue(2);
  processor.enqueue(3);

  assert.equal(processor.isProcessing(), true);
  assert.equal(processor.size(), 2);

  releaseFirst();
  await processor.waitForIdle();

  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
});

test('offscreen bridge sends blob plus session context to background', async () => {
  const blob = new Blob(['audio']);
  const sent = [];
  const serialized = await serializeChunkBlob(blob);
  const response = await dispatchChunkToBackground({
    blob,
    sessionContext: { sessionId: 'txs_1', chunkIndex: 7 },
    sendMessage: async (message) => {
      sent.push(message);
      return { ok: true };
    }
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(sent[0], buildProcessChunkMessage(serialized, { sessionId: 'txs_1', chunkIndex: 7 }));
});

test('offscreen bridge serializes chunk audio and restores it as a Blob', async () => {
  const blob = new Blob(['hola mundo'], { type: 'audio/webm' });
  blob.sampleRate = 16000;
  const serialized = await serializeChunkBlob(blob);
  const restored = deserializeChunkBlob(serialized);

  assert.equal(restored instanceof Blob, true);
  assert.equal(restored.type, 'audio/webm');
  assert.equal(await restored.text(), 'hola mundo');
  assert.equal(serialized.sampleRate, 16000);
});

test('offscreen bridge exposes live session messages without breaking batch chunk helpers', async () => {
  const sent = [];
  const blob = new Blob(['live-audio'], { type: 'audio/webm;codecs=opus' });
  const serialized = await serializeLiveAudioChunk(blob);
  const restored = deserializeLiveAudioChunk(serialized);

  const startMessage = buildStartLiveSessionMessage({
    sessionId: 'txs_live',
    sessionContext: { providerId: 'deepgram', audioFormat: 'webm/opus' }
  });
  const flushMessage = buildFlushLiveSessionMessage({ sessionId: 'txs_live' }, { reason: 'stop' });
  const stopMessage = buildStopLiveSessionMessage({ sessionId: 'txs_live' }, { reason: 'user_stop' });
  const audioResponse = await dispatchLiveAudioChunkToBackground({
    blob,
    sessionContext: { sessionId: 'txs_live', chunkIndex: 2 },
    sendMessage: async (message) => {
      sent.push(message);
      return { ok: true };
    }
  });

  assert.equal(startMessage.action, LIVE_BRIDGE_ACTIONS.START_LIVE_SESSION);
  assert.equal(flushMessage.action, LIVE_BRIDGE_ACTIONS.FLUSH_LIVE_SESSION);
  assert.equal(stopMessage.action, LIVE_BRIDGE_ACTIONS.STOP_LIVE_SESSION);
  assert.equal(await restored.text(), 'live-audio');
  assert.equal(audioResponse.ok, true);
  assert.equal(sent[0].action, LIVE_BRIDGE_ACTIONS.LIVE_AUDIO_CHUNK);
  assert.equal(sent[0].audio.mimeType, 'audio/webm;codecs=opus');
});
