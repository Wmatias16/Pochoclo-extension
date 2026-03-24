const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDefaultProviderSettings } = require('../storage/settings.js');
const { createHarness } = require('./helpers/extension-harness.js');

function createBaseSettings() {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = 'sk-openai';
  settings.providers.deepgram = { enabled: true, apiKey: 'dg-key' };
  settings.providers.assemblyai = { enabled: true, apiKey: 'aa-key' };
  settings.providers.groq = { enabled: true, apiKey: 'gsk-key' };
  settings.providers.whisperLocal = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8765',
    healthPath: '/health',
    transcribePath: '/transcribe'
  };
  return settings;
}

test('default provider flow uses background/offscreen messaging and saves resolved provider audit', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'deepgram';

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      deepgram: {
        async transcribe() {
          return { text: 'hola deepgram' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, true);
  assert.equal(started.transcriptSession.activeProvider, 'deepgram');

  const chunkResult = await harness.dispatchChunk({ chunkIndex: 0 });
  assert.equal(chunkResult.ok, true);
  assert.equal(chunkResult.providerId, 'deepgram');

  const liveTranscript = await harness.getTranscript();
  assert.equal(liveTranscript.final, 'hola deepgram ');

  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);

  const history = await harness.getSavedTranscriptions();
  assert.equal(history.length, 1);
  assert.equal(history[0].resolvedProvider, 'deepgram');
  assert.equal(history[0].providerAudit.attempts[0].providerId, 'deepgram');
  assert.equal(history[0].providerAudit.attempts[0].status, 'succeeded');
  assert.equal(
    harness.chrome.__sentMessages.filter((message) => message.target === 'offscreen' && message.action === 'start').length,
    1
  );
  assert.equal(
    harness.chrome.__sentMessages.filter((message) => message.target === 'offscreen' && message.action === 'stop').length,
    1
  );
});

test('override precedence is one-run only and later sessions fall back to saved default', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'openai';

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      groq: {
        async transcribe() {
          return { text: 'hola groq' };
        }
      },
      openai: {
        async transcribe() {
          return { text: 'hola openai' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const firstStart = await harness.startCapture({ providerOverride: 'groq' });
  assert.equal(firstStart.ok, true);
  assert.equal(firstStart.transcriptSession.activeProvider, 'groq');
  await harness.dispatchChunk({ chunkIndex: 0 });
  await harness.stopCapture();

  const secondStart = await harness.startCapture();
  assert.equal(secondStart.ok, true);
  assert.equal(secondStart.transcriptSession.activeProvider, 'openai');
  await harness.dispatchChunk({ chunkIndex: 0 });
  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history.length, 2);
  assert.equal(history[0].resolvedProvider, 'openai');
  assert.equal(history[0].providerAudit.providerOverride, null);
  assert.equal(history[1].resolvedProvider, 'groq');
  assert.equal(history[1].providerAudit.providerOverride, 'groq');
  assert.equal(history[1].providerAudit.defaultProvider, 'openai');
});

test('recoverable failure falls back to the next provider and keeps attempt audit', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'openai';

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          const error = new Error('network down');
          error.code = 'fetch_error';
          throw error;
        }
      },
      deepgram: {
        async transcribe() {
          return { text: 'fallback deepgram' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, true);
  assert.equal(started.transcriptSession.activeProvider, 'openai');

  const chunkResult = await harness.dispatchChunk({ chunkIndex: 4 });
  assert.equal(chunkResult.ok, true);
  assert.equal(chunkResult.providerId, 'deepgram');

  const session = await harness.getTranscriptSession();
  assert.equal(session.activeProvider, 'deepgram');
  assert.deepEqual(session.attempts.map((attempt) => attempt.providerId), ['openai', 'deepgram']);
  assert.equal(session.attempts[0].errorCode, 'network');

  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history[0].resolvedProvider, 'deepgram');
  assert.deepEqual(history[0].providerAudit.attempts.map((attempt) => attempt.status), ['failed', 'succeeded']);
  assert.match(history[0].providerAudit.attempts[0].errorSummary, /conexión de red/i);
});

test('start is rejected when no provider is eligible and offscreen never receives start', { concurrency: false }, async (t) => {
  const settings = buildDefaultProviderSettings();
  settings.defaultProvider = 'whisperLocal';
  settings.providers.openai.apiKey = '';
  settings.providers.openai.enabled = false;
  settings.providers.whisperLocal = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8765',
    healthPath: '/health',
    transcribePath: '/transcribe'
  };

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    fetchResponseForUrl(url) {
      if (url.includes('/health')) {
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200 };
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, false);
  assert.match(started.error, /No hay providers elegibles/i);
  assert.equal(
    harness.chrome.__sentMessages.filter((message) => message.target === 'offscreen' && message.action === 'start').length,
    0
  );
});

