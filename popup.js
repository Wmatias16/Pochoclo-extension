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
const detailAudit = document.getElementById('detailAudit');
const detailText = document.getElementById('detailText');
const detailSummarySection = document.getElementById('detailSummarySection');
const detailSummaryStatus = document.getElementById('detailSummaryStatus');
const detailSummaryBadge = document.getElementById('detailSummaryBadge');
const detailSummaryCard = document.getElementById('detailSummaryCard');
const detailSummaryText = document.getElementById('detailSummaryText');
const detailSummaryKeyPoints = document.getElementById('detailSummaryKeyPoints');
const detailSummaryError = document.getElementById('detailSummaryError');
const btnDetailSummarize = document.getElementById('btnDetailSummarize');
const btnSaveTitle = document.getElementById('btnSaveTitle');
const btnDetailCopy = document.getElementById('btnDetailCopy');
const btnDetailDelete = document.getElementById('btnDetailDelete');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const historyCount = document.getElementById('historyCount');

let currentView = 'recorder';
let currentDetailId = null;
let currentDetailItem = null;
let providerCatalog = [];
let providerSettingsState = null;
let liveSessionState = null;
let detailSummaryRequest = { id: null, status: 'idle', error: null };

const popupSummaryUi = globalThis.PochoclaPopupSummaryUI || null;

let timerInterval = null;
let waveformInterval = null;
let transcriptInterval = null;

const LANG_NAMES = {
  es: 'Español',
  en: 'English',
  pt: 'Português',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी'
};

const PROVIDER_NAMES = {
  openai: 'OpenAI',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
  groq: 'Groq',
  google: 'Google',
  whisperLocal: 'Whisper local'
};

const PROVIDER_DESCRIPTIONS = {
  openai: 'Camino estable y compatible con el flujo histórico.',
  deepgram: 'Speech-to-text remoto optimizado para audio largo.',
  assemblyai: 'Transcripción asíncrona con polling administrado.',
  groq: 'Whisper compatible con endpoint OpenAI-style.',
  google: 'Google Speech-to-Text remoto.',
  whisperLocal: 'Bridge local de Whisper sin correr WASM dentro de la extensión.'
};

const PROVIDER_DOC_LINKS = {
  openai: 'https://platform.openai.com/api-keys',
  deepgram: 'https://console.deepgram.com/project/api-keys',
  assemblyai: 'https://www.assemblyai.com/dashboard/api-keys',
  groq: 'https://console.groq.com/keys',
  google: 'https://console.cloud.google.com/apis/credentials'
};

const PROVIDER_FIELDS = {
  openai: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'sk-...', full: true },
    { key: 'model', label: 'Modelo Whisper', type: 'text', placeholder: 'whisper-1' },
    { key: 'translationModel', label: 'Modelo traducción', type: 'text', placeholder: 'gpt-4o-mini' }
  ],
  deepgram: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'dg-...', full: true },
    { key: 'model', label: 'Modelo', type: 'text', placeholder: 'nova-3' },
    { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.deepgram.com/v1/listen', full: true }
  ],
  assemblyai: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'aa-...', full: true },
    { key: 'model', label: 'Speech model', type: 'text', placeholder: 'best' },
    { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.assemblyai.com/v2', full: true },
    { key: 'pollIntervalMs', label: 'Poll ms', type: 'number', placeholder: '1500' },
    { key: 'maxPolls', label: 'Máx polls', type: 'number', placeholder: '120' }
  ],
  groq: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'gsk_...', full: true },
    { key: 'model', label: 'Modelo', type: 'text', placeholder: 'whisper-large-v3-turbo' },
    { key: 'baseUrl', label: 'Endpoint', type: 'text', placeholder: 'https://api.groq.com/openai/v1/audio/transcriptions', full: true }
  ],
  google: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'AIza...', full: true },
    { key: 'model', label: 'Modelo', type: 'text', placeholder: 'latest_long' }
  ],
  whisperLocal: [
    { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'http://127.0.0.1:8765', full: true },
    { key: 'healthPath', label: 'Health path', type: 'text', placeholder: '/health' },
    { key: 'transcribePath', label: 'Transcribe path', type: 'text', placeholder: '/transcribe' },
    { key: 'model', label: 'Modelo bridge', type: 'text', placeholder: 'bridge-default', full: true }
  ]
};

const PROVIDER_REQUIRED_FIELDS = {
  openai: ['apiKey'],
  deepgram: ['apiKey'],
  assemblyai: ['apiKey'],
  groq: ['apiKey'],
  google: ['apiKey'],
  whisperLocal: ['baseUrl']
};

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

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getProviderLabel(providerId) {
  return PROVIDER_NAMES[providerId] || providerId || 'OpenAI';
}

