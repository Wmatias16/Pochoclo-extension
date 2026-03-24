// offscreen.js — Persistent recording engine
// This document stays alive even when the popup closes.

let mediaStream = null;
let mediaRecorder = null;
let liveMediaRecorder = null;
let audioContext = null;
let analyser = null;
let mediaStreamSource = null;
let audioChunks = [];
const chunkProcessor = globalThis.PochoclaChunkProcessor;
const offscreenBridge = globalThis.PochoclaOffscreenBridge;
const liveProviderSessionRuntime = globalThis.PochoclaLiveProviderSessionRuntime;
const deepgramLiveTransportRuntime = globalThis.PochoclaDeepgramLiveTransport;
const providerRegistry = globalThis.PochoclaProviderRegistry || null;
const DEFAULT_TRANSCRIPTION_CHUNK_MS = 7000;
const DEFAULT_WAV_SAMPLE_RATE = 48000;
const DEFAULT_LIVE_RECORDER_TIMESLICE_MS = 250;
const LIVE_MEDIA_RECORDER_MIME_TYPE = 'audio/webm;codecs=opus';
// Significant-amplitude threshold for the V1 inactivity proxy shared with background defaults.
const PCM_AUDIO_THRESHOLD = 0.05;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
// Emit at most one heartbeat every ~2.5s while meaningful audio is present.
const AUDIO_ACTIVITY_HEARTBEAT_THROTTLE_MS = 2500;

let captureSessionContext = {
  sessionId: null,
  language: 'es',
  activeProvider: null,
  nextChunkIndex: 0,
  chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
};

let liveCaptureContext = {
  sessionId: null,
  providerId: null,
  audioFormat: null,
  runtime: null,
  transport: null,
  recorderTimesliceMs: DEFAULT_LIVE_RECORDER_TIMESLICE_MS,
  sendChain: Promise.resolve(),
  monitorNode: null,
  stopping: false
};

let currentCaptureMode = 'idle';

function resetCaptureSessionContext() {
  captureSessionContext = {
    sessionId: null,
    language: 'es',
    activeProvider: null,
    nextChunkIndex: 0,
    chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
  };
}

function resetLiveCaptureContext() {
  liveCaptureContext = {
    sessionId: null,
    providerId: null,
    audioFormat: null,
    runtime: null,
    transport: null,
    recorderTimesliceMs: DEFAULT_LIVE_RECORDER_TIMESLICE_MS,
    sendChain: Promise.resolve(),
    monitorNode: null,
    stopping: false
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
      stopCurrentCapture().then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;

    case 'startLiveSession':
      startLive(msg).then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'stopLiveSession':
      stopLive().then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;

    case 'promoteBatchFallback':
      promoteBatchFallback(msg).then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'flushLiveSession':
      flushLive(msg).then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
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
  currentCaptureMode = 'batch';
  captureSessionContext = {
    sessionId: sessionContext && sessionContext.sessionId ? sessionContext.sessionId : null,
    language: sessionContext && sessionContext.language ? sessionContext.language : 'es',
    activeProvider: sessionContext && sessionContext.activeProvider ? sessionContext.activeProvider : null,
    nextChunkIndex: 0,
    chunkIntervalMs: Number.isFinite(Number(sessionContext && sessionContext.chunkIntervalMs))
      ? Number(sessionContext.chunkIntervalMs)
      : DEFAULT_TRANSCRIPTION_CHUNK_MS
  };

  await initializeSharedCapture(streamId);

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: LIVE_MEDIA_RECORDER_MIME_TYPE
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
  currentCaptureMode = 'idle';
  // 1. Stop capturing new chunks and wait for the final chunk + queue to drain
  await stopTranscriptionCapture();

  // 2. Now safe to tear down media resources
  await stopMediaRecorderInstance(mediaRecorder);
  mediaRecorder = null;
  await teardownSharedCapture();
}

function pauseRecording() {
  if (currentCaptureMode === 'live') {
    pauseLiveCapture();
    return;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
  }
  stopTranscriptionCapture();
}

function resumeRecording() {
  if (currentCaptureMode === 'live') {
    resumeLiveCapture();
    return;
  }

  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
  }
  startTranscriptionCapture();
}

