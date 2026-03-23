// offscreen.js — Persistent recording engine
// This document stays alive even when the popup closes.

let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let analyser = null;
let mediaStreamSource = null;
let audioChunks = [];
const chunkProcessor = globalThis.PochoclaChunkProcessor;
const offscreenBridge = globalThis.PochoclaOffscreenBridge;
const DEFAULT_TRANSCRIPTION_CHUNK_MS = 7000;
const DEFAULT_WAV_SAMPLE_RATE = 48000;
const PCM_AUDIO_THRESHOLD = 0.01;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

let captureSessionContext = {
  sessionId: null,
  language: 'es',
  activeProvider: null,
  nextChunkIndex: 0,
  chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
};

function resetCaptureSessionContext() {
  captureSessionContext = {
    sessionId: null,
    language: 'es',
    activeProvider: null,
    nextChunkIndex: 0,
    chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'start':
      startRecording(msg.streamId, msg.sessionContext).then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'stop':
      stopRecording().then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;

    case 'pause':
      pauseRecording();
      sendResponse({ ok: true });
      break;

    case 'resume':
      resumeRecording();
      sendResponse({ ok: true });
      break;

    case 'getWaveform':
      sendResponse({ data: getWaveformData() });
      break;
  }
});

async function startRecording(streamId, sessionContext) {
  captureSessionContext = {
    sessionId: sessionContext && sessionContext.sessionId ? sessionContext.sessionId : null,
    language: sessionContext && sessionContext.language ? sessionContext.language : 'es',
    activeProvider: sessionContext && sessionContext.activeProvider ? sessionContext.activeProvider : null,
    nextChunkIndex: 0,
    chunkIntervalMs: Number.isFinite(Number(sessionContext && sessionContext.chunkIntervalMs))
      ? Number(sessionContext.chunkIntervalMs)
      : DEFAULT_TRANSCRIPTION_CHUNK_MS
  };

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  audioContext = new AudioContext();
  mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.8;
  mediaStreamSource.connect(analyser);
  mediaStreamSource.connect(audioContext.destination);

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: 'audio/webm;codecs=opus'
  });
  audioChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.start(1000);

  // Start transcription capture (hands chunks to background orchestration)
  startTranscriptionCapture();
}

async function stopRecording() {
  // 1. Stop capturing new chunks and wait for the final chunk + queue to drain
  await stopTranscriptionCapture();

  // 2. Now safe to tear down media resources
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
    analyser = null;
    mediaStreamSource = null;
  }
}

function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
  }
  stopTranscriptionCapture();
}

function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
  }
  startTranscriptionCapture();
}

function getWaveformData() {
  if (!analyser) return null;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(dataArray);
  return Array.from(dataArray);
}

// ── Transcription capture (sends audio chunks to Whisper API) ──
let transcriptionChunkTimerId = null;
let transcriptionProcessorNode = null;
let transcriptionPcmChunks = [];
let transcriptionPcmSampleCount = 0;
let transcriptionSampleRate = DEFAULT_WAV_SAMPLE_RATE;
let isTranscribing = false;
let chunkHadAudio = false;       // tracks audio activity DURING each chunk

// ── Serialized transcription queue ──
// Ensures chunks are handed to background in order, one at a time.
let queueDrainResolve = null;
let queueDrainTimeoutId = null;
const transcriptionProcessor = chunkProcessor.createSerialProcessor(
  async (item) => {
    const response = await offscreenBridge.dispatchChunkToBackground({
      blob: item.blob,
      sessionContext: {
        sessionId: item.sessionId,
        chunkIndex: item.chunkIndex
      },
      sendMessage: chrome.runtime.sendMessage
    });

    if (!response || !response.ok) {
      console.warn('Chunk processing failed in background:', response && response.error ? response.error : 'unknown error');
    }
  },
  {
    onIdle: resolveTranscriptionDrainIfReady,
    onError(error) {
      console.warn('Chunk queue error:', error);
      resolveTranscriptionDrainIfReady();
    }
  }
);

function enqueueTranscription(blob) {
  transcriptionProcessor.enqueue({
    blob,
    sessionId: captureSessionContext.sessionId,
    chunkIndex: captureSessionContext.nextChunkIndex
  });
  captureSessionContext.nextChunkIndex += 1;
}

function resolveTranscriptionDrainIfReady() {
  if (
    queueDrainResolve
    && !isTranscribing
    && !transcriptionProcessor.isProcessing()
    && transcriptionProcessor.size() === 0
  ) {
    clearTimeout(queueDrainTimeoutId);
    queueDrainTimeoutId = null;
    resetCaptureSessionContext();
    queueDrainResolve();
    queueDrainResolve = null;
  }
}

function mergePcmChunks(chunks, sampleCount) {
  const merged = new Float32Array(sampleCount);
  let offset = 0;

  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });

  return merged;
}