function getResolvedProviderId(item) {
  return item && (item.resolvedProvider || (item.providerAudit && item.providerAudit.resolvedProvider))
    ? (item.resolvedProvider || (item.providerAudit && item.providerAudit.resolvedProvider))
    : null;
}

function isLocalProvider(providerId) {
  return providerId === 'whisperLocal';
}

function getProviderFailureCount(item) {
  return getAttemptList(item).filter((attempt) => attempt.status === 'failed').length;
}

function hasRelevantProviderContext(item) {
  if (!item) return false;

  const status = item.status || (item.providerAudit && item.providerAudit.status) || 'completed';
  const resolvedProviderId = getResolvedProviderId(item);

  return status === 'failed'
    || getProviderFailureCount(item) > 0
    || isLocalProvider(resolvedProviderId);
}

function getProviderContextBadge(item) {
  if (!item) return null;

  const status = item.status || (item.providerAudit && item.providerAudit.status) || 'completed';
  const resolvedProviderId = getResolvedProviderId(item);
  const resolvedProvider = getProviderLabel(resolvedProviderId);
  const failureCount = getProviderFailureCount(item);

  if (status === 'failed') {
    return {
      tone: 'failed',
      text: failureCount > 0
        ? `Falló tras ${failureCount} intento${failureCount === 1 ? '' : 's'}`
        : 'Falló'
    };
  }

  if (failureCount > 0) {
    return {
      tone: 'warning',
      text: `Fallback a ${resolvedProvider}`
    };
  }

  if (isLocalProvider(resolvedProviderId)) {
    return {
      tone: 'neutral',
      text: `Modo local · ${resolvedProvider}`
    };
  }

  return null;
}

function buildEmptyProviderSettings() {
  return {
    defaultProvider: 'openai',
    providers: {
      openai: { enabled: true, apiKey: '', model: '', translationModel: '' },
      deepgram: { enabled: false, apiKey: '', model: '', baseUrl: '' },
      assemblyai: { enabled: false, apiKey: '', model: '', baseUrl: '', pollIntervalMs: '', maxPolls: '' },
      groq: { enabled: false, apiKey: '', model: '', baseUrl: '' },
      google: { enabled: false, apiKey: '', model: '' },
      whisperLocal: { enabled: false, baseUrl: 'http://127.0.0.1:8765', healthPath: '/health', transcribePath: '/transcribe', model: '' }
    }
  };
}

function cloneProviderSettings(settings) {
  return JSON.parse(JSON.stringify(settings || buildEmptyProviderSettings()));
}

function normalizeProviderSettingsShape(settings = {}) {
  const base = buildEmptyProviderSettings();
  const next = cloneProviderSettings(base);
  const providerIds = Object.keys(PROVIDER_NAMES);

  providerIds.forEach((providerId) => {
    next.providers[providerId] = {
      ...base.providers[providerId],
      ...((settings.providers && settings.providers[providerId]) || {})
    };
  });

  next.defaultProvider = providerIds.includes(settings.defaultProvider)
    ? settings.defaultProvider
    : 'openai';

  return next;
}

function sanitizeProviderSettingsDraft(draft) {
  const next = normalizeProviderSettingsShape(draft);

  Object.keys(next.providers).forEach((providerId) => {
    const config = next.providers[providerId];
    Object.keys(config).forEach((fieldKey) => {
      if (typeof config[fieldKey] === 'string') {
        config[fieldKey] = config[fieldKey].trim();
      }
      if ((fieldKey === 'pollIntervalMs' || fieldKey === 'maxPolls') && config[fieldKey] !== '') {
        const numeric = Number(config[fieldKey]);
        config[fieldKey] = Number.isFinite(numeric) && numeric > 0 ? numeric : '';
      }
    });
  });

  return next;
}

function getProviderConfigStatus(providerId, settings = providerSettingsState) {
  const config = (settings && settings.providers && settings.providers[providerId]) || {};
  const enabled = config.enabled !== false;
  const missing = (PROVIDER_REQUIRED_FIELDS[providerId] || []).filter((fieldKey) => !hasText(config[fieldKey]));
  return {
    enabled,
    missing,
    ready: enabled && missing.length === 0
  };
}

function getAttemptList(item) {
  return Array.isArray(item && item.providerAudit && item.providerAudit.attempts)
    ? [...item.providerAudit.attempts].sort((left, right) => (left.order || 0) - (right.order || 0))
    : [];
}

