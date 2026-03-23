const test = require('node:test');
const assert = require('node:assert/strict');

const { createSerialProcessor } = require('../runtime/chunk-processor.js');
const {
  buildProcessChunkMessage,
  deserializeChunkBlob,
  dispatchChunkToBackground,
  serializeChunkBlob
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