async function startLive(config = {}) {
  const sessionContext = config.sessionContext || {};
  const providerId = config.providerId || (sessionContext && sessionContext.activeProvider) || null;
  const providerConfig = config.providerConfig || {};
  const liveAudioFormat = config.audioFormat || LIVE_MEDIA_RECORDER_MIME_TYPE;
  const requiresPCM = !!(
    liveProviderSessionRuntime
    && typeof liveProviderSessionRuntime.providerRequiresPCM === 'function'
    && liveProviderSessionRuntime.providerRequiresPCM(providerId, providerRegistry)
  );

  if (providerId !== 'deepgram') {
    throw new Error(`Provider live no soportado: ${providerId || 'unknown'}`);
  }

  currentCaptureMode = 'live';
  captureSessionContext = {
    sessionId: sessionContext.sessionId || null,
    language: sessionContext.language || config.language || 'es',
    activeProvider: providerId,
    nextChunkIndex: 0,
    chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
  };

  await initializeSharedCapture(config.streamId);

  if (!liveProviderSessionRuntime || typeof liveProviderSessionRuntime.createLiveProviderSessionRuntime !== 'function') {
    throw new Error('No se pudo inicializar el runtime de sesión live');
  }

  if (!deepgramLiveTransportRuntime || typeof deepgramLiveTransportRuntime.createDeepgramLiveTransport !== 'function') {
    throw new Error('No se pudo inicializar el transporte live de Deepgram');
  }

  const transport = deepgramLiveTransportRuntime.createDeepgramLiveTransport({
    settings: providerConfig,
    language: sessionContext.language || config.language || 'es'
  });
  const runtime = liveProviderSessionRuntime.createLiveProviderSessionRuntime();

  liveCaptureContext = {
    sessionId: sessionContext.sessionId || null,
    providerId,
    audioFormat: liveAudioFormat,
    runtime,
    transport,
    recorderTimesliceMs: Number.isFinite(Number(config.recorderTimesliceMs))
      ? Number(config.recorderTimesliceMs)
      : DEFAULT_LIVE_RECORDER_TIMESLICE_MS,
    sendChain: Promise.resolve(),
    monitorNode: null,
    stopping: false
  };

  attachLiveTransportListeners();
  attachLiveRuntimeListeners();

  try {
    await runtime.start({
      providerId,
      audioFormat: liveCaptureContext.audioFormat,
      requiresPCM,
      transport,
      flushPayload: { type: 'Finalize' }
    });
  } catch (error) {
    if (error && (error.code === 'startup_failed' || error.code === 'reconnect_exhausted')) {
      return true;
    }
    throw error;
  }

  startLiveActivityMonitor();

  // Future scaffold only: AssemblyAI/OpenAI Realtime will route through a PCM16
  // transcoder once a provider advertises `liveAudioFormat === 'pcm16'`.
  // Current rollout keeps Deepgram on direct MediaRecorder WebM/Opus.
  if (requiresPCM) {
    throw new Error(`Provider live no soportado todavía para PCM16: ${providerId || 'unknown'}`);
  }

  liveMediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: LIVE_MEDIA_RECORDER_MIME_TYPE
  });

  liveMediaRecorder.ondataavailable = (event) => {
    const blob = event && event.data;
    if (!blob || !Number.isFinite(Number(blob.size)) || Number(blob.size) <= 0) {
      return;
    }

    queueLiveAudio(blob, { requiresPCM });
  };

  liveMediaRecorder.start(liveCaptureContext.recorderTimesliceMs);
}