function getHistoryPreview(item) {
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (text) {
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  }

  const lastError = item && item.providerAudit && item.providerAudit.lastChunkError;
  if (lastError && lastError.summary) {
    return `Falló: ${lastError.summary}`;
  }

  return 'Sin texto final guardado.';
}

function getHistoryProviderSummary(item) {
  const status = (item && item.status) || (item && item.providerAudit && item.providerAudit.status) || 'completed';
  const resolvedProvider = getProviderLabel(item && (item.resolvedProvider || (item.providerAudit && item.providerAudit.resolvedProvider)));
  const failedAttempts = getAttemptList(item).filter((attempt) => attempt.status === 'failed').length;

  if (status === 'failed') {
    return `Fallida · ${resolvedProvider}`;
  }

  if (failedAttempts > 0) {
    return `${resolvedProvider} · ${failedAttempts} fallback`;
  }

  return resolvedProvider;
}

function setCurrentDetailItem(item) {
  currentDetailItem = item ? cloneValue(item) : null;
  currentDetailId = currentDetailItem ? currentDetailItem.id : null;
}

function setDetailSummaryRequest(nextState = {}) {
  detailSummaryRequest = {
    id: nextState.id || null,
    status: nextState.status || 'idle',
    error: nextState.error || null
  };
}

async function getTranscriptionById(id) {
  if (!hasText(id)) return null;
  const list = await sendBg('getTranscriptions');
  return Array.isArray(list) ? list.find((entry) => entry && entry.id === id) || null : null;
}

function getSummaryViewModel(item) {
  if (popupSummaryUi && typeof popupSummaryUi.createSummaryViewModel === 'function') {
    return popupSummaryUi.createSummaryViewModel({
      transcription: item,
      request: detailSummaryRequest.id === (item && item.id)
        ? detailSummaryRequest
        : { id: item && item.id, status: 'idle', error: null }
    });
  }

  return {
    state: 'idle',
    canSummarize: hasText(item && item.text),
    actionLabel: 'Resumir',
    actionDisabled: !hasText(item && item.text),
    statusText: 'Generá una síntesis corta con los puntos más importantes.',
    showCard: false,
    short: '',
    keyPoints: [],
    errorMessage: ''
  };
}

function renderDetailSummary(item) {
  if (!detailSummarySection) return;

  const viewModel = getSummaryViewModel(item);
  detailSummarySection.hidden = false;
  detailSummaryStatus.textContent = viewModel.statusText;
   if (detailSummaryBadge) {
     detailSummaryBadge.hidden = !viewModel.showStaleBadge;
     detailSummaryBadge.textContent = viewModel.staleBadgeText || 'Resumen desactualizado';
   }
  btnDetailSummarize.textContent = viewModel.actionLabel;
  btnDetailSummarize.disabled = !!viewModel.actionDisabled;

  detailSummaryCard.hidden = !viewModel.showCard;
  detailSummaryCard.classList.toggle('error', viewModel.state === 'error');

  detailSummaryText.hidden = !(viewModel.showCard && hasText(viewModel.short));
  detailSummaryText.textContent = viewModel.short || '';

  detailSummaryError.hidden = !(viewModel.showCard && hasText(viewModel.errorMessage));
  detailSummaryError.textContent = viewModel.errorMessage || '';

  const keyPoints = Array.isArray(viewModel.keyPoints) ? viewModel.keyPoints : [];
  detailSummaryKeyPoints.hidden = !(viewModel.showCard && keyPoints.length > 0);
  detailSummaryKeyPoints.innerHTML = '';
  keyPoints.forEach((point) => {
    const li = document.createElement('li');
    li.textContent = point;
    detailSummaryKeyPoints.appendChild(li);
  });
}

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

