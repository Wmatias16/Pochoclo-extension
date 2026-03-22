(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaProviderDiagnostics = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SENSITIVE_KEYS = [
    'apikey',
    'authorization',
    'token',
    'secret',
    'password',
    'blob',
    'audio',
    'dataurl',
    'payload',
    'raw',
    'transcript',
    'text',
    'content',
    'file'
  ];
  const SENSITIVE_SUFFIX_KEYS = ['apikey', 'token', 'secret', 'password', 'blob', 'file'];

  function normalizeKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isSensitiveKey(key) {
    const normalized = normalizeKey(key);
    return SENSITIVE_KEYS.includes(normalized)
      || SENSITIVE_SUFFIX_KEYS.some((candidate) => normalized !== candidate && normalized.endsWith(candidate));
  }

  function sanitizeString(value) {
    return String(value)
      .replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, 'bearer [redacted]')
      .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function sanitizeValue(value, key) {
    if (value === null || value === undefined) {
      return value;
    }

    if (isSensitiveKey(key)) {
      return '[redacted]';
    }

    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return '[Blob]';
    }

    if (typeof FormData !== 'undefined' && value instanceof FormData) {
      return '[FormData]';
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitizeString(value.message || ''),
        code: value.code || null,
        status: Number.isFinite(Number(value.status)) ? Number(value.status) : 0
      };
    }

    if (ArrayBuffer.isView(value)) {
      return `[${value.constructor && value.constructor.name ? value.constructor.name : 'TypedArray'}]`;
    }

    if (value instanceof ArrayBuffer) {
      return '[ArrayBuffer]';
    }

    if (Array.isArray(value)) {
      return value.slice(0, 10).map((item) => sanitizeValue(item, key));
    }

    if (typeof value === 'string') {
      return sanitizeString(value);
    }

    if (typeof value !== 'object') {
      return value;
    }

    return Object.entries(value).reduce((acc, [entryKey, entryValue]) => {
      if (typeof entryValue === 'function') {
        return acc;
      }

      acc[entryKey] = sanitizeValue(entryValue, entryKey);
      return acc;
    }, {});
  }

  function callSink(sink, level, message, payload) {
    if (!sink) {
      return;
    }

    if (typeof sink[level] === 'function') {
      sink[level](message, payload);
      return;
    }

    if (typeof sink.log === 'function') {
      sink.log(message, payload);
    }
  }

  function createDiagnosticsLogger(options = {}) {
    const namespace = options.namespace || 'providers';
    const sink = options.sink || console;
    const baseContext = sanitizeValue(options.baseContext || {}, 'context');

    function emit(level, event, context = {}) {
      const payload = sanitizeValue({ event, ...baseContext, ...context }, 'context');
      callSink(sink, level, `[${namespace}] ${event}`, payload);
      return payload;
    }

    return {
      info(event, context) {
        return emit('info', event, context);
      },
      warn(event, context) {
        return emit('warn', event, context);
      },
      error(event, context) {
        return emit('error', event, context);
      },
      child(context = {}) {
        return createDiagnosticsLogger({
          namespace,
          sink,
          baseContext: { ...baseContext, ...sanitizeValue(context, 'context') }
        });
      }
    };
  }

  return {
    createDiagnosticsLogger,
    sanitizeDiagnosticsContext: sanitizeValue
  };
});
