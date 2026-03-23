(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaWhisperLocalAdapter = factory(root.PochoclaProviderAdapterShared);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (shared) {
  const {
    buildSuccessPayload,
    ensureOkResponse,
    getFetchImpl,
    getAudioUploadMetadata,
    hasText,
    joinUrl,
    parseJsonResponse
  } = shared;

  async function preflight(settings = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const response = await fetchImpl(joinUrl(settings.baseUrl, settings.healthPath || '/health'), {
      method: 'GET'
    });

    if (response && response.ok) {
      return { ok: true };
    }

    return {
      ok: false,
      reason: 'healthcheck_failed',
      status: response && response.status ? response.status : 0
    };
  }

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const endpoint = joinUrl(settings.baseUrl, settings.transcribePath || '/transcribe');
    const upload = getAudioUploadMetadata(input.blob);
    const formData = new FormData();
    formData.append('file', input.blob, upload.fileName);

    if (hasText(input.language)) {
      formData.append('language', input.language.trim());
    }

    if (hasText(input.targetLanguage)) {
      formData.append('targetLanguage', input.targetLanguage.trim());
    }

    if (hasText(settings.model)) {
      formData.append('model', settings.model.trim());
    }

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      body: formData
    });

    await ensureOkResponse(response);
    const data = await parseJsonResponse(response);
    const text = data && typeof data.text === 'string'
      ? data.text
      : data && typeof data.transcript === 'string'
        ? data.transcript
        : data && data.result && typeof data.result.text === 'string'
          ? data.result.text
          : '';

    return buildSuccessPayload('whisperLocal', text, {
      language: input.language || 'es',
      targetLanguage: input.targetLanguage || input.language || 'es',
      model: settings.model || 'bridge-default',
      raw: data
    });
  }

  return {
    id: 'whisperLocal',
    preflight,
    transcribe
  };
});
