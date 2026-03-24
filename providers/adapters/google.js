(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaGoogleAdapter = factory(root.PochoclaProviderAdapterShared);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  const {
    blobToBase64,
    buildSuccessPayload,
    ensureOkResponse,
    ensureText,
    getFetchImpl,
    parseJsonResponse
  } = shared;

  function normalizeLanguageCode(language) {
    const normalized = typeof language === 'string' ? language.trim() : '';
    if (!normalized) return 'es-ES';
    if (normalized.includes('-')) return normalized;
    if (normalized === 'es') return 'es-ES';
    if (normalized === 'en') return 'en-US';
    if (normalized === 'pt') return 'pt-BR';
    return normalized;
  }

  function resolveGoogleEncoding(blob) {
    const mimeType = blob && typeof blob.type === 'string' ? blob.type.trim() : '';
    if (mimeType === 'audio/wav' || mimeType === 'audio/wave' || mimeType === 'audio/x-wav') {
      return 'LINEAR16';
    }
    return 'WEBM_OPUS';
  }

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de Google Speech');
    const languageCode = normalizeLanguageCode(input.language || 'es');
    const audioContent = await blobToBase64(input.blob);
    const encoding = resolveGoogleEncoding(input.blob);
    const sampleRateHertz = input.context && Number.isFinite(Number(input.context.audioSampleRate))
      ? Number(input.context.audioSampleRate)
      : undefined;
    const response = await fetchImpl('https://speech.googleapis.com/v1/speech:recognize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey
      },
      body: JSON.stringify({
        config: {
          encoding,
          languageCode,
          enableAutomaticPunctuation: true,
          model: settings.model || 'latest_long',
          ...(sampleRateHertz ? { sampleRateHertz } : {})
        },
        audio: {
          content: audioContent
        }
      })
    });

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);
    const text = Array.isArray(data && data.results)
      ? data.results
          .map((result) => result && result.alternatives && result.alternatives[0] ? result.alternatives[0].transcript || '' : '')
          .filter(Boolean)
          .join(' ')
          .trim()
      : '';

    return buildSuccessPayload('google', text, {
      language: languageCode,
      targetLanguage: input.targetLanguage || input.language || 'es',
      model: settings.model || 'latest_long',
      raw: data
    });
  }

  return {
    id: 'google',
    normalizeLanguageCode,
    resolveGoogleEncoding,
    transcribe
  };
});
