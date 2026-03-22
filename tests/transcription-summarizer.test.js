const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SUMMARY_MODEL,
  buildSummaryMessages,
  chunkTextForSummary,
  selectSummaryStrategy,
  sourceTextHash,
  summarizeTranscription,
  summarizeSinglePass
} = require('../runtime/transcription-summarizer.js');

test('transcription summarizer builds validated single-pass summary payload', async () => {
  const result = await summarizeSinglePass(
    {
      text: 'Primera oración. Segunda oración.',
      apiKey: 'sk-openai'
    },
    {
      summarizeText: async ({ apiKey, model, messages }) => {
        assert.equal(apiKey, 'sk-openai');
        assert.equal(model, DEFAULT_SUMMARY_MODEL);
        assert.equal(Array.isArray(messages), true);
        assert.equal(messages[0].role, 'system');
        assert.equal(messages[1].role, 'user');
        assert.match(messages[0].content, /summary/i);
        assert.match(messages[0].content, /key_points/i);
        assert.match(messages[1].content, /Primera oración/);

        return {
          summary: 'Resumen corto.',
          key_points: ['Punto uno', 'Punto dos', 'Punto tres']
        };
      }
    }
  );

  assert.equal(result.short, 'Resumen corto.');
  assert.deepEqual(result.keyPoints, ['Punto uno', 'Punto dos', 'Punto tres']);
  assert.equal(result.model, DEFAULT_SUMMARY_MODEL);
  assert.equal(result.sourceTextHash, await sourceTextHash('Primera oración. Segunda oración.'));
});

test('transcription summarizer rejects malformed payload with invalid_payload', async () => {
  await assert.rejects(
    () => summarizeSinglePass(
      {
        text: 'Texto a resumir.',
        apiKey: 'sk-openai'
      },
      {
        summarizeText: async () => ({
          summary: '   ',
          key_points: ['Punto válido']
        })
      }
    ),
    (error) => {
      assert.equal(error.code, 'invalid_payload');
      assert.equal(error.retryable, true);
      return true;
    }
  );
});

test('transcription summarizer prompt builder keeps JSON contract explicit', () => {
  const messages = buildSummaryMessages({ text: 'Texto original.' });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /json/i);
  assert.match(messages[0].content, /summary/i);
  assert.match(messages[0].content, /key_points/i);
  assert.match(messages[1].content, /Texto original\./);
});

test('transcription summarizer chooses map-reduce and keeps paragraph-aware chunks for long text', () => {
  const text = [
    'Primer bloque con bastante contenido para obligar al chunking y mantener juntas las ideas principales del inicio.',
    'Segundo bloque con contexto adicional para verificar que el corte prioriza párrafos completos antes de partir oraciones.',
    'Tercer bloque para empujar el texto por encima del threshold configurado en esta prueba y validar la estrategia larga.'
  ].join('\n\n');

  const strategy = selectSummaryStrategy(text, {
    singlePassCharThreshold: 120,
    targetChunkChars: 120,
    maxChunks: 8
  });

  const chunks = chunkTextForSummary(text, {
    targetChunkChars: 120,
    maxChunks: 8
  });

  assert.equal(strategy, 'map-reduce');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0], 'Primer bloque con bastante contenido para obligar al chunking y mantener juntas las ideas principales del inicio.');
  assert.equal(chunks[1], 'Segundo bloque con contexto adicional para verificar que el corte prioriza párrafos completos antes de partir oraciones.');
  assert.equal(chunks[2], 'Tercer bloque para empujar el texto por encima del threshold configurado en esta prueba y validar la estrategia larga.');
});

test('transcription summarizer consolidates long text with map-reduce into final payload shape', async () => {
  const longText = [
    'Bloque uno con contexto importante y decisiones del equipo. '.repeat(6),
    'Bloque dos con riesgos, próximos pasos y acuerdos relevantes. '.repeat(6),
    'Bloque tres con cierre, dependencias y puntos accionables. '.repeat(6)
  ].join('\n\n');

  const calls = [];
  const result = await summarizeTranscription(
    {
      text: longText,
      apiKey: 'sk-openai',
      model: 'gpt-4o-mini'
    },
    {
      summarizeText: async ({ messages, model }) => {
        calls.push({ messages, model });

        if (calls.length < 4) {
          return {
            summary: `Resumen parcial ${calls.length}.`,
            key_points: [
              `Punto ${calls.length}.1`,
              `Punto ${calls.length}.2`,
              `Punto ${calls.length}.3`
            ]
          };
        }

        return {
          summary: 'Resumen final consolidado.',
          key_points: ['Punto final 1', 'Punto final 2', 'Punto final 3']
        };
      }
    },
    {
      singlePassCharThreshold: 120,
      targetChunkChars: 400,
      maxChunks: 8
    }
  );

  assert.equal(calls.length, 4);
  assert.match(calls[0].messages[0].content, /chunk/i);
  assert.match(calls[3].messages[0].content, /consolid/i);
  assert.equal(result.short, 'Resumen final consolidado.');
  assert.deepEqual(result.keyPoints, ['Punto final 1', 'Punto final 2', 'Punto final 3']);
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.sourceTextHash, await sourceTextHash(longText));
});
