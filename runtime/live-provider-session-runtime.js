(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaLiveProviderSessionRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_RECONNECTS = 2;
  const RECONNECT_BACKOFF_MS = [1000, 2000];

  async function transcodeToPCM() {
    // TODO: Phase future — PCM transcoding for AssemblyAI/OpenAI Realtime.
    throw new Error('PCM transcoding not yet implemented');
  }

  function normalizeLiveAudioFormat(audioFormat) {
    if (typeof audioFormat !== 'string') {
      return null;
    }

    const normalized = audioFormat.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  function providerRequiresPCM(providerId, providerRegistry) {
    if (!providerRegistry || typeof providerRegistry.getProviderDefinition !== 'function') {
      return false;
    }

    const definition = providerRegistry.getProviderDefinition(providerId);
    const liveAudioFormat = normalizeLiveAudioFormat(definition && definition.liveAudioFormat);
    return liveAudioFormat === 'pcm16' || !!(definition && definition.requiresPCM === true);
  }

  function resolveAudioPipeline(config = {}) {
    const audioFormat = normalizeLiveAudioFormat(config.audioFormat);
    const requiresPCM = !!config.requiresPCM || audioFormat === 'pcm16';

    return requiresPCM
      ? 'pcm-transcoder'
      : 'direct';
  }

  function cloneState(state) {
    return {
      ...state,
      reconnects: Number.isFinite(Number(state && state.reconnects)) ? Number(state.reconnects) : 0
    };
  }

  function createInitialState() {
      return {
        status: 'idle',
        reconnects: 0,
        providerId: null,
        audioFormat: null,
        audioPipeline: 'direct',
        fallbackReason: null,
        lastError: null,
        startedAt: null,
        updatedAt: Date.now()
    };
  }

  function createListenerRegistry() {
    return {
      partial: [],
      final: [],
      error: [],
      fallback: [],
      connect: [],
      reconnect: [],
      close: []
    };
  }

  function createLiveProviderSessionRuntime(options = {}) {
    let state = createInitialState();
    let currentConfig = null;
    const listeners = createListenerRegistry();
    const wait = typeof options.wait === 'function'
      ? options.wait
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function updateState(patch = {}) {
      state = {
        ...state,
        ...patch,
        updatedAt: Date.now()
      };
      return getState();
    }

    function getState() {
      return cloneState(state);
    }

    function emit(type, payload) {
      const registry = listeners[type] || [];
      registry.forEach((callback) => {
        callback(payload);
      });
    }

    function addListener(type, callback) {
      if (typeof callback !== 'function') {
        return () => {};
      }

      listeners[type].push(callback);
      return () => {
        const index = listeners[type].indexOf(callback);
        if (index >= 0) {
          listeners[type].splice(index, 1);
        }
      };
    }

    function prepareAudioChunkForTransport(chunk) {
      if (currentConfig && currentConfig.audioPipeline === 'pcm-transcoder') {
        // Future scaffold only: offscreen will hand us transcoded PCM16 chunks once
        // AssemblyAI/OpenAI Realtime are enabled. Current rollout stays on direct WebM/Opus.
        return chunk;
      }

      return chunk;
    }

    async function safeClose() {
      if (!currentConfig || !currentConfig.transport || typeof currentConfig.transport.close !== 'function') {
        return;
      }

      await currentConfig.transport.close();
      emit('close', {
        providerId: state.providerId,
        reconnects: state.reconnects,
        fallbackReason: state.fallbackReason,
        status: state.status
      });
    }

    async function connectTransport() {
      if (!currentConfig || !currentConfig.transport || typeof currentConfig.transport.connect !== 'function') {
        throw new Error('Live session transport inválido');
      }

      updateState({ status: 'connecting' });
      await currentConfig.transport.connect(currentConfig.url, currentConfig.protocols);
      updateState({ status: 'streaming' });
      emit('connect', {
        providerId: state.providerId,
        reconnects: state.reconnects,
        audioFormat: state.audioFormat
      });
    }

    async function connectWithRetry(error) {
      emit('error', {
        reason: 'startup_connect_failed',
        reconnects: state.reconnects,
        providerId: state.providerId,
        error
      });

      while (state.reconnects < MAX_RECONNECTS) {
        const nextReconnect = state.reconnects + 1;
        const backoff = RECONNECT_BACKOFF_MS[nextReconnect - 1] || RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];

        updateState({ status: 'connecting', reconnects: nextReconnect, lastError: { message: error.message } });
        await wait(backoff);

        try {
          await connectTransport();
          return getState();
        } catch (reconnectError) {
          emit('error', {
            reason: 'startup_reconnect_failed',
            reconnects: state.reconnects,
            providerId: state.providerId,
            error: reconnectError
          });
          error = reconnectError;
        }
      }

      return triggerFallback('startup_failed', error);
    }

    async function triggerFallback(reason, error) {
      updateState({
        status: 'error',
        fallbackReason: reason,
        lastError: error ? { message: error.message } : null
      });
      emit('fallback', {
        reason,
        reconnects: state.reconnects,
        providerId: state.providerId,
        error: error || null
      });
      await safeClose();
      const fallbackError = new Error(`Live session reconnect exhausted: ${reason}`);
      fallbackError.code = reason;
      throw fallbackError;
    }

    async function attemptReconnect(replayData, error) {
      emit('error', {
        reason: 'transport_error',
        reconnects: state.reconnects,
        providerId: state.providerId,
        error
      });

      while (state.reconnects < MAX_RECONNECTS) {
        const nextReconnect = state.reconnects + 1;
        const backoff = RECONNECT_BACKOFF_MS[nextReconnect - 1] || RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];

        updateState({ status: 'connecting', reconnects: nextReconnect, lastError: { message: error.message } });
        await wait(backoff);

        try {
          await connectTransport();
          emit('reconnect', {
            providerId: state.providerId,
            reconnects: state.reconnects,
            audioFormat: state.audioFormat
          });
          if (replayData !== undefined) {
            await currentConfig.transport.send(replayData);
          }
          return getState();
        } catch (reconnectError) {
          emit('error', {
            reason: 'reconnect_failed',
            reconnects: state.reconnects,
            providerId: state.providerId,
            error: reconnectError
          });
          error = reconnectError;
        }
      }

      return triggerFallback('reconnect_exhausted', error);
    }

    async function start(config = {}) {
      if (!config.transport || typeof config.transport.send !== 'function') {
        throw new Error('Live session transport inválido');
      }

      currentConfig = {
        providerId: config.providerId || null,
        audioFormat: config.audioFormat || null,
        requiresPCM: !!config.requiresPCM,
        audioPipeline: resolveAudioPipeline(config),
        url: config.url || '',
        protocols: Array.isArray(config.protocols) ? config.protocols.slice() : [],
        transport: config.transport,
        flushPayload: Object.prototype.hasOwnProperty.call(config, 'flushPayload') ? config.flushPayload : null
      };

      updateState({
        status: 'connecting',
        reconnects: 0,
        providerId: currentConfig.providerId,
        audioFormat: currentConfig.audioFormat,
        audioPipeline: currentConfig.audioPipeline,
        fallbackReason: null,
        lastError: null,
        startedAt: Date.now()
      });
      try {
        await connectTransport();
      } catch (error) {
        await connectWithRetry(error);
      }
      return getState();
    }

    async function pushAudio(chunk) {
      if (!currentConfig || !currentConfig.transport || typeof currentConfig.transport.send !== 'function') {
        throw new Error('La sesión live no está iniciada');
      }

      if (state.status !== 'streaming') {
        throw new Error('La sesión live no está lista para enviar audio');
      }

      const transportChunk = prepareAudioChunkForTransport(chunk);

      try {
        await currentConfig.transport.send(transportChunk);
        return getState();
      } catch (error) {
        return attemptReconnect(transportChunk, error);
      }
    }

    async function flush() {
      if (!currentConfig || state.status === 'idle' || state.status === 'stopped' || state.status === 'error') {
        return getState();
      }

      updateState({ status: 'flushing' });

      try {
        if (currentConfig.flushPayload !== null) {
          await currentConfig.transport.send(currentConfig.flushPayload);
        }
        updateState({ status: 'streaming' });
        return getState();
      } catch (error) {
        return attemptReconnect(currentConfig.flushPayload, error);
      }
    }

    async function stop() {
      if (state.status === 'idle' || state.status === 'stopped') {
        return getState();
      }

      if (state.status !== 'error') {
        updateState({ status: 'flushing' });
        if (currentConfig && currentConfig.flushPayload !== null) {
          try {
            await currentConfig.transport.send(currentConfig.flushPayload);
          } catch (error) {
            await attemptReconnect(currentConfig.flushPayload, error);
          }
        }
      }

      await safeClose();
      updateState({ status: 'stopped' });
      return getState();
    }

    return {
      flush,
      getState,
      onError(callback) {
        return addListener('error', callback);
      },
      onConnect(callback) {
        return addListener('connect', callback);
      },
      onReconnect(callback) {
        return addListener('reconnect', callback);
      },
      onClose(callback) {
        return addListener('close', callback);
      },
      onFallback(callback) {
        return addListener('fallback', callback);
      },
      onFinal(callback) {
        return addListener('final', callback);
      },
      onPartial(callback) {
        return addListener('partial', callback);
      },
      pushAudio,
      start,
      stop
    };
  }

  return {
    MAX_RECONNECTS,
    RECONNECT_BACKOFF_MS,
    createInitialState,
    createLiveProviderSessionRuntime,
    providerRequiresPCM,
    resolveAudioPipeline,
    transcodeToPCM
  };
});