function renderAuditDetail(item) {
  const audit = item && item.providerAudit;
  const status = (audit && audit.status) || item.status || 'completed';
  const statusLabel = status === 'failed' ? 'Fallida' : 'Completada';
  const statusClass = status === 'failed' ? 'danger' : 'success';
  const resolvedProviderId = getResolvedProviderId(item);
  const resolvedProvider = getProviderLabel(resolvedProviderId);
  const shouldAutoOpen = hasRelevantProviderContext(item);
  const summaryBadge = getProviderContextBadge(item);
  const summaryCopy = summaryBadge
    ? summaryBadge.text
    : 'Sin fallback ni incidencias. Abrí esto solo si necesitás ver el provider exacto o la auditoría.';

  if (!audit) {
    detailAudit.innerHTML = `
      <details class="detail-audit-card detail-audit-disclosure">
        <summary class="detail-audit-summary-row">
          <div>
            <div class="detail-audit-title">Detalle técnico</div>
            <div class="detail-audit-summary-copy">Registro histórico sin auditoría multi-provider.</div>
          </div>
          <span class="audit-chip ${statusClass}">${statusLabel}</span>
        </summary>
        <div class="detail-audit-body">
          <div class="detail-audit-summary">
            <span class="audit-summary-label">Provider final</span>
            <strong>${escapeHtml(resolvedProvider)}</strong>
          </div>
          <div class="detail-audit-note">Esta transcripción viene del historial previo al cambio multi-provider.</div>
        </div>
      </details>
    `;
    return;
  }

  const attempts = getAttemptList(item);
  const defaultProvider = audit.defaultProvider ? getProviderLabel(audit.defaultProvider) : null;
  const overrideProvider = audit.providerOverride ? getProviderLabel(audit.providerOverride) : null;
  const failureCount = attempts.filter((attempt) => attempt.status === 'failed').length;
  const attemptsHtml = attempts.length
    ? attempts.map((attempt) => {
        const attemptStatusLabel = attempt.status === 'failed'
          ? 'Falló'
          : attempt.status === 'succeeded'
            ? 'Éxito'
            : 'Activo';
        const attemptClass = attempt.status === 'failed'
          ? 'danger'
          : attempt.status === 'succeeded'
            ? 'success'
            : 'neutral';

        return `
          <div class="audit-attempt-item">
            <div class="audit-attempt-top">
              <span class="audit-attempt-provider">#${attempt.order || 0} · ${escapeHtml(getProviderLabel(attempt.providerId))}</span>
              <span class="audit-chip ${attemptClass}">${attemptStatusLabel}</span>
            </div>
            ${attempt.errorSummary ? `<div class="audit-attempt-error">${escapeHtml(attempt.errorSummary)}</div>` : ''}
          </div>
        `;
      }).join('')
    : '<div class="detail-audit-note">No hay intentos persistidos para esta transcripción.</div>';

  detailAudit.innerHTML = `
    <details class="detail-audit-card detail-audit-disclosure" ${shouldAutoOpen ? 'open' : ''}>
      <summary class="detail-audit-summary-row">
        <div>
          <div class="detail-audit-title">Detalle técnico</div>
          <div class="detail-audit-summary-copy">${escapeHtml(summaryCopy)}</div>
        </div>
        <span class="audit-chip ${statusClass}">${statusLabel}</span>
      </summary>
      <div class="detail-audit-body">
        <div class="detail-audit-grid">
          <div class="detail-audit-summary">
            <span class="audit-summary-label">Provider final</span>
            <strong>${escapeHtml(resolvedProvider)}</strong>
          </div>
          <div class="detail-audit-summary">
            <span class="audit-summary-label">Fallbacks fallidos</span>
            <strong>${failureCount}</strong>
          </div>
          ${defaultProvider ? `
            <div class="detail-audit-summary">
              <span class="audit-summary-label">Default</span>
              <strong>${escapeHtml(defaultProvider)}</strong>
            </div>
          ` : ''}
          ${overrideProvider ? `
            <div class="detail-audit-summary">
              <span class="audit-summary-label">Override</span>
              <strong>${escapeHtml(overrideProvider)}</strong>
            </div>
          ` : ''}
        </div>
        ${audit.lastChunkError && audit.lastChunkError.summary ? `
          <div class="detail-audit-note">Último error: ${escapeHtml(audit.lastChunkError.summary)}</div>
        ` : ''}
        <div class="audit-attempt-list">${attemptsHtml}</div>
      </div>
    </details>
  `;
}

// ── UI update from state ──
let waveformAnimFrame = null;

