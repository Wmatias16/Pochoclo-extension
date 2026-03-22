(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
    return;
  }

  root.PochoclaAssemblyAIAdapter = factory(root.PochoclaProviderAdapterShared);
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

  function sleep(ms, deps) {
    const { setTimeoutImpl } = getTimeoutDeps(deps);
    return new Promise((resolve) => setTimeoutImpl(resolve, ms));
  }

  async function pollTranscript(fetchImpl, transcriptId, settings, deps) {
    const pollingIntervalMs = Number.isFinite(Number(settings.pollIntervalMs)) ? Number(settings.pollIntervalMs) : 1500;
    const maxPolls = Number.isFinite(Number(settings.maxPolls)) ? Number(settings.maxPolls) : 20;
    const statusUrl = `${settings.baseUrl || 'https://api.assemblyai.com/v2'}/transcript/${transcriptId}`;

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const response = await fetchImpl(statusUrl, {
        method: 'GET',
        headers: {
          Authorization: settings.apiKey
        }
      });

      await ensureOkResponse(response);
      const data = await parseJsonResponse(response);

      if (data && data.status === 'completed') {
        return data;
      }

      if (data && data.status === 'error') {
        throw buildApiError(data.error || 'AssemblyAI devolvió un error de transcripción', { status: 422, response: data });
      }

      await sleep(pollingIntervalMs, deps);
    }

    throw buildApiError('AssemblyAI no completó la transcripción dentro del tiempo esperado', { status: 504 });
  }

  async function transcribe(input = {}, deps = {}) {
    const fetchImpl = getFetchImpl(deps);
    const settings = input.settings || {};
    const apiKey = ensureText(settings.apiKey, 'Falta la API key de AssemblyAI');
    const baseUrl = settings.baseUrl || 'https://api.assemblyai.com/v2';
    const uploadResponse = await fetchImpl(`${baseUrl}/upload`, {
      method: 'POST',
      headers: {
        Authorization: apiKey
      },
      body: input.blob
    });

    await ensureOkResponse(uploadResponse);
    const uploadData = await parseJsonResponse(uploadResponse);
    const uploadUrl = ensureText(uploadData && uploadData.upload_url, 'AssemblyAI no devolvió upload_url');

    const transcriptResponse = await fetchImpl(`${baseUrl}/transcript`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: uploadUrl,
        language_code: input.language || 'es',
        speech_model: settings.model || 'best'
      })
    });

    await ensureOkResponse(transcriptResponse);
    const transcriptData = await parseJsonResponse(transcriptResponse);
    const completed = await pollTranscript(fetchImpl, transcriptData.id, { ...settings, apiKey, baseUrl }, deps);

    return buildSuccessPayload('assemblyai', completed && completed.text ? completed.text : '', {
      language: input.language || 'es',
      targetLanguage: input.targetLanguage || input.language || 'es',
      model: settings.model || 'best',
      raw: completed
    });
  }

  return {
    id: 'assemblyai',
    transcribe
  };
});
