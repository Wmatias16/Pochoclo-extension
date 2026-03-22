const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTranscriptionSession,
  resolveProviderPlan
} = require('../providers/registry.js');
const { buildDefaultProviderSettings } = require('../storage/settings.js');

function createSettings() {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = 'sk-openai';
  settings.providers.deepgram = { enabled: true, apiKey: 'dg-key' };
  settings.providers.assemblyai = { enabled: true, apiKey: 'aa-key' };
  settings.providers.groq = { enabled: true, apiKey: 'gq-key' };
  settings.providers.google = { enabled: true, apiKey: 'gg-key' };
  settings.providers.whisperLocal = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8765',
    healthPath: '/health',
    transcribePath: '/transcribe'
  };
  return settings;
}

test('override takes precedence over default and remaining providers', async () => {
  const settings = createSettings();
  settings.defaultProvider = 'openai';

  const result = await resolveProviderPlan(
    { providerSettings: settings, providerOverride: 'groq' },
    { fetchImpl: async () => ({ ok: true, status: 200 }) }
  );

  assert.deepEqual(result.plan, ['groq', 'openai', 'deepgram']);
});

test('default provider is skipped when whisper local preflight fails', async () => {
  const settings = createSettings();
  settings.defaultProvider = 'whisperLocal';

  const result = await resolveProviderPlan(
    { providerSettings: settings },
    { fetchImpl: async () => ({ ok: false, status: 503 }) }
  );

  assert.deepEqual(result.plan, ['openai', 'deepgram', 'assemblyai']);
  assert.equal(result.skippedProviders[0].providerId, 'whisperLocal');
  assert.equal(result.skippedProviders[0].reason, 'healthcheck_failed');
});

test('provider plan keeps deterministic order and max-3 cap', async () => {
  const settings = createSettings();
  settings.defaultProvider = 'google';

  const result = await resolveProviderPlan(
    { providerSettings: settings, providerOverride: 'groq' },
    { fetchImpl: async () => ({ ok: true, status: 200 }) }
  );

  assert.deepEqual(result.plan, ['groq', 'google', 'openai']);
  assert.equal(result.maxAttempts, 3);
});

test('session creation rejects start when no provider is eligible', async () => {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = '';

  await assert.rejects(
    () => createTranscriptionSession({ providerSettings: settings, language: 'es' }),
    (error) => {
      assert.equal(error.code, 'no_eligible_provider');
      assert.match(error.message, /No hay providers elegibles/);
      return true;
    }
  );
});
