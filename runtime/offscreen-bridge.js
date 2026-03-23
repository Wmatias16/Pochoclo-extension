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

  function buildProcessChunkMessage(audio, sessionContext = {}) {
    return {
      target: 'background',
      action: 'processChunk',
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
    };
  }

  async function dispatchChunkToBackground(input = {}) {
    if (typeof input.sendMessage !== 'function') {
      throw new Error('Falta el bridge de mensajes hacia background');
    }

    return input.sendMessage(buildProcessChunkMessage(
      await serializeChunkBlob(input.blob),
      input.sessionContext
    ));
  }

  return {
    buildProcessChunkMessage,
    deserializeChunkBlob,
    serializeChunkBlob,
    dispatchChunkToBackground
  };
});
