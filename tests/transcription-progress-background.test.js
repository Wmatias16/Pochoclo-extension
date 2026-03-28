const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: nativeSetTimeout, clearTimeout: nativeClearTimeout } = require('node:timers');
const { setTimeout: delay } = require('node:timers/promises');

const { buildDefaultProviderSettings } = require('../storage/settings.js');
const { createHarness } = require('./helpers/extension-harness.js');
const liveProviderSessionRuntime = require('../runtime/live-provider-session-runtime.js');

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

test('background resets progress on start, keeps totals monotonic, rejects stale snapshots, and clears after drain completion', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: {
      providerSettings: createSettings(),
      transcriptionProgress: {
        sessionId: 'stale-session',
        totalChunks: 8,
        completedChunks: 8,
        status: 'done',
        updatedAt: 101
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 41, tabTitle: 'Progress reset', tabUrl: 'https://example.com/progress-reset' });
  assert.equal(started.ok, true);

  const startedProgress = harness.storageArea.store.transcriptionProgress;
  assert.equal(startedProgress.sessionId, started.transcriptSession.id);
  assert.equal(startedProgress.totalChunks, 0);
  assert.equal(startedProgress.completedChunks, 0);
  assert.equal(startedProgress.status, 'active');

  const firstSync = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 3,
    status: 'active',
    updatedAt: 1_111
  });
  assert.equal(firstSync.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 0);

  const monotonicSync = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 1,
    status: 'active',
    updatedAt: 1_222
  });
  assert.equal(monotonicSync.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);

  const staleSync = await background.syncTranscriptionProgress({
    sessionId: 'old-session',
    totalChunks: 99,
    status: 'draining',
    updatedAt: 1_333
  });
  assert.deepEqual(staleSync, { ok: true, ignored: true, reason: 'stale-session' });
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'active');

  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);
  assert.equal(harness.storageArea.store.recState.status, 'idle');

  const drainingSync = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 3,
    status: 'draining',
    updatedAt: 1_444
  });
  assert.equal(drainingSync.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'draining');

  await background.patchTranscriptionProgress({
    completedChunks: 2,
    status: 'draining',
    updatedAt: 1_555
  });
  const stillVisible = await background.maybeFinalizeTranscriptionProgress();
  assert.equal(stillVisible.completedChunks, 2);
  assert.equal(stillVisible.status, 'draining');
  assert.equal('transcriptionProgress' in harness.storageArea.store, true);

  await background.patchTranscriptionProgress({
    completedChunks: 3,
    status: 'done',
    updatedAt: 1_666
  });
  const finalized = await background.maybeFinalizeTranscriptionProgress();
  assert.equal(finalized, null);
  assert.equal('transcriptionProgress' in harness.storageArea.store, false);
});

test('background counts successful and failed terminal chunk outcomes as completed exactly once before final cleanup', { concurrency: false }, async (t) => {
  let transcribeCalls = 0;
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          transcribeCalls += 1;
          if (transcribeCalls === 1) {
            return { text: 'chunk ok' };
          }

          const error = new Error('temporary unavailable');
          error.code = 'temporary_unavailable';
          throw error;
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 42, tabTitle: 'Terminal completion', tabUrl: 'https://example.com/terminal-completion' });
  assert.equal(started.ok, true);

  await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 2,
    status: 'active',
    updatedAt: 2_000
  });

  const firstChunk = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'good-audio'
  });
  assert.equal(firstChunk.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 1);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'active');

  const secondChunk = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 1,
    body: 'bad-audio'
  });
  assert.equal(secondChunk.ok, false);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 2);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'done');

  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);
  assert.equal('transcriptionProgress' in harness.storageArea.store, false);
});