async function transcodeToPCM(webmBlob) {
  if (
    liveProviderSessionRuntime
    && typeof liveProviderSessionRuntime.transcodeToPCM === 'function'
  ) {
    return liveProviderSessionRuntime.transcodeToPCM(webmBlob);
  }

  // TODO: Phase future — PCM transcoding for AssemblyAI/OpenAI Realtime.
  throw new Error('PCM transcoding not yet implemented');
}

async function flushLive() {
  if (!liveCaptureContext.runtime) {
    return false;
  }

  await liveCaptureContext.sendChain;
  await liveCaptureContext.runtime.flush();
  return true;
}

async function stopLive() {
  currentCaptureMode = 'idle';
  return stopLivePipeline({ teardownSharedCapture: true, resetBatchContext: true });
}

async function stopLivePipeline(options = {}) {
  const shouldTearDownSharedCapture = options.teardownSharedCapture !== false;
  const resetBatchContext = options.resetBatchContext !== false;

  if (!liveCaptureContext.runtime && !liveMediaRecorder && !mediaStream) {
    if (resetBatchContext) {
      resetCaptureSessionContext();
    }
    resetLiveCaptureContext();
    return;
  }

  liveCaptureContext.stopping = true;

  await stopMediaRecorderInstance(liveMediaRecorder);
  liveMediaRecorder = null;
  await flushLive();

  if (liveCaptureContext.runtime) {
    await liveCaptureContext.runtime.stop();
  }

  stopLiveActivityMonitor();
  if (shouldTearDownSharedCapture) {
    await teardownSharedCapture();
  }
  if (resetBatchContext) {
    resetCaptureSessionContext();
  }
  resetLiveCaptureContext();
}

async function promoteBatchFallback(message = {}) {
  const nextSessionContext = message.sessionContext || {};

  await stopLivePipeline({ teardownSharedCapture: false, resetBatchContext: false });

  captureSessionContext = {
    sessionId: nextSessionContext.sessionId || captureSessionContext.sessionId || null,
    language: nextSessionContext.language || captureSessionContext.language || 'es',
    activeProvider: nextSessionContext.activeProvider || captureSessionContext.activeProvider || null,
    nextChunkIndex: 0,
    chunkIntervalMs: Number.isFinite(Number(nextSessionContext.chunkIntervalMs))
      ? Number(nextSessionContext.chunkIntervalMs)
      : DEFAULT_TRANSCRIPTION_CHUNK_MS
  };

  currentCaptureMode = 'batch';
  startTranscriptionCapture();
  return true;
}

async function stopCurrentCapture() {
  if (currentCaptureMode === 'live') {
    return stopLive();
  }

  return stopRecording();
}

function pauseLiveCapture() {
  if (liveMediaRecorder && liveMediaRecorder.state === 'recording') {
    liveMediaRecorder.pause();
  }
  stopLiveActivityMonitor();
}

function resumeLiveCapture() {
  if (liveMediaRecorder && liveMediaRecorder.state === 'paused') {
    liveMediaRecorder.resume();
  }
  startLiveActivityMonitor();
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
let lastAudioHeartbeatAt = 0;

function resetAudioActivityHeartbeat() {
  // Called on start/pause/stop so a resumed session can emit a fresh heartbeat immediately.
  lastAudioHeartbeatAt = 0;
}

async function createTabCaptureStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });
}

async function initializeSharedCapture(streamId) {
  mediaStream = await createTabCaptureStream(streamId);
  audioContext = new AudioContext();
  mediaStreamSource = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.8;
  mediaStreamSource.connect(analyser);
  mediaStreamSource.connect(audioContext.destination);
}

async function stopMediaRecorderInstance(recorder) {
  if (!recorder || recorder.state === 'inactive') {
    return;
  }

  await new Promise((resolve) => {
    const previousOnStop = recorder.onstop;
    recorder.onstop = (...args) => {
      recorder.onstop = previousOnStop;
      if (typeof previousOnStop === 'function') {
        previousOnStop(...args);
      }
      resolve();
    };
    recorder.stop();
  });
}

