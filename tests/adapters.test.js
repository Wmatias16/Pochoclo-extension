const test = require('node:test');
const assert = require('node:assert/strict');

const openai = require('../providers/adapters/openai.js');
const deepgram = require('../providers/adapters/deepgram.js');
const assemblyai = require('../providers/adapters/assemblyai.js');
const groq = require('../providers/adapters/groq.js');
const google = require('../providers/adapters/google.js');
const whisperLocal = require('../providers/adapters/whisper-local.js');

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('openai adapter shapes multipart request and optional translation', async () => {
  const calls = [];
  const blob = new Blob(['audio'], { type: 'audio/webm' });

  const result = await openai.transcribe(
    {
      blob,
      language: 'en',
      targetLanguage: 'es',
      settings: { apiKey: 'sk-openai' }
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/audio/transcriptions')) {
          assert.equal(options.headers.Authorization, 'Bearer sk-openai');
          assert.equal(options.body.get('model'), 'whisper-1');
          assert.equal(options.body.get('language'), 'en');
          return jsonResponse({ text: 'hello world' });
        }

        assert.match(url, /chat\/completions/);
        return jsonResponse({ choices: [{ message: { content: 'hola mundo' } }] });
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(result.providerId, 'openai');
  assert.equal(result.text, 'hola mundo');
  assert.equal(result.translated, true);
});

test('deepgram adapter sends raw audio and extracts transcript', async () => {
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  const result = await deepgram.transcribe(
    {
      blob,
      language: 'es',
      settings: { apiKey: 'dg-key' }
    },
    {
      fetchImpl: async (url, options) => {
        assert.match(url, /api\.deepgram\.com\/v1\/listen/);
        assert.equal(options.headers.Authorization, 'Token dg-key');
        assert.equal(options.headers['Content-Type'], 'audio/webm');
        return jsonResponse({
          results: {
            channels: [{ alternatives: [{ transcript: 'hola deepgram' }] }]
          }
        });
      }
    }
  );

  assert.equal(result.text, 'hola deepgram');
});

test('assemblyai adapter uploads, creates transcript, and polls until completion', async () => {
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  const urls = [];
  const responses = [
    jsonResponse({ upload_url: 'https://cdn.example/audio.webm' }),
    jsonResponse({ id: 'job-123', status: 'queued' }),
    jsonResponse({ id: 'job-123', status: 'completed', text: 'hola assembly' })
  ];

  const result = await assemblyai.transcribe(
    {
      blob,
      language: 'es',
      settings: { apiKey: 'aa-key', pollIntervalMs: 0, maxPolls: 2 }
    },
    {
      fetchImpl: async (url) => {
        urls.push(url);
        return responses.shift();
      },
      setTimeoutImpl: (resolve) => resolve()
    }
  );

  assert.deepEqual(urls, [
    'https://api.assemblyai.com/v2/upload',
    'https://api.assemblyai.com/v2/transcript',
    'https://api.assemblyai.com/v2/transcript/job-123'
  ]);
  assert.equal(result.text, 'hola assembly');
});

test('groq adapter uses openai-compatible audio endpoint', async () => {
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  const result = await groq.transcribe(
    {
      blob,
      language: 'es',
      settings: { apiKey: 'gq-key' }
    },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
        assert.equal(options.headers.Authorization, 'Bearer gq-key');
        assert.equal(options.body.get('model'), 'whisper-large-v3-turbo');
        return jsonResponse({ text: 'hola groq' });
      }
    }
  );

  assert.equal(result.text, 'hola groq');
});

test('google adapter sends recognize request with base64 audio', async () => {
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  const result = await google.transcribe(
    {
      blob,
      language: 'es',
      settings: { apiKey: 'gg-key' }
    },
    {
      fetchImpl: async (url, options) => {
        assert.match(url, /speech:recognize\?key=gg-key/);
        const body = JSON.parse(options.body);
        assert.equal(body.config.encoding, 'WEBM_OPUS');
        assert.equal(body.config.languageCode, 'es-ES');
        assert.ok(body.audio.content.length > 0);
        return jsonResponse({
          results: [
            { alternatives: [{ transcript: 'hola' }] },
            { alternatives: [{ transcript: 'google' }] }
          ]
        });
      }
    }
  );

  assert.equal(result.text, 'hola google');
});

test('whisper local adapter preflight handles pass/fail and transcribe uses bridge path', async () => {
  const blob = new Blob(['audio'], { type: 'audio/webm' });
  let calls = 0;
  const ok = await whisperLocal.preflight(
    { baseUrl: 'http://127.0.0.1:8765', healthPath: '/health' },
    {
      fetchImpl: async () => {
        calls += 1;
        return new Response('', { status: 200 });
      }
    }
  );
  assert.deepEqual(ok, { ok: true });

  const fail = await whisperLocal.preflight(
    { baseUrl: 'http://127.0.0.1:8765', healthPath: '/health' },
    {
      fetchImpl: async () => new Response('', { status: 503 })
    }
  );
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, 'healthcheck_failed');

  const result = await whisperLocal.transcribe(
    {
      blob,
      language: 'es',
      targetLanguage: 'es',
      settings: {
        baseUrl: 'http://127.0.0.1:8765',
        transcribePath: '/transcribe'
      }
    },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:8765/transcribe');
        assert.equal(options.body.get('language'), 'es');
        return jsonResponse({ text: 'hola whisper' });
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.text, 'hola whisper');
});

test('adapters validate required config before requesting remote APIs', async () => {
  await assert.rejects(
    () => openai.transcribe({ blob: new Blob(['audio']) }),
    (error) => {
      assert.equal(error.status, 422);
      return true;
    }
  );

  await assert.rejects(
    () => whisperLocal.transcribe({ blob: new Blob(['audio']), settings: {} }),
    (error) => {
      assert.equal(error.status, 422);
      return true;
    }
  );
});
