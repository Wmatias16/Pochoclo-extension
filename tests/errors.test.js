const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProviderError } = require('../providers/errors.js');

test('maps authentication failures to auth', () => {
  const result = normalizeProviderError({ status: 401, message: 'Invalid API key sk-secret-key' });
  assert.equal(result.code, 'auth');
  assert.equal(result.summary, 'Autenticación inválida. Revisá las credenciales del provider.');
});

test('maps rate limit failures to rate_limit', () => {
  const result = normalizeProviderError({ status: 429, message: 'Rate limit exceeded' });
  assert.equal(result.code, 'rate_limit');
  assert.equal(result.retryable, true);
});

test('maps network failures to network', () => {
  const result = normalizeProviderError(new TypeError('Failed to fetch'));
  assert.equal(result.code, 'network');
  assert.equal(result.summary, 'Falló la conexión de red con el provider.');
});

test('maps whisper bridge connectivity failures to unavailable', () => {
  const result = normalizeProviderError(
    { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8765' },
    { providerId: 'whisperLocal' }
  );

  assert.equal(result.code, 'unavailable');
  assert.equal(result.summary, 'El bridge local de Whisper no está disponible.');
});

test('maps unsupported failures to unsupported', () => {
  const result = normalizeProviderError({ status: 415, message: 'Unsupported media type' });
  assert.equal(result.code, 'unsupported');
});

test('maps invalid chunk payload failures to unsupported instead of network', () => {
  const result = normalizeProviderError(new TypeError("Failed to execute 'append' on 'FormData': parameter 2 is not of type 'Blob'"));
  assert.equal(result.code, 'unsupported');
  assert.equal(result.retryable, false);
});