function updateProviderLiveChip(state) {
  const status = state && state.status ? state.status : 'idle';
  const activeProviderId = liveSessionState && liveSessionState.activeProvider
    ? liveSessionState.activeProvider
    : null;
  const activeProvider = activeProviderId ? getProviderLabel(activeProviderId) : null;
  const failureCount = getProviderFailureCount(liveSessionState);
  const pendingDefaultProviderId = (providerSettingsState && providerSettingsState.defaultProvider) || 'openai';

  sessionMeta.hidden = false;
  providerLiveChip.className = 'session-meta-pill';

  if (status === 'recording' || status === 'paused') {
    if (failureCount > 0 && activeProvider) {
      providerLiveChip.textContent = `Fallback activo · ahora sigue ${activeProvider}`;
      providerLiveChip.classList.add('warning');
      return;
    }

    if (isLocalProvider(activeProviderId) && activeProvider) {
      providerLiveChip.textContent = `Modo local activo · ${activeProvider}`;
      providerLiveChip.classList.add('neutral');
      return;
    }

    if (liveSessionState && liveSessionState.lastChunkError && liveSessionState.lastChunkError.summary) {
      providerLiveChip.textContent = liveSessionState.lastChunkError.summary;
      providerLiveChip.classList.add('danger');
      return;
    }

    sessionMeta.hidden = true;
    return;
  }

  if (isLocalProvider(pendingDefaultProviderId)) {
    providerLiveChip.textContent = `Modo local por default · ${getProviderLabel(pendingDefaultProviderId)}`;
    providerLiveChip.classList.add('neutral');
    return;
  }

  sessionMeta.hidden = true;
}

async function refreshTranscriptSession() {
  const response = await sendBg('getTranscriptionSession');
  liveSessionState = response && response.ok ? response.transcriptSession : null;
  const state = await sendBg('getState');
  updateProviderLiveChip(state || { status: 'idle' });
}

function applyUI(state) {
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

    timerInterval = setInterval(() => {
      const now = (Date.now() - state.startTime - (state.pausedDuration || 0)) / 1000;
      timerEl.textContent = formatTime(now);
    }, 500);

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

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.clip();

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

      const mirrored = new Float32Array(NUM_BARS);
      for (let i = 0; i < HALF; i++) {
        mirrored[HALF - 1 - i] = smoothed[i];
        mirrored[HALF + i] = smoothed[i];
      }

      const barsWidth = ringR * 2;
      const barSpacing = barsWidth / NUM_BARS;
      const barW = 2.5;
      const startX = cx - ringR;
      const maxH = ringR * 1.5;

      const grad = ctx.createLinearGradient(0, cy - ringR, 0, cy + ringR);
      grad.addColorStop(0, '#5a5a5a');
      grad.addColorStop(0.45, '#9b6a6a');
      grad.addColorStop(1, '#dc2626');

      for (let i = 0; i < NUM_BARS; i++) {
        const val = mirrored[i];
        const wobble = Math.sin(time * 3 + i * 0.4) * 0.06 + Math.sin(time * 2 + i * 0.7) * 0.04;
        const h = Math.max(4, (val + wobble * (0.3 + val)) * maxH);
        const x = startX + i * barSpacing + (barSpacing - barW) / 2;
        const y = cy - h / 2;

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, 1.2);
        ctx.fill();
      }

      ctx.restore();
      const scale = 1 + avg * 0.03;
      ringOuter.style.transform = `scale(${scale})`;

      waveformInterval = setTimeout(() => {
        waveformAnimFrame = requestAnimationFrame(drawVisualizer);
      }, 40);
    }

    waveformAnimFrame = requestAnimationFrame(drawVisualizer);

    transcriptInterval = setInterval(async () => {
      const [{ transcript }, response] = await Promise.all([
        chrome.storage.local.get('transcript'),
        sendBg('getTranscriptionSession')
      ]);

      liveSessionState = response && response.ok ? response.transcriptSession : null;
      updateProviderLiveChip({ status: 'recording' });

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
  }

  updateProviderLiveChip(state);

  const existing = document.querySelector('.cursor-blink');
  if (state.status === 'recording') {
    if (!existing) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor-blink';
      transcriptText.after(cursor);
    }
  } else if (existing) {
    existing.remove();
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
  const newFinal = finalText.slice(lastTranscriptLength);
  if (newFinal) {
    appendStreamText(newFinal);
    lastTranscriptLength = finalText.length;
  }

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
  const interim = transcriptText.querySelector('.interim');
  if (interim) interim.remove();

  let i = 0;
  const interval = setInterval(() => {
    if (i >= text.length) {
      clearInterval(interval);
      if (interim) transcriptText.appendChild(interim);
      return;
    }
    transcriptText.insertAdjacentText('beforeend', text[i]);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    i += 1;
  }, 20);
}

function clearTranscriptUI() {
  transcriptText.textContent = '';
  placeholder.style.display = 'flex';
  btnCopy.disabled = true;
  lastTranscriptLength = 0;
}

// ── Provider settings UI ──
const btnSettings = document.getElementById('btnSettings');
const settingsPanel = document.getElementById('settingsPanel');
const langSelect = document.getElementById('langSelect');
const defaultProviderSelect = document.getElementById('defaultProviderSelect');
const providerCards = document.getElementById('providerCards');
const providerLiveChip = document.getElementById('providerLiveChip');
const sessionMeta = document.getElementById('sessionMeta');
const btnSaveProviders = document.getElementById('btnSaveProviders');
const providerSettingsSaved = document.getElementById('providerSettingsSaved');
const providerSettingsHint = document.getElementById('providerSettingsHint');