test('background settings messaging persists sanitized provider defaults and clears migrated legacy keys', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { openaiApiKey: 'sk-legacy-still-there' }
  });
  t.after(() => harness.dispose());

  const saved = await harness.saveProviderSettings({
    defaultProvider: 'deepgram',
    providers: {
      openai: { enabled: true, apiKey: '' },
      deepgram: { enabled: true, apiKey: 'dg-live', model: 'nova-3' }
    }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.providerSettings.defaultProvider, 'deepgram');

  const fetched = await harness.getProviderSettings();
  assert.equal(fetched.ok, true);
  assert.equal(fetched.providerSettings.defaultProvider, 'deepgram');
  assert.equal(fetched.providerSettings.providers.deepgram.apiKey, 'dg-...live');
  assert.equal(harness.storageArea.store.providerSettings.providers.deepgram.apiKey, 'dg-live');
  assert.equal(Object.prototype.hasOwnProperty.call(harness.storageArea.store, 'openaiApiKey'), false);
});

test('background provider settings reject untrusted runtime senders', { concurrency: false }, async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());

  const fetched = await harness.sendRuntimeMessageAs(
    { target: 'background', action: 'getProviderSettings' },
    { url: 'https://evil.example/leak.html' }
  );

  assert.equal(fetched.ok, false);
  assert.match(fetched.error, /Origen no autorizado/i);
});

test('saving masked provider settings keeps stored secrets intact', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram.model = 'nova-2';

  const harness = createHarness({
    initialStorage: { providerSettings: settings }
  });
  t.after(() => harness.dispose());

  const saved = await harness.saveProviderSettings({
    defaultProvider: 'deepgram',
    providers: {
      openai: { enabled: true, apiKey: 'sk-...enai' },
      deepgram: { enabled: true, apiKey: 'dg-...-key', model: 'nova-3' },
      assemblyai: { enabled: true, apiKey: 'aa-...-key' },
      groq: { enabled: true, apiKey: 'gsk_...-key' },
      google: { enabled: true, apiKey: 'gg-...-key' },
      whisperLocal: { enabled: false, baseUrl: 'http://127.0.0.1:8765', healthPath: '/health', transcribePath: '/transcribe' }
    }
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.providerSettings.providers.deepgram.apiKey, 'dg-...-key');
  assert.equal(saved.providerSettings.providers.deepgram.model, 'nova-3');
  assert.equal(harness.storageArea.store.providerSettings.providers.deepgram.apiKey, 'dg-key');
  assert.equal(harness.storageArea.store.providerSettings.providers.deepgram.model, 'nova-3');
});

test('fallback exhaustion after three providers stores a failed audit snapshot', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'openai';

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          const error = new Error('temporary unavailable');
          error.code = 'temporary_unavailable';
          throw error;
        }
      },
      deepgram: {
        async transcribe() {
          const error = new Error('temporary unavailable');
          error.code = 'temporary_unavailable';
          throw error;
        }
      },
      assemblyai: {
        async transcribe() {
          const error = new Error('temporary unavailable');
          error.code = 'temporary_unavailable';
          throw error;
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, true);

  const chunkResult = await harness.dispatchChunk({ chunkIndex: 2 });
  assert.equal(chunkResult.ok, false);
  assert.equal(chunkResult.code, 'unavailable');

  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'failed');
  assert.equal(history[0].resolvedProvider, 'assemblyai');
  assert.deepEqual(history[0].providerAudit.attempts.map((attempt) => attempt.providerId), ['openai', 'deepgram', 'assemblyai']);
  assert.deepEqual(history[0].providerAudit.attempts.map((attempt) => attempt.status), ['failed', 'failed', 'failed']);
  assert.equal(history[0].providerAudit.lastChunkError.providerId, 'assemblyai');
});

