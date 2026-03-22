(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaOpenAIAdapter = factory(root.PochoclaProviderAdapterShared);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  const {
    buildSuccessPayload,
    ensureOkResponse,
    ensureText,
    getFetchImpl,
    parseJsonResponse
  } = shared;

  async function translateText(apiKey, text, targetLanguage, settings, deps) {
    const fetchImpl = getFetchImpl(deps);
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.translationModel || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Sos un traductor. Traducí el texto a ${targetLanguage}. Devolvé SOLO la traducción.`
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.2,
        max_tokens: 1024
      })
    });

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);
    return data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : text;
  }

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de OpenAI');
    const model = settings.model || 'whisper-1';
    const language = input.language || 'es';
    const targetLanguage = input.targetLanguage || language;
    const formData = new FormData();
    formData.append('file', input.blob, 'audio.webm');
    formData.append('model', model);
    formData.append('language', language);

    const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);
    let text = data && typeof data.text === 'string' ? data.text.trim() : '';
    let translated = false;

    if (text && language !== targetLanguage) {
      text = await translateText(apiKey, text, targetLanguage, settings, deps);
      translated = true;
    }

    return buildSuccessPayload('openai', text, {
      language,
      targetLanguage,
      translated,
      model,
      raw: data
    });
  }

  return {
    id: 'openai',
    transcribe
  };
});
