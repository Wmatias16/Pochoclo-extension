// offscreen.js — Persistent recording engine
// This document stays alive even when the popup closes.

let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let analyser = null;
let audioChunks = [];
const chunkProcessor = globalThis.PochoclaChunkProcessor;
const offscreenBridge = globalThis.PochoclaOffscreenBridge;
const DEFAULT_TRANSCRIPTION_CHUNK_MS = 7000;

let captureSessionContext = {
  sessionId: null,
  language: 'es',
  activeProvider: null,
  nextChunkIndex: 0,
  chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
};

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
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  source.connect(audioContext.destination);

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
let transcriptionRecorder = null;
let transcriptionTimer = null;
let audioActivityMonitor = null;
let isTranscribing = false;
let chunkHadAudio = false;       // tracks audio activity DURING each chunk

// ── Serialized transcription queue ──
// Ensures chunks are handed to background in order, one at a time.
let queueDrainResolve = null;
let pendingChunkStop = 0;
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
    && pendingChunkStop === 0
    && !transcriptionProcessor.isProcessing()
    && transcriptionProcessor.size() === 0
  ) {
    queueDrainResolve();
    queueDrainResolve = null;
  }
}

function startTranscriptionCapture() {
  if (!mediaStream || isTranscribing) return;
  isTranscribing = true;
  captureNextChunk();
}

function captureNextChunk() {
  if (!isTranscribing || !mediaStream) return;

  chunkHadAudio = false;

  const recorder = new MediaRecorder(mediaStream, {
    mimeType: 'audio/webm;codecs=opus'
  });
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const hadAudio = chunkHadAudio; // Save BEFORE next chunk resets the flag

    // Start next chunk immediately (no audio gap)
    if (isTranscribing && mediaStream) {
      captureNextChunk();
    }

    // Enqueue for serialized transcription if there was audio during this chunk
    if (blob.size > 100 && hadAudio) {
      enqueueTranscription(blob);
    }

    if (pendingChunkStop > 0) {
      pendingChunkStop -= 1;
    }

    resolveTranscriptionDrainIfReady();
  };

  transcriptionRecorder = recorder;
  recorder.start();

  // Monitor audio activity during the chunk (check every 200ms)
  clearInterval(audioActivityMonitor);
  audioActivityMonitor = setInterval(() => {
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length;
    if (avg > 5) chunkHadAudio = true;
  }, 200);

  transcriptionTimer = setTimeout(() => {
    clearInterval(audioActivityMonitor);
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, captureSessionContext.chunkIntervalMs || DEFAULT_TRANSCRIPTION_CHUNK_MS);
}

function stopTranscriptionCapture() {
  isTranscribing = false;
  clearTimeout(transcriptionTimer);
  clearInterval(audioActivityMonitor);

  // Stop the current recorder (fires onstop → may enqueue final chunk)
  if (transcriptionRecorder && transcriptionRecorder.state !== 'inactive') {
    pendingChunkStop += 1;
    transcriptionRecorder.stop();
  }
  transcriptionRecorder = null;

  // Return a promise that resolves when the queue finishes processing
  if (pendingChunkStop > 0 || transcriptionProcessor.size() > 0 || transcriptionProcessor.isProcessing()) {
    return new Promise((resolve) => {
      queueDrainResolve = resolve;
      // Safety timeout: don't block stop forever (max 30s for pending API calls)
      setTimeout(() => {
        if (queueDrainResolve) {
          captureSessionContext = {
            sessionId: null,
            language: 'es',
            activeProvider: null,
            nextChunkIndex: 0,
            chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
          };
          queueDrainResolve();
          queueDrainResolve = null;
        }
      }, 30000);
    });
  }
  captureSessionContext = {
    sessionId: null,
    language: 'es',
    activeProvider: null,
    nextChunkIndex: 0,
    chunkIntervalMs: DEFAULT_TRANSCRIPTION_CHUNK_MS
  };
  return Promise.resolve();
}