test('whisper bridge down is skipped at session start and OpenAI legacy migration still works', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'whisperLocal';

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      openaiApiKey: 'sk-legacy-openai'
    },
    fetchResponseForUrl(url) {
      if (url.includes('/health')) {
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200 };
    },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          return { text: 'hola legacy openai' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, true);
  assert.equal(started.transcriptSession.activeProvider, 'openai');
  assert.equal(Object.prototype.hasOwnProperty.call(harness.storageArea.store, 'openaiApiKey'), false);

  const session = await harness.getTranscriptSession();
  assert.equal(session.audit.skippedProviders[0].providerId, 'whisperLocal');
  assert.equal(session.audit.skippedProviders[0].reason, 'healthcheck_failed');

  await harness.dispatchChunk({ chunkIndex: 0 });
  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history[0].resolvedProvider, 'openai');
  assert.equal(harness.storageArea.store.providerSettings.providers.openai.apiKey, 'sk-openai');
  assert.equal(Object.prototype.hasOwnProperty.call(harness.storageArea.store, 'openaiApiKey'), false);
});

test('legacy OpenAI-only storage migrates lazily and removes the old key', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: {
      openaiApiKey: 'sk-legacy-only'
    },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          return { text: 'hola rollback' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, true);
  assert.equal(started.transcriptSession.activeProvider, 'openai');
  assert.equal(Object.prototype.hasOwnProperty.call(harness.storageArea.store, 'openaiApiKey'), false);

  await harness.dispatchChunk({ chunkIndex: 1 });
  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history.length, 1);
  assert.equal(history[0].resolvedProvider, 'openai');
  assert.equal(harness.storageArea.store.providerSettings.providers.openai.apiKey, 'sk-legacy-only');
  assert.equal(Object.prototype.hasOwnProperty.call(harness.storageArea.store, 'openaiApiKey'), false);
});

test('OpenAI sessions request shorter live chunk windows without changing other providers', { concurrency: false }, async (t) => {
  const openAiHarness = createHarness({
    initialStorage: { providerSettings: createBaseSettings() }
  });
  t.after(() => openAiHarness.dispose());

  const openAiStarted = await openAiHarness.startCapture();
  assert.equal(openAiStarted.ok, true);

  const openAiStartMessage = openAiHarness.chrome.__sentMessages.find(
    (message) => message.target === 'offscreen' && message.action === 'start'
  );
  assert.equal(openAiStartMessage.sessionContext.activeProvider, 'openai');
  assert.equal(openAiStartMessage.sessionContext.chunkIntervalMs, 3000);

  const deepgramSettings = createBaseSettings();
  deepgramSettings.defaultProvider = 'deepgram';
  const deepgramHarness = createHarness({
    initialStorage: { providerSettings: deepgramSettings }
  });
  t.after(() => deepgramHarness.dispose());

  const deepgramStarted = await deepgramHarness.startCapture();
  assert.equal(deepgramStarted.ok, true);

  const deepgramStartMessage = deepgramHarness.chrome.__sentMessages.find(
    (message) => message.target === 'offscreen' && message.action === 'start'
  );
  assert.equal(deepgramStartMessage.sessionContext.activeProvider, 'deepgram');
  assert.equal(deepgramStartMessage.sessionContext.chunkIntervalMs, 7000);
});

test('OpenAI chunk payload survives runtime messaging serialization before adapter execution', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'openai';

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      openai: {
        async transcribe(input) {
          assert.equal(input.blob instanceof Blob, true);
          assert.equal(await input.blob.text(), 'serialized-openai-chunk');
          return { text: 'hola openai serializado' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const started = await harness.startCapture();
  assert.equal(started.ok, true);

  const chunkResult = await harness.dispatchChunk({
    chunkIndex: 0,
    blob: new Blob(['serialized-openai-chunk'], { type: 'audio/webm' })
  });

  assert.equal(chunkResult.ok, true);
  assert.equal(chunkResult.providerId, 'openai');
});

test('live Deepgram sessions start via startLiveSession and preserve batch flow for non-live providers', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram.liveEnabled = true;

  const liveHarness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      deepgramLiveTransport: {
        connect: async () => true,
        send: async () => true,
        close: async () => true
      }
    }
  });
  t.after(() => liveHarness.dispose());

  const liveStarted = await liveHarness.startCapture();
  assert.equal(liveStarted.ok, true);
  assert.equal(liveStarted.transcriptSession.providerPlan[0], 'deepgram');

  const liveStartMessage = liveHarness.chrome.__sentMessages.find(
    (message) => message.target === 'offscreen' && message.action === 'startLiveSession'
  );
  assert.equal(!!liveStartMessage, true);
  assert.equal(liveStartMessage.providerId, 'deepgram');

  const batchHarness = createHarness({
    initialStorage: { providerSettings: createBaseSettings() }
  });
  t.after(() => batchHarness.dispose());

  const batchStarted = await batchHarness.startCapture();
  assert.equal(batchStarted.ok, true);

  const batchStartMessage = batchHarness.chrome.__sentMessages.find(
    (message) => message.target === 'offscreen' && message.action === 'start'
  );
  assert.equal(!!batchStartMessage, true);
  assert.equal(
    batchHarness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'startLiveSession'),
    false
  );
});

