(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../providers/adapters/openai.js'));
    return;
  }

  root.PochoclaTranscriptionSummarizer = factory(root.PochoclaOpenAIAdapter);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (openaiAdapter) {
  const DEFAULT_SUMMARY_MODEL = 'gpt-4o-mini';
  const MIN_KEY_POINTS = 3;
  const MAX_KEY_POINTS = 7;
  const DEFAULT_SINGLE_PASS_CHAR_THRESHOLD = 24000;
  const DEFAULT_TARGET_CHUNK_CHARS = 12000;
  const DEFAULT_MAX_CHUNKS = 8;

  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function ensureText(value, message, code = 'invalid_input') {
    if (!hasText(value)) {
      const error = new Error(message);
      error.code = code;
      error.status = 422;
      error.retryable = false;
      throw error;
    }

    return value.trim();
  }

  function buildInvalidPayloadError(message, cause) {
    const error = new Error(message || 'El provider devolvió un payload de resumen inválido.');
    error.code = 'invalid_payload';
    error.status = 502;
    error.retryable = true;
    if (cause) {
      error.cause = cause;
    }
    return error;
  }

  function buildSummaryMessages(input = {}) {
    const text = ensureText(input.text, 'No hay texto disponible para resumir.', 'empty_text');

    return [
      {
        role: 'system',
        content: 'Sos un asistente que resume transcripciones. Mantené el mismo idioma del texto recibido. No inventes datos ni agregues contexto externo. Devolvé SOLO JSON válido con las claves "summary" y "key_points". "summary" debe ser un resumen corto de 2 a 4 oraciones. "key_points" debe ser un array de 3 a 7 strings breves y concretos.'
      },
      {
        role: 'user',
        content: text
      }
    ];
  }

  function buildChunkSummaryMessages(input = {}) {
    const text = ensureText(input.text, 'No hay texto disponible para resumir.', 'empty_text');
    const chunkIndex = Number.isFinite(Number(input.chunkIndex)) ? Number(input.chunkIndex) : 1;
    const totalChunks = Number.isFinite(Number(input.totalChunks)) ? Number(input.totalChunks) : 1;

    return [
      {
        role: 'system',
        content: 'Sos un asistente que resume un chunk de una transcripción larga. Mantené el mismo idioma del texto recibido. No inventes datos ni agregues contexto externo. Priorizá hechos, decisiones y acciones mencionadas en este chunk. Devolvé SOLO JSON válido con las claves "summary" y "key_points". "summary" debe ser un resumen corto de 2 a 4 oraciones del chunk. "key_points" debe ser un array de 3 a 7 strings breves y concretos.'
      },
      {
        role: 'user',
        content: `Chunk ${chunkIndex} de ${totalChunks}:\n\n${text}`
      }
    ];
  }

  function buildReduceSummaryMessages(input = {}) {
    const partialSummaries = Array.isArray(input.partialSummaries) ? input.partialSummaries : [];
    if (partialSummaries.length === 0) {
      throw buildInvalidPayloadError('No hay resúmenes parciales para consolidar.');
    }

    const serialized = partialSummaries
      .map((partial, index) => {
        const summary = hasText(partial && partial.short) ? partial.short.trim() : '';
        const keyPoints = Array.isArray(partial && partial.keyPoints)
          ? partial.keyPoints.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
          : [];

        return [
          `Chunk ${index + 1}:`,
          `Resumen: ${summary}`,
          `Puntos clave: ${keyPoints.join(' | ')}`
        ].join('\n');
      })
      .join('\n\n');

    return [
      {
        role: 'system',
        content: 'Sos un asistente que consolida resúmenes parciales de una transcripción larga. Mantené el mismo idioma de los fragmentos. No inventes datos ni agregues contexto externo. Deduplicá ideas repetidas y devolvé SOLO JSON válido con las claves "summary" y "key_points". "summary" debe ser un resumen final corto de 2 a 4 oraciones. "key_points" debe ser un array de 3 a 7 strings breves y concretos.'
      },
      {
        role: 'user',
        content: `Consolidá estos resúmenes parciales en una única síntesis final:\n\n${serialized}`
      }
    ];
  }

  function getSummaryOptions(options = {}) {
    const singlePassCharThreshold = Number(options.singlePassCharThreshold);
    const targetChunkChars = Number(options.targetChunkChars);
    const maxChunks = Number(options.maxChunks);

    return {
      singlePassCharThreshold: Number.isFinite(singlePassCharThreshold) && singlePassCharThreshold > 0
        ? Math.floor(singlePassCharThreshold)
        : DEFAULT_SINGLE_PASS_CHAR_THRESHOLD,
      targetChunkChars: Number.isFinite(targetChunkChars) && targetChunkChars > 0
        ? Math.floor(targetChunkChars)
        : DEFAULT_TARGET_CHUNK_CHARS,
      maxChunks: Number.isFinite(maxChunks) && maxChunks > 0
        ? Math.floor(maxChunks)
        : DEFAULT_MAX_CHUNKS
    };
  }

  function splitParagraphIntoSentences(paragraph) {
    const normalized = hasText(paragraph) ? paragraph.trim() : '';
    if (!normalized) {
      return [];
    }

    const matches = normalized.match(/[^.!?\n]+[.!?]?/g);
    const sentences = Array.isArray(matches)
      ? matches.map((item) => item.trim()).filter(Boolean)
      : [normalized];

    return sentences.length > 0 ? sentences : [normalized];
  }

  function splitOversizedSegment(segment, targetChunkChars) {
    const normalized = hasText(segment) ? segment.trim() : '';
    if (!normalized) {
      return [];
    }

    if (normalized.length <= targetChunkChars) {
      return [normalized];
    }

    const sentences = splitParagraphIntoSentences(normalized);
    const parts = [];
    let current = '';

    for (const sentence of sentences) {
      if (!sentence) {
        continue;
      }

      if (sentence.length > targetChunkChars) {
        if (current) {
          parts.push(current);
          current = '';
        }

        for (let index = 0; index < sentence.length; index += targetChunkChars) {
          parts.push(sentence.slice(index, index + targetChunkChars).trim());
        }
        continue;
      }

      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length > targetChunkChars) {
        parts.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    }

    if (current) {
      parts.push(current);
    }

    return parts.filter(Boolean);
  }

  function segmentTextForSummary(text, options = {}) {
    const normalized = ensureText(text, 'No hay texto disponible para resumir.', 'empty_text');
    const { targetChunkChars } = getSummaryOptions(options);
    const paragraphs = normalized
      .split(/\n\s*\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    const segments = [];

    for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized]) {
      segments.push(...splitOversizedSegment(paragraph, targetChunkChars));
    }

    return segments.filter(Boolean);
  }

  function mergeSegmentsIntoChunks(segments, targetChunkChars) {
    const chunks = [];
    let current = '';

    for (const segment of segments) {
      if (!segment) {
        continue;
      }

      const separator = current ? '\n\n' : '';
      const candidate = `${current}${separator}${segment}`;
      if (current && candidate.length > targetChunkChars) {
        chunks.push(current);
        current = segment;
      } else {
        current = candidate;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.filter(Boolean);
  }

  function rebalanceChunks(chunks, maxChunks) {
    if (chunks.length <= maxChunks) {
      return chunks;
    }

    const grouped = [];
    const baseSize = Math.floor(chunks.length / maxChunks);
    const remainder = chunks.length % maxChunks;
    let cursor = 0;

    for (let index = 0; index < maxChunks; index += 1) {
      const sliceSize = baseSize + (index < remainder ? 1 : 0);
      const slice = chunks.slice(cursor, cursor + sliceSize);
      cursor += sliceSize;
      grouped.push(slice.join('\n\n').trim());
    }

    return grouped.filter(Boolean);
  }

  function chunkTextForSummary(text, options = {}) {
    const normalized = ensureText(text, 'No hay texto disponible para resumir.', 'empty_text');
    const { targetChunkChars, maxChunks } = getSummaryOptions(options);
    const segments = segmentTextForSummary(normalized, { targetChunkChars });
    const merged = mergeSegmentsIntoChunks(segments, targetChunkChars);
    const rebalanced = rebalanceChunks(merged, maxChunks);
    return rebalanced.length > 0 ? rebalanced : [normalized];
  }

  function selectSummaryStrategy(text, options = {}) {
    const normalized = ensureText(text, 'No hay texto disponible para resumir.', 'empty_text');
    const { singlePassCharThreshold } = getSummaryOptions(options);
    return normalized.length > singlePassCharThreshold ? 'map-reduce' : 'single-pass';
  }

  function normalizeKeyPoints(value) {
    if (!Array.isArray(value)) {
      throw buildInvalidPayloadError('El payload de resumen no incluye una lista válida de key points.');
    }

    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);

    if (normalized.length < MIN_KEY_POINTS || normalized.length > MAX_KEY_POINTS) {
      throw buildInvalidPayloadError('La cantidad de key points devuelta por el provider es inválida.');
    }

    return normalized;
  }

  function validateSummaryPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw buildInvalidPayloadError('El payload de resumen no es un objeto JSON válido.');
    }

    const summary = hasText(payload.summary)
      ? payload.summary.trim()
      : '';

    if (!summary) {
      throw buildInvalidPayloadError('El payload de resumen no incluye un summary válido.');
    }

    return {
      short: summary,
      keyPoints: normalizeKeyPoints(payload.key_points),
      model: hasText(payload.model) ? payload.model.trim() : null
    };
  }

  async function sourceTextHash(text) {
    const normalized = ensureText(text, 'No hay texto disponible para resumir.', 'empty_text');

    if (typeof require === 'function') {
      try {
        const { createHash } = require('node:crypto');
        return createHash('sha256').update(normalized, 'utf8').digest('hex');
      } catch (error) {
        // fallback below
      }
    }

    if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
      const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
      return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }

    throw new Error('No hay implementación de hash disponible para resumir transcripciones.');
  }

  async function summarizeSinglePass(input = {}, deps = {}) {
    const text = ensureText(input.text, 'No hay texto disponible para resumir.', 'empty_text');
    const apiKey = ensureText(input.apiKey, 'Falta la API key de OpenAI.', 'missing_api_key');
    const model = hasText(input.model) ? input.model.trim() : DEFAULT_SUMMARY_MODEL;
    const summarizeText = deps.summarizeText || (openaiAdapter && openaiAdapter.summarizeText);

    if (typeof summarizeText !== 'function') {
      throw new Error('El adapter de OpenAI no expone summarizeText().');
    }

    const payload = await summarizeText(
      {
        apiKey,
        model,
        text,
        messages: buildSummaryMessages({ text })
      },
      deps
    );

    const validated = validateSummaryPayload(payload);
    return {
      short: validated.short,
      keyPoints: validated.keyPoints,
      model,
      sourceTextHash: await sourceTextHash(text)
    };
  }

  async function summarizeChunk(input = {}, deps = {}) {
    const text = ensureText(input.text, 'No hay texto disponible para resumir.', 'empty_text');
    const apiKey = ensureText(input.apiKey, 'Falta la API key de OpenAI.', 'missing_api_key');
    const model = hasText(input.model) ? input.model.trim() : DEFAULT_SUMMARY_MODEL;
    const summarizeText = deps.summarizeText || (openaiAdapter && openaiAdapter.summarizeText);

    if (typeof summarizeText !== 'function') {
      throw new Error('El adapter de OpenAI no expone summarizeText().');
    }

    const payload = await summarizeText(
      {
        apiKey,
        model,
        text,
        messages: buildChunkSummaryMessages({
          text,
          chunkIndex: input.chunkIndex,
          totalChunks: input.totalChunks
        })
      },
      deps
    );

    return validateSummaryPayload(payload);
  }

  async function summarizeReducePass(input = {}, deps = {}) {
    const apiKey = ensureText(input.apiKey, 'Falta la API key de OpenAI.', 'missing_api_key');
    const model = hasText(input.model) ? input.model.trim() : DEFAULT_SUMMARY_MODEL;
    const summarizeText = deps.summarizeText || (openaiAdapter && openaiAdapter.summarizeText);

    if (typeof summarizeText !== 'function') {
      throw new Error('El adapter de OpenAI no expone summarizeText().');
    }

    const payload = await summarizeText(
      {
        apiKey,
        model,
        text: input.partialSummaries.map((partial) => partial.short).join('\n\n'),
        messages: buildReduceSummaryMessages({ partialSummaries: input.partialSummaries })
      },
      deps
    );

    return validateSummaryPayload(payload);
  }

  async function summarizeMapReduce(input = {}, deps = {}, options = {}) {
    const text = ensureText(input.text, 'No hay texto disponible para resumir.', 'empty_text');
    const apiKey = ensureText(input.apiKey, 'Falta la API key de OpenAI.', 'missing_api_key');
    const model = hasText(input.model) ? input.model.trim() : DEFAULT_SUMMARY_MODEL;
    const chunks = chunkTextForSummary(text, options);
    const partialSummaries = [];

    for (let index = 0; index < chunks.length; index += 1) {
      partialSummaries.push(await summarizeChunk({
        text: chunks[index],
        apiKey,
        model,
        chunkIndex: index + 1,
        totalChunks: chunks.length
      }, deps));
    }

    const reduced = await summarizeReducePass({ partialSummaries, apiKey, model }, deps);
    return {
      short: reduced.short,
      keyPoints: reduced.keyPoints,
      model,
      sourceTextHash: await sourceTextHash(text)
    };
  }

  async function summarizeTranscription(input = {}, deps = {}, options = {}) {
    const text = ensureText(input.text, 'No hay texto disponible para resumir.', 'empty_text');
    const strategy = selectSummaryStrategy(text, options);

    if (strategy === 'map-reduce') {
      return summarizeMapReduce({ ...input, text }, deps, options);
    }

    return summarizeSinglePass({ ...input, text }, deps);
  }

  return {
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_MAX_CHUNKS,
    DEFAULT_SINGLE_PASS_CHAR_THRESHOLD,
    DEFAULT_TARGET_CHUNK_CHARS,
    buildInvalidPayloadError,
    buildChunkSummaryMessages,
    buildReduceSummaryMessages,
    buildSummaryMessages,
    chunkTextForSummary,
    getSummaryOptions,
    selectSummaryStrategy,
    sourceTextHash,
    summarizeChunk,
    summarizeMapReduce,
    summarizeReducePass,
    summarizeTranscription,
    summarizeSinglePass,
    validateSummaryPayload
  };
});
