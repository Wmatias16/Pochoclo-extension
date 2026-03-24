(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../adapters/deepgram.js'));
    return;
  }

  root.PochoclaDeepgramLiveTransport = factory(root.PochoclaDeepgramAdapter);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deepgramAdapter) {
  const KEEPALIVE_INTERVAL_MS = 9000;
  const OPEN_STATE = 1;
  const CLOSING_STATE = 2;
  const CLOSED_STATE = 3;

  function createListenerBucket() {
    return {
      message: [],
      error: [],
      close: []
    };
  }

  function addListener(registry, key, callback) {
    if (typeof callback !== 'function') {
      return function noop() {};
    }

    registry[key].push(callback);
    return function unsubscribe() {
      const index = registry[key].indexOf(callback);
      if (index >= 0) {
        registry[key].splice(index, 1);
      }
    };
  }

  function emit(listeners, key, payload) {
    listeners[key].forEach((callback) => {
      callback(payload);
    });
  }

  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function bindSocketEvent(socket, eventName, handler) {
    if (!socket || typeof handler !== 'function') {
      return;
    }

    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener(eventName, handler);
      return;
    }

    socket[`on${eventName}`] = handler;
  }

  function extractDeepgramTranscript(payload) {
    return payload
      && payload.channel
      && Array.isArray(payload.channel.alternatives)
      && payload.channel.alternatives[0]
      && typeof payload.channel.alternatives[0].transcript === 'string'
      ? payload.channel.alternatives[0].transcript.trim()
      : '';
  }

  function buildTransportError(message, options = {}) {
    const builder = deepgramAdapter && typeof deepgramAdapter.buildDeepgramLiveStartupError === 'function'
      ? deepgramAdapter.buildDeepgramLiveStartupError
      : ((fallbackMessage, fallbackOptions) => {
          const error = new Error(fallbackMessage);
          error.code = fallbackOptions && fallbackOptions.code ? fallbackOptions.code : 'live_transport_error';
          error.status = fallbackOptions && fallbackOptions.status ? fallbackOptions.status : 503;
          error.fallbackReady = true;
          error.retryable = !!(fallbackOptions && fallbackOptions.retryable);
          return error;
        });

    return builder(message, options);
  }

  function resolveLiveConfig(config = {}) {
    if (config.settings && deepgramAdapter && typeof deepgramAdapter.getDeepgramLiveConfig === 'function') {
      return deepgramAdapter.getDeepgramLiveConfig(config.settings, {
        language: config.language,
        sampleRate: config.sampleRate,
        encoding: config.encoding,
        channels: config.channels,
        endpointing: config.endpointing
      });
    }

    if (hasText(config.url)) {
      return {
        apiKey: hasText(config.apiKey) ? config.apiKey.trim() : '',
        model: hasText(config.model) ? config.model.trim() : 'nova-3',
        language: hasText(config.language) ? config.language.trim() : 'es',
        url: config.url.trim()
      };
    }

    throw buildTransportError('Falta la configuración de Deepgram Live.', {
      code: 'live_startup_blocked',
      status: 422,
      retryable: false
    });
  }

  function createSocketFactory(config = {}) {
    if (typeof config.createWebSocket === 'function') {
      return config.createWebSocket;
    }

    const WebSocketCtor = config.WebSocket || (typeof WebSocket === 'function' ? WebSocket : null);
    if (typeof WebSocketCtor === 'function') {
      return function createSocket(url, protocols) {
        return new WebSocketCtor(url, protocols);
      };
    }

    return null;
  }

  function createDeepgramLiveTransport(config = {}) {
    const listeners = createListenerBucket();
    const socketFactory = createSocketFactory(config);
    const setIntervalImpl = typeof config.setIntervalImpl === 'function' ? config.setIntervalImpl : setInterval;
    const clearIntervalImpl = typeof config.clearIntervalImpl === 'function' ? config.clearIntervalImpl : clearInterval;
    const keepaliveIntervalMs = Number.isFinite(Number(config.keepaliveIntervalMs))
      ? Number(config.keepaliveIntervalMs)
      : KEEPALIVE_INTERVAL_MS;

    let socket = null;
    let keepaliveTimer = null;
    let closePromise = null;
    let closeResolve = null;
    let hasOpened = false;

    function cleanupKeepalive() {
      if (keepaliveTimer) {
        clearIntervalImpl(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    function getReadyState() {
      return socket && typeof socket.readyState === 'number' ? socket.readyState : CLOSED_STATE;
    }

    function serializeOutboundPayload(data) {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return data;
      }

      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return data;
      }

      if (typeof data === 'string') {
        return data;
      }

      return JSON.stringify(data);
    }

    function sendRaw(data) {
      if (!socket || getReadyState() !== OPEN_STATE || typeof socket.send !== 'function') {
        throw buildTransportError('La conexión Deepgram Live no está abierta.', {
          code: 'socket_not_open',
          status: 503,
          retryable: true
        });
      }

      socket.send(serializeOutboundPayload(data));
      return true;
    }

    function startKeepalive() {
      cleanupKeepalive();
      keepaliveTimer = setIntervalImpl(() => {
        try {
          if (getReadyState() === OPEN_STATE) {
            sendRaw({ type: 'KeepAlive' });
          }
        } catch (error) {
          emit(listeners, 'error', buildTransportError('Falló el keepalive de Deepgram Live.', {
            code: 'keepalive_failed',
            status: 503,
            retryable: true,
            cause: error
          }));
        }
      }, keepaliveIntervalMs);

      if (keepaliveTimer && typeof keepaliveTimer.unref === 'function') {
        keepaliveTimer.unref();
      }
    }

    function ensureClosePromise() {
      if (!closePromise) {
        closePromise = new Promise((resolve) => {
          closeResolve = resolve;
        });
      }

      return closePromise;
    }

    function resolveClose(event) {
      cleanupKeepalive();
      if (closeResolve) {
        closeResolve(event || null);
        closeResolve = null;
      }
      closePromise = null;
    }

    function handleIncomingMessage(event) {
      if (!event) {
        return;
      }

      const rawPayload = event.data;
      const textPayload = typeof rawPayload === 'string'
        ? rawPayload
        : (typeof Buffer !== 'undefined' && rawPayload instanceof Buffer)
          ? rawPayload.toString('utf8')
          : '';

      if (!textPayload) {
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(textPayload);
      } catch (error) {
        emit(listeners, 'error', buildTransportError('Deepgram Live respondió con JSON inválido.', {
          code: 'invalid_payload',
          status: 502,
          retryable: true,
          cause: error
        }));
        return;
      }

      const type = parsed && typeof parsed.type === 'string' ? parsed.type : 'message';
      if (type === 'Results') {
        const transcript = extractDeepgramTranscript(parsed);
        if (!transcript) {
          return;
        }

        emit(listeners, 'message', {
          type: parsed.is_final ? 'final' : 'partial',
          isFinal: parsed.is_final === true,
          text: transcript,
          providerId: 'deepgram',
          raw: parsed
        });
        return;
      }

      if (type === 'Metadata') {
        emit(listeners, 'message', {
          type: 'metadata',
          providerId: 'deepgram',
          raw: parsed
        });
        return;
      }

      if (type === 'Warning') {
        emit(listeners, 'message', {
          type: 'warning',
          providerId: 'deepgram',
          code: parsed.warning || parsed.code || null,
          message: parsed.description || parsed.message || '',
          raw: parsed
        });
        return;
      }

      if (type === 'Error') {
        emit(listeners, 'error', buildTransportError(parsed.description || parsed.message || 'Deepgram Live devolvió un error.', {
          code: parsed.err_code || parsed.code || 'provider_error',
          status: 502,
          retryable: true,
          details: parsed
        }));
        return;
      }

      emit(listeners, 'message', {
        type: 'message',
        providerId: 'deepgram',
        raw: parsed
      });
    }

    async function connect(urlOverride, protocols) {
      if (typeof socketFactory !== 'function') {
        throw buildTransportError('WebSocket no está disponible para Deepgram Live.', {
          code: 'websocket_unavailable',
          status: 503,
          retryable: false
        });
      }

      const liveConfig = resolveLiveConfig(config);
      const connectionUrl = hasText(urlOverride) ? urlOverride.trim() : liveConfig.url;
      hasOpened = false;
      cleanupKeepalive();
      ensureClosePromise();

      await new Promise((resolve, reject) => {
        let settled = false;
        const rejectOnce = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };
        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(true);
        };

        try {
          socket = socketFactory(connectionUrl, Array.isArray(protocols) ? protocols : []);
        } catch (error) {
          rejectOnce(buildTransportError('No se pudo crear el WebSocket de Deepgram Live.', {
            code: 'handshake_failed',
            status: 503,
            retryable: true,
            cause: error
          }));
          return;
        }

        bindSocketEvent(socket, 'open', () => {
          hasOpened = true;
          startKeepalive();
          resolveOnce();
        });

        bindSocketEvent(socket, 'message', handleIncomingMessage);

        bindSocketEvent(socket, 'error', (event) => {
          const error = buildTransportError(hasOpened
            ? 'Deepgram Live reportó un error de transporte.'
            : 'Falló el handshake de Deepgram Live.', {
            code: hasOpened ? 'transport_error' : 'handshake_failed',
            status: 503,
            retryable: true,
            details: event || null
          });
          emit(listeners, 'error', error);
          if (!hasOpened) {
            rejectOnce(error);
          }
        });

        bindSocketEvent(socket, 'close', (event) => {
          cleanupKeepalive();
          emit(listeners, 'close', event || { code: 1000, reason: '', wasClean: true });
          resolveClose(event);
          if (!hasOpened) {
            rejectOnce(buildTransportError('Deepgram Live cerró durante el handshake.', {
              code: 'handshake_failed',
              status: 503,
              retryable: true,
              details: event || null
            }));
          }
        });
      });

      return true;
    }

    async function send(data) {
      sendRaw(data);
      return true;
    }

    async function close() {
      if (!socket) {
        cleanupKeepalive();
        resolveClose(null);
        return true;
      }

      if (getReadyState() === OPEN_STATE) {
        try {
          sendRaw({ type: 'CloseStream' });
        } catch (error) {
          emit(listeners, 'error', error);
        }
      }

      const pendingClose = ensureClosePromise();

      if (typeof socket.close === 'function' && getReadyState() < CLOSING_STATE) {
        socket.close();
      } else if (getReadyState() === CLOSED_STATE) {
        resolveClose({ code: 1000, reason: '', wasClean: true });
      }

      await pendingClose;
      socket = null;
      return true;
    }

    return {
      close,
      connect,
      onClose(callback) {
        return addListener(listeners, 'close', callback);
      },
      onError(callback) {
        return addListener(listeners, 'error', callback);
      },
      onMessage(callback) {
        return addListener(listeners, 'message', callback);
      },
      send
    };
  }

  return {
    KEEPALIVE_INTERVAL_MS,
    createDeepgramLiveTransport,
    extractDeepgramTranscript
  };
});
