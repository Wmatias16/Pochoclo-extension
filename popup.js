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
const centerDot = document.getElementById('centerDot');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const ctx = visualizerCanvas.getContext('2d');
const transcriptBox = document.getElementById('transcriptBox');
const transcriptText = document.getElementById('transcriptText');
const placeholder = document.getElementById('placeholder');

// Views & navigation
const viewRecorder = document.getElementById('viewRecorder');
const viewHistory = document.getElementById('viewHistory');
const viewDetail = document.getElementById('viewDetail');
const btnBack = document.getElementById('btnBack');
const btnHistory = document.getElementById('btnHistory');
const toastEl = document.getElementById('toast');

// Detail view
const detailTitle = document.getElementById('detailTitle');
const detailMeta = document.getElementById('detailMeta');
const detailUrl = document.getElementById('detailUrl');
const detailText = document.getElementById('detailText');
const btnSaveTitle = document.getElementById('btnSaveTitle');
const btnDetailCopy = document.getElementById('btnDetailCopy');
const btnDetailDelete = document.getElementById('btnDetailDelete');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const historyCount = document.getElementById('historyCount');

let currentView = 'recorder';
let currentDetailId = null;

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

// ── View switching ──
function showView(view) {
  currentView = view;
  viewRecorder.classList.toggle('active', view === 'recorder');
  viewHistory.classList.toggle('active', view === 'history');
  viewDetail.classList.toggle('active', view === 'detail');
  btnBack.classList.toggle('visible', view !== 'recorder');
  if (view !== 'recorder') settingsPanel.classList.remove('open');
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const LANG_NAMES = { es: 'Español', en: 'English', pt: 'Português', fr: 'Français', de: 'Deutsch', it: 'Italiano', ja: '日本語', zh: '中文', ko: '한국어', ru: 'Русский', ar: 'العربية', hi: 'हिन्दी' };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── UI update from state ──
let waveformAnimFrame = null;

function applyUI(state) {
  // Clear previous intervals
  clearInterval(timerInterval);
  clearTimeout(waveformInterval);
  cancelAnimationFrame(waveformAnimFrame);
  clearInterval(transcriptInterval);
  timerInterval = null;
  waveformInterval = null;
  waveformAnimFrame = null;
  transcriptInterval = null;

  if (state.status === 'recording') {
    const elapsed = (Date.now() - state.startTime - (state.pausedDuration || 0)) / 1000;
    timerEl.textContent = formatTime(elapsed);

    // Live timer
    timerInterval = setInterval(() => {
      const now = (Date.now() - state.startTime - (state.pausedDuration || 0)) / 1000;
      timerEl.textContent = formatTime(now);
    }, 500);

    // Live visualizer — dense soundwave bars inside ring
    const NUM_BARS = 48;
    const smoothed = new Float32Array(NUM_BARS).fill(0);
    let time = 0;

    async function drawVisualizer() {
      const resp = await sendBg('getWaveform');
      const data = resp && resp.data ? resp.data : [];

      const W = visualizerCanvas.width;
      const H = visualizerCanvas.height;
      const cx = W / 2;
      const cy = H / 2;
      const ringR = 82;

      ctx.clearRect(0, 0, W, H);

      // Clip to circle
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.clip();

      // Smooth audio data into half-array, then mirror for symmetry
      const HALF = NUM_BARS / 2;
      let avg = 0;
      for (let i = 0; i < HALF; i++) {
        const dataIdx = Math.floor(i * data.length / HALF);
        const raw = (data[dataIdx] || 0) / 255;
        smoothed[i] += (raw - smoothed[i]) * 0.35;
        avg += smoothed[i];
      }
      avg /= HALF;
      time += 0.07;

      // Build mirrored array: center = loudest, edges = quietest
      const mirrored = new Float32Array(NUM_BARS);
      for (let i = 0; i < HALF; i++) {
        mirrored[HALF - 1 - i] = smoothed[i]; // left half (center→left)
        mirrored[HALF + i]     = smoothed[i]; // right half (center→right)
      }

      // Bars span full ring diameter, centered
      const barsWidth = ringR * 2;
      const barSpacing = barsWidth / NUM_BARS;
      const barW = 2.5;
      const startX = cx - ringR;
      const maxH = ringR * 1.5;

      // Create gradient (dark gray top -> red/pink bottom)
      const grad = ctx.createLinearGradient(0, cy - ringR, 0, cy + ringR);
      grad.addColorStop(0, '#5a5a5a');
      grad.addColorStop(0.45, '#9b6a6a');
      grad.addColorStop(1, '#dc2626');

      for (let i = 0; i < NUM_BARS; i++) {
        const val = mirrored[i];

        // Faster wobble for more energy
        const wobble = Math.sin(time * 3 + i * 0.4) * 0.06
                      + Math.sin(time * 2 + i * 0.7) * 0.04;

        const h = Math.max(4, (val + wobble * (0.3 + val)) * maxH);
        const x = startX + i * barSpacing + (barSpacing - barW) / 2;
        const y = cy - h / 2;

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, 1.2);
        ctx.fill();
      }

      ctx.restore();

      // Subtle ring breathing
      const scale = 1 + avg * 0.03;
      ringOuter.style.transform = `scale(${scale})`;

      waveformInterval = setTimeout(() => {
        waveformAnimFrame = requestAnimationFrame(drawVisualizer);
      }, 40);
    }

    waveformAnimFrame = requestAnimationFrame(drawVisualizer);

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
  ctx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
  ringOuter.style.transform = '';
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

    const resp = await sendBg('startCapture', { tabId: tab.id, tabTitle: tab.title, tabUrl: tab.url });
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
      showToast('✓ Guardado en historial');
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
const langSelect = document.getElementById('langSelect');

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
});