function renderDefaultProviderOptions() {
  defaultProviderSelect.innerHTML = '';
  Object.keys(PROVIDER_NAMES).forEach((providerId) => {
    const option = document.createElement('option');
    option.value = providerId;
    option.textContent = getProviderLabel(providerId);
    defaultProviderSelect.appendChild(option);
  });
  defaultProviderSelect.value = providerSettingsState.defaultProvider;
}

function renderProviderCards() {
  providerCards.innerHTML = '';
  const catalog = providerCatalog.length ? providerCatalog : Object.keys(PROVIDER_NAMES).map((id) => ({ id, label: getProviderLabel(id) }));

  catalog.forEach((provider) => {
    const providerId = provider.id;
    const providerLabel = provider.label || getProviderLabel(providerId);
    const config = providerSettingsState.providers[providerId] || {};
    const status = getProviderConfigStatus(providerId, providerSettingsState);
    const fields = PROVIDER_FIELDS[providerId] || [];

    const badges = [
      `<span class="provider-badge ${status.ready ? 'ready' : 'warning'}">${status.ready ? 'Listo' : 'Incompleto'}</span>`
    ];
    if (providerSettingsState.defaultProvider === providerId) badges.push('<span class="provider-badge">Default</span>');
    if (!status.enabled) badges.push('<span class="provider-badge muted">Deshabilitado</span>');
    if (providerId === 'whisperLocal') badges.push('<span class="provider-badge muted">Bridge local</span>');

    const fieldsHtml = fields.map((field) => {
      const value = config[field.key] ?? '';
      const hint = /key|token|secret/i.test(field.key)
        ? 'Se guarda en storage local y solo se muestra en este formulario.'
        : '';
      return `
        <label class="provider-field ${field.full ? 'full' : ''}">
          <span class="provider-field-label">${escapeHtml(field.label)}</span>
          <input
            class="settings-input provider-config-input"
            data-provider-id="${escapeHtml(providerId)}"
            data-field-key="${escapeHtml(field.key)}"
            type="${escapeHtml(field.type)}"
            placeholder="${escapeHtml(field.placeholder || '')}"
            value="${escapeHtml(String(value))}"
            autocomplete="off"
          />
          ${hint ? `<span class="provider-field-hint">${escapeHtml(hint)}</span>` : ''}
        </label>
      `;
    }).join('');

    const helpText = status.missing.length
      ? `Falta configurar: ${status.missing.join(', ')}.`
      : (PROVIDER_DOC_LINKS[providerId]
        ? `Configuración mínima completa. <a href="${PROVIDER_DOC_LINKS[providerId]}" target="_blank">Ver credenciales</a>`
        : 'Configuración mínima completa.');

    const card = document.createElement('div');
    card.className = `provider-card ${status.enabled ? '' : 'disabled'}`.trim();
    card.innerHTML = `
      <div class="provider-card-header">
        <div class="provider-card-title-wrap">
          <div class="provider-card-title">${escapeHtml(providerLabel)}</div>
          <div class="provider-card-description">${escapeHtml(PROVIDER_DESCRIPTIONS[providerId] || '')}</div>
        </div>
        <label class="provider-card-toggle">
          <input type="checkbox" class="provider-enabled-toggle" data-provider-id="${escapeHtml(providerId)}" ${status.enabled ? 'checked' : ''} />
          Activo
        </label>
      </div>
      <div class="provider-card-status">${badges.join('')}</div>
      <div class="provider-field-grid">${fieldsHtml}</div>
      <div class="settings-hint">${helpText}</div>
    `;
    providerCards.appendChild(card);
  });
}

function renderProviderSettingsUI() {
  renderDefaultProviderOptions();
  renderProviderCards();

  const defaultStatus = getProviderConfigStatus(providerSettingsState.defaultProvider, providerSettingsState);
  providerSettingsHint.textContent = defaultStatus.ready
    ? `El default global actual es ${getProviderLabel(providerSettingsState.defaultProvider)}.`
    : `Ojo: ${getProviderLabel(providerSettingsState.defaultProvider)} está como default pero todavía no está listo. Si grabás así, Pochoclo lo va a saltar y usar fallback.`;
}

