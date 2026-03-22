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

test('background settings messaging persists sanitized provider defaults', { concurrency: false }, async (t) => {
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
  assert.equal(fetched.providerSettings.providers.deepgram.apiKey, 'dg-live');
  assert.equal(harness.storageArea.store.openaiApiKey, 'sk-legacy-still-there');
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

  const session = await harness.getTranscriptSession();
  assert.equal(session.audit.skippedProviders[0].providerId, 'whisperLocal');
  assert.equal(session.audit.skippedProviders[0].reason, 'healthcheck_failed');

  await harness.dispatchChunk({ chunkIndex: 0 });
  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history[0].resolvedProvider, 'openai');
  assert.equal(harness.storageArea.store.providerSettings.providers.openai.apiKey, 'sk-openai');
  assert.equal(harness.storageArea.store.openaiApiKey, 'sk-legacy-openai');
});

test('legacy OpenAI-only storage migrates lazily and remains a valid rollback path', { concurrency: false }, async (t) => {
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

  await harness.dispatchChunk({ chunkIndex: 1 });
  await harness.stopCapture();

  const history = await harness.getSavedTranscriptions();
  assert.equal(history.length, 1);
  assert.equal(history[0].resolvedProvider, 'openai');
  assert.equal(harness.storageArea.store.providerSettings.providers.openai.apiKey, 'sk-legacy-only');
  assert.equal(harness.storageArea.store.openaiApiKey, 'sk-legacy-only');
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