test('background enriches batch chunk transcripts with active video timestamps', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }
      assert.equal(tabId, 61);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return {
        hasVideo: true,
        currentTimeSec: 20.4,
        durationSec: 120,
        paused: false
      };
    },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          return { text: 'chunk con video' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture({ tabId: 61, tabTitle: 'Chunk timestamp', tabUrl: 'https://example.com/chunk-timestamp' });
  assert.equal(started.ok, true);

  const chunkResult = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'video-audio'
  });

  assert.equal(chunkResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.text, 'chunk con video [00m 20s]');
  assert.equal(harness.storageArea.store.transcript.final, 'chunk con video [00m 20s]');
  assert.deepEqual(harness.storageArea.store.transcript.segments, [
    {
      text: 'chunk con video',
      timestampSec: 20.4,
      timestampLabel: '[00m 20s]'
    }
  ]);
  assert.equal(harness.chrome.__tabMessages.at(-1).tabId, 61);
});

test('background falls back to unlabeled batch segments when video snapshot times out', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }

      assert.equal(tabId, 62);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return new Promise(() => {});
    },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          return { text: 'chunk timeout' };
        }
      }
    }
  });
  t.after(() => harness.dispose());
  global.setTimeout = nativeSetTimeout;
  global.clearTimeout = nativeClearTimeout;

  const started = await harness.startCapture({ tabId: 62, tabTitle: 'Chunk timeout', tabUrl: 'https://example.com/chunk-timeout' });
  assert.equal(started.ok, true);

  const chunkResult = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'timeout-audio'
  });

  assert.equal(chunkResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.text, 'chunk timeout');
  assert.deepEqual(harness.storageArea.store.transcript.segments, [
    {
      text: 'chunk timeout',
      timestampSec: null,
      timestampLabel: null
    }
  ]);
});

test('background stores unlabeled batch segments when the tab has no active video', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }

      assert.equal(tabId, 63);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return { hasVideo: false };
    },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          return { text: 'chunk sin video' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture({ tabId: 63, tabTitle: 'Chunk no video', tabUrl: 'https://example.com/chunk-no-video' });
  assert.equal(started.ok, true);

  const chunkResult = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'no-video-audio'
  });

  assert.equal(chunkResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.text, 'chunk sin video');
  assert.deepEqual(harness.storageArea.store.transcript.segments, [
    {
      text: 'chunk sin video',
      timestampSec: null,
      timestampLabel: null
    }
  ]);
});

test('background keeps live partials volatile, appends finals, suppresses late partials, and marks fallback without crashing', { concurrency: false }, async (t) => {
  const settings = createSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram = { enabled: true, apiKey: 'dg-key', liveEnabled: true };

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }
      assert.equal(tabId, 52);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return {
        hasVideo: true,
        currentTimeSec: 65,
        durationSec: 300,
        paused: false
      };
    },
    adapterBehaviors: {
      deepgramLiveTransport: {
        connect: async () => true,
        send: async () => true,
        close: async () => true
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 52, tabTitle: 'Live partials', tabUrl: 'https://example.com/live' });
  assert.equal(started.ok, true);

  const partialResult = await background.applyLiveTranscriptEvent({
    action: 'livePartial',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola par',
    at: 10
  });
  assert.equal(partialResult.ok, true);
  assert.equal(partialResult.transcript.interim, 'hola par');
  assert.equal(harness.storageArea.store.transcript.interim, 'hola par');
  assert.equal(harness.storageArea.store.transcript.mode, 'live');
  assert.equal(
    harness.chrome.__tabMessages.some((entry) => entry.message && entry.message.action === 'getActiveVideoTime'),
    false
  );

  const finalResult = await background.applyLiveTranscriptEvent({
    action: 'liveFinal',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola final',
    at: 11
  });
  assert.equal(finalResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.interim, '');
  assert.equal(harness.storageArea.store.transcript.text, 'hola final [01m 05s]');
  assert.equal(harness.storageArea.store.transcript.final, 'hola final [01m 05s]');
  assert.equal(harness.storageArea.store.transcript.mode, 'live');
  assert.deepEqual(harness.storageArea.store.transcript.segments, [
    {
      text: 'hola final',
      timestampSec: 65,
      timestampLabel: '[01m 05s]'
    }
  ]);

  const latePartialResult = await background.applyLiveTranscriptEvent({
    action: 'livePartial',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola final',
    at: 11.5
  });
  assert.equal(latePartialResult.ok, true);
  assert.equal(latePartialResult.suppressed, true);
  assert.equal(harness.storageArea.store.transcript.text, 'hola final [01m 05s]');
  assert.equal(harness.storageArea.store.transcript.interim, '');

  const errorResult = await background.handleLiveError({
    action: 'liveError',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    code: 'transport_error',
    message: 'socket down',
    retryable: true
  });
  assert.equal(errorResult.ok, true);

  const fallbackResult = await background.handleLiveFallback({
    action: 'liveFallback',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    reason: 'reconnect_exhausted',
    reconnects: 2,
    at: 12
  });
  assert.equal(fallbackResult.ok, true);
  assert.equal(fallbackResult.fallbackQueued, true);
  assert.equal(harness.storageArea.store.transcriptSession.mode, 'batch');
  assert.equal(harness.storageArea.store.transcript.mode, 'batch');
  assert.equal(harness.storageArea.store.transcriptSession.live.status, 'fallback');
  assert.equal(harness.storageArea.store.transcriptSession.live.fallbackReason, 'reconnect_exhausted');
  assert.equal(fallbackResult.promoteResult.ok, true);
  assert.equal(
    harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'promoteBatchFallback'),
    true
  );
});

