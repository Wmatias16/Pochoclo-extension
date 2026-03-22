const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDiagnosticsLogger,
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
