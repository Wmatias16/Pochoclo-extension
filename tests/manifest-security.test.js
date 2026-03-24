const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.resolve(__dirname, '..', 'manifest.json');

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('manifest narrows host permissions to required provider endpoints', () => {
  const manifest = readManifest();

  assert.deepEqual(manifest.host_permissions, [
    'https://api.openai.com/*',
    'https://api.deepgram.com/*',
    'https://api.assemblyai.com/*',
    'https://api.groq.com/*',
    'https://speech.googleapis.com/*',
    'http://127.0.0.1:*/*',
    'http://localhost:*/*'
  ]);
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
});

test('manifest keeps recording indicator content script on all urls at document_idle', () => {
  const manifest = readManifest();
  const [contentScript] = manifest.content_scripts;

  assert.deepEqual(contentScript.matches, ['<all_urls>']);
  assert.deepEqual(contentScript.js, ['content.js']);
  assert.equal(contentScript.run_at, 'document_idle');
});

test('manifest declares explicit extension page CSP without remote font origins', () => {
  const manifest = readManifest();

  assert.deepEqual(manifest.content_security_policy, {
    extension_pages: "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https://api.openai.com https://api.deepgram.com wss://api.deepgram.com https://api.assemblyai.com https://api.groq.com https://speech.googleapis.com http://127.0.0.1:* http://localhost:*"
  });
});
