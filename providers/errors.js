(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaProviderErrors = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function asStatus(error) {
    const status = error && (error.status || error.statusCode || (error.response && error.response.status));
    return Number.isFinite(Number(status)) ? Number(status) : 0;
  }

  function extractMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string') return error.message;
    if (error.error && typeof error.error.message === 'string') return error.error.message;
    return '';
  }

  function sanitizeSummary(message) {
    if (!message) return '';

    return message
      .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, 'bearer [redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function inferErrorCode(error, options = {}) {
    const message = extractMessage(error).toLowerCase();
    const status = asStatus(error);
    const errorName = String((error && error.name) || '').toLowerCase();
    const rawCode = String(
      (error && (error.code || error.errorCode || (error.error && error.error.code))) || ''
    ).toLowerCase();
    const providerId = options.providerId || '';

    if (
      errorName === 'aborterror'
      || rawCode.includes('timeout')
      || rawCode.includes('timedout')
      || message.includes('timeout')
      || message.includes('timed out')
      || message.includes('tiempo de espera')
    ) {
      return 'timeout';
    }

    if (status === 401 || status === 403 || rawCode.includes('auth') || message.includes('unauthorized') || message.includes('invalid api key')) {
      return 'auth';
    }

    if (status === 429 || rawCode.includes('rate') || message.includes('rate limit')) {
      return 'rate_limit';
    }

    if (status === 404 || status === 405 || status === 415 || status === 422 || status === 501 || message.includes('unsupported')) {
      return 'unsupported';
    }

    if (
      message.includes('audio del chunk no es válido') ||
      message.includes('audio serializado del chunk no es válido') ||
      message.includes("parameter 2 is not of type 'blob'")
    ) {
      return 'unsupported';
    }

    if (
      providerId === 'whisperLocal' &&
      (rawCode.includes('econnrefused') || rawCode.includes('enotfound') || rawCode.includes('etimedout') || message.includes('healthcheck'))
    ) {
      return 'unavailable';
    }

    if (status === 502 || status === 503 || status === 504 || rawCode.includes('unavailable') || message.includes('unavailable')) {
      return 'unavailable';
    }

    if (
      rawCode.includes('network') ||
      rawCode.includes('fetch') ||
      error instanceof TypeError ||
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('load failed')
    ) {
      return 'network';
    }

    return 'unknown';
  }

  function buildSafeSummary(errorCode, error, options = {}) {
    const sanitized = sanitizeSummary(extractMessage(error));

    switch (errorCode) {
      case 'auth':
        return 'Autenticación inválida. Revisá las credenciales del provider.';
      case 'rate_limit':
        return 'El provider alcanzó el rate limit. Probá nuevamente en unos minutos.';
      case 'timeout':
        return 'El provider tardó demasiado en generar el resultado. Probá nuevamente.';
      case 'network':
        return 'Falló la conexión de red con el provider.';
      case 'unavailable':
        return options.providerId === 'whisperLocal'
          ? 'El bridge local de Whisper no está disponible.'
          : 'El provider no está disponible en este momento.';
      case 'unsupported':
        return 'La operación no está soportada por la configuración actual del provider.';
      default:
        return sanitized || 'Falló la transcripción por un error inesperado.';
    }
  }

  function normalizeProviderError(error, options = {}) {
    const code = inferErrorCode(error, options);
    const status = asStatus(error);

    return {
      code,
      status,
      retryable: code === 'rate_limit' || code === 'timeout' || code === 'network' || code === 'unavailable',
      summary: buildSafeSummary(code, error, options)
    };
  }

  return {
    inferErrorCode,
    normalizeProviderError,
    sanitizeSummary
  };
});
