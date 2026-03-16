// offscreen.js — Persistent recording engine
// This document stays alive even when the popup closes.

let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let analyser = null;
let audioChunks = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  switch (msg.action) {
    case 'start':
      startRecording(msg.streamId).then(() => sendResponse({ ok: true }))
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

async function startRecording(streamId) {
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

  // Start transcription capture (sends chunks to Whisper API)
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
const TRANSCRIPTION_CHUNK_MS = 7000;

// ── Serialized transcription queue ──
// Ensures chunks are transcribed in order, one at a time
let transcriptionQueue = [];
let isProcessingQueue = false;
let queueDrainResolve = null;    // resolved when queue is empty and no more chunks coming

function enqueueTranscription(blob) {
  transcriptionQueue.push(blob);
  if (!isProcessingQueue) processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (transcriptionQueue.length > 0) {
    const blob = transcriptionQueue.shift();
    await transcribeChunk(blob);
  }

  isProcessingQueue = false;

  // Signal that queue is drained (used during stop)
  if (queueDrainResolve && !isTranscribing) {
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
    } else if (!isTranscribing && queueDrainResolve && transcriptionQueue.length === 0 && !isProcessingQueue) {
      // Stopping and this silent chunk was the last — drain immediately
      queueDrainResolve();
      queueDrainResolve = null;
    }
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
  }, TRANSCRIPTION_CHUNK_MS);
}

// Known Whisper hallucination phrases (silence artifacts)
const HALLUCINATIONS = [
  'subt\u00edtulos realizados por la comunidad de amara.org',
  'subtitulos realizados por la comunidad de amara.org',
  'amara.org',
  'subt\u00edtulos realizados por',
  'subtitulado por',
  'subt\u00edtulos por',
  'gracias por ver',
  'thanks for watching',
  'thank you for watching',
  'suscr\u00edbete',
  'subscribe',
  '\u00a1suscr\u00edbete al canal!',
  'you',
  '...',
  'MosCatalworking',
];

function isHallucination(text) {
  const lower = text.toLowerCase().trim();
  return HALLUCINATIONS.some(h => lower.includes(h)) || lower.length < 3;
}

async function transcribeChunk(blob) {
  // Offscreen can't use chrome.storage — ask background for the key
  const { key } = await chrome.runtime.sendMessage({ target: 'background', action: 'getApiKey' });
  if (!key) {
    console.warn('Whisper: no API key configured');
    return;
  }

  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('language', 'es');

  try {
    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: formData
    });
    const data = await resp.json();
    if (data.error) {
      console.warn('Whisper API error:', data.error.message);
      return;
    }
    if (data.text && data.text.trim() && !isHallucination(data.text)) {
      // Save transcript through background (offscreen can't access chrome.storage)
      await chrome.runtime.sendMessage({
        target: 'background',
        action: 'saveTranscript',
        text: data.text.trim() + ' '
      });
    }
  } catch (e) {
    console.warn('Whisper transcription error:', e);
  }
}

function stopTranscriptionCapture() {
  isTranscribing = false;
  clearTimeout(transcriptionTimer);
  clearInterval(audioActivityMonitor);

  // Stop the current recorder (fires onstop → may enqueue final chunk)
  if (transcriptionRecorder && transcriptionRecorder.state !== 'inactive') {
    transcriptionRecorder.stop();
  }
  transcriptionRecorder = null;

  // Return a promise that resolves when the queue finishes processing
  if (transcriptionQueue.length > 0 || isProcessingQueue) {
    return new Promise((resolve) => {
      queueDrainResolve = resolve;
      // Safety timeout: don't block stop forever (max 30s for pending API calls)
      setTimeout(() => {
        if (queueDrainResolve) {
          queueDrainResolve();
          queueDrainResolve = null;
        }
      }, 30000);
    });
  }
  return Promise.resolve();
}
