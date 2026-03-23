(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaProviderAdapterShared = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function buildConfigError(message) {
    const error = new Error(message || 'Missing provider configuration');
    error.code = 'unsupported';
    error.status = 422;
    return error;
  }

  function ensureText(value, message) {
    if (!hasText(value)) {
      throw buildConfigError(message);
    }

    return value.trim();
  }

  async function parseJsonResponse(response) {
    if (!response) return null;

    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  async function parseTextResponse(response) {
    if (!response || typeof response.text !== 'function') {
      return '';
    }

    try {
      return await response.text();
    } catch (error) {
      return '';
    }
  }

  function buildApiError(message, options = {}) {
    const error = new Error(message || 'Provider request failed');
    if (options.status) error.status = options.status;
    if (options.code) error.code = options.code;
    if (options.response) error.response = options.response;
    return error;
  }

  async function parseErrorResponse(response) {
    const data = await parseJsonResponse(response);
    const message = data && data.error
      ? data.error.message || data.error.code || response.statusText
      : (data && data.message) || response.statusText || 'Provider request failed';

    throw buildApiError(message, {
      status: response && response.status,
      code: data && data.error ? data.error.code : undefined,
      response: data
    });
  }

  async function ensureOkResponse(response) {
    if (response && response.ok) {
      return response;
    }

    await parseErrorResponse(response);
  }

  function buildSuccessPayload(providerId, text, extra = {}) {
    return {
      providerId,
      text: typeof text === 'string' ? text.trim() : '',
      model: extra.model || null,
      translated: !!extra.translated,
      language: extra.language || null,
      targetLanguage: extra.targetLanguage || null,
      raw: extra.raw || null
    };
  }

  function getFetchImpl(deps = {}) {
    const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch API no está disponible para el adapter');
    }

    return fetchImpl;
  }

  function getTimeoutDeps(deps = {}) {
    return {
      setTimeoutImpl: deps.setTimeoutImpl || setTimeout,
      clearTimeoutImpl: deps.clearTimeoutImpl || clearTimeout
    };
  }

  async function blobToBase64(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') {
      throw new Error('El audio del chunk no es válido');
    }

    const buffer = await blob.arrayBuffer();

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(buffer).toString('base64');
    }

    let binary = '';
    const bytes = new Uint8Array(buffer);
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function getAudioUploadMetadata(blob) {
    const mimeType = blob && typeof blob.type === 'string' && blob.type.trim()
      ? blob.type.trim()
      : 'audio/webm';

    const extensionByMimeType = {
      'audio/webm': 'webm',
      'audio/webm;codecs=opus': 'webm',
      'audio/wav': 'wav',
      'audio/wave': 'wav',
      'audio/x-wav': 'wav',
      'audio/mp3': 'mp3',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/oga': 'oga',
      'audio/flac': 'flac',
      'audio/mp4': 'mp4',
      'audio/m4a': 'm4a'
    };

    return {
      mimeType,
      fileName: `audio.${extensionByMimeType[mimeType] || 'webm'}`
    };
  }

  function joinUrl(baseUrl, path) {
    const normalizedBase = ensureText(baseUrl, 'Falta la URL base del provider').replace(/\/+$/, '');
    const normalizedPath = hasText(path) ? path.trim() : '';

    if (!normalizedPath) {
      return normalizedBase;
    }

    return `${normalizedBase}${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`;
  }

  return {
    blobToBase64,
    buildApiError,
    buildConfigError,
    buildSuccessPayload,
    ensureOkResponse,
    ensureText,
    getAudioUploadMetadata,
    getFetchImpl,
    getTimeoutDeps,
    hasText,
    joinUrl,
    parseJsonResponse,
    parseTextResponse
  };
});
