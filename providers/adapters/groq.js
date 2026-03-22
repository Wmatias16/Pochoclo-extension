(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaGroqAdapter = factory(root.PochoclaProviderAdapterShared);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  const {
    buildSuccessPayload,
    ensureOkResponse,
    ensureText,
    getFetchImpl,
    parseJsonResponse
  } = shared;

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de Groq');
    const model = settings.model || 'whisper-large-v3-turbo';
    const formData = new FormData();
    formData.append('file', input.blob, 'audio.webm');
    formData.append('model', model);
    formData.append('language', input.language || 'es');

    const response = await fetchImpl(settings.baseUrl || 'https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);

    return buildSuccessPayload('groq', data && data.text ? data.text : '', {
      language: input.language || 'es',
      targetLanguage: input.targetLanguage || input.language || 'es',
      model,
      raw: data
    });
  }

  return {
    id: 'groq',
    transcribe
  };
});
