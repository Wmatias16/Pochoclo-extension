const test = require('node:test');
const assert = require('node:assert/strict');

const { executeChunkWithFallback, finalizeSession } = require('../runtime/provider-session-runtime.js');

function buildSession() {
  return {
    id: 'txs_1',
    providerPlan: ['openai', 'deepgram', 'assemblyai'],
    activeProvider: 'openai',
    resolvedProvider: null,
    attempts: [],
    status: 'recording',
    language: 'es',
    targetLanguage: 'es'
  };
}

function buildProviderSettings() {
  return {
    providers: {
      openai: { apiKey: 'sk-openai', enabled: true },
      deepgram: { apiKey: 'dg-key', enabled: true },
      assemblyai: { apiKey: 'aa-key', enabled: true }
    }
  };
}

test('same chunk retries with next eligible provider after recoverable failure', async () => {
  const attemptedProviders = [];
  const appended = [];
  const result = await executeChunkWithFallback({
    session: buildSession(),
    message: { blob: new Blob(['audio']), chunkIndex: 4 },
    providerSettings: buildProviderSettings(),
    getProviderLabel: (providerId) => providerId,
    getProviderAdapter(providerId) {
      attemptedProviders.push(providerId);
      if (providerId === 'openai') {
        return {
          async transcribe() {
            const error = new Error('network down');
            error.code = 'fetch_error';
            throw error;
          }
        };
      }

      return {
        async transcribe() {
          return { text: 'hola fallback' };
        }
      };
    },
    normalizeProviderError(error) {
      return {
        code: error.code === 'fetch_error' ? 'network' : 'unknown',
        summary: error.code === 'fetch_error' ? 'Falló la conexión de red con el provider.' : error.message,
        retryable: error.code === 'fetch_error',
        status: 0
      };
    },
    appendTranscriptText: async (text) => {
      appended.push(text);
    },
    isHallucination: () => false,
    fetchImpl: async () => ({ ok: true }),
    setTimeoutImpl: (resolve) => resolve(),
    clearTimeoutImpl: () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, 'deepgram');
  assert.deepEqual(attemptedProviders, ['openai', 'deepgram']);
  assert.deepEqual(appended, ['hola fallback ']);
  assert.equal(result.session.activeProvider, 'deepgram');
  assert.equal(result.session.resolvedProvider, 'deepgram');
  assert.equal(result.session.attempts.length, 2);
  assert.deepEqual(result.session.attempts.map((attempt) => attempt.status), ['failed', 'active']);
  assert.equal(result.session.attempts[0].providerId, 'openai');
  assert.equal(result.session.attempts[0].errorCode, 'network');
});

test('terminal stop happens after third distinct provider fails', async () => {
  const result = await executeChunkWithFallback({
    session: buildSession(),
    message: { blob: new Blob(['audio']), chunkIndex: 2 },
    providerSettings: buildProviderSettings(),
    getProviderLabel: (providerId) => providerId,
    getProviderAdapter() {
      return {
        async transcribe() {
          const error = new Error('temporarily unavailable');
          error.code = 'temporary_unavailable';
          throw error;
        }
      };
    },
    normalizeProviderError() {
      return {
        code: 'unavailable',
        summary: 'El provider no está disponible en este momento.',
        retryable: true,
        status: 503
      };
    },
    appendTranscriptText: async () => {},
    isHallucination: () => false,
    fetchImpl: async () => ({ ok: true }),
    setTimeoutImpl: (resolve) => resolve(),
    clearTimeoutImpl: () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.providerId, 'assemblyai');
  assert.equal(result.retryable, false);
  assert.equal(result.session.status, 'failed');
  assert.deepEqual(result.session.attempts.map((attempt) => attempt.providerId), ['openai', 'deepgram', 'assemblyai']);
  assert.deepEqual(result.session.attempts.map((attempt) => attempt.status), ['failed', 'failed', 'failed']);
  assert.equal(result.session.lastChunkError.providerId, 'assemblyai');
});

test('finalizeSession marks active provider as succeeded on stop', () => {
  const session = buildSession();
  session.activeProvider = 'deepgram';
  session.resolvedProvider = 'deepgram';
  session.attempts = [
    {
      providerId: 'openai',
      order: 1,
      status: 'failed',
      startedAt: 1,
      endedAt: 2,
      chunkIndex: 3,
      errorCode: 'network',
      errorSummary: 'Falló la conexión de red con el provider.'
    },
    {
      providerId: 'deepgram',
      order: 2,
      status: 'active',
      startedAt: 3,
      endedAt: null,
      chunkIndex: 3,
      errorCode: null,
      errorSummary: null
    }
  ];

  const finalized = finalizeSession(session, { endedAt: 10 });

  assert.equal(finalized.status, 'completed');
  assert.equal(finalized.attempts[1].status, 'succeeded');
  assert.equal(finalized.attempts[1].endedAt, 10);
});

test('runtime logs preflight failure and fallback rotation for diagnosable traces', async () => {
  const events = [];
  const log = {
    info(event, payload) {
      events.push({ level: 'info', event, payload });
    },
    warn(event, payload) {
      events.push({ level: 'warn', event, payload });
    }
  };

  const result = await executeChunkWithFallback({
    session: {
      ...buildSession(),
      providerPlan: ['whisperLocal', 'openai'],
      activeProvider: 'whisperLocal'
    },
    message: { blob: new Blob(['audio']), chunkIndex: 1 },
    providerSettings: {
      providers: {
        whisperLocal: { enabled: true, baseUrl: 'http://127.0.0.1:8765' },
        openai: { enabled: true, apiKey: 'sk-openai' }
      }
    },
    getProviderLabel: (providerId) => providerId,
    getProviderAdapter(providerId) {
      if (providerId === 'whisperLocal') {
        return {
          async preflight() {
            return { ok: false, reason: 'healthcheck_failed', status: 503 };
          },
          async transcribe() {
            throw new Error('should not transcribe after failed preflight');
          }
        };
      }

      return {
        async transcribe() {
          return { text: 'hola openai' };
        }
      };
    },
    normalizeProviderError(error) {
      return {
        code: error && error.code === 'unavailable' ? 'unavailable' : 'unknown',
        summary: error && error.code === 'unavailable'
          ? 'El bridge local de Whisper no está disponible.'
          : 'Falló la transcripción por un error inesperado.',
        retryable: error && error.code === 'unavailable',
        status: error && error.status ? error.status : 0
      };
    },
    appendTranscriptText: async () => {},
    isHallucination: () => false,
    fetchImpl: async () => ({ ok: true }),
    setTimeoutImpl: (resolve) => resolve(),
    clearTimeoutImpl: () => {},
    log
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    events.map((entry) => entry.event),
    [
      'chunk.attempt-started',
      'chunk.preflight-started',
      'chunk.preflight-failed',
      'chunk.attempt-failed',
      'chunk.provider-rotated',
      'chunk.attempt-started',
      'chunk.attempt-succeeded'
    ]
  );
  assert.equal(events[2].payload.reason, 'healthcheck_failed');
  assert.equal(events[4].payload.fromProviderId, 'whisperLocal');
  assert.equal(events[4].payload.toProviderId, 'openai');
});
