(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaDeepgramAdapter = factory(root.PochoclaProviderAdapterShared);
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
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de Deepgram');
    const language = input.language || 'es';
    const model = settings.model || 'nova-3';
    const url = new URL(settings.baseUrl || 'https://api.deepgram.com/v1/listen');
    url.searchParams.set('model', model);
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('language', language);

    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': input.blob && input.blob.type ? input.blob.type : 'audio/webm'
      },
      body: input.blob
    });

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);
    const text = data
      && data.results
      && data.results.channels
      && data.results.channels[0]
      && data.results.channels[0].alternatives
      && data.results.channels[0].alternatives[0]
      ? String(data.results.channels[0].alternatives[0].transcript || '').trim()
      : '';

    return buildSuccessPayload('deepgram', text, {
      language,
      targetLanguage: input.targetLanguage || language,
      model,
      raw: data
    });
  }

  return {
    id: 'deepgram',
    transcribe
  };
});