test('background degrades startup live failure to batch and keeps finalized text continuous after fallback', { concurrency: false }, async (t) => {
  const settings = createSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram = { enabled: true, apiKey: 'dg-key', liveEnabled: true };

  let connectAttempts = 0;
  const immediateReconnectRuntime = {
    ...liveProviderSessionRuntime,
    createLiveProviderSessionRuntime() {
      return liveProviderSessionRuntime.createLiveProviderSessionRuntime({
        wait: async () => {}
      });
    }
  };
  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }
      assert.equal(tabId, 53);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return { hasVideo: false };
    },
    liveProviderSessionRuntime: immediateReconnectRuntime,
    adapterBehaviors: {
      deepgramLiveTransport: {
        async connect() {
          connectAttempts += 1;
          throw new Error(`connect failed ${connectAttempts}`);
        },
        async send() { return true; },
        async close() { return true; }
      },
      deepgram: {
        async transcribe() {
          return { text: 'texto batch' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 53, tabTitle: 'Startup fallback', tabUrl: 'https://example.com/live-fallback' });
  assert.equal(started.ok, true);

  await waitFor(() => harness.storageArea.store.transcriptSession && harness.storageArea.store.transcriptSession.mode === 'batch');
  assert.equal(connectAttempts, 3);
  assert.equal(harness.storageArea.store.transcriptSession.live.fallbackReason, 'startup_failed');
  assert.equal(
    harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'promoteBatchFallback'),
    true
  );

  const liveFinalResult = await background.applyLiveTranscriptEvent({
    action: 'liveFinal',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'live final',
    at: 20
  });
  assert.equal(liveFinalResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.text, 'live final');
  assert.deepEqual(harness.storageArea.store.transcript.segments, [
    {
      text: 'live final',
      timestampSec: null,
      timestampLabel: null
    }
  ]);

  const chunkResult = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'batch-audio'
  });
  assert.equal(chunkResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.text, 'live final\ntexto batch');
  assert.equal(harness.storageArea.store.transcript.final, 'live final\ntexto batch');
  assert.equal(harness.storageArea.store.transcript.mode, 'batch');
});