async function teardownSharedCapture() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
    analyser = null;
    mediaStreamSource = null;
  }
}

function emitAudioActivityHeartbeat(now = Date.now()) {
  if (!isTranscribing || !captureSessionContext.sessionId) {
    return false;
  }

  const heartbeatAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (lastAudioHeartbeatAt > 0 && (heartbeatAt - lastAudioHeartbeatAt) < AUDIO_ACTIVITY_HEARTBEAT_THROTTLE_MS) {
    return false;
  }

  lastAudioHeartbeatAt = heartbeatAt;

  try {
    // Heartbeats are best-effort only: background uses them to push the inactivity deadline forward,
    // but capture must continue even if the worker is restarting or messaging briefly fails.
    const maybePromise = chrome.runtime.sendMessage({
      target: 'background',
      action: 'audioActivity',
      sessionId: captureSessionContext.sessionId,
      at: heartbeatAt
    });

    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.catch(() => {});
    }
  } catch (error) {
    // Ignore transient messaging failures while capture continues.
  }

  return true;
}

// ── Serialized transcription queue ──
// Ensures chunks are handed to background in order, one at a time.
let queueDrainResolve = null;
let queueDrainTimeoutId = null;
let acceptedChunkCount = 0;
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

function buildTranscriptionProgressSnapshot(status = 'active') {
  return {
    sessionId: captureSessionContext.sessionId,
    totalChunks: acceptedChunkCount,
    status,
    updatedAt: Date.now()
  };
}

function syncTranscriptionProgress(status = 'active') {
  if (!captureSessionContext.sessionId || !offscreenBridge || typeof offscreenBridge.dispatchTranscriptionProgressToBackground !== 'function') {
    return Promise.resolve({ ok: false, ignored: true });
  }

  try {
    const maybePromise = offscreenBridge.dispatchTranscriptionProgressToBackground({
      progress: buildTranscriptionProgressSnapshot(status),
      sendMessage: chrome.runtime.sendMessage
    });

    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.catch(() => ({ ok: false, ignored: true }));
    }

    return Promise.resolve(maybePromise);
  } catch (error) {
    return Promise.resolve({ ok: false, ignored: true });
  }
}

function enqueueTranscription(blob) {
  transcriptionProcessor.enqueue({
    blob,
    sessionId: captureSessionContext.sessionId,
    chunkIndex: captureSessionContext.nextChunkIndex
  });
  captureSessionContext.nextChunkIndex += 1;
  acceptedChunkCount += 1;
  void syncTranscriptionProgress('active');
}

function resolveTranscriptionDrainIfReady() {
  if (
    captureSessionContext.sessionId
    && acceptedChunkCount > 0
    && !isTranscribing
    && (transcriptionProcessor.isProcessing() || transcriptionProcessor.size() > 0)
  ) {
    void syncTranscriptionProgress('draining');
  }

  if (
    queueDrainResolve
    && !isTranscribing
    && !transcriptionProcessor.isProcessing()
    && transcriptionProcessor.size() === 0
  ) {
    clearTimeout(queueDrainTimeoutId);
    queueDrainTimeoutId = null;
    resetCaptureSessionContext();
    acceptedChunkCount = 0;
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
  const analysis = analyzeInputBuffer(inputBuffer);
  if (!analysis) {
    return;
  }

  if (analysis.rms > PCM_AUDIO_THRESHOLD) {
    chunkHadAudio = true;
    emitAudioActivityHeartbeat();
  }

  transcriptionPcmChunks.push(analysis.monoSamples);
  transcriptionPcmSampleCount += analysis.monoSamples.length;
}

function analyzeInputBuffer(inputBuffer) {
  if (!inputBuffer || typeof inputBuffer.numberOfChannels !== 'number' || typeof inputBuffer.getChannelData !== 'function') {
    return null;
  }

  const channelCount = Math.max(1, inputBuffer.numberOfChannels);
  const frameLength = inputBuffer.getChannelData(0).length;
  const monoSamples = new Float32Array(frameLength);
  let sumSquares = 0;

  for (let sampleIndex = 0; sampleIndex < frameLength; sampleIndex += 1) {
    let sum = 0;
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      sum += inputBuffer.getChannelData(channelIndex)[sampleIndex] || 0;
    }

    const monoSample = sum / channelCount;
    monoSamples[sampleIndex] = monoSample;
    sumSquares += monoSample * monoSample;
  }

  return {
    monoSamples,
    rms: frameLength > 0 ? Math.sqrt(sumSquares / frameLength) : 0
  };
}