function applyProviderSettingsPayload(payload) {
  providerCatalog = Array.isArray(payload && payload.providers) ? payload.providers : [];
  providerSettingsState = normalizeProviderSettingsShape(payload && payload.providerSettings);
  renderProviderSettingsUI();
}

async function loadProviderSettings() {
  const response = await sendBg('getProviderSettings');
  if (response && response.ok) {
    applyProviderSettingsPayload(response);
  } else {
    providerSettingsState = buildEmptyProviderSettings();
    renderProviderSettingsUI();
  }
}

function updateProviderDraftField(providerId, fieldKey, value) {
  if (!providerId || !fieldKey) return;
  if (!providerSettingsState.providers[providerId]) {
    providerSettingsState.providers[providerId] = {};
  }
  providerSettingsState.providers[providerId][fieldKey] = value;
}

async function saveProviderSettingsFromUI() {
  const nextSettings = sanitizeProviderSettingsDraft(providerSettingsState);
  const response = await sendBg('saveProviderSettings', { providerSettings: nextSettings });
  if (!response || !response.ok) {
    showToast((response && response.error) || 'No se pudo guardar la configuración');
    return false;
  }

  applyProviderSettingsPayload(response);
  providerSettingsSaved.classList.add('show');
  setTimeout(() => providerSettingsSaved.classList.remove('show'), 2000);
  showToast('Configuración guardada');
  return true;
}

// ── Init ──
async function init() {
  const [state] = await Promise.all([
    sendBg('getState'),
    loadProviderSettings(),
    refreshTranscriptSession()
  ]);

  applyUI(state || { status: 'idle' });

  const { transcript } = await chrome.storage.local.get('transcript');
  if (transcript && (transcript.final || transcript.interim)) {
    placeholder.style.display = 'none';
    transcriptText.textContent = transcript.final || '';
    lastTranscriptLength = (transcript.final || '').length;
    if (transcript.final || transcript.interim) btnCopy.disabled = false;
  }

  const { audioLanguage } = await chrome.storage.local.get('audioLanguage');
  if (audioLanguage) {
    langSelect.value = audioLanguage;
  }
}

init();

// ── Button handlers ──
btnRecord.addEventListener('click', async () => {
  const state = await sendBg('getState');

  if (state.status === 'idle') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      timerLabel.textContent = 'Error: No hay pestaña activa';
      return;
    }

    const resp = await sendBg('startCapture', {
      tabId: tab.id,
      tabTitle: tab.title,
      tabUrl: tab.url
    });

    if (!resp || !resp.ok) {
      timerLabel.textContent = 'Error: ' + (resp?.error || 'desconocido');
      return;
    }

    clearTranscriptUI();
    await refreshTranscriptSession();
    const newState = await sendBg('getState');
    applyUI(newState);
  } else {
    await sendBg('stopCapture');
    await refreshTranscriptSession();
    const newState = await sendBg('getState');
    applyUI(newState);
    statusBadge.textContent = 'Finalizado';
    timerLabel.textContent = 'Grabación finalizada';
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
  await refreshTranscriptSession();
  const newState = await sendBg('getState');
  applyUI(newState);
});

btnReset.addEventListener('click', async () => {
  await sendBg('resetCapture');
  liveSessionState = null;
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
btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
});

langSelect.addEventListener('change', () => {
  chrome.storage.local.set({ audioLanguage: langSelect.value });
});

defaultProviderSelect.addEventListener('change', () => {
  providerSettingsState.defaultProvider = defaultProviderSelect.value;
  renderProviderSettingsUI();
  updateProviderLiveChip({ status: 'idle' });
});

providerCards.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.classList.contains('provider-config-input')) return;
  updateProviderDraftField(target.dataset.providerId, target.dataset.fieldKey, target.value);
});

providerCards.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  if (target.classList.contains('provider-enabled-toggle')) {
    const providerId = target.dataset.providerId;
    if (!providerSettingsState.providers[providerId]) {
      providerSettingsState.providers[providerId] = {};
    }
    providerSettingsState.providers[providerId].enabled = target.checked;
    renderProviderSettingsUI();
    updateProviderLiveChip({ status: 'idle' });
    return;
  }

  if (target.classList.contains('provider-config-input')) {
    updateProviderDraftField(target.dataset.providerId, target.dataset.fieldKey, target.value);
  }
});