test('complete live happy path persists final transcript, interim updates, and live mode metadata', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram.liveEnabled = true;

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
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
  const started = await harness.startCapture();
  assert.equal(started.ok, true);

  await background.handleLiveConnect({ action: 'liveConnect', sessionId: started.transcriptSession.id, providerId: 'deepgram', at: 1 });
  const partial = await background.applyLiveTranscriptEvent({
    action: 'livePartial',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola parc',
    at: 2
  });
  assert.equal(partial.liveTranscript.interim, 'hola parc');

  const final = await background.applyLiveTranscriptEvent({
    action: 'liveFinal',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'hola parcial final',
    at: 3
  });
  assert.equal(final.liveTranscript.final, 'hola parcial final ');
  assert.equal(final.liveTranscript.interim, '');

  await background.handleLiveClose({ action: 'liveClose', sessionId: started.transcriptSession.id, providerId: 'deepgram', at: 4 });
  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);

  const saved = await harness.getSavedTranscriptions();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mode, 'live');
  assert.equal(saved[0].text, 'hola parcial final');
  assert.equal(saved[0].terminalStatus, 'completed');
  assert.deepEqual(saved[0].providerAttribution, ['deepgram-live']);
});

test('reconnect exhaustion falls back to batch without duplicating live finals', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  settings.defaultProvider = 'deepgram';
  settings.providers.deepgram.liveEnabled = true;

  const harness = createHarness({
    initialStorage: { providerSettings: settings },
    adapterBehaviors: {
      deepgramLiveTransport: {
        connect: async () => true,
        send: async () => true,
        close: async () => true
      },
      deepgram: {
        async transcribe() {
          return { text: 'batch continua' };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture();
  assert.equal(started.ok, true);

  await background.handleLiveConnect({ action: 'liveConnect', sessionId: started.transcriptSession.id, providerId: 'deepgram', at: 1 });
  await background.applyLiveTranscriptEvent({
    action: 'liveFinal',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    text: 'segmento live',
    at: 2
  });
  await background.handleLiveReconnect({
    action: 'liveReconnect',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    reconnects: 2,
    at: 3
  });
  await background.handleLiveFallback({
    action: 'liveFallback',
    sessionId: started.transcriptSession.id,
    providerId: 'deepgram',
    reason: 'reconnect_exhausted',
    reconnects: 2,
    at: 4
  });

  const chunkResult = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'batch-audio'
  });
  assert.equal(chunkResult.ok, true);
  assert.equal((await harness.getTranscript()).final, 'segmento live batch continua ');

  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);

  const saved = await harness.getSavedTranscriptions();
  assert.equal(saved[0].text, 'segmento live batch continua');
  assert.deepEqual(saved[0].providerAttribution, ['deepgram-live', 'deepgram-batch']);
  assert.equal(saved[0].fallbackReason, 'reconnect_exhausted');
  assert.equal(saved[0].terminalStatus, 'fallback-to-batch');
});

test('summarizeTranscription fails fast on missing_api_key, not_found, and empty_text', { concurrency: false }, async (t) => {
  const settingsWithoutApiKey = createBaseSettings();
  settingsWithoutApiKey.providers.openai.apiKey = '';

  const missingKeyHarness = createHarness({
    initialStorage: {
      providerSettings: settingsWithoutApiKey,
      savedTranscriptions: [{ id: 'tx_missing_key', title: 'Missing key', text: 'Texto disponible.' }]
    }
  });
  t.after(() => missingKeyHarness.dispose());

  const missingKeyResult = await missingKeyHarness.summarizeTranscription('tx_missing_key');
  assert.equal(missingKeyResult.ok, false);
  assert.equal(missingKeyResult.code, 'missing_api_key');
  assert.equal(missingKeyResult.retryable, false);

  const notFoundHarness = createHarness({
    initialStorage: {
      providerSettings: createBaseSettings(),
      savedTranscriptions: []
    }
  });
  t.after(() => notFoundHarness.dispose());

  const notFoundResult = await notFoundHarness.summarizeTranscription('tx_missing');
  assert.equal(notFoundResult.ok, false);
  assert.equal(notFoundResult.code, 'not_found');
  assert.equal(notFoundResult.retryable, false);

  const emptyTextHarness = createHarness({
    initialStorage: {
      providerSettings: createBaseSettings(),
      savedTranscriptions: [{ id: 'tx_empty', title: 'Empty', text: '   ' }]
    }
  });
  t.after(() => emptyTextHarness.dispose());

  const emptyTextResult = await emptyTextHarness.summarizeTranscription('tx_empty');
  assert.equal(emptyTextResult.ok, false);
  assert.equal(emptyTextResult.code, 'empty_text');
  assert.equal(emptyTextResult.retryable, false);
});

test('summarizeTranscription dedupes in-flight jobs and returns summary payload to popup', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  let summarizeCalls = 0;
  let releaseSummary = () => {};
  const summaryGate = new Promise((resolve) => {
    releaseSummary = resolve;
  });

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      savedTranscriptions: [{ id: 'tx_summary', title: 'Resumen', text: 'Texto para resumir.' }]
    },
    adapterBehaviors: {
      openai: {
        summarizeText: async () => {
          summarizeCalls += 1;
          await summaryGate;
          return {
            summary: 'Resumen corto generado.',
            key_points: ['Punto 1', 'Punto 2', 'Punto 3']
          };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const firstRequest = harness.summarizeTranscription('tx_summary');

  const duplicateResult = await harness.summarizeTranscription('tx_summary');
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.code, 'summary_in_progress');
  assert.equal(duplicateResult.retryable, true);

  assert.equal(typeof releaseSummary, 'function');

  releaseSummary();

  const successResult = await firstRequest;
  assert.equal(successResult.ok, true);
  assert.equal(successResult.transcription.id, 'tx_summary');
  assert.equal(successResult.transcription.summary.short, 'Resumen corto generado.');
  assert.deepEqual(successResult.transcription.summary.keyPoints, ['Punto 1', 'Punto 2', 'Punto 3']);
  assert.equal(successResult.transcription.summary.status, 'ready');
  assert.equal(successResult.transcription.summary.version, 1);
  assert.equal(typeof successResult.transcription.summary.updatedAt, 'number');
  assert.equal(typeof successResult.transcription.summary.sourceTextHash, 'string');
  assert.ok(successResult.transcription.summary.sourceTextHash.length > 0);
  assert.equal(successResult.transcription.summary.error, null);
  assert.equal(summarizeCalls, 1);

  const savedTranscriptions = await harness.getSavedTranscriptions();
  assert.equal(savedTranscriptions.length, 1);
  assert.deepEqual(savedTranscriptions[0].summary, successResult.transcription.summary);
});

test('summarizeTranscription persists retryable error payloads on the saved transcription entry', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      savedTranscriptions: [{ id: 'tx_summary_error', title: 'Resumen', text: 'Texto para resumir.' }]
    },
    adapterBehaviors: {
      openai: {
        async summarizeText() {
          return {
            summary: '   ',
            key_points: []
          };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const result = await harness.summarizeTranscription('tx_summary_error');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_payload');
  assert.equal(result.retryable, true);

  const savedTranscriptions = await harness.getSavedTranscriptions();
  assert.equal(savedTranscriptions.length, 1);
  assert.deepEqual(savedTranscriptions[0].summary.error, {
    code: 'invalid_payload',
    message: 'El payload de resumen no incluye un summary válido.'
  });
  assert.equal(savedTranscriptions[0].summary.status, 'error');
  assert.equal(savedTranscriptions[0].summary.version, 1);
  assert.equal(savedTranscriptions[0].summary.short, '');
  assert.deepEqual(savedTranscriptions[0].summary.keyPoints, []);
  assert.equal(savedTranscriptions[0].summary.model, 'gpt-4o-mini');
  assert.equal(typeof savedTranscriptions[0].summary.updatedAt, 'number');
  assert.equal(typeof savedTranscriptions[0].summary.sourceTextHash, 'string');
  assert.ok(savedTranscriptions[0].summary.sourceTextHash.length > 0);
});

test('summarizeTranscription maps provider timeouts to retryable persisted errors', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      savedTranscriptions: [{ id: 'tx_summary_timeout', title: 'Resumen timeout', text: 'Texto para resumir.' }]
    },
    adapterBehaviors: {
      openai: {
        async summarizeText() {
          const error = new Error('The operation timed out.');
          error.code = 'timeout';
          error.status = 504;
          throw error;
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const result = await harness.summarizeTranscription('tx_summary_timeout');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
  assert.equal(result.retryable, true);

  const savedTranscriptions = await harness.getSavedTranscriptions();
  assert.deepEqual(savedTranscriptions[0].summary.error, {
    code: 'timeout',
    message: 'The operation timed out.'
  });
});

test('summarizeTranscription exposes loading meta after popup reopen and clears it once completed', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  let releaseSummary;

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      savedTranscriptions: [{ id: 'tx_summary_reload', title: 'Resumen reload', text: 'Texto para resumir.' }]
    },
    adapterBehaviors: {
      openai: {
        summarizeText: async () => {
          await new Promise((resolve) => {
            releaseSummary = resolve;
          });
          return {
            summary: 'Resumen después de reopen.',
            key_points: ['Punto 1', 'Punto 2', 'Punto 3']
          };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const pendingRequest = harness.summarizeTranscription('tx_summary_reload');

  for (let attempt = 0; attempt < 20 && typeof releaseSummary !== 'function'; attempt += 1) {
    await Promise.resolve();
  }

  const reloadedList = await harness.getTranscriptions();
  assert.equal(reloadedList[0].summaryMeta.isLoading, true);

  releaseSummary();
  await pendingRequest;

  const refreshedList = await harness.getTranscriptions();
  assert.equal(refreshedList[0].summaryMeta.isLoading, false);
  assert.equal(refreshedList[0].summary.short, 'Resumen después de reopen.');
});

test('getTranscriptions marks persisted summaries as stale when source text changes', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      savedTranscriptions: [{
        id: 'tx_summary_stale',
        title: 'Resumen stale',
        text: 'Texto actualizado.',
        summary: {
          version: 1,
          status: 'ready',
          short: 'Resumen viejo.',
          keyPoints: ['Punto 1', 'Punto 2'],
          model: 'gpt-4o-mini',
          updatedAt: Date.now(),
          sourceTextHash: 'hash-viejo',
          error: null
        }
      }]
    }
  });
  t.after(() => harness.dispose());

  const list = await harness.getTranscriptions();
  assert.equal(list[0].summaryMeta.isStale, true);
  assert.equal(list[0].summaryMeta.isLoading, false);
});

