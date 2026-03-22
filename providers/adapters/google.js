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

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de Google Speech');
    const languageCode = normalizeLanguageCode(input.language || 'es');
    const audioContent = await blobToBase64(input.blob);
    const response = await fetchImpl(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        config: {
          encoding: 'WEBM_OPUS',
          languageCode,
          enableAutomaticPunctuation: true,
          model: settings.model || 'latest_long'
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
    transcribe
  };
});
