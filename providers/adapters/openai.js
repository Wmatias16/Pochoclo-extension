(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaOpenAIAdapter = factory(root.PochoclaProviderAdapterShared);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  const {
    buildApiError,
    buildSuccessPayload,
    ensureOkResponse,
    ensureText,
    getFetchImpl,
    getTimeoutDeps,
    parseJsonResponse
  } = shared;

  const DEFAULT_SUMMARY_TIMEOUT_MS = 45000;

  function getSummaryTimeoutMs(input = {}) {
    const candidates = [
      input.timeoutMs,
      input.settings && input.settings.summaryTimeoutMs,
      input.settings && input.settings.timeoutMs
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }

    return DEFAULT_SUMMARY_TIMEOUT_MS;
  }

  async function fetchWithTimeout(url, options, deps = {}, timeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS) {
    const fetchImpl = getFetchImpl(deps);
    const { setTimeoutImpl, clearTimeoutImpl } = getTimeoutDeps(deps);

    if (typeof AbortController === 'undefined') {
      return fetchImpl(url, options);
    }

    const controller = new AbortController();
    const mergedOptions = {
      ...options,
      signal: options && options.signal ? options.signal : controller.signal
    };

    let timeoutHandle = null;

    try {
      timeoutHandle = setTimeoutImpl(() => controller.abort(), timeoutMs);
      return await fetchImpl(url, mergedOptions);
    } catch (error) {
      if (controller.signal.aborted) {
        throw buildApiError('OpenAI tardó demasiado en responder el resumen.', {
          status: 504,
          code: 'timeout'
        });
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeoutImpl(timeoutHandle);
      }
    }
  }

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

  async function summarizeText(input = {}, deps = {}) {
    const apiKey = ensureText(input.apiKey || (input.settings && input.settings.apiKey), 'Falta la API key de OpenAI');
    const model = input.model || (input.settings && input.settings.summaryModel) || 'gpt-4o-mini';
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const timeoutMs = getSummaryTimeoutMs(input);

    if (messages.length === 0) {
      throw buildApiError('Faltan mensajes para resumir con OpenAI', {
        status: 422,
        code: 'unsupported'
      });
    }

    const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 600
      })
    }, deps, timeoutMs);

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : '';

    if (!content) {
      throw buildApiError('OpenAI no devolvió contenido para el resumen', {
        status: 502,
        code: 'invalid_payload',
        response: data
      });
    }

    try {
      return JSON.parse(content);
    } catch (error) {
      throw buildApiError('OpenAI devolvió JSON inválido para el resumen', {
        status: 502,
        code: 'invalid_payload',
        response: data
      });
    }
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
    DEFAULT_SUMMARY_TIMEOUT_MS,
    id: 'openai',
    fetchWithTimeout,
    getSummaryTimeoutMs,
    summarizeText,
    transcribe
  };
});
