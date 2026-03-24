(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaOffscreenBridge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIVE_BRIDGE_ACTIONS = {
    START_LIVE_SESSION: 'startLiveSession',
    LIVE_AUDIO_CHUNK: 'liveAudioChunk',
    FLUSH_LIVE_SESSION: 'flushLiveSession',
    STOP_LIVE_SESSION: 'stopLiveSession',
    PROMOTE_BATCH_FALLBACK: 'promoteBatchFallback',
    LIVE_CONNECT: 'liveConnect',
    LIVE_PARTIAL: 'livePartial',
    LIVE_FINAL: 'liveFinal',
    LIVE_ERROR: 'liveError',
    LIVE_FALLBACK: 'liveFallback',
    LIVE_RECONNECT: 'liveReconnect',
    LIVE_CLOSE: 'liveClose'
  };

  function encodeBase64(buffer) {
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

  function decodeBase64(base64) {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(base64, 'base64'));
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function serializeAudioBlob(blob, fallbackMimeType) {
    if (!blob || typeof blob.arrayBuffer !== 'function') {
      throw new Error('El audio del chunk no es válido');
    }

    return {
      mimeType: blob.type || fallbackMimeType,
      size: Number.isFinite(Number(blob.size)) ? Number(blob.size) : 0,
      base64: encodeBase64(await blob.arrayBuffer()),
      sampleRate: blob && Number.isFinite(Number(blob.sampleRate)) ? Number(blob.sampleRate) : undefined
    };
  }

  function deserializeAudioBlob(serializedAudio = {}, fallbackMimeType) {
    if (!serializedAudio || typeof serializedAudio.base64 !== 'string' || serializedAudio.base64.length === 0) {
      throw new Error('El audio serializado del chunk no es válido');
    }

    return new Blob([decodeBase64(serializedAudio.base64)], {
      type: serializedAudio.mimeType || fallbackMimeType
    });
  }

  async function serializeChunkBlob(blob) {
    return serializeAudioBlob(blob, 'audio/webm');
  }

  function deserializeChunkBlob(serializedAudio = {}) {
    return deserializeAudioBlob(serializedAudio, 'audio/webm');
  }

  async function serializeLiveAudioChunk(blob) {
    return serializeAudioBlob(blob, 'audio/webm;codecs=opus');
  }

  function deserializeLiveAudioChunk(serializedAudio = {}) {
    return deserializeAudioBlob(serializedAudio, 'audio/webm;codecs=opus');
  }

  function buildBackgroundMessage(action, payload = {}) {
    return {
      target: 'background',
      action,
      ...(payload && typeof payload === 'object' ? payload : {})
    };
  }

  function buildOffscreenMessage(action, payload = {}) {
    return {
      target: 'offscreen',
      action,
      ...(payload && typeof payload === 'object' ? payload : {})
    };
  }

  function buildProcessChunkMessage(audio, sessionContext = {}) {
    return buildBackgroundMessage('processChunk', {
      audio,
      audioMetadata: audio
        ? {
            mimeType: audio.mimeType || 'audio/webm',
            size: Number.isFinite(Number(audio.size)) ? Number(audio.size) : 0,
            sampleRate: Number.isFinite(Number(audio.sampleRate)) ? Number(audio.sampleRate) : undefined
          }
        : null,
      sessionId: sessionContext.sessionId || null,
      chunkIndex: Number.isFinite(Number(sessionContext.chunkIndex)) ? Number(sessionContext.chunkIndex) : 0
    });
  }

  function buildSyncTranscriptionProgressMessage(progress = {}) {
    return buildBackgroundMessage('syncTranscriptionProgress', {
      sessionId: progress.sessionId || null,
      totalChunks: Number.isFinite(Number(progress.totalChunks)) ? Number(progress.totalChunks) : 0,
      status: typeof progress.status === 'string' ? progress.status : 'idle',
      updatedAt: Number.isFinite(Number(progress.updatedAt)) ? Number(progress.updatedAt) : Date.now()
    });
  }

  function buildStartLiveSessionMessage(config = {}) {
    return buildOffscreenMessage(LIVE_BRIDGE_ACTIONS.START_LIVE_SESSION, {
      sessionId: config.sessionId || null,
      streamId: config.streamId || null,
      providerId: config.providerId || null,
      providerConfig: config.providerConfig || null,
      audioFormat: config.audioFormat || null,
      recorderTimesliceMs: Number.isFinite(Number(config.recorderTimesliceMs)) ? Number(config.recorderTimesliceMs) : undefined,
      sessionContext: config.sessionContext || null
    });
  }

  function buildLiveAudioChunkMessage(audio, sessionContext = {}) {
    return buildOffscreenMessage(LIVE_BRIDGE_ACTIONS.LIVE_AUDIO_CHUNK, {
      audio,
      audioMetadata: audio
        ? {
            mimeType: audio.mimeType || 'audio/webm;codecs=opus',
            size: Number.isFinite(Number(audio.size)) ? Number(audio.size) : 0,
            sampleRate: Number.isFinite(Number(audio.sampleRate)) ? Number(audio.sampleRate) : undefined
          }
        : null,
      sessionId: sessionContext.sessionId || null,
      chunkIndex: Number.isFinite(Number(sessionContext.chunkIndex)) ? Number(sessionContext.chunkIndex) : 0
    });
  }

  function buildFlushLiveSessionMessage(sessionContext = {}, payload = {}) {
    return buildOffscreenMessage(LIVE_BRIDGE_ACTIONS.FLUSH_LIVE_SESSION, {
      sessionId: sessionContext.sessionId || null,
      reason: payload.reason || null
    });
  }

  function buildStopLiveSessionMessage(sessionContext = {}, payload = {}) {
    return buildOffscreenMessage(LIVE_BRIDGE_ACTIONS.STOP_LIVE_SESSION, {
      sessionId: sessionContext.sessionId || null,
      reason: payload.reason || null
    });
  }

  function buildPromoteBatchFallbackMessage(sessionContext = {}, payload = {}) {
    return buildOffscreenMessage(LIVE_BRIDGE_ACTIONS.PROMOTE_BATCH_FALLBACK, {
      sessionId: sessionContext.sessionId || null,
      reason: payload.reason || null,
      reconnects: Number.isFinite(Number(payload.reconnects)) ? Number(payload.reconnects) : 0,
      sessionContext: payload.sessionContext || null
    });
  }

  function buildLiveTranscriptMessage(action, payload = {}) {
    return buildBackgroundMessage(action, {
      sessionId: payload.sessionId || null,
      providerId: payload.providerId || null,
      text: typeof payload.text === 'string' ? payload.text : '',
      at: Number.isFinite(Number(payload.at)) ? Number(payload.at) : Date.now(),
      meta: payload.meta || null,
      code: payload.code || null,
      message: payload.message || null,
      retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
      reason: payload.reason || null,
      reconnects: Number.isFinite(Number(payload.reconnects)) ? Number(payload.reconnects) : 0,
      error: payload.error || null
    });
  }

  function buildLivePartialMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_PARTIAL, payload);
  }

  function buildLiveConnectMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_CONNECT, payload);
  }

  function buildLiveFinalMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_FINAL, payload);
  }

  function buildLiveErrorMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_ERROR, payload);
  }

  function buildLiveFallbackMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_FALLBACK, payload);
  }

  function buildLiveReconnectMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_RECONNECT, payload);
  }

  function buildLiveCloseMessage(payload = {}) {
    return buildLiveTranscriptMessage(LIVE_BRIDGE_ACTIONS.LIVE_CLOSE, payload);
  }

  function dispatchToBackground(message, sendMessage) {
    if (typeof sendMessage !== 'function') {
      throw new Error('Falta el bridge de mensajes hacia background');
    }

    return sendMessage(message);
  }

  async function dispatchChunkToBackground(input = {}) {
    return dispatchToBackground(
      buildProcessChunkMessage(
        await serializeChunkBlob(input.blob),
        input.sessionContext
      ),
      input.sendMessage
    );
  }

  async function dispatchLiveAudioChunkToBackground(input = {}) {
    return dispatchToBackground(
      buildLiveAudioChunkMessage(
        await serializeLiveAudioChunk(input.blob),
        input.sessionContext
      ),
      input.sendMessage
    );
  }

  function dispatchTranscriptionProgressToBackground(input = {}) {
    return dispatchToBackground(
      buildSyncTranscriptionProgressMessage(input.progress),
      input.sendMessage
    );
  }

  return {
    LIVE_BRIDGE_ACTIONS,
    buildBackgroundMessage,
    buildFlushLiveSessionMessage,
    buildLiveConnectMessage,
    buildLiveErrorMessage,
    buildLiveFallbackMessage,
    buildLiveFinalMessage,
    buildLiveCloseMessage,
    buildLiveAudioChunkMessage,
    buildLivePartialMessage,
    buildLiveReconnectMessage,
    buildProcessChunkMessage,
    buildPromoteBatchFallbackMessage,
    buildStartLiveSessionMessage,
    buildStopLiveSessionMessage,
    buildSyncTranscriptionProgressMessage,
    buildOffscreenMessage,
    deserializeChunkBlob,
    deserializeLiveAudioChunk,
    dispatchToBackground,
    serializeChunkBlob,
    serializeLiveAudioChunk,
    dispatchChunkToBackground,
    dispatchLiveAudioChunkToBackground,
    dispatchTranscriptionProgressToBackground
  };
});
