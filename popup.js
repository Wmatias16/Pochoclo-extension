// popup.js — Stateless UI
// All recording happens in the offscreen document.
// State is persisted in chrome.storage.local so it survives popup close/reopen.

// ── DOM Elements ──
const btnRecord = document.getElementById('btnRecord');
const btnPause = document.getElementById('btnPause');
const btnReset = document.getElementById('btnReset');
const btnCopy = document.getElementById('btnCopy');
const timerEl = document.getElementById('timer');
const timerLabel = document.getElementById('timerLabel');
const statusBadge = document.getElementById('statusBadge');
const ringOuter = document.getElementById('ringOuter');
const ringGlow = document.getElementById('ringGlow');
const waveform = document.getElementById('waveform');
const transcriptBox = document.getElementById('transcriptBox');
const transcriptText = document.getElementById('transcriptText');
const placeholder = document.getElementById('placeholder');
const waveBars = waveform.querySelectorAll('.wave-bar');

let timerInterval = null;
let waveformInterval = null;
let transcriptInterval = null;

// ── Helpers ──
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function sendBg(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'background', action, ...extra }, resolve);
  });
}

// ── UI update from state ──
function applyUI(state) {
  // Clear previous intervals
  clearInterval(timerInterval);
  clearInterval(waveformInterval);
  clearInterval(transcriptInterval);
  timerInterval = null;
  waveformInterval = null;
  transcriptInterval = null;

  if (state.status === 'recording') {
    const elapsed = (Date.now() - state.startTime - (state.pausedDuration || 0)) / 1000;
    timerEl.textContent = formatTime(elapsed);

    // Live timer
    timerInterval = setInterval(() => {
      const now = (Date.now() - state.startTime - (state.pausedDuration || 0)) / 1000;
      timerEl.textContent = formatTime(now);
    }, 500);

    // Live waveform from offscreen analyser
    waveBars.forEach(bar => bar.classList.add('active'));
    waveformInterval = setInterval(async () => {
      const resp = await sendBg('getWaveform');
      if (resp && resp.data) {
        waveBars.forEach((bar, i) => {
          const index = Math.floor(i * resp.data.length / waveBars.length);
          const value = resp.data[index] || 0;
          bar.style.height = Math.max(8, (value / 255) * 56) + 'px';
        });
      }
    }, 150);

    // Live transcript polling from storage
    transcriptInterval = setInterval(async () => {
      const { transcript } = await chrome.storage.local.get('transcript');
      if (transcript) {
        updateTranscriptUI(transcript.final || '', transcript.interim || '');
      }
    }, 300);

    btnRecord.classList.add('recording');
    btnPause.disabled = false;
    btnReset.disabled = false;
    statusBadge.textContent = 'Grabando';
    statusBadge.className = 'status-badge recording';
    timerLabel.textContent = 'Capturando audio de la pestaña...';
    ringOuter.classList.add('active');
    ringGlow.classList.add('active');
    transcriptBox.classList.add('active');
    placeholder.style.display = 'none';
    btnPause.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;

  } else if (state.status === 'paused') {
    const elapsed = (state.pausedAt - state.startTime - (state.pausedDuration || 0)) / 1000;
    timerEl.textContent = formatTime(elapsed);

    resetWaveBars();
    waveBars.forEach(bar => bar.classList.add('active'));

    btnRecord.classList.add('recording');
    btnPause.disabled = false;
    btnReset.disabled = false;
    statusBadge.textContent = 'Pausado';
    statusBadge.className = 'status-badge paused';
    timerLabel.textContent = 'Grabación en pausa';
    ringOuter.classList.add('active');
    ringGlow.classList.remove('active');
    placeholder.style.display = 'none';
    btnPause.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>`;

  } else {
    // idle
    resetWaveBars();
    btnRecord.classList.remove('recording');
    btnPause.disabled = true;
    btnReset.disabled = true;
    statusBadge.textContent = 'Listo';
    statusBadge.className = 'status-badge';
    timerLabel.textContent = 'Presioná grabar para iniciar';
    timerEl.textContent = '00:00';
    ringOuter.classList.remove('active');
    ringGlow.classList.remove('active');
    transcriptBox.classList.remove('active');
    // Don't clear transcript here — keep it visible after stop
  }

  // Cursor blink
  const existing = document.querySelector('.cursor-blink');
  if (state.status === 'recording') {
    if (!existing) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor-blink';
      transcriptText.after(cursor);
    }
  } else {
    if (existing) existing.remove();
  }
}

function resetWaveBars() {
  waveBars.forEach(bar => {
    bar.style.height = '8px';
    bar.classList.remove('active');
  });
}

// ── Transcript UI helpers ──
let lastTranscriptLength = 0;

function updateTranscriptUI(finalText, interimText) {
  placeholder.style.display = 'none';

  // Stream mode: only append new text, don't rewrite everything
  const newFinal = finalText.slice(lastTranscriptLength);
  if (newFinal) {
    // Append new final text character by character (stream effect)
    appendStreamText(newFinal);
    lastTranscriptLength = finalText.length;
  }

  // Update interim span
  let interimSpan = transcriptText.querySelector('.interim');
  if (interimText) {
    if (!interimSpan) {
      interimSpan = document.createElement('span');
      interimSpan.className = 'interim';
      interimSpan.style.color = '#9ca3af';
      transcriptText.appendChild(interimSpan);
    }
    interimSpan.textContent = interimText;
  } else if (interimSpan) {
    interimSpan.remove();
  }

  if (finalText || interimText) {
    btnCopy.disabled = false;
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }
}

function appendStreamText(text) {
  // Remove interim span temporarily
  const interim = transcriptText.querySelector('.interim');
  if (interim) interim.remove();

  // Append each character with a small delay for stream effect
  let i = 0;
  const interval = setInterval(() => {
    if (i >= text.length) {
      clearInterval(interval);
      // Re-add interim if exists
      if (interim) transcriptText.appendChild(interim);
      return;
    }
    transcriptText.insertAdjacentText('beforeend', text[i]);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    i++;
  }, 20);
}

function clearTranscriptUI() {
  transcriptText.textContent = '';
  placeholder.style.display = 'flex';
  btnCopy.disabled = true;
  lastTranscriptLength = 0;
}

// ── Init: restore state on popup open ──
async function init() {
  const state = await sendBg('getState');
  applyUI(state || { status: 'idle' });

  // Restore transcript from storage (instant, no stream animation)
  const { transcript } = await chrome.storage.local.get('transcript');
  if (transcript && (transcript.final || transcript.interim)) {
    placeholder.style.display = 'none';
    transcriptText.textContent = transcript.final || '';
    lastTranscriptLength = (transcript.final || '').length;
    if (transcript.final || transcript.interim) btnCopy.disabled = false;
  }
}

init();

// ── Button handlers ──
btnRecord.addEventListener('click', async () => {
  const state = await sendBg('getState');

  if (state.status === 'idle') {
    // Get current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      timerLabel.textContent = 'Error: No hay pestaña activa';
      return;
    }

    const resp = await sendBg('startCapture', { tabId: tab.id });
    if (!resp || !resp.ok) {
      timerLabel.textContent = 'Error: ' + (resp?.error || 'desconocido');
      return;
    }

    // Clear previous transcript from UI
    clearTranscriptUI();

    const newState = await sendBg('getState');
    applyUI(newState);
  } else {
    // Stop
    await sendBg('stopCapture');
    const newState = await sendBg('getState');
    applyUI(newState);
    statusBadge.textContent = 'Finalizado';
    timerLabel.textContent = 'Grabación finalizada';
    // Keep transcript visible, enable copy
    const { transcript } = await chrome.storage.local.get('transcript');
    if (transcript && transcript.final) {
      updateTranscriptUI(transcript.final, '');
    }
  }
});

btnPause.addEventListener('click', async () => {
  const state = await sendBg('getState');

  if (state.status === 'recording') {
    await sendBg('pauseCapture');
  } else if (state.status === 'paused') {
    await sendBg('resumeCapture');
  }

  const newState = await sendBg('getState');
  applyUI(newState);
});

btnReset.addEventListener('click', async () => {
  await sendBg('resetCapture');
  const newState = await sendBg('getState');
  applyUI(newState);
  clearTranscriptUI();
});

btnCopy.addEventListener('click', () => {
  const text = transcriptText.textContent.trim();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const original = btnCopy.textContent;
    btnCopy.textContent = '¡Copiado!';
    setTimeout(() => { btnCopy.textContent = original; }, 1500);
  });
});

// ── Settings panel ──
const btnSettings = document.getElementById('btnSettings');
const settingsPanel = document.getElementById('settingsPanel');
const apiKeyInput = document.getElementById('apiKeyInput');
const btnSaveKey = document.getElementById('btnSaveKey');
const keySaved = document.getElementById('keySaved');

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
});

chrome.storage.local.get('openaiApiKey', ({ openaiApiKey }) => {
  if (openaiApiKey) {
    apiKeyInput.value = openaiApiKey;
  }
});

btnSaveKey.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    chrome.storage.local.set({ openaiApiKey: key });
    keySaved.classList.add('show');
    setTimeout(() => keySaved.classList.remove('show'), 2000);
  }
});