test('summarizeTranscription switches to map-reduce for long texts and persists final summary shape', { concurrency: false }, async (t) => {
  const settings = createBaseSettings();
  const longText = [
    'Primer bloque con suficiente contenido para superar el threshold configurado en runtime y mantener una unidad temática clara. '.repeat(140),
    'Segundo bloque con más decisiones, contexto y acuerdos para forzar múltiples chunks sin romper el contrato final. '.repeat(140),
    'Tercer bloque para que el reduce consolide todos los parciales y devuelva una única síntesis usable. '.repeat(140)
  ].join('\n\n');
  const calls = [];

  const harness = createHarness({
    initialStorage: {
      providerSettings: settings,
      savedTranscriptions: [{ id: 'tx_summary_long', title: 'Resumen largo', text: longText }]
    },
    adapterBehaviors: {
      openai: {
        async summarizeText({ messages }) {
          calls.push(messages);

          if (calls.length < 4) {
            return {
              summary: `Resumen parcial ${calls.length}.`,
              key_points: [`Punto ${calls.length}.1`, `Punto ${calls.length}.2`, `Punto ${calls.length}.3`]
            };
          }

          return {
            summary: 'Resumen largo consolidado.',
            key_points: ['Idea 1', 'Idea 2', 'Idea 3']
          };
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const result = await harness.summarizeTranscription('tx_summary_long');
  assert.equal(result.ok, true);
  assert.equal(result.transcription.summary.status, 'ready');
  assert.equal(result.transcription.summary.short, 'Resumen largo consolidado.');
  assert.deepEqual(result.transcription.summary.keyPoints, ['Idea 1', 'Idea 2', 'Idea 3']);
  assert.ok(calls.length > 1);
  assert.match(calls[0][0].content, /chunk/i);
  assert.match(calls[calls.length - 1][0].content, /consolida/i);

  const savedTranscriptions = await harness.getSavedTranscriptions();
  assert.equal(savedTranscriptions[0].summary.short, 'Resumen largo consolidado.');
  assert.deepEqual(savedTranscriptions[0].summary.keyPoints, ['Idea 1', 'Idea 2', 'Idea 3']);
});
