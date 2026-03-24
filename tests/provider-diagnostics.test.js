const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDiagnosticsLogger,
  LIVE_EVENT_TYPES,
  sanitizeDiagnosticsContext
} = require('../diagnostics/provider-logger.js');

test('sanitizeDiagnosticsContext redacts secrets and transcript payloads', () => {
  const sanitized = sanitizeDiagnosticsContext({
    apiKey: 'sk-secret-123456789',
    authorization: 'Bearer token-123456789',
    transcript: 'texto sensible',
    nested: {
      token: 'nested-secret',
      providerId: 'openai'
    },
    providerId: 'openai'
  }, 'context');

  assert.equal(sanitized.apiKey, '[redacted]');
  assert.equal(sanitized.authorization, '[redacted]');
  assert.equal(sanitized.transcript, '[redacted]');
  assert.equal(sanitized.nested.token, '[redacted]');
  assert.equal(sanitized.nested.providerId, 'openai');
});

test('createDiagnosticsLogger emits structured sanitized payloads', () => {
  const events = [];
  const logger = createDiagnosticsLogger({
    namespace: 'providers',
    sink: {
      info(message, payload) {
        events.push({ message, payload });
      }
    }
  });

  logger.info('provider.plan-resolved', {
    providerId: 'openai',
    apiKey: 'sk-top-secret',
    blob: new Blob(['audio'])
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].message, '[providers] provider.plan-resolved');
  assert.equal(events[0].payload.event, 'provider.plan-resolved');
  assert.equal(events[0].payload.apiKey, '[redacted]');
  assert.equal(events[0].payload.blob, '[redacted]');
  assert.equal(events[0].payload.providerId, 'openai');
});

test('createDiagnosticsLogger sanitizes live event payloads and preserves audit metadata', () => {
  const events = [];
  const logger = createDiagnosticsLogger({
    namespace: 'providers',
    sink: {
      info(message, payload) {
        events.push({ message, payload });
      }
    }
  });

  const payload = logger.liveEvent('live:partial', {
    sessionId: 'tx_live',
    timestamp: 123,
    provider: 'deepgram',
    text: 'texto sensible',
    apiKey: 'dg-super-secret',
    meta: {
      Authorization: 'Bearer top-secret',
      reconnects: 1
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].message, '[providers] live:partial');
  assert.equal(events[0].payload.sessionId, 'tx_live');
  assert.equal(events[0].payload.provider, 'deepgram');
  assert.equal(events[0].payload.text, '[redacted]');
  assert.equal(events[0].payload.apiKey, '[redacted]');
  assert.equal(events[0].payload.meta.Authorization, '[redacted]');
  assert.equal(events[0].payload.meta.reconnects, 1);
  assert.equal(payload.event, 'live:partial');
});

test('createDiagnosticsLogger normalizes unknown live events to live:unknown', () => {
  const events = [];
  const logger = createDiagnosticsLogger({
    namespace: 'providers',
    sink: {
      info(message, payload) {
        events.push({ message, payload });
      }
    }
  });

  const payload = logger.liveEvent('live:not-real', {
    sessionId: 'tx_live',
    token: 'secret-token'
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].message, '[providers] live:unknown');
  assert.equal(events[0].payload.event, 'live:unknown');
  assert.equal(events[0].payload.token, '[redacted]');
  assert.equal(payload.event, 'live:unknown');
});

test('provider diagnostics exports the supported live audit event set', () => {
  assert.equal(LIVE_EVENT_TYPES.has('live:connect'), true);
  assert.equal(LIVE_EVENT_TYPES.has('live:fallback'), true);
  assert.equal(LIVE_EVENT_TYPES.has('live:close'), true);
});