chrome.storage.local.get('openaiApiKey', ({ openaiApiKey }) => {
  if (openaiApiKey) {
    apiKeyInput.value = openaiApiKey;
  }
});

chrome.storage.local.get('audioLanguage', ({ audioLanguage }) => {
  if (audioLanguage) {
    langSelect.value = audioLanguage;
  }
});

langSelect.addEventListener('change', () => {
  chrome.storage.local.set({ audioLanguage: langSelect.value });
});

btnSaveKey.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    chrome.storage.local.set({ openaiApiKey: key });
    keySaved.classList.add('show');
    setTimeout(() => keySaved.classList.remove('show'), 2000);
  }
});

// ── View navigation ──
btnBack.addEventListener('click', () => {
  if (currentView === 'detail') {
    showView('history');
    loadHistory();
  } else {
    showView('recorder');
  }
});

btnHistory.addEventListener('click', () => {
  if (currentView === 'history') {
    showView('recorder');
  } else {
    showView('history');
    loadHistory();
  }
});

// ── History ──
async function loadHistory() {
  const list = await sendBg('getTranscriptions');
  historyCount.textContent = list.length;

  if (list.length === 0) {
    historyList.style.display = 'none';
    historyEmpty.style.display = 'block';
    return;
  }

  historyEmpty.style.display = 'none';
  historyList.style.display = 'flex';
  historyList.innerHTML = '';

  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const preview = item.text.length > 100 ? item.text.slice(0, 100) + '…' : item.text;
    const langName = LANG_NAMES[item.language] || item.language;

    el.innerHTML = `
      <div class="history-item-title">${escapeHtml(item.title)}</div>
      <div class="history-item-meta">
        ${formatDate(item.date)}
        <span class="dot"></span>
        ${formatDuration(item.duration)}
        <span class="dot"></span>
        ${escapeHtml(langName)}
      </div>
      <div class="history-item-preview">${escapeHtml(preview)}</div>
    `;

    el.addEventListener('click', () => openDetail(item));
    historyList.appendChild(el);
  });
}

// ── Detail view ──
function openDetail(item) {
  currentDetailId = item.id;
  detailTitle.value = item.title;
  detailTitle.dataset.original = item.title;
  btnSaveTitle.classList.remove('visible');

  const langName = LANG_NAMES[item.language] || item.language;
  detailMeta.innerHTML = `
    ${formatDate(item.date)}
    <span class="dot"></span>
    ${formatDuration(item.duration)}
    <span class="dot"></span>
    ${escapeHtml(langName)}
  `;

  let hostname = '';
  try { hostname = new URL(item.url).hostname; } catch {}
  detailUrl.textContent = hostname;
  detailUrl.style.display = hostname ? 'block' : 'none';
  detailText.textContent = item.text;

  showView('detail');
}

detailTitle.addEventListener('input', () => {
  const changed = detailTitle.value !== detailTitle.dataset.original;
  btnSaveTitle.classList.toggle('visible', changed);
});

btnSaveTitle.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const newTitle = detailTitle.value.trim();
  if (!newTitle) return;
  await sendBg('updateTranscription', { id: currentDetailId, updates: { title: newTitle } });
  detailTitle.dataset.original = newTitle;
  btnSaveTitle.classList.remove('visible');
  showToast('Título actualizado');
});

btnDetailCopy.addEventListener('click', () => {
  const text = detailText.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('¡Copiado!');
  });
});

btnDetailDelete.addEventListener('click', async () => {
  if (!currentDetailId) return;
  if (!confirm('¿Eliminar esta transcripción?')) return;
  await sendBg('deleteTranscription', { id: currentDetailId });
  currentDetailId = null;
  showView('history');
  loadHistory();
  showToast('Transcripción eliminada');
});