function monitorLiveInputBuffer(inputBuffer) {
  const analysis = analyzeInputBuffer(inputBuffer);
  if (!analysis) {
    return;
  }

  if (analysis.rms > PCM_AUDIO_THRESHOLD) {
    emitAudioActivityHeartbeat();
  }
}

function startLiveActivityMonitor() {
  if (!mediaStreamSource || !audioContext || liveCaptureContext.monitorNode) {
    return;
  }

  resetAudioActivityHeartbeat();

  if (typeof audioContext.createScriptProcessor !== 'function') {
    return;
  }

  const processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 2, 1);
  processorNode.onaudioprocess = (event) => {
    if (currentCaptureMode !== 'live') {
      return;
    }

    monitorLiveInputBuffer(event && event.inputBuffer);
  };

  mediaStreamSource.connect(processorNode);
  processorNode.connect(audioContext.destination);
  liveCaptureContext.monitorNode = processorNode;
}

function stopLiveActivityMonitor() {
  resetAudioActivityHeartbeat();

  if (!liveCaptureContext.monitorNode) {
    return;
  }

  if (mediaStreamSource && typeof mediaStreamSource.disconnect === 'function') {
    mediaStreamSource.disconnect(liveCaptureContext.monitorNode);
  }
  if (typeof liveCaptureContext.monitorNode.disconnect === 'function') {
    liveCaptureContext.monitorNode.disconnect();
  }
  liveCaptureContext.monitorNode.onaudioprocess = null;
  liveCaptureContext.monitorNode = null;
}

function attachLiveTransportListeners() {
  if (!liveCaptureContext.transport) {
    return;
  }

  liveCaptureContext.transport.onMessage((event) => {
    if (!event || !event.type) {
      return;
    }

    if (event.type === 'partial') {
      dispatchLiveEventToBackground('partial', {
        text: event.text,
        providerId: event.providerId,
        meta: event.raw || null
      });
      return;
    }

    if (event.type === 'final') {
      dispatchLiveEventToBackground('final', {
        text: event.text,
        providerId: event.providerId,
        meta: event.raw || null
      });
    }
  });

  liveCaptureContext.transport.onError((error) => {
    dispatchLiveEventToBackground('error', {
      providerId: liveCaptureContext.providerId,
      code: error && error.code ? error.code : 'live_transport_error',
      message: error && error.message ? error.message : 'Falló el transporte live.',
      retryable: !!(error && error.retryable)
    });
  });
}

