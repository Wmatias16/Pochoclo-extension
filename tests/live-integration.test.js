const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const { buildDefaultProviderSettings } = require('../storage/settings.js');
const liveProviderSessionRuntime = require('../runtime/live-provider-session-runtime.js');
const { createHarness } = require('./helpers/extension-harness.js');

function createSettings() {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = 'sk-openai';
  return settings;
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }

  throw new Error('Timed out waiting for condition.');
}

describe('live integration coverage', () => {
  const harnesses = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      harnesses.pop().dispose();
    }
  });

  it('covers Deepgram live happy path end-to-end with volatile partials and final-only transcript persistence', { concurrency: false }, async () => {
    const settings = createSettings();
    settings.defaultProvider = 'deepgram';
    settings.providers.deepgram = { enabled: true, apiKey: 'dg-key', liveEnabled: true };

    const transportListeners = {};
    const harness = createHarness({
      initialStorage: { providerSettings: settings },
      adapterBehaviors: {
        deepgramLiveTransport: {
          connect: async () => true,
          send: async () => true,
          close: async () => true,
          onMessage(callback) {
            transportListeners.message = callback;
            return () => {
              if (transportListeners.message === callback) {
                delete transportListeners.message;
              }
            };
          }
        }
      }
    });
    harnesses.push(harness);

    const started = await harness.startCapture({ tabId: 70, tabTitle: 'Live happy path', tabUrl: 'https://example.com/live-happy' });
    assert.equal(started.ok, true);
    assert.equal(started.transcriptSession.mode, 'live');
    assert.equal(harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'startLiveSession'), true);

    transportListeners.message({ type: 'partial', text: 'hola par', providerId: 'deepgram', raw: { id: 1 } });
    await waitFor(() => harness.storageArea.store.transcript && harness.storageArea.store.transcript.interim === 'hola par');
    assert.equal(harness.storageArea.store.transcript.text, '');
    assert.equal(harness.storageArea.store.transcript.final, '');

    transportListeners.message({ type: 'final', text: 'hola final', providerId: 'deepgram', raw: { id: 1, is_final: true } });
    await waitFor(() => harness.storageArea.store.transcript && harness.storageArea.store.transcript.final === 'hola final ');
    assert.equal(harness.storageArea.store.transcript.interim, '');

    transportListeners.message({ type: 'partial', text: 'mundo', providerId: 'deepgram', raw: { id: 2 } });
    await waitFor(() => harness.storageArea.store.transcript && harness.storageArea.store.transcript.interim === 'mundo');
    assert.equal(harness.storageArea.store.transcript.text, 'hola final ');

    transportListeners.message({ type: 'final', text: 'mundo final', providerId: 'deepgram', raw: { id: 2, is_final: true } });
    await waitFor(() => harness.storageArea.store.transcript && harness.storageArea.store.transcript.final === 'hola final mundo final ');

    const liveTranscript = await harness.getLiveTranscript(started.transcriptSession.id);
    assert.equal(liveTranscript.ok, true);
    assert.equal(liveTranscript.liveTranscript.text, 'hola final mundo final ');
    assert.equal(liveTranscript.liveTranscript.interim, '');
    assert.equal(liveTranscript.liveTranscript.mode, 'live');

    const stopped = await harness.stopCapture();
    assert.equal(stopped.ok, true);

    const saved = await harness.getSavedTranscriptions();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].text.trim(), 'hola final mundo final');
    assert.equal(saved[0].final.trim(), 'hola final mundo final');
    assert.equal(saved[0].interim, '');
    assert.equal(saved[0].mode, 'live');
  });

  it('covers reconnect exhaustion degrading to batch fallback without stopping capture or duplicating final text', { concurrency: false }, async () => {
    const settings = createSettings();
    settings.defaultProvider = 'deepgram';
    settings.providers.deepgram = { enabled: true, apiKey: 'dg-key', liveEnabled: true };

    const transportListeners = {};

    const harness = createHarness({
      initialStorage: { providerSettings: settings },
      adapterBehaviors: {
        deepgramLiveTransport: {
          async connect() { return true; },
          async send() { return true; },
          async close() {
            return true;
          },
          onMessage(callback) {
            transportListeners.message = callback;
            return () => {
              if (transportListeners.message === callback) {
                delete transportListeners.message;
              }
            };
          }
        },
        deepgram: {
          async transcribe() {
            return { text: 'texto batch' };
          }
        }
      }
    });
    harnesses.push(harness);

    const background = require('../background.js');

    const started = await harness.startCapture({ tabId: 71, tabTitle: 'Live fallback', tabUrl: 'https://example.com/live-fallback' });
    assert.equal(started.ok, true);
    assert.equal(started.transcriptSession.mode, 'live');

    transportListeners.message({ type: 'final', text: 'hola live', providerId: 'deepgram', raw: { id: 1, is_final: true } });
    await waitFor(() => harness.storageArea.store.transcript && harness.storageArea.store.transcript.final === 'hola live ');

    const errorResult = await background.handleLiveError({
      action: 'liveError',
      sessionId: started.transcriptSession.id,
      providerId: 'deepgram',
      code: 'transport_error',
      message: 'socket dropped',
      retryable: true,
      reconnects: 1,
      at: 20
    });
    assert.equal(errorResult.ok, true);

    const fallbackResult = await background.handleLiveFallback({
      action: 'liveFallback',
      sessionId: started.transcriptSession.id,
      providerId: 'deepgram',
      reason: 'reconnect_exhausted',
      reconnects: liveProviderSessionRuntime.MAX_RECONNECTS,
      at: 21
    });
    assert.equal(fallbackResult.ok, true);
    assert.equal(fallbackResult.fallbackQueued, true);

    assert.equal(harness.storageArea.store.recState.status, 'recording');
    assert.equal(harness.storageArea.store.transcriptSession.live.status, 'fallback');
    assert.equal(harness.storageArea.store.transcriptSession.live.fallbackReason, 'reconnect_exhausted');
    assert.equal(harness.storageArea.store.transcriptSession.mode, 'batch');
    assert.equal(harness.storageArea.store.transcript.text.trim(), 'hola live');
    assert.equal(harness.storageArea.store.transcript.final.trim(), 'hola live');
    assert.equal(harness.storageArea.store.transcript.mode, 'batch');
    assert.equal(
      harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'promoteBatchFallback'),
      true
    );

    const chunkResult = await harness.dispatchChunk({
      sessionId: started.transcriptSession.id,
      chunkIndex: 0,
      body: 'batch-audio'
    });
    assert.equal(chunkResult.ok, true);
    assert.equal(harness.storageArea.store.transcript.text.trim(), 'hola live texto batch');
    assert.equal(harness.storageArea.store.transcript.final.trim(), 'hola live texto batch');
    assert.deepEqual(harness.storageArea.store.transcript.providerAttribution, ['deepgram-live', 'deepgram-batch']);

    const stopped = await harness.stopCapture();
    assert.equal(stopped.ok, true);
  });

  it('covers non-live providers staying on the batch path and never attempting live startup', { concurrency: false }, async () => {
    const settings = createSettings();
    settings.defaultProvider = 'google';
    settings.providers.google = { enabled: true, apiKey: 'google-key' };

    const harness = createHarness({
      initialStorage: { providerSettings: settings }
    });
    harnesses.push(harness);

    const started = await harness.startCapture({ tabId: 72, tabTitle: 'Google batch', tabUrl: 'https://example.com/google-batch' });
    assert.equal(started.ok, true);
    assert.equal(started.transcriptSession.mode, 'batch');
    assert.equal(started.transcriptSession.activeProvider, 'google');
    assert.equal(
      harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'startLiveSession'),
      false
    );
    assert.equal(
      harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'start'),
      true
    );

    const stopped = await harness.stopCapture();
    assert.equal(stopped.ok, true);
  });
});
