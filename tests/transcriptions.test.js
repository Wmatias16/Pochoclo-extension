const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProviderAuditSnapshot,
  normalizeSavedTranscription,
  normalizeSavedTranscriptions
} = require('../storage/transcriptions.js');

test('createProviderAuditSnapshot preserves runtime audit fields for history entries', () => {
  const snapshot = createProviderAuditSnapshot({
    providerPlan: ['openai', 'deepgram'],
    attempts: [
      {
        providerId: 'openai',
        order: 1,
        status: 'failed',
        startedAt: 1,
        endedAt: 2,
        chunkIndex: 3,
        errorCode: 'network',
        errorSummary: 'Falló la conexión.'
      },
      {
        providerId: 'deepgram',
        order: 2,
        status: 'succeeded',
        startedAt: 3,
        endedAt: 4,
        chunkIndex: 3
      }
    ],
    providerOverride: 'deepgram',
    defaultProvider: 'openai',
    activeProvider: 'deepgram',
    resolvedProvider: 'deepgram',
    lastChunkError: null,
    status: 'completed',
    audit: {
      eligibleProviders: ['openai', 'deepgram'],
      skippedProviders: [{ providerId: 'whisperLocal', reason: 'healthcheck_failed', status: 503 }]
    }
  });

  assert.equal(snapshot.resolvedProvider, 'deepgram');
  assert.equal(snapshot.activeProvider, 'deepgram');
  assert.equal(snapshot.attempts.length, 2);
  assert.equal(snapshot.skippedProviders[0].providerId, 'whisperLocal');
});

test('normalizeSavedTranscription keeps backward compatibility for legacy openai-only history', () => {
  const normalized = normalizeSavedTranscription({
    id: 'tx_legacy',
    title: 'Legacy',
    text: 'hola mundo',
    status: '',
    resolvedProvider: ''
  });

  assert.equal(normalized.resolvedProvider, 'openai');
  assert.equal(normalized.status, 'completed');
  assert.equal(normalized.providerAudit, null);
  assert.equal(normalized.summary, null);
});

test('normalizeSavedTranscription preserves a valid persisted summary payload', () => {
  const normalized = normalizeSavedTranscription({
    id: 'tx_summary',
    title: 'Resumen',
    text: 'hola mundo',
    summary: {
      version: 1,
      status: 'ready',
      short: 'Resumen corto.',
      keyPoints: ['Punto 1', 'Punto 2', 'Punto 3'],
      model: 'gpt-4o-mini',
      updatedAt: 123,
      sourceTextHash: 'abc123',
      error: null
    }
  });

  assert.deepEqual(normalized.summary, {
    version: 1,
    status: 'ready',
    short: 'Resumen corto.',
    keyPoints: ['Punto 1', 'Punto 2', 'Punto 3'],
    model: 'gpt-4o-mini',
    updatedAt: 123,
    sourceTextHash: 'abc123',
    error: null
  });
});

test('normalizeSavedTranscription sanitizes malformed summary payloads to null', () => {
  const normalized = normalizeSavedTranscription({
    id: 'tx_bad_summary',
    title: 'Resumen roto',
    text: 'hola mundo',
    summary: {
      version: 'bad',
      status: 'ready',
      short: '   ',
      keyPoints: 'no-array',
      sourceTextHash: '',
      error: null
    }
  });

  assert.equal(normalized.summary, null);
});

test('normalizeSavedTranscription preserves error summaries for retry-safe reloads', () => {
  const normalized = normalizeSavedTranscription({
    id: 'tx_error_summary',
    title: 'Resumen con error',
    text: 'hola mundo',
    summary: {
      version: 1,
      status: 'error',
      short: '',
      keyPoints: [],
      model: 'gpt-4o-mini',
      updatedAt: 456,
      sourceTextHash: 'hash-error',
      error: {
        code: 'timeout',
        message: 'El provider tardó demasiado en generar el resultado. Probá nuevamente.'
      }
    }
  });

  assert.deepEqual(normalized.summary, {
    version: 1,
    status: 'error',
    short: '',
    keyPoints: [],
    model: 'gpt-4o-mini',
    updatedAt: 456,
    sourceTextHash: 'hash-error',
    error: {
      code: 'timeout',
      message: 'El provider tardó demasiado en generar el resultado. Probá nuevamente.'
    }
  });
});

test('normalizeSavedTranscriptions preserves provider audit and failure summaries after reload', () => {
  const list = normalizeSavedTranscriptions([
    {
      id: 'tx_failed',
      title: 'Fallback failed',
      text: '',
      status: 'failed',
      resolvedProvider: 'assemblyai',
      providerAudit: {
        attempts: [
          { providerId: 'openai', order: 1, status: 'failed', errorSummary: '401' },
          { providerId: 'assemblyai', order: 2, status: 'failed', errorSummary: '503' }
        ],
        resolvedProvider: 'assemblyai',
        status: 'failed',
        lastChunkError: {
          providerId: 'assemblyai',
          code: 'unavailable',
          summary: 'AssemblyAI no disponible.'
        }
      }
    }
  ]);

  assert.equal(list[0].providerAudit.attempts[0].providerId, 'openai');
  assert.equal(list[0].providerAudit.lastChunkError.summary, 'AssemblyAI no disponible.');
  assert.equal(list[0].resolvedProvider, 'assemblyai');
});

test('normalizeSavedTranscriptions logs lazy history normalization migrations', () => {
  const events = [];
  const logger = {
    info(event, payload) {
      events.push({ event, payload });
    }
  };

  normalizeSavedTranscriptions(
    [
      {
        id: 'tx_legacy',
        title: 'Legacy',
        text: 'hola mundo',
        status: '',
        resolvedProvider: ''
      }
    ],
    { logger }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'transcriptions.history-normalized');
  assert.equal(events[0].payload.migratedEntries, 1);
  assert.equal(events[0].payload.migration, 'lazy_history_normalization');
});
