(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaOffscreenBridge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  async function serializeChunkBlob(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') {
      throw new Error('El audio del chunk no es válido');
    }

    return {
      mimeType: blob.type || 'audio/webm',
      size: Number.isFinite(Number(blob.size)) ? Number(blob.size) : 0,
      base64: encodeBase64(await blob.arrayBuffer()),
      sampleRate: blob && Number.isFinite(Number(blob.sampleRate)) ? Number(blob.sampleRate) : undefined
    };
  }

  function deserializeChunkBlob(serializedAudio = {}) {
    if (!serializedAudio || typeof serializedAudio.base64 !== 'string' || serializedAudio.base64.length === 0) {
      throw new Error('El audio serializado del chunk no es válido');
    }

    return new Blob([decodeBase64(serializedAudio.base64)], {
      type: serializedAudio.mimeType || 'audio/webm'
    });
  }

  function buildBackgroundMessage(action, payload = {}) {
    return {
      target: 'background',
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

  function dispatchTranscriptionProgressToBackground(input = {}) {
    return dispatchToBackground(
      buildSyncTranscriptionProgressMessage(input.progress),
      input.sendMessage
    );
  }

  return {
    buildBackgroundMessage,
    buildProcessChunkMessage,
    buildSyncTranscriptionProgressMessage,
    deserializeChunkBlob,
    dispatchToBackground,
    serializeChunkBlob,
    dispatchChunkToBackground,
    dispatchTranscriptionProgressToBackground
  };
});