function encodePcm16Wav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + (samples.length * bytesPerSample));
  const view = new DataView(buffer);

  function writeAscii(offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + (samples.length * bytesPerSample), true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += bytesPerSample;
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  blob.sampleRate = sampleRate;
  return blob;
}

function captureInputBufferChunk(inputBuffer) {
  if (!inputBuffer || typeof inputBuffer.numberOfChannels !== 'number' || typeof inputBuffer.getChannelData !== 'function') {
    return;
  }

  const channelCount = Math.max(1, inputBuffer.numberOfChannels);
  const frameLength = inputBuffer.getChannelData(0).length;
  const monoSamples = new Float32Array(frameLength);
  let maxAmplitude = 0;

  for (let sampleIndex = 0; sampleIndex < frameLength; sampleIndex += 1) {
    let sum = 0;
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      sum += inputBuffer.getChannelData(channelIndex)[sampleIndex] || 0;
    }

    const monoSample = sum / channelCount;
    monoSamples[sampleIndex] = monoSample;
    const amplitude = Math.abs(monoSample);
    if (amplitude > maxAmplitude) {
      maxAmplitude = amplitude;
    }
  }

  if (maxAmplitude > PCM_AUDIO_THRESHOLD) {
    chunkHadAudio = true;
  }

  transcriptionPcmChunks.push(monoSamples);
  transcriptionPcmSampleCount += monoSamples.length;
}

function flushTranscriptionChunk(options = {}) {
  const force = !!options.force;
  const hadAudio = chunkHadAudio;
  const hasSamples = transcriptionPcmSampleCount > 0;

  chunkHadAudio = false;

  if (!hasSamples) {
    return false;
  }

  const samples = mergePcmChunks(transcriptionPcmChunks, transcriptionPcmSampleCount);
  transcriptionPcmChunks = [];
  transcriptionPcmSampleCount = 0;

  if (!force && !hadAudio) {
    return false;
  }

  if (!hadAudio) {
    return false;
  }

  const blob = encodePcm16Wav(samples, transcriptionSampleRate || DEFAULT_WAV_SAMPLE_RATE);
  if (blob.size > 44) {
    enqueueTranscription(blob);
    return true;
  }

  return false;
}

function startTranscriptionCapture() {
  if (!mediaStream || !mediaStreamSource || !audioContext || isTranscribing) return;

  isTranscribing = true;
  chunkHadAudio = false;
  transcriptionPcmChunks = [];
  transcriptionPcmSampleCount = 0;
  transcriptionSampleRate = Number.isFinite(Number(audioContext.sampleRate))
    ? Number(audioContext.sampleRate)
    : DEFAULT_WAV_SAMPLE_RATE;

  if (typeof audioContext.createScriptProcessor !== 'function') {
    throw new Error('El navegador no soporta captura PCM continua para transcripción');
  }

  const processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 2, 1);
  processorNode.onaudioprocess = (event) => {
    if (!isTranscribing) {
      return;
    }

    captureInputBufferChunk(event && event.inputBuffer);
  };

  mediaStreamSource.connect(processorNode);
  processorNode.connect(audioContext.destination);
  transcriptionProcessorNode = processorNode;

  transcriptionChunkTimerId = setInterval(() => {
    flushTranscriptionChunk();
    resolveTranscriptionDrainIfReady();
  }, captureSessionContext.chunkIntervalMs || DEFAULT_TRANSCRIPTION_CHUNK_MS);
}

function stopTranscriptionCapture() {
  isTranscribing = false;

  clearInterval(transcriptionChunkTimerId);
  transcriptionChunkTimerId = null;

  if (transcriptionProcessorNode) {
    if (mediaStreamSource && typeof mediaStreamSource.disconnect === 'function') {
      mediaStreamSource.disconnect(transcriptionProcessorNode);
    }
    if (typeof transcriptionProcessorNode.disconnect === 'function') {
      transcriptionProcessorNode.disconnect();
    }
    transcriptionProcessorNode.onaudioprocess = null;
    transcriptionProcessorNode = null;
  }

  flushTranscriptionChunk({ force: true });
  resolveTranscriptionDrainIfReady();

  // Return a promise that resolves when the queue finishes processing
  if (transcriptionProcessor.size() > 0 || transcriptionProcessor.isProcessing()) {
    return new Promise((resolve) => {
      queueDrainResolve = resolve;
      // Safety timeout: don't block stop forever (max 30s for pending API calls)
      queueDrainTimeoutId = setTimeout(() => {
        if (queueDrainResolve) {
          resetCaptureSessionContext();
          queueDrainResolve();
          queueDrainResolve = null;
          queueDrainTimeoutId = null;
        }
      }, 30000);
    });
  }
  clearTimeout(queueDrainTimeoutId);
  queueDrainTimeoutId = null;
  resetCaptureSessionContext();
  return Promise.resolve();
}
