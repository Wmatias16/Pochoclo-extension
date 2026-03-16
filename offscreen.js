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
      stopRecording();
      sendResponse({ ok: true });
      break;

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

function stopRecording() {
  stopTranscriptionCapture();
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
let isTranscribing = false;
const TRANSCRIPTION_CHUNK_MS = 7000;

function startTranscriptionCapture() {
  if (!mediaStream || isTranscribing) return;
  isTranscribing = true;
  captureNextChunk();
}

function captureNextChunk() {
  if (!isTranscribing || !mediaStream) return;

  const recorder = new MediaRecorder(mediaStream, {
    mimeType: 'audio/webm;codecs=opus'
  });
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    // Start next chunk immediately (don't wait for API)
    if (isTranscribing && mediaStream) {
      captureNextChunk();
    }
    if (blob.size > 100) {
      transcribeChunk(blob);
    }
  };

  transcriptionRecorder = recorder;
  recorder.start();

  transcriptionTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, TRANSCRIPTION_CHUNK_MS);
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
    if (data.text && data.text.trim()) {
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
  if (transcriptionRecorder && transcriptionRecorder.state !== 'inactive') {
    transcriptionRecorder.stop();
  }
  transcriptionRecorder = null;
}
