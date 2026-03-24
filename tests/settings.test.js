const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDefaultProviderSettings,
  normalizeProviderSettings,
  readProviderSettings,
  saveProviderSettings
} = require('../storage/settings.js');

function createStorage(initial = {}) {
  const store = { ...initial };

  return {
    store,
    async get(keys) {
      if (Array.isArray(keys)) {
        return keys.reduce((acc, key) => {
          acc[key] = store[key];
          return acc;
        }, {});
      }

      return { [keys]: store[keys] };
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => {
        delete store[key];
      });
    }
  };
}

function createLogger(events) {
  return {
    info(event, payload) {
      events.push({ level: 'info', event, payload });
    }
  };
}

test('migrates legacy openai key into provider settings', async () => {
  const storage = createStorage({ openaiApiKey: 'sk-legacy' });

  const result = await readProviderSettings(storage);

  assert.equal(result.defaultProvider, 'openai');
  assert.equal(result.providers.openai.apiKey, 'sk-legacy');
  assert.equal(storage.store.providerSettings.providers.openai.apiKey, 'sk-legacy');
  assert.equal(Object.prototype.hasOwnProperty.call(storage.store, 'openaiApiKey'), false);
});

test('compat reads merge legacy openai key without breaking current provider settings', async () => {
  const existing = buildDefaultProviderSettings();
  existing.defaultProvider = 'deepgram';
  existing.providers.deepgram = { enabled: true, apiKey: 'dg-live' };
  existing.providers.openai.apiKey = '';

  const storage = createStorage({
    providerSettings: existing,
    openaiApiKey: 'sk-fallback'
  });

  const result = await readProviderSettings(storage);

  assert.equal(result.defaultProvider, 'deepgram');
  assert.equal(result.providers.openai.apiKey, 'sk-fallback');
  assert.equal(result.providers.deepgram.apiKey, 'dg-live');
  assert.equal(Object.prototype.hasOwnProperty.call(storage.store, 'openaiApiKey'), false);
});

test('saveProviderSettings normalizes unknown defaults back to openai', async () => {
  const storage = createStorage();

  const result = await saveProviderSettings(
    {
      defaultProvider: 'not-a-provider',
      providers: {
        openai: { enabled: true, apiKey: 'sk-test' }
      }
    },
    storage
  );

  assert.equal(result.defaultProvider, 'openai');
  assert.equal(storage.store.providerSettings.defaultProvider, 'openai');
});

test('readProviderSettings logs lazy legacy migration without exposing api key', async () => {
  const events = [];
  const storage = createStorage({ openaiApiKey: 'sk-legacy-super-secret' });

  await readProviderSettings(storage, { logger: createLogger(events) });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'settings.legacy-openai-migrated');
  assert.equal(events[0].payload.migration, 'legacy_openai_key');
  assert.equal(events[0].payload.openaiEnabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(events[0].payload, 'apiKey'), false);
});

test('normalizeProviderSettings preserves per-provider config used by popup UI', () => {
  const result = normalizeProviderSettings({
    defaultProvider: 'groq',
    providers: {
      groq: { enabled: true, apiKey: 'gsk_live', model: 'whisper-large-v3' },
      whisperLocal: { enabled: true, baseUrl: ' http://127.0.0.1:9000 ', healthPath: '/healthz', transcribePath: '/tx' }
    }
  });

  assert.equal(result.defaultProvider, 'groq');
  assert.equal(result.providers.groq.apiKey, 'gsk_live');
  assert.equal(result.providers.groq.model, 'whisper-large-v3');
  assert.equal(result.providers.whisperLocal.baseUrl, ' http://127.0.0.1:9000 ');
  assert.equal(result.providers.whisperLocal.healthPath, '/healthz');
  assert.equal(result.providers.whisperLocal.transcribePath, '/tx');
});

test('saveProviderSettings persists multi-provider defaults without mutating legacy key state', async () => {
  const storage = createStorage({ openaiApiKey: 'sk-legacy' });

  const result = await saveProviderSettings({
    defaultProvider: 'deepgram',
    providers: {
      openai: { enabled: true, apiKey: '' },
      deepgram: { enabled: true, apiKey: 'dg-live', model: 'nova-3' },
      whisperLocal: { enabled: true, baseUrl: 'http://127.0.0.1:8765', healthPath: '/health', transcribePath: '/transcribe' }
    }
  }, storage);

  assert.equal(result.defaultProvider, 'deepgram');
  assert.equal(storage.store.providerSettings.providers.deepgram.apiKey, 'dg-live');
  assert.equal(storage.store.providerSettings.providers.whisperLocal.baseUrl, 'http://127.0.0.1:8765');
  assert.equal(storage.store.openaiApiKey, 'sk-legacy');
});

test('readProviderSettings removes leftover legacy key even when provider settings are already normalized', async () => {
  const existing = buildDefaultProviderSettings();
  existing.providers.openai.apiKey = 'sk-current';

  const storage = createStorage({
    providerSettings: existing,
    openaiApiKey: 'sk-legacy-leftover'
  });

  const result = await readProviderSettings(storage);

  assert.equal(result.providers.openai.apiKey, 'sk-current');
  assert.equal(storage.store.providerSettings.providers.openai.apiKey, 'sk-current');
  assert.equal(Object.prototype.hasOwnProperty.call(storage.store, 'openaiApiKey'), false);
});