function attachLiveRuntimeListeners() {
  if (!liveCaptureContext.runtime) {
    return;
  }

  if (typeof liveCaptureContext.runtime.onConnect === 'function') {
    liveCaptureContext.runtime.onConnect((payload = {}) => {
      dispatchLiveEventToBackground('connect', {
        providerId: payload.providerId || liveCaptureContext.providerId,
        reconnects: payload.reconnects || 0,
        meta: payload
      });
    });
  }

  if (typeof liveCaptureContext.runtime.onReconnect === 'function') {
    liveCaptureContext.runtime.onReconnect((payload = {}) => {
      dispatchLiveEventToBackground('reconnect', {
        providerId: payload.providerId || liveCaptureContext.providerId,
        reconnects: payload.reconnects || 0,
        meta: payload
      });
    });
  }

  liveCaptureContext.runtime.onError((payload = {}) => {
    dispatchLiveEventToBackground('error', {
      providerId: payload.providerId || liveCaptureContext.providerId,
      code: payload.reason || 'live_transport_error',
      message: payload.error && payload.error.message ? payload.error.message : 'Falló la sesión live.',
      reconnects: payload.reconnects || 0
    });
  });

  liveCaptureContext.runtime.onFallback((payload = {}) => {
    dispatchLiveEventToBackground('fallback', {
      providerId: payload.providerId || liveCaptureContext.providerId,
      reason: payload.reason || 'reconnect_exhausted',
      reconnects: payload.reconnects || 0,
      error: payload.error && payload.error.message ? payload.error.message : null
    });
  });

  if (typeof liveCaptureContext.runtime.onClose === 'function') {
    liveCaptureContext.runtime.onClose((payload = {}) => {
      dispatchLiveEventToBackground('close', {
        providerId: payload.providerId || liveCaptureContext.providerId,
        reconnects: payload.reconnects || 0,
        meta: payload
      });
    });
  }
}

function queueLiveAudio(blob, options = {}) {
  if (!liveCaptureContext.runtime) {
    return;
  }

  liveCaptureContext.sendChain = liveCaptureContext.sendChain
    .catch(() => {})
    .then(async () => {
      if (options.requiresPCM) {
        // TODO: Phase future — PCM transcoding for AssemblyAI/OpenAI Realtime.
        // Current providers never hit this branch because registry capabilities keep
        // `liveAudioFormat` on non-PCM values (Deepgram: `webm/opus`).
        const pcmBlob = await transcodeToPCM(blob);
        return liveCaptureContext.runtime.pushAudio(pcmBlob);
      }

      return liveCaptureContext.runtime.pushAudio(blob);
    });
}

function dispatchLiveEventToBackground(type, payload = {}) {
  if (!offscreenBridge || typeof offscreenBridge.dispatchToBackground !== 'function') {
    return Promise.resolve({ ok: false, ignored: true });
  }

  const messageBuilders = {
    connect: offscreenBridge.buildLiveConnectMessage,
    partial: offscreenBridge.buildLivePartialMessage,
    final: offscreenBridge.buildLiveFinalMessage,
    error: offscreenBridge.buildLiveErrorMessage,
    fallback: offscreenBridge.buildLiveFallbackMessage,
    reconnect: offscreenBridge.buildLiveReconnectMessage,
    close: offscreenBridge.buildLiveCloseMessage
  };
  const buildMessage = messageBuilders[type];

  if (typeof buildMessage !== 'function') {
    return Promise.resolve({ ok: false, ignored: true });
  }

  try {
    const maybePromise = offscreenBridge.dispatchToBackground(
      buildMessage({
        sessionId: liveCaptureContext.sessionId,
        providerId: payload.providerId || liveCaptureContext.providerId,
        ...payload
      }),
      chrome.runtime.sendMessage
    );

    return maybePromise && typeof maybePromise.then === 'function'
      ? maybePromise.catch(() => ({ ok: false, ignored: true }))
      : Promise.resolve(maybePromise);
  } catch (error) {
    return Promise.resolve({ ok: false, ignored: true });
  }
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
  resetAudioActivityHeartbeat();
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
  // Stop/pause must silence future heartbeats before queue draining and media teardown begin.
  resetAudioActivityHeartbeat();

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
    void syncTranscriptionProgress('draining');
    return new Promise((resolve) => {
      queueDrainResolve = resolve;
      // Safety timeout: don't block stop forever (max 30s for pending API calls)
      queueDrainTimeoutId = setTimeout(() => {
        if (queueDrainResolve) {
          resetCaptureSessionContext();
          acceptedChunkCount = 0;
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
  acceptedChunkCount = 0;
  return Promise.resolve();
}