btnSaveProviders.addEventListener('click', async () => {
  btnSaveProviders.disabled = true;
  try {
    providerSettingsState = sanitizeProviderSettingsDraft(providerSettingsState);
    const saved = await saveProviderSettingsFromUI();
    if (saved) {
      updateProviderLiveChip({ status: 'idle' });
    }
  } finally {
    btnSaveProviders.disabled = false;
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

  list.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const preview = getHistoryPreview(item);
    const langName = LANG_NAMES[item.language] || item.language;
    const providerContext = getProviderContextBadge(item);
    const metaParts = [
      formatDate(item.date),
      '<span class="dot"></span>',
      formatDuration(item.duration),
      '<span class="dot"></span>',
      escapeHtml(langName)
    ];

    if (providerContext) {
      metaParts.push('<span class="dot"></span>');
      metaParts.push(`<span class="history-provider-pill ${escapeHtml(providerContext.tone)}">${escapeHtml(providerContext.text)}</span>`);
    }

    el.innerHTML = `
      <div class="history-item-title">${escapeHtml(item.title)}</div>
      <div class="history-item-meta">
        ${metaParts.join('\n        ')}
      </div>
      <div class="history-item-preview">${escapeHtml(preview)}</div>
    `;

    el.addEventListener('click', () => openDetail(item));
    historyList.appendChild(el);
  });
}

// ── Detail view ──
function openDetail(item) {
  setCurrentDetailItem(item);
  setDetailSummaryRequest({ id: item.id, status: 'idle', error: null });
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
  try {
    hostname = new URL(item.url).hostname;
  } catch {}

  detailUrl.textContent = hostname;
  detailUrl.style.display = hostname ? 'block' : 'none';
  detailText.textContent = item.text || 'La transcripción no generó texto final.';
  renderDetailSummary(currentDetailItem);
  renderAuditDetail(item);
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

btnDetailSummarize.addEventListener('click', async () => {
  if (!currentDetailItem || !hasText(currentDetailItem.id)) return;
  if (detailSummaryRequest.id === currentDetailItem.id && detailSummaryRequest.status === 'loading') return;

  const transcriptionId = currentDetailItem.id;
  setDetailSummaryRequest({ id: transcriptionId, status: 'loading', error: null });
  renderDetailSummary(currentDetailItem);

  try {
    const response = await sendBg('summarizeTranscription', { id: transcriptionId });

    if (response && response.ok && response.transcription) {
      if (currentDetailId === transcriptionId) {
        setCurrentDetailItem(response.transcription);
        setDetailSummaryRequest({ id: transcriptionId, status: 'idle', error: null });
        renderDetailSummary(currentDetailItem);
        renderAuditDetail(currentDetailItem);
        showToast('Resumen listo');
      }
      return;
    }

    const shouldRefresh = !!(
      response
      && (response.retryable || response.code === 'summary_in_progress')
    );

    const refreshed = shouldRefresh ? await getTranscriptionById(transcriptionId) : null;

    if (currentDetailId !== transcriptionId) {
      setDetailSummaryRequest({ id: transcriptionId, status: 'idle', error: null });
      return;
    }

    if (refreshed) {
      setCurrentDetailItem(refreshed);
      setDetailSummaryRequest({
        id: transcriptionId,
        status: response && response.code === 'summary_in_progress' ? 'loading' : 'idle',
        error: null
      });
      renderDetailSummary(currentDetailItem);
      renderAuditDetail(currentDetailItem);
      if (response && response.code === 'summary_in_progress') {
        showToast('Ya hay un resumen en progreso');
      }
      return;
    }

    setDetailSummaryRequest({
      id: transcriptionId,
      status: 'idle',
      error: {
        message: (response && response.error) || 'No se pudo generar el resumen.',
        code: response && response.code ? response.code : 'provider_error',
        retryable: !!(response && response.retryable)
      }
    });
    renderDetailSummary(currentDetailItem);
  } catch (error) {
    if (currentDetailId !== transcriptionId) {
      setDetailSummaryRequest({ id: transcriptionId, status: 'idle', error: null });
      return;
    }

    setDetailSummaryRequest({
      id: transcriptionId,
      status: 'idle',
      error: {
        message: hasText(error && error.message) ? error.message : 'No se pudo generar el resumen.',
        code: error && error.code ? error.code : 'provider_error',
        retryable: false
      }
    });
    renderDetailSummary(currentDetailItem);
  }
});

btnDetailDelete.addEventListener('click', async () => {
  if (!currentDetailId) return;
  if (!confirm('¿Eliminar esta transcripción?')) return;
  await sendBg('deleteTranscription', { id: currentDetailId });
  setCurrentDetailItem(null);
  setDetailSummaryRequest({ id: null, status: 'idle', error: null });
  showView('history');
  loadHistory();
  showToast('Transcripción eliminada');
});