test('background exposes live transcript surface with faster polling and auditable metadata', { concurrency: false }, async (t) => {
  const settings = createSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram = { enabled: true, apiKey: 'dg-key', liveEnabled: true };

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }
      assert.equal(tabId, 60);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return {
        hasVideo: true,
        currentTimeSec: 125,
        durationSec: 400,
        paused: true
      };
    },
    adapterBehaviors: {
      deepgramLiveTransport: {
        connect: async () => true,
        send: async () => true,
        close: async () => true
      },
      deepgram: {
        async transcribe() {
          return { text: 'segmento batch' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 60, tabTitle: 'Live surface', tabUrl: 'https://example.com/live-surface' });
  assert.equal(started.ok, true);
  assert.equal(started.transcriptSession.mode, 'live');
  assert.equal(started.transcriptSession.pollIntervalMs, 150);

  await background.handleLiveConnect({
    action: 'liveConnect',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    reconnects: 0,
    at: 1
  });

  const partialResult = await background.applyLiveTranscriptEvent({
    action: 'livePartial',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola en vivo',
    at: 2,
    meta: { token: 'secret-token' }
  });
  assert.equal(partialResult.liveTranscript.interim, 'hola en vivo');
  assert.equal(partialResult.liveTranscript.pollIntervalMs, 150);
  assert.equal(partialResult.liveTranscript.providerAttribution[0], 'deepgram-live');

  const finalResult = await background.applyLiveTranscriptEvent({
    action: 'liveFinal',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola final',
    at: 3
  });
  assert.equal(finalResult.liveTranscript.final, 'hola final [02m 05s]');
  assert.equal(finalResult.liveTranscript.interim, '');

  const fallbackResult = await background.handleLiveFallback({
    action: 'liveFallback',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    reason: 'reconnect_exhausted',
    reconnects: 2,
    at: 4
  });
  assert.equal(fallbackResult.liveTranscript.mode, 'batch');
  assert.equal(fallbackResult.liveTranscript.fallbackReason, 'reconnect_exhausted');
  assert.equal(fallbackResult.liveTranscript.reconnectCount, 2);
  assert.deepEqual(fallbackResult.liveTranscript.providerAttribution, ['deepgram-live', 'deepgram-batch']);

  const chunkResult = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'batch-audio'
  });
  assert.equal(chunkResult.ok, true);

  await background.handleLiveClose({
    action: 'liveClose',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    at: 5
  });

  const liveTranscriptResponse = await harness.getLiveTranscript(started.transcriptSession.id);
  assert.equal(liveTranscriptResponse.ok, true);
  assert.equal(liveTranscriptResponse.liveTranscript.text, 'hola final [02m 05s]\nsegmento batch [02m 05s]');
  assert.equal(liveTranscriptResponse.liveTranscript.terminalStatus, 'fallback-to-batch');
  assert.equal(liveTranscriptResponse.liveTranscript.liveMeta.finalSegments, 1);
  assert.equal(liveTranscriptResponse.liveTranscript.pollIntervalMs, 300);

  const storedSession = harness.storageArea.store.transcriptSession;
  assert.equal(storedSession.audit.liveEvents.some((event) => event.event === 'live:partial'), true);
  assert.equal(storedSession.audit.liveEvents.some((event) => event.event === 'live:fallback'), true);
  assert.equal(storedSession.audit.liveEvents.some((event) => event.event === 'live:close'), true);
  const partialAuditEvent = storedSession.audit.liveEvents.find((event) => event.event === 'live:partial');
  assert.equal(partialAuditEvent.payload.meta.token, '[redacted]');
});

test('background stores live finals without timestamp when no active video exists', { concurrency: false }, async (t) => {
  const settings = createSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram = { enabled: true, apiKey: 'dg-key', liveEnabled: true };

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    tabSendMessage(tabId, message) {
      if (message.type === 'recording-state-changed') {
        return { ok: true };
      }

      assert.equal(tabId, 64);
      assert.deepEqual(message, { action: 'getActiveVideoTime' });
      return { hasVideo: false };
    },
    adapterBehaviors: {
      deepgramLiveTransport: {
        connect: async () => true,
        send: async () => true,
        close: async () => true
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 64, tabTitle: 'Live no video', tabUrl: 'https://example.com/live-no-video' });
  assert.equal(started.ok, true);

  const finalResult = await background.applyLiveTranscriptEvent({
    action: 'liveFinal',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'sin timestamp',
    at: 30
  });

  assert.equal(finalResult.ok, true);
  assert.equal(harness.storageArea.store.transcript.text, 'sin timestamp');
  assert.deepEqual(harness.storageArea.store.transcript.segments, [
    {
      text: 'sin timestamp',
      timestampSec: null,
      timestampLabel: null
    }
  ]);
});
