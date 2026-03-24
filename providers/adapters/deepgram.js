(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaDeepgramAdapter = factory(root.PochoclaProviderAdapterShared);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  const {
    buildConfigError,
    buildSuccessPayload,
    ensureOkResponse,
    ensureText,
    getAudioUploadMetadata,
    getFetchImpl,
    parseJsonResponse
  } = shared;

  const DEFAULT_DEEPGRAM_BATCH_URL = 'https://api.deepgram.com/v1/listen';
  const DEFAULT_DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen';
  const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
  const DEFAULT_DEEPGRAM_LANGUAGE = 'es';

  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function ensureDeepgramUrl(baseUrl, fallbackUrl) {
    const raw = hasText(baseUrl) ? baseUrl.trim() : fallbackUrl;
    return new URL(raw);
  }

  function appendDeepgramCommonQueryParams(url, options = {}) {
    const model = hasText(options.model) ? options.model.trim() : DEFAULT_DEEPGRAM_MODEL;
    const language = hasText(options.language) ? options.language.trim() : DEFAULT_DEEPGRAM_LANGUAGE;

    url.searchParams.set('model', model);
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('language', language);

    if (options.interimResults === true) {
      url.searchParams.set('interim_results', 'true');
    }

    if (hasText(options.encoding)) {
      url.searchParams.set('encoding', options.encoding.trim());
    }

    if (Number.isFinite(Number(options.sampleRate))) {
      url.searchParams.set('sample_rate', String(Number(options.sampleRate)));
    }

    if (hasText(options.channels)) {
      url.searchParams.set('channels', options.channels.trim());
    }

    if (hasText(options.endpointing)) {
      url.searchParams.set('endpointing', options.endpointing.trim());
    }

    return {
      model,
      language,
      url
    };
  }

  function getDeepgramBatchConfig(settings = {}, options = {}) {
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de Deepgram');
    const prepared = appendDeepgramCommonQueryParams(
      ensureDeepgramUrl(settings.baseUrl, DEFAULT_DEEPGRAM_BATCH_URL),
      {
        model: settings.model,
        language: options.language
      }
    );

    return {
      apiKey,
      model: prepared.model,
      language: prepared.language,
      url: prepared.url
    };
  }

  function buildDeepgramLiveStartupError(message, options = {}) {
    const error = buildConfigError(message || 'No se pudo iniciar Deepgram Live');
    error.code = options.code || 'live_startup_blocked';
    error.status = options.status || error.status || 422;
    error.fallbackReady = true;
    error.retryable = !!options.retryable;
    error.providerId = 'deepgram';
    error.mode = 'live';
    if (options.details !== undefined) {
      error.details = options.details;
    }
    if (options.cause) {
      error.cause = options.cause;
    }
    return error;
  }

  function getDeepgramLiveConfig(settings = {}, options = {}) {
    if (settings.liveEnabled !== true) {
      throw buildDeepgramLiveStartupError(
        'Deepgram Live está deshabilitado para este rollout.',
        {
          code: 'live_disabled',
          status: 412,
          details: { requires: 'providers.deepgram.liveEnabled=true' }
        }
      );
    }

    const apiKey = ensureText(settings.apiKey, 'Falta la API key de Deepgram para live');
    const prepared = appendDeepgramCommonQueryParams(
      ensureDeepgramUrl(settings.liveUrl || settings.baseUrl, DEFAULT_DEEPGRAM_LIVE_URL),
      {
        model: settings.model,
        language: options.language || settings.language,
        interimResults: true,
        encoding: options.encoding || settings.liveEncoding || 'opus',
        sampleRate: options.sampleRate || settings.sampleRate || 48000,
        channels: options.channels || settings.channels,
        endpointing: options.endpointing || settings.endpointing
      }
    );

    prepared.url.searchParams.set('token', apiKey);

    return {
      apiKey,
      model: prepared.model,
      language: prepared.language,
      url: prepared.url.toString()
    };
  }

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const batchConfig = getDeepgramBatchConfig(settings, {
      language: input.language || DEFAULT_DEEPGRAM_LANGUAGE
    });
    const upload = getAudioUploadMetadata(input.blob);

    const response = await fetchImpl(batchConfig.url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${batchConfig.apiKey}`,
        'Content-Type': upload.mimeType
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
      language: batchConfig.language,
      targetLanguage: input.targetLanguage || batchConfig.language,
      model: batchConfig.model,
      raw: data
    });
  }

  return {
    DEFAULT_DEEPGRAM_BATCH_URL,
    DEFAULT_DEEPGRAM_LIVE_URL,
    buildDeepgramLiveStartupError,
    getDeepgramBatchConfig,
    getDeepgramLiveConfig,
    id: 'deepgram',
    transcribe
  };
});
