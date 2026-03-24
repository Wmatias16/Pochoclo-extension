// background.js — Service worker orchestrator
// Manages state, offscreen document lifecycle, tab capture, and provider session setup.

if (typeof importScripts === 'function') {
  importScripts(
    'diagnostics/provider-logger.js',
    'runtime/provider-session-runtime.js',
    'runtime/recording-awareness.js',
    'runtime/offscreen-bridge.js',
    'providers/errors.js',
    'providers/registry.js',
    'storage/transcriptions.js',
    'providers/adapters/shared.js',
    'providers/adapters/openai.js',
    'runtime/transcription-summarizer.js',
    'providers/adapters/deepgram.js',
    'providers/adapters/assemblyai.js',
    'providers/adapters/groq.js',
    'providers/adapters/google.js',
    'providers/adapters/whisper-local.js',
    'storage/settings.js'
  );
}

const providerErrors = globalThis.PochoclaProviderErrors;
const providerDiagnostics = globalThis.PochoclaProviderDiagnostics;
const providerRegistry = globalThis.PochoclaProviderRegistry;
const offscreenBridge = globalThis.PochoclaOffscreenBridge;
const providerSettingsStore = globalThis.PochoclaProviderSettings;
const transcriptionStore = globalThis.PochoclaTranscriptionStorage;
const providerSessionRuntime = globalThis.PochoclaProviderSessionRuntime;
const recordingAwarenessRuntime = globalThis.PochoclaRecordingAwareness
  || (typeof module === 'object' && module.exports
    ? require('./runtime/recording-awareness.js')
    : {});
const transcriptionSummarizer = globalThis.PochoclaTranscriptionSummarizer;
const providerAdapters = {
  openai: globalThis.PochoclaOpenAIAdapter,
  deepgram: globalThis.PochoclaDeepgramAdapter,
  assemblyai: globalThis.PochoclaAssemblyAIAdapter,
  groq: globalThis.PochoclaGroqAdapter,
  google: globalThis.PochoclaGoogleAdapter,
  whisperLocal: globalThis.PochoclaWhisperLocalAdapter
};
const providerLogger = providerDiagnostics && typeof providerDiagnostics.createDiagnosticsLogger === 'function'
  ? providerDiagnostics.createDiagnosticsLogger({ namespace: 'providers', sink: console })
  : console;

function createScopedLogger(context) {
  if (providerLogger && typeof providerLogger.child === 'function') {
    return providerLogger.child(context || {});
  }

  return providerLogger;
}

// ── State stored in chrome.storage.local ──
// { status: 'idle'|'recording'|'paused', startTime, pausedAt, pausedDuration }

// ── Serialized transcript writes (prevents race conditions) ──
let saveChain = Promise.resolve();
let processChunkChain = Promise.resolve();
const activeSummaryJobs = new Map();

const SUMMARY_JOB_STORAGE_KEY = 'summaryJobs';
const TRANSCRIPTION_PROGRESS_STORAGE_KEY = 'transcriptionProgress';
const SUMMARY_JOB_TTL_MS = 2 * 60 * 1000;

const DEFAULT_TRANSCRIPTION_CHUNK_MS = 7000;
const OPENAI_LIVE_TRANSCRIPTION_CHUNK_MS = 3000;

const PRODUCT_NAME = 'Pochoclo - Transcriptor';
/**
 * Recording-awareness defaults used when persisted state is missing fields.
 * - reminderIntervalMin: native reminder cadence (2 min by default)
 * - inactivityMs: auto-stop window without significant audio (60s by default)
 * - amplitudeThreshold: V1 amplitude proxy persisted for parity with runtime helpers
 * - indicatorVisible / activeNotificationId: transient UI cleanup flags reset on pause/stop/reset
 */
const RECORDING_AWARENESS_DEFAULTS = recordingAwarenessRuntime.DEFAULT_RECORDING_AWARENESS || Object.freeze({
  sessionId: null,
  reminderIntervalMin: 2,
  inactivityMs: 60 * 1000,
  amplitudeThreshold: 0.05,
  lastAudioAt: 0,
  indicatorVisible: false,
  activeNotificationId: null
});
const IDLE_ACTION_ICON_PATH = recordingAwarenessRuntime.IDLE_ACTION_ICON_PATH || 'icons/logo.png';
const TRANSPARENT_BADGE_BACKGROUND_COLOR = recordingAwarenessRuntime.TRANSPARENT_BADGE_BACKGROUND_COLOR || Object.freeze([0, 0, 0, 0]);
// Reminder notifications expose a single primary action: stop the active capture session.
const REMINDER_NOTIFICATION_BUTTON_INDEX = 0;

function isRecordingAwarenessAlarm(name) {
  return typeof name === 'string'
    && (name.startsWith('recording-reminder:') || name.startsWith('recording-inactive:'));
}

function isRecordingAwarenessNotification(id) {
  return typeof id === 'string'
    && (id.startsWith('recording-reminder:') || id.startsWith('recording-autostop:'));
}

function buildReminderNotificationId(sessionId) {
  return `recording-reminder:${sessionId || 'unknown'}`;
}

function buildAutoStopNotificationId(sessionId) {
  return `recording-autostop:${sessionId || 'unknown'}`;
}

function buildRecordingAwarenessDefaults(overrides = {}) {
  if (typeof recordingAwarenessRuntime.buildRecordingAwarenessDefaults === 'function') {
    return recordingAwarenessRuntime.buildRecordingAwarenessDefaults(overrides);
  }

  return {
    ...RECORDING_AWARENESS_DEFAULTS,
    ...(overrides && typeof overrides === 'object' ? overrides : {})
  };
}

function normalizeRecordingState(state = {}) {
  if (typeof recordingAwarenessRuntime.normalizeRecordingState === 'function') {
    return recordingAwarenessRuntime.normalizeRecordingState(state);
  }

  return {
    status: typeof state.status === 'string' ? state.status : 'idle',
    startTime: Number.isFinite(Number(state.startTime)) ? Number(state.startTime) : 0,
    pausedAt: Number.isFinite(Number(state.pausedAt)) ? Number(state.pausedAt) : 0,
    pausedDuration: Number.isFinite(Number(state.pausedDuration)) ? Number(state.pausedDuration) : 0,
    tabId: Number.isInteger(state.tabId) ? state.tabId : null,
    tabTitle: typeof state.tabTitle === 'string' ? state.tabTitle : '',
    tabUrl: typeof state.tabUrl === 'string' ? state.tabUrl : '',
    awareness: buildRecordingAwarenessDefaults(state.awareness)
  };
}

function buildRecordingReminderAlarmName(sessionId) {
  if (typeof recordingAwarenessRuntime.buildRecordingReminderAlarmName === 'function') {
    return recordingAwarenessRuntime.buildRecordingReminderAlarmName(sessionId);
  }

  return `recording-reminder:${sessionId || 'unknown'}`;
}

function buildRecordingInactivityAlarmName(sessionId) {
  if (typeof recordingAwarenessRuntime.buildRecordingInactivityAlarmName === 'function') {
    return recordingAwarenessRuntime.buildRecordingInactivityAlarmName(sessionId);
  }

  return `recording-inactive:${sessionId || 'unknown'}`;
}

function parseRecordingAwarenessAlarmName(name) {
  if (typeof recordingAwarenessRuntime.parseAlarmKey === 'function') {
    return recordingAwarenessRuntime.parseAlarmKey(name);
  }

  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }

  const separatorIndex = name.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }

  const rawType = name.slice(0, separatorIndex);
  const sessionId = name.slice(separatorIndex + 1) || null;
  return {
    rawType,
    type: rawType === 'recording-reminder'
      ? 'reminder'
      : (rawType === 'recording-inactive' ? 'inactive' : rawType),
    sessionId
  };
}

function buildRecordingToolbarPresentation(state) {
  if (typeof recordingAwarenessRuntime.buildToolbarPresentation === 'function') {
    return recordingAwarenessRuntime.buildToolbarPresentation(state, {
      productName: PRODUCT_NAME,
    });
  }

  return {
    badgeText: state && state.status === 'recording' ? 'REC' : '',
    badgeBackgroundColor: state && state.status === 'recording' ? '#dc2626' : TRANSPARENT_BADGE_BACKGROUND_COLOR,
    title: state && state.status === 'recording' ? `${PRODUCT_NAME} • Grabando` : PRODUCT_NAME,
    isRecording: !!(state && state.status === 'recording')
  };
}

function calculateRecordingInactivityDeadline(state, now = Date.now()) {
  if (typeof recordingAwarenessRuntime.calculateInactivityDeadline === 'function') {
    return recordingAwarenessRuntime.calculateInactivityDeadline(state, now);
  }

  const normalizedState = normalizeRecordingState(state);
  if (normalizedState.status !== 'recording') {
    return null;
  }

  const baseTimestamp = normalizedState.awareness.lastAudioAt > 0
    ? normalizedState.awareness.lastAudioAt
    : normalizedState.startTime;
  return baseTimestamp + normalizedState.awareness.inactivityMs;
}

const HALLUCINATIONS = [
  'subtítulos realizados por la comunidad de amara.org',
  'subtitulos realizados por la comunidad de amara.org',
  'amara.org',
  'subtítulos realizados por',
  'subtitulado por',
  'subtítulos por',
  'gracias por ver',
  'thanks for watching',
  'thank you for watching',
  'suscríbete',
  'subscribe',
  '¡suscribete al canal!',
  '¡suscríbete al canal!',
  'you',
  '...',
  'moscatalworking'
];

function saveTranscriptQueued(text) {
  saveChain = saveChain.then(() => new Promise((resolve) => {
    chrome.storage.local.get('transcript', ({ transcript }) => {
      const current = transcript || { final: '', interim: '' };
      current.final = (current.final || '') + text;
      current.interim = '';
      chrome.storage.local.set({ transcript: current }, resolve);
    });
  }));
  return saveChain;
}

function isHallucination(text) {
  const lower = String(text || '').toLowerCase().trim();
  return lower.length < 3 || HALLUCINATIONS.some((entry) => lower.includes(entry));
}

function getProviderAdapter(providerId) {
  return providerAdapters[providerId] || null;
}

function getLiveTranscriptionChunkMs(providerId) {
  return providerId === 'openai'
    ? OPENAI_LIVE_TRANSCRIPTION_CHUNK_MS
    : DEFAULT_TRANSCRIPTION_CHUNK_MS;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildSummaryActionError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = options.status || 500;
  error.retryable = !!options.retryable;
  return error;
}

function normalizeSummaryFailure(error) {
  const errorCode = error && error.code ? error.code : '';
  const retryableCodes = new Set(['summary_in_progress', 'invalid_payload', 'timeout', 'network', 'rate_limit', 'unavailable', 'provider_error']);

  if (
    errorCode === 'missing_api_key'
    || errorCode === 'not_found'
    || errorCode === 'empty_text'
    || errorCode === 'summary_in_progress'
    || errorCode === 'invalid_payload'
    || errorCode === 'timeout'
    || errorCode === 'network'
    || errorCode === 'rate_limit'
    || errorCode === 'unavailable'
    || errorCode === 'auth'
    || errorCode === 'unsupported'
    || errorCode === 'provider_error'
  ) {
    return {
      ok: false,
      error: hasText(error && error.message) ? error.message : 'No se pudo generar el resumen.',
      code: errorCode || 'provider_error',
      retryable: typeof (error && error.retryable) === 'boolean'
        ? !!error.retryable
        : retryableCodes.has(errorCode || 'provider_error'),
      status: Number.isFinite(Number(error && error.status)) ? Number(error.status) : 500
    };
  }

  if (providerErrors && typeof providerErrors.normalizeProviderError === 'function') {
    const normalized = providerErrors.normalizeProviderError(error, { providerId: 'openai' });
    return {
      ok: false,
      error: normalized.summary || 'No se pudo generar el resumen.',
      code: normalized.code || 'provider_error',
      retryable: !!normalized.retryable,
      status: Number.isFinite(Number(normalized.status)) ? Number(normalized.status) : 500
    };
  }

  return {
    ok: false,
    error: hasText(error && error.message) ? error.message : 'No se pudo generar el resumen.',
    code: 'provider_error',
    retryable: false,
    status: 500
  };
}

function normalizeSummaryResultError(error) {
  const normalized = normalizeSummaryFailure(error);
  return {
    ok: normalized.ok,
    error: normalized.error,
    code: normalized.code,
    retryable: normalized.retryable
  };
}

function buildReadySummaryPayload(summaryResult) {
  return {
    version: 1,
    status: 'ready',
    short: summaryResult.short,
    keyPoints: Array.isArray(summaryResult.keyPoints) ? summaryResult.keyPoints.slice() : [],
    model: summaryResult.model || null,
    updatedAt: Date.now(),
    sourceTextHash: summaryResult.sourceTextHash,
    error: null
  };
}

function getSummaryModelForPersistence(model) {
  if (hasText(model)) {
    return model.trim();
  }

  if (transcriptionSummarizer && hasText(transcriptionSummarizer.DEFAULT_SUMMARY_MODEL)) {
    return transcriptionSummarizer.DEFAULT_SUMMARY_MODEL.trim();
  }

  return 'gpt-4o-mini';
}

async function buildErrorSummaryPayload(context, error) {
  const normalizedError = normalizeSummaryFailure(error);
  const sourceTextHash = transcriptionSummarizer && typeof transcriptionSummarizer.sourceTextHash === 'function'
    ? await transcriptionSummarizer.sourceTextHash(context.text)
    : null;

  return {
    version: 1,
    status: 'error',
    short: '',
    keyPoints: [],
    model: getSummaryModelForPersistence(context && context.model),
    updatedAt: Date.now(),
    sourceTextHash,
    error: {
      code: normalizedError.code,
      message: normalizedError.error
    }
  };
}

function buildSummaryJob(transcriptionId) {
  return {
    transcriptionId,
    requestId: `summary_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Date.now()
  };
}

async function readSummaryJobs() {
  const stored = await chrome.storage.local.get(SUMMARY_JOB_STORAGE_KEY);
  const jobs = stored && stored[SUMMARY_JOB_STORAGE_KEY] && typeof stored[SUMMARY_JOB_STORAGE_KEY] === 'object'
    ? stored[SUMMARY_JOB_STORAGE_KEY]
    : {};

  return { ...jobs };
}

function isStaleSummaryJob(job, now = Date.now()) {
  if (!job || typeof job !== 'object') {
    return true;
  }

  const startedAt = Number(job.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return true;
  }

  return (now - startedAt) > SUMMARY_JOB_TTL_MS;
}

async function writeSummaryJobs(jobs) {
  await chrome.storage.local.set({ [SUMMARY_JOB_STORAGE_KEY]: jobs });
}

async function setPersistedSummaryJob(job) {
  const jobs = await readSummaryJobs();
  jobs[job.transcriptionId] = {
    requestId: job.requestId,
    startedAt: job.startedAt
  };
  await writeSummaryJobs(jobs);
}

async function clearPersistedSummaryJob(transcriptionId, requestId) {
  const jobs = await readSummaryJobs();
  const storedJob = jobs[transcriptionId];

  if (!storedJob) {
    return;
  }

  if (requestId && storedJob.requestId && storedJob.requestId !== requestId) {
    return;
  }

  delete jobs[transcriptionId];
  await writeSummaryJobs(jobs);
}

async function getActiveSummaryJob(transcriptionId, options = {}) {
  if (!hasText(transcriptionId)) {
    return null;
  }

  const jobs = await readSummaryJobs();
  const job = jobs[transcriptionId];

  if (!job) {
    return null;
  }

  if (isStaleSummaryJob(job)) {
    if (options.clearStale !== false) {
      delete jobs[transcriptionId];
      await writeSummaryJobs(jobs);
      const summaryLogger = createScopedLogger({ scope: 'summary.generate', transcriptionId });
      if (typeof summaryLogger.info === 'function') {
        summaryLogger.info('summary.job-stale-cleared', { transcriptionId });
      }
    }

    return null;
  }

  return {
    transcriptionId,
    requestId: job.requestId || null,
    startedAt: Number(job.startedAt)
  };
}

async function buildSummaryMeta(entry) {
  const activeJob = await getActiveSummaryJob(entry && entry.id, { clearStale: true });
  let isStale = false;
  const summaryUpdatedAt = Number(entry && entry.summary && entry.summary.updatedAt);
  const jobStillLoading = !!(
    activeJob
    && (!Number.isFinite(summaryUpdatedAt) || summaryUpdatedAt < activeJob.startedAt)
  );

  if (
    entry
    && entry.summary
    && hasText(entry.summary.sourceTextHash)
    && hasText(entry.text)
    && transcriptionSummarizer
    && typeof transcriptionSummarizer.sourceTextHash === 'function'
  ) {
    try {
      const currentSourceTextHash = await transcriptionSummarizer.sourceTextHash(entry.text);
      isStale = currentSourceTextHash !== entry.summary.sourceTextHash;
    } catch (error) {
      isStale = false;
    }
  }

  return {
    isLoading: jobStillLoading,
    isStale,
    activeRequestStartedAt: activeJob ? activeJob.startedAt : null
  };
}

async function enrichTranscriptionForSummary(entry) {
  const normalizedEntry = transcriptionStore && typeof transcriptionStore.normalizeSavedTranscription === 'function'
    ? transcriptionStore.normalizeSavedTranscription(entry)
    : entry;

  return {
    ...normalizedEntry,
    summaryMeta: await buildSummaryMeta(normalizedEntry)
  };
}

async function persistSummaryPayload(transcriptionId, summaryPayload) {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  const list = Array.isArray(savedTranscriptions) ? savedTranscriptions.slice() : [];
  const index = list.findIndex((entry) => entry && entry.id === transcriptionId);

  if (index === -1) {
    throw buildSummaryActionError('not_found', 'No encontramos la transcripción para resumir.', {
      status: 404,
      retryable: false
    });
  }

  const nextEntry = {
    ...list[index],
    summary: summaryPayload
  };

  list[index] = transcriptionStore && typeof transcriptionStore.normalizeSavedTranscription === 'function'
    ? transcriptionStore.normalizeSavedTranscription(nextEntry)
    : nextEntry;

  await chrome.storage.local.set({ savedTranscriptions: list });

  return enrichTranscriptionForSummary(list[index]);
}

function getOpenAiSummarySettings(providerSettings = {}) {
  return providerSettings && providerSettings.providers && providerSettings.providers.openai
    ? providerSettings.providers.openai
    : {};
}

async function loadSummaryRequestContext(id) {
  const normalizedId = hasText(id) ? id.trim() : '';
  const transcriptions = await getTranscriptions();
  const transcription = transcriptions.find((entry) => entry && entry.id === normalizedId);

  if (!transcription) {
    throw buildSummaryActionError('not_found', 'No encontramos la transcripción para resumir.', {
      status: 404,
      retryable: false
    });
  }

  const text = hasText(transcription.text) ? transcription.text.trim() : '';
  if (!text) {
    throw buildSummaryActionError('empty_text', 'La transcripción no tiene texto para resumir.', {
      status: 422,
      retryable: false
    });
  }

  const providerSettings = await readProviderSettings();
  const openaiSettings = getOpenAiSummarySettings(providerSettings);
  const apiKey = hasText(openaiSettings.apiKey) ? openaiSettings.apiKey.trim() : '';

  if (!apiKey) {
    throw buildSummaryActionError('missing_api_key', 'Falta la API key de OpenAI para generar el resumen.', {
      status: 422,
      retryable: false
    });
  }

  return {
    transcription,
    text,
    apiKey,
    model: hasText(openaiSettings.summaryModel) ? openaiSettings.summaryModel.trim() : undefined
  };
}

async function executeSummaryRequest(context) {
  const summaryLogger = createScopedLogger({
    scope: 'summary.generate',
    transcriptionId: context && context.transcription ? context.transcription.id : null
  });

  if (!transcriptionSummarizer || typeof transcriptionSummarizer.summarizeTranscription !== 'function') {
    throw buildSummaryActionError('provider_error', 'No se pudo inicializar el runtime de resumen.', {
      status: 500,
      retryable: false
    });
  }

  const summarizeText = providerAdapters.openai && typeof providerAdapters.openai.summarizeText === 'function'
    ? providerAdapters.openai.summarizeText.bind(providerAdapters.openai)
    : undefined;

  const strategy = transcriptionSummarizer && typeof transcriptionSummarizer.selectSummaryStrategy === 'function'
    ? transcriptionSummarizer.selectSummaryStrategy(context.text)
    : 'single-pass';

  if (typeof summaryLogger.info === 'function') {
    summaryLogger.info('summary.started', {
      transcriptionId: context.transcription.id,
      textLength: context.text.length,
      strategy,
      hasPersistedSummary: !!(context.transcription && context.transcription.summary)
    });
  }

  const summaryResult = await transcriptionSummarizer.summarizeTranscription({
    text: context.text,
    apiKey: context.apiKey,
    model: context.model
  }, {
    fetchImpl: fetch.bind(globalThis),
    summarizeText,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout
  });

  if (typeof summaryLogger.info === 'function') {
    summaryLogger.info('summary.completed', {
      transcriptionId: context.transcription.id,
      model: summaryResult.model,
      keyPoints: summaryResult.keyPoints.length
    });
  }

  const persistedTranscription = await persistSummaryPayload(
    context.transcription.id,
    buildReadySummaryPayload(summaryResult)
  );

  return {
    ok: true,
    transcription: persistedTranscription
  };
}

async function handleSummarizeTranscription(id) {
  const transcriptionId = hasText(id) ? id.trim() : '';

  if (activeSummaryJobs.has(transcriptionId)) {
    throw buildSummaryActionError('summary_in_progress', 'Ya hay un resumen en progreso para esta transcripción.', {
      status: 409,
      retryable: true
    });
  }

  const summaryJob = buildSummaryJob(transcriptionId);

  const job = Promise.resolve()
    .then(async () => {
      const persistedJob = await getActiveSummaryJob(transcriptionId, { clearStale: true });
      if (persistedJob) {
        throw buildSummaryActionError('summary_in_progress', 'Ya hay un resumen en progreso para esta transcripción.', {
          status: 409,
          retryable: true
        });
      }
    })
    .then(() => setPersistedSummaryJob(summaryJob))
    .then(() => loadSummaryRequestContext(transcriptionId))
    .then((context) => executeSummaryRequest(context))
    .catch(async (error) => {
      const summaryLogger = createScopedLogger({ scope: 'summary.generate', transcriptionId });
      const normalizedError = normalizeSummaryFailure(error);
      if (typeof summaryLogger.warn === 'function') {
        summaryLogger.warn('summary.failed', {
          transcriptionId,
          code: normalizedError.code,
          retryable: normalizedError.retryable,
          status: normalizedError.status
        });
      }

      if (normalizedError.code !== 'missing_api_key' && normalizedError.code !== 'not_found' && normalizedError.code !== 'empty_text') {
        try {
          const context = await loadSummaryRequestContext(transcriptionId);
          const summaryPayload = await buildErrorSummaryPayload(context, error);
          await persistSummaryPayload(transcriptionId, summaryPayload);
        } catch (persistError) {
          if (typeof summaryLogger.warn === 'function') {
            summaryLogger.warn('summary.persist-failed', {
              transcriptionId,
              code: persistError && persistError.code ? persistError.code : 'provider_error'
            });
          }
        }
      }

      throw error;
    })
    .finally(() => {
      if (activeSummaryJobs.get(transcriptionId) === job) {
        activeSummaryJobs.delete(transcriptionId);
      }

      return clearPersistedSummaryJob(transcriptionId, summaryJob.requestId);
    });

  activeSummaryJobs.set(transcriptionId, job);
  return job;
}

function hydrateProcessChunkMessage(message = {}) {
  const blob = message.blob && typeof message.blob.arrayBuffer === 'function'
    ? message.blob
    : (offscreenBridge && typeof offscreenBridge.deserializeChunkBlob === 'function' && message.audio
      ? offscreenBridge.deserializeChunkBlob(message.audio)
      : null);

  if (!blob || typeof blob.arrayBuffer !== 'function') {
    const error = new Error('El audio del chunk no es válido');
    error.code = 'unsupported';
    error.status = 422;
    throw error;
  }

  return {
    ...message,
    blob
  };
}

async function getTranscriptSession() {
  const { transcriptSession } = await chrome.storage.local.get('transcriptSession');
  return transcriptSession || null;
}

async function setTranscriptSession(session) {
  await chrome.storage.local.set({ transcriptSession: session });
  return session;
}

async function patchTranscriptSession(patch) {
  const current = await getTranscriptSession();
  const next = { ...(current || {}), ...patch };
  await chrome.storage.local.set({ transcriptSession: next });
  return next;
}

async function clearTranscriptSession() {
  await chrome.storage.local.remove('transcriptSession');
}

function normalizeTranscriptionProgress(progress = {}) {
  return {
    sessionId: typeof progress.sessionId === 'string' && progress.sessionId.trim().length > 0
      ? progress.sessionId.trim()
      : null,
    totalChunks: Math.max(0, Number.isFinite(Number(progress.totalChunks)) ? Number(progress.totalChunks) : 0),
    completedChunks: Math.max(0, Number.isFinite(Number(progress.completedChunks)) ? Number(progress.completedChunks) : 0),
    status: typeof progress.status === 'string' ? progress.status : 'idle',
    updatedAt: Number.isFinite(Number(progress.updatedAt)) ? Number(progress.updatedAt) : Date.now()
  };
}

async function getTranscriptionProgress() {
  const stored = await chrome.storage.local.get(TRANSCRIPTION_PROGRESS_STORAGE_KEY);
  const progress = stored ? stored[TRANSCRIPTION_PROGRESS_STORAGE_KEY] : null;
  return progress ? normalizeTranscriptionProgress(progress) : null;
}

async function setTranscriptionProgress(progress) {
  const next = normalizeTranscriptionProgress(progress);
  await chrome.storage.local.set({ [TRANSCRIPTION_PROGRESS_STORAGE_KEY]: next });
  return next;
}

async function patchTranscriptionProgress(patchOrUpdater) {
  const current = await getTranscriptionProgress();
  const patch = typeof patchOrUpdater === 'function'
    ? await patchOrUpdater(current)
    : patchOrUpdater;

  if (!patch) {
    return current;
  }

  return setTranscriptionProgress({
    ...(current || {}),
    ...patch,
    updatedAt: Number.isFinite(Number(patch.updatedAt)) ? Number(patch.updatedAt) : Date.now()
  });
}

async function clearTranscriptionProgress() {
  await chrome.storage.local.remove(TRANSCRIPTION_PROGRESS_STORAGE_KEY);
}

async function maybeFinalizeTranscriptionProgress(progressInput) {
  const progress = progressInput ? normalizeTranscriptionProgress(progressInput) : await getTranscriptionProgress();
  if (!progress || !progress.sessionId) {
    return null;
  }

  const state = await getState();
  const isRecordingActive = state.status === 'recording' || state.status === 'paused';
  const isDrained = progress.completedChunks >= progress.totalChunks;

  if (!isRecordingActive && isDrained) {
    await clearTranscriptionProgress();
    return null;
  }

  return progress;
}

async function syncTranscriptionProgress(snapshot = {}) {
  const incoming = normalizeTranscriptionProgress(snapshot);
  const transcriptSession = await getTranscriptSession();
  const current = await getTranscriptionProgress();
  const activeSessionId = transcriptSession && transcriptSession.id ? transcriptSession.id : null;

  if (!incoming.sessionId) {
    return { ok: false, error: 'Falta sessionId para sincronizar el progreso.' };
  }

  if (activeSessionId && incoming.sessionId !== activeSessionId) {
    return { ok: true, ignored: true, reason: 'stale-session' };
  }

  if (!activeSessionId && current && current.sessionId && incoming.sessionId !== current.sessionId) {
    return { ok: true, ignored: true, reason: 'stale-progress' };
  }

  const merged = await setTranscriptionProgress({
    sessionId: incoming.sessionId,
    totalChunks: Math.max(current && current.sessionId === incoming.sessionId ? current.totalChunks : 0, incoming.totalChunks),
    completedChunks: current && current.sessionId === incoming.sessionId ? current.completedChunks : 0,
    status: incoming.status,
    updatedAt: incoming.updatedAt
  });

  const finalized = await maybeFinalizeTranscriptionProgress(merged);
  return { ok: true, progress: finalized };
}

async function readProviderSettings() {
  if (providerSettingsStore && typeof providerSettingsStore.readProviderSettings === 'function') {
    return providerSettingsStore.readProviderSettings(chrome.storage.local, {
      logger: createScopedLogger({ scope: 'provider-settings.read' })
    });
  }

  return {
    defaultProvider: 'openai',
    providers: {
      openai: { enabled: false, apiKey: '' }
    }
  };
}

async function saveProviderSettings(nextSettings) {
  if (providerSettingsStore && typeof providerSettingsStore.saveProviderSettings === 'function') {
    return providerSettingsStore.saveProviderSettings(nextSettings, chrome.storage.local, {
      logger: createScopedLogger({ scope: 'provider-settings.save' })
    });
  }

  await chrome.storage.local.set({ providerSettings: nextSettings });
  return nextSettings;
}

function isExtensionPageUrl(url) {
  return typeof url === 'string' && /^chrome-extension:\/\/[^/]+\//.test(url);
}

function isTrustedExtensionPageSender(sender) {
  return !!(sender && isExtensionPageUrl(sender.url));
}

function maskSecret(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';

  const visibleSuffix = normalized.slice(-4);
  const separatorIndex = Math.max(normalized.indexOf('-'), normalized.indexOf('_'));
  const visiblePrefix = separatorIndex >= 0
    ? normalized.slice(0, separatorIndex + 1)
    : normalized.slice(0, Math.min(4, Math.max(0, normalized.length - 4)));

  return `${visiblePrefix || ''}...${visibleSuffix}`;
}

function redactProviderSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    return settings;
  }

  const cloned = JSON.parse(JSON.stringify(settings));
  const providers = cloned.providers && typeof cloned.providers === 'object'
    ? cloned.providers
    : {};

  Object.keys(providers).forEach((providerId) => {
    const providerConfig = providers[providerId];
    if (!providerConfig || typeof providerConfig !== 'object') {
      return;
    }

    if (typeof providerConfig.apiKey === 'string') {
      providerConfig.apiKey = maskSecret(providerConfig.apiKey);
    }
  });

  return cloned;
}

function restoreRedactedProviderSecrets(nextSettings, currentSettings) {
  if (!nextSettings || typeof nextSettings !== 'object') {
    return nextSettings;
  }

  const merged = JSON.parse(JSON.stringify(nextSettings));
  const nextProviders = merged.providers && typeof merged.providers === 'object'
    ? merged.providers
    : {};
  const currentProviders = currentSettings && currentSettings.providers && typeof currentSettings.providers === 'object'
    ? currentSettings.providers
    : {};

  Object.keys(nextProviders).forEach((providerId) => {
    const nextProvider = nextProviders[providerId];
    const currentProvider = currentProviders[providerId];
    if (!nextProvider || typeof nextProvider !== 'object' || !currentProvider || typeof currentProvider !== 'object') {
      return;
    }

    const currentApiKey = typeof currentProvider.apiKey === 'string' ? currentProvider.apiKey.trim() : '';
    const nextApiKey = typeof nextProvider.apiKey === 'string' ? nextProvider.apiKey.trim() : '';
    if (!currentApiKey || !nextApiKey) {
      return;
    }

    if (nextApiKey === maskSecret(currentApiKey)) {
      nextProvider.apiKey = currentApiKey;
    }
  });

  return merged;
}

function buildUnauthorizedProviderSettingsResponse() {
  return {
    ok: false,
    error: 'Origen no autorizado para acceder a la configuración de providers.'
  };
}

function getProviderLabel(providerId) {
  if (!providerRegistry || typeof providerRegistry.getProviderDefinition !== 'function') {
    return providerId;
  }

  const definition = providerRegistry.getProviderDefinition(providerId);
  return (definition && definition.label) || providerId;
}

async function getState() {
  const { recState } = await chrome.storage.local.get('recState');
  return normalizeRecordingState(recState || {
    status: 'idle',
    startTime: 0,
    pausedAt: 0,
    pausedDuration: 0,
    tabId: null,
    tabTitle: '',
    tabUrl: '',
    awareness: buildRecordingAwarenessDefaults()
  });
}

async function setState(patch) {
  const current = await getState();
  const next = normalizeRecordingState({
    ...current,
    ...patch,
    awareness: buildRecordingAwarenessDefaults({
      ...(current && current.awareness ? current.awareness : {}),
      ...(patch && patch.awareness ? patch.awareness : {})
    })
  });
  await chrome.storage.local.set({ recState: next });
  return next;
}

function formatElapsedRecordingTime(state, now = Date.now()) {
  const normalizedState = normalizeRecordingState(state);
  if (normalizedState.startTime <= 0) {
    return '00:00';
  }

  const referenceNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const pausedPenalty = normalizedState.status === 'paused' && normalizedState.pausedAt > 0
    ? Math.max(0, referenceNow - normalizedState.pausedAt)
    : 0;
  const elapsedMs = Math.max(
    0,
    referenceNow - normalizedState.startTime - normalizedState.pausedDuration - pausedPenalty
  );
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildAwarenessSnapshot(state, now = Date.now(), viewerTabId = null) {
  const normalizedState = normalizeRecordingState(state);
  const isActiveIndicatorTab = Number.isInteger(normalizedState.tabId)
    && normalizedState.tabId !== null
    && (!Number.isInteger(viewerTabId) || viewerTabId === normalizedState.tabId);

  return {
    status: normalizedState.status,
    startTime: normalizedState.startTime,
    pausedAt: normalizedState.pausedAt,
    pausedDuration: normalizedState.pausedDuration,
    tabId: normalizedState.tabId,
    tabTitle: normalizedState.tabTitle,
    tabUrl: normalizedState.tabUrl,
    sessionId: normalizedState.awareness.sessionId,
    indicatorVisible: normalizedState.status === 'recording' && isActiveIndicatorTab,
    elapsedMs: Math.max(0, Number(now) - normalizedState.startTime - normalizedState.pausedDuration),
    elapsedText: formatElapsedRecordingTime(normalizedState, now),
    reminderIntervalMin: normalizedState.awareness.reminderIntervalMin,
    inactivityMs: normalizedState.awareness.inactivityMs,
    lastAudioAt: normalizedState.awareness.lastAudioAt,
    activeNotificationId: normalizedState.awareness.activeNotificationId
  };
}

function buildRecordingIndicatorStateResponse(state, sender = {}, now = Date.now()) {
  const senderTabId = sender && sender.tab && Number.isInteger(sender.tab.id)
    ? sender.tab.id
    : null;

  return {
    ok: true,
    state: buildAwarenessSnapshot(state, now, senderTabId)
  };
}

async function broadcastRecordingState(state) {
  const normalizedState = normalizeRecordingState(state);
  const message = {
    type: 'recording-state-changed',
    state: buildAwarenessSnapshot(normalizedState)
  };

  if (Number.isInteger(normalizedState.tabId) && normalizedState.tabId >= 0 && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
    try {
      await chrome.tabs.sendMessage(normalizedState.tabId, message);
    } catch (error) {
      // Ignore tabs that are gone or not ready for messaging.
    }
  }
}

async function clearNotification(notificationId) {
  if (!notificationId || !chrome.notifications || typeof chrome.notifications.clear !== 'function') {
    return false;
  }

  return chrome.notifications.clear(notificationId);
}

async function clearAwarenessNotifications(state) {
  const normalizedState = normalizeRecordingState(state);
  const ids = new Set();

  if (normalizedState.awareness.activeNotificationId) {
    ids.add(normalizedState.awareness.activeNotificationId);
  }

  if (normalizedState.awareness.sessionId) {
    ids.add(buildReminderNotificationId(normalizedState.awareness.sessionId));
    ids.add(buildAutoStopNotificationId(normalizedState.awareness.sessionId));
  }

  await Promise.all(Array.from(ids).map((id) => clearNotification(id)));
}

async function clearRecordingAwarenessArtifacts(state, options = {}) {
  const normalizedState = normalizeRecordingState(state);
  const sessionId = normalizedState.awareness.sessionId;
  const targetStatus = typeof options.targetStatus === 'string' ? options.targetStatus : 'idle';
  const clearSession = options.clearSession !== false;

  // Unified cleanup path for stop/reset/error and paused-state reconciliation:
  // - always clear reminder + inactivity alarms
  // - always clear outstanding reminder/autostop notifications
  // - always broadcast indicatorVisible:false so the recording tab removes stale UI
  // - optionally keep sessionId when pausing so resume can restore the same awareness session

  if (sessionId && chrome.alarms && typeof chrome.alarms.clear === 'function') {
    await chrome.alarms.clear(buildRecordingReminderAlarmName(sessionId));
    await chrome.alarms.clear(buildRecordingInactivityAlarmName(sessionId));
  }

  await clearAwarenessNotifications(normalizedState);
  await broadcastRecordingState({
    ...normalizedState,
    status: targetStatus,
    tabId: normalizedState.tabId,
    awareness: buildRecordingAwarenessDefaults({
      ...normalizedState.awareness,
      sessionId: clearSession ? null : normalizedState.awareness.sessionId,
      indicatorVisible: false,
      activeNotificationId: null
    })
  });
}

async function createReminderNotification(state, now = Date.now()) {
  const normalizedState = normalizeRecordingState(state);
  const sessionId = normalizedState.awareness.sessionId;

  if (!sessionId || !chrome.notifications || typeof chrome.notifications.create !== 'function') {
    return null;
  }

  const notificationId = buildReminderNotificationId(sessionId);
  const elapsedText = formatElapsedRecordingTime(normalizedState, now);
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: IDLE_ACTION_ICON_PATH,
    title: 'Grabación activa',
    message: `Seguís grabando hace ${elapsedText}.`,
    buttons: [{ title: 'Detener' }],
    requireInteraction: false,
    priority: 1
  });
  return notificationId;
}

async function createAutoStopNotification(state, now = Date.now()) {
  const normalizedState = normalizeRecordingState(state);
  const sessionId = normalizedState.awareness.sessionId;

  if (!sessionId || !chrome.notifications || typeof chrome.notifications.create !== 'function') {
    return null;
  }

  const notificationId = buildAutoStopNotificationId(sessionId);
  const elapsedText = formatElapsedRecordingTime(normalizedState, now);
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: IDLE_ACTION_ICON_PATH,
    title: 'Grabación detenida por inactividad',
    message: `La grabación se detuvo automáticamente tras ${elapsedText} sin actividad significativa.`,
    priority: 2
  });
  return notificationId;
}

async function reconcileRecordingAwareness(stateInput, options = {}) {
  const state = normalizeRecordingState(stateInput);
  const presentation = buildRecordingToolbarPresentation(state);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  if (chrome.action && typeof chrome.action.setBadgeText === 'function') {
    await chrome.action.setBadgeText({ text: presentation.badgeText });
  }

  if (chrome.action && typeof chrome.action.setTitle === 'function') {
    await chrome.action.setTitle({ title: presentation.title });
  }

  if (chrome.action && typeof chrome.action.setBadgeBackgroundColor === 'function') {
    await chrome.action.setBadgeBackgroundColor({
      color: presentation.badgeBackgroundColor || TRANSPARENT_BADGE_BACKGROUND_COLOR
    });
  }

  if (!state.awareness.sessionId) {
    // No active awareness session means everything must be cleaned up and kept idle.
    await clearRecordingAwarenessArtifacts(state, {
      targetStatus: state.status,
      clearSession: true
    });
    return normalizeRecordingState({
      ...state,
      awareness: buildRecordingAwarenessDefaults({
        ...state.awareness,
        sessionId: null,
        indicatorVisible: false,
        activeNotificationId: null
      })
    });
  }

  if (!presentation.isRecording) {
    // Paused/non-recording states keep persisted session context but must clear UI side effects.
    await clearRecordingAwarenessArtifacts(state, {
      targetStatus: state.status,
      clearSession: false
    });
    return normalizeRecordingState({
      ...state,
      awareness: buildRecordingAwarenessDefaults({
        ...state.awareness,
        indicatorVisible: false,
        activeNotificationId: null
      })
    });
  }

  const reminderAlarmName = buildRecordingReminderAlarmName(state.awareness.sessionId);
  const inactivityAlarmName = buildRecordingInactivityAlarmName(state.awareness.sessionId);
  const reminderDelayMinutes = Math.max(1, Number(state.awareness.reminderIntervalMin) || RECORDING_AWARENESS_DEFAULTS.reminderIntervalMin);

  if (chrome.alarms && typeof chrome.alarms.create === 'function') {
    await chrome.alarms.create(reminderAlarmName, {
      delayInMinutes: reminderDelayMinutes,
      periodInMinutes: reminderDelayMinutes
    });

    const inactivityDeadline = calculateRecordingInactivityDeadline(state, now);
    if (Number.isFinite(inactivityDeadline)) {
      await chrome.alarms.create(inactivityAlarmName, {
        when: Math.max(now, inactivityDeadline)
      });
    }
  }

  await broadcastRecordingState({
    ...state,
    awareness: buildRecordingAwarenessDefaults({
      ...state.awareness,
      indicatorVisible: true,
      activeNotificationId: options.notificationId || state.awareness.activeNotificationId || null
    })
  });

  return normalizeRecordingState({
    ...state,
    awareness: buildRecordingAwarenessDefaults({
      ...state.awareness,
      indicatorVisible: true,
      activeNotificationId: options.notificationId || state.awareness.activeNotificationId || null
    })
  });
}

async function persistAndReconcileState(patch, options = {}) {
  const nextState = await setState(patch);
  const reconciledState = await reconcileRecordingAwareness(nextState, options);

  if (JSON.stringify(reconciledState.awareness) !== JSON.stringify(nextState.awareness)) {
    return setState({ awareness: reconciledState.awareness });
  }

  return nextState;
}

async function stopRecordingAndCleanup(reason = 'user-stop', options = {}) {
  const prevState = await getState();
  const transcriptSession = await getTranscriptSession();
  let finalizedSession = transcriptSession;
  const idleAwareness = buildRecordingAwarenessDefaults();

  // Stop is terminal cleanup: alarms, notifications, badge/icon, and page indicator all return to idle.
  await clearRecordingAwarenessArtifacts(prevState, {
    targetStatus: 'idle',
    clearSession: true
  });
  const idleState = await setState({
    status: 'idle',
    startTime: 0,
    pausedAt: 0,
    pausedDuration: 0,
    tabId: null,
    tabTitle: '',
    tabUrl: '',
    awareness: idleAwareness
  });
  await reconcileRecordingAwareness(idleState, { now: options.now });

  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
  } catch (e) {
    // Offscreen may already be gone — that's fine
  }

  await maybeFinalizeTranscriptionProgress();

  if (transcriptSession && providerSessionRuntime && typeof providerSessionRuntime.finalizeSession === 'function') {
    finalizedSession = providerSessionRuntime.finalizeSession(transcriptSession, {
      status: transcriptSession.status === 'failed' || reason === 'error' ? 'failed' : 'completed',
      endedAt: Date.now(),
      stopReason: reason
    });
    await setTranscriptSession(finalizedSession);
  }

  if (prevState.status !== 'idle') {
    await autoSaveTranscript(prevState, finalizedSession);
  }

  if (reason === 'inactive') {
    await createAutoStopNotification(prevState, options.now);
  }

  setTimeout(() => closeOffscreen().catch(() => {}), 2000);
  return { ok: true, reason };
}

async function syncRecordingAwarenessOnStartup() {
  const state = await getState();
  const nextState = await reconcileRecordingAwareness(state, { startup: true });

  if (JSON.stringify(nextState.awareness) !== JSON.stringify(state.awareness)) {
    await setState({ awareness: nextState.awareness });
  }
}

async function handleReminderAlarm(parsedAlarm, state, now = Date.now()) {
  const initialState = normalizeRecordingState(state);
  if (initialState.status !== 'recording' || initialState.awareness.sessionId !== parsedAlarm.sessionId) {
    if (chrome.alarms && typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(buildRecordingReminderAlarmName(parsedAlarm.sessionId));
    }
    return { ignored: true, reason: 'stale-session' };
  }

  const freshState = normalizeRecordingState(await getState());
  if (freshState.status !== 'recording' || freshState.awareness.sessionId !== parsedAlarm.sessionId) {
    if (chrome.alarms && typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(buildRecordingReminderAlarmName(parsedAlarm.sessionId));
    }
    return { ignored: true, reason: 'stale-after-refresh' };
  }

  const notificationId = await createReminderNotification(freshState, now);
  const nextState = await persistAndReconcileState({
    awareness: {
      ...freshState.awareness,
      activeNotificationId: notificationId
    }
  }, {
    now,
    notificationId
  });

  return { ignored: false, state: nextState };
}

async function handleInactivityAlarm(parsedAlarm, state, now = Date.now()) {
  const initialState = normalizeRecordingState(state);
  if (initialState.status !== 'recording' || initialState.awareness.sessionId !== parsedAlarm.sessionId) {
    if (chrome.alarms && typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(buildRecordingInactivityAlarmName(parsedAlarm.sessionId));
    }
    return { ignored: true, reason: 'stale-session' };
  }

  const freshState = normalizeRecordingState(await getState());
  if (freshState.status !== 'recording' || freshState.awareness.sessionId !== parsedAlarm.sessionId) {
    if (chrome.alarms && typeof chrome.alarms.clear === 'function') {
      await chrome.alarms.clear(buildRecordingInactivityAlarmName(parsedAlarm.sessionId));
    }
    return { ignored: true, reason: 'stale-after-refresh' };
  }

  const deadline = calculateRecordingInactivityDeadline(freshState, now);
  if (Number.isFinite(deadline) && deadline > now) {
    await reconcileRecordingAwareness(freshState, { now });
    return { ignored: true, reason: 'not-due-yet' };
  }

  await stopRecordingAndCleanup('inactive', { now });
  return { ignored: false, stopped: true };
}

// ── Offscreen document management ──
let creatingOffscreen = null;

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Tab audio capture and recording'
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function closeOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const acceptsUntargetedContentMessage = !msg.target
    && (msg.action === 'stopCapture' || msg.action === 'getRecordingIndicatorState');

  if (msg.target !== 'background' && !acceptsUntargetedContentMessage) return;

  switch (msg.action) {
    case 'startCapture':
      handleStart(msg.tabId, msg.tabTitle, msg.tabUrl, msg.providerOverride).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'stopCapture':
      handleStop().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'getRecordingIndicatorState':
      getState()
        .then((state) => sendResponse(buildRecordingIndicatorStateResponse(state, sender)))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case 'pauseCapture':
      handlePause().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'resumeCapture':
      handleResume().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'resetCapture':
      handleReset().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'audioActivity':
      handleAudioActivity(msg).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'getState':
      getState().then(s => sendResponse(s));
      return true;

    case 'getWaveform':
      chrome.runtime.sendMessage({ target: 'offscreen', action: 'getWaveform' }, (resp) => {
        sendResponse(resp);
      });
      return true;

    case 'downloadAudio':
      downloadAudio(msg.dataUrl);
      break;

    case 'getProviderSettings':
      handleGetProviderSettings(sender).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'saveProviderSettings':
      handleSaveProviderSettings(msg.providerSettings, sender).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'getTranscriptionSession':
      getTranscriptSession().then(session => sendResponse({ ok: true, transcriptSession: session }));
      return true;

    case 'saveTranscript':
      saveTranscriptQueued(msg.text).then(() => sendResponse({ ok: true }));
      return true;

    case 'processChunk':
      processChunkChain = processChunkChain
        .then(() => handleProcessChunk(msg))
        .then((result) => {
          sendResponse(result);
          return result;
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error.message });
        });
      return true;

    case 'syncTranscriptionProgress':
      syncTranscriptionProgress(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'getTranscriptions':
      getTranscriptions().then(list => sendResponse(list));
      return true;

    case 'deleteTranscription':
      deleteTranscription(msg.id).then(r => sendResponse(r));
      return true;

    case 'updateTranscription':
      updateTranscription(msg.id, msg.updates).then(r => sendResponse(r));
      return true;

    case 'summarizeTranscription':
      handleSummarizeTranscription(msg.id)
        .then(sendResponse)
        .catch((error) => sendResponse(normalizeSummaryResultError(error)));
      return true;
  }
});

if (chrome.alarms && chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || !isRecordingAwarenessAlarm(alarm.name)) {
      return;
    }

    const parsedAlarm = parseRecordingAwarenessAlarmName(alarm.name);

    Promise.resolve()
      .then(() => getState())
      .then((state) => {
        if (!parsedAlarm) {
          return null;
        }

        if (parsedAlarm.type === 'reminder') {
          return handleReminderAlarm(parsedAlarm, state, alarm.scheduledTime || Date.now());
        }

        if (parsedAlarm.type === 'inactive') {
          return handleInactivityAlarm(parsedAlarm, state, alarm.scheduledTime || Date.now());
        }

        return null;
      })
      .catch(() => {});
  });
}

if (chrome.notifications && chrome.notifications.onButtonClicked && typeof chrome.notifications.onButtonClicked.addListener === 'function') {
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (!isRecordingAwarenessNotification(notificationId) || buttonIndex !== REMINDER_NOTIFICATION_BUTTON_INDEX) {
      return;
    }

    Promise.resolve()
      .then(() => handleStop())
      .catch(() => {});
  });
}

if (chrome.runtime && chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => {
    syncRecordingAwarenessOnStartup().catch(() => {});
  });
}

if (chrome.runtime && chrome.runtime.onInstalled && typeof chrome.runtime.onInstalled.addListener === 'function') {
  chrome.runtime.onInstalled.addListener(() => {
    syncRecordingAwarenessOnStartup().catch(() => {});
  });
}

// ── Handlers ──
async function handleStart(tabId, tabTitle, tabUrl, providerOverride) {
  const providerSettings = await readProviderSettings();
  const { audioLanguage } = await chrome.storage.local.get('audioLanguage');
  const startLogger = createScopedLogger({ scope: 'session.start', tabId });
  const transcriptionSession = await providerRegistry.createTranscriptionSession({
    providerSettings,
    providerOverride,
    language: audioLanguage || 'es',
    targetLanguage: 'es'
  }, {
    fetchImpl: fetch.bind(globalThis),
    logger: startLogger
  });

  // tabCapture works after a user-invoked extension action and can target tabs granted via activeTab,
  // so we keep host_permissions narrowed to provider/transcription endpoints instead of <all_urls>.
  // Chrome docs: chrome.tabCapture.getMediaStreamId({ targetTabId }) only requires activeTab access.
  // Get a stream ID for the given tab
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  await ensureOffscreen();

  await setTranscriptSession({
    ...transcriptionSession,
    status: 'starting',
    tabId,
    tabTitle: tabTitle || '',
    tabUrl: tabUrl || ''
  });

  // Tell offscreen to start recording with this stream ID
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start',
    streamId,
    sessionContext: {
      sessionId: transcriptionSession.id,
      language: transcriptionSession.language || 'es',
      activeProvider: transcriptionSession.activeProvider || null,
      chunkIntervalMs: getLiveTranscriptionChunkMs(transcriptionSession.activeProvider)
    }
  });

  if (!resp.ok) throw new Error(resp.error);

  await setTranscriptionProgress({
    sessionId: transcriptionSession.id,
    totalChunks: 0,
    completedChunks: 0,
    status: 'active',
    updatedAt: Date.now()
  });

  // Clear previous transcript for fresh start
  await chrome.storage.local.remove('transcript');

  await patchTranscriptSession({
    status: 'recording',
    startedAt: Date.now()
  });

  const awarenessStartedAt = Date.now();
  await persistAndReconcileState({
    status: 'recording',
    startTime: awarenessStartedAt,
    pausedAt: 0,
    pausedDuration: 0,
    tabId,
    tabTitle: tabTitle || '',
    tabUrl: tabUrl || '',
    awareness: buildRecordingAwarenessDefaults({
      sessionId: transcriptionSession.id,
      lastAudioAt: awarenessStartedAt,
      indicatorVisible: true,
      activeNotificationId: null
    })
  });

  if (typeof startLogger.info === 'function') {
    startLogger.info('session.capture-started', {
      sessionId: transcriptionSession.id,
      activeProvider: transcriptionSession.activeProvider,
      providerPlan: transcriptionSession.providerPlan,
      overrideProvider: transcriptionSession.providerOverride,
      defaultProvider: transcriptionSession.defaultProvider
    });
  }

  return {
    ok: true,
    transcriptSession: {
      id: transcriptionSession.id,
      activeProvider: transcriptionSession.activeProvider,
      providerPlan: transcriptionSession.providerPlan
    }
  };
}

async function handleStop() {
  return stopRecordingAndCleanup('user-stop');
}

async function handlePause() {
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause' });
  const state = await getState();
  // Pause keeps session identity for resume, but reminders/inactivity timers and page UI must disappear.
  await persistAndReconcileState({
    status: 'paused',
    pausedAt: Date.now(),
    awareness: {
      ...state.awareness,
      indicatorVisible: false,
      activeNotificationId: null
    }
  });
  return { ok: true };
}

async function handleResume() {
  const state = await getState();
  const extraPaused = Date.now() - (state.pausedAt || Date.now());
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume' });
  await persistAndReconcileState({
    status: 'recording',
    pausedAt: 0,
    pausedDuration: (state.pausedDuration || 0) + extraPaused,
    awareness: {
      ...state.awareness,
      lastAudioAt: Date.now()
    }
  });
  return { ok: true };
}

async function handleAudioActivity(message = {}) {
  const state = await getState();
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
  const at = Number.isFinite(Number(message.at)) ? Number(message.at) : Date.now();

  if (
    state.status !== 'recording'
    || !sessionId
    || !state.awareness.sessionId
    || state.awareness.sessionId !== sessionId
  ) {
    return { ok: true, ignored: true };
  }

  await persistAndReconcileState({
    awareness: {
      ...state.awareness,
      lastAudioAt: Math.max(state.awareness.lastAudioAt || 0, at)
    }
  }, { now: at });

  return { ok: true };
}

async function handleReset() {
  const state = await getState();
  if (state.status !== 'idle') {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
    setTimeout(() => closeOffscreen(), 1000);
  }
  // Reset behaves like a hard cleanup: clear awareness artifacts and discard any persisted session metadata.
  await clearRecordingAwarenessArtifacts(state);
  await setState({
    status: 'idle',
    startTime: 0,
    pausedAt: 0,
    pausedDuration: 0,
    tabId: null,
    tabTitle: '',
    tabUrl: '',
    awareness: buildRecordingAwarenessDefaults()
  });
  await chrome.storage.local.remove('transcript');
  await clearTranscriptSession();
  await clearTranscriptionProgress();
  return { ok: true };
}

async function handleGetProviderSettings(sender) {
  if (!isTrustedExtensionPageSender(sender)) {
    return buildUnauthorizedProviderSettingsResponse();
  }

  const providerSettings = await readProviderSettings();
  return {
    ok: true,
    providerSettings: redactProviderSettings(providerSettings),
    providers: providerRegistry.listProviders()
  };
}

async function handleSaveProviderSettings(nextProviderSettings, sender) {
  if (!isTrustedExtensionPageSender(sender)) {
    return buildUnauthorizedProviderSettingsResponse();
  }

  const currentProviderSettings = await readProviderSettings();
  const providerSettings = await saveProviderSettings(restoreRedactedProviderSecrets(
    nextProviderSettings || {},
    currentProviderSettings
  ));

  return {
    ok: true,
    providerSettings: redactProviderSettings(providerSettings),
    providers: providerRegistry.listProviders()
  };
}

async function handleProcessChunk(message) {
  const transcriptSession = await getTranscriptSession();
  const chunkLogger = createScopedLogger({
    scope: 'chunk.process',
    sessionId: transcriptSession && transcriptSession.id ? transcriptSession.id : null
  });
  if (!transcriptSession) {
    if (typeof chunkLogger.warn === 'function') {
      chunkLogger.warn('chunk.discarded-no-session', {
        chunkIndex: message && message.chunkIndex
      });
    }
    return { ok: false, error: 'No hay una sesión activa para procesar chunks.' };
  }

  if (message.sessionId && transcriptSession.id && message.sessionId !== transcriptSession.id) {
    if (typeof chunkLogger.warn === 'function') {
      chunkLogger.warn('chunk.discarded-stale-session', {
        chunkIndex: message && message.chunkIndex,
        messageSessionId: message.sessionId,
        activeSessionId: transcriptSession.id
      });
    }
    return { ok: false, error: 'El chunk pertenece a una sesión anterior y se descarta.' };
  }

  let hydratedMessage;
  try {
    hydratedMessage = hydrateProcessChunkMessage(message);
  } catch (error) {
    const normalizedError = providerErrors && typeof providerErrors.normalizeProviderError === 'function'
      ? providerErrors.normalizeProviderError(error, { providerId: transcriptSession.activeProvider || 'unknown' })
      : null;

    await patchTranscriptionProgress((current) => {
      if (!current || current.sessionId !== transcriptSession.id) {
        return null;
      }

      return {
        completedChunks: Math.min(current.totalChunks, current.completedChunks + 1),
        status: current.completedChunks + 1 >= current.totalChunks ? 'done' : current.status,
        updatedAt: Date.now()
      };
    });
    await maybeFinalizeTranscriptionProgress();

    return {
      ok: false,
      error: normalizedError && normalizedError.summary ? normalizedError.summary : error.message,
      code: normalizedError && normalizedError.code ? normalizedError.code : (error.code || 'unsupported'),
      retryable: !!(normalizedError && normalizedError.retryable)
    };
  }

  const providerSettings = await readProviderSettings();
  const runtime = providerSessionRuntime && typeof providerSessionRuntime.executeChunkWithFallback === 'function'
    ? providerSessionRuntime
    : null;

  if (!runtime) {
    if (typeof chunkLogger.error === 'function') {
      chunkLogger.error('chunk.runtime-missing', {
        chunkIndex: message && message.chunkIndex
      });
    }
    return { ok: false, error: 'No se pudo inicializar el runtime de fallback multi-provider.' };
  }

  let result;
  try {
    result = await runtime.executeChunkWithFallback({
      session: transcriptSession,
      message: hydratedMessage,
      providerSettings,
      getProviderAdapter,
      getProviderLabel,
      normalizeProviderError: providerErrors && typeof providerErrors.normalizeProviderError === 'function'
        ? providerErrors.normalizeProviderError
        : null,
      appendTranscriptText: saveTranscriptQueued,
      isHallucination,
      fetchImpl: fetch.bind(globalThis),
      setTimeoutImpl: setTimeout,
      clearTimeoutImpl: clearTimeout,
      log: chunkLogger
    });

    if (result && result.session) {
      await setTranscriptSession(result.session);
    }

    return {
      ok: !!(result && result.ok),
      providerId: result && result.providerId ? result.providerId : null,
      transcriptAppended: !!(result && result.transcriptAppended),
      error: result && result.error ? result.error : undefined,
      code: result && result.code ? result.code : undefined,
      retryable: !!(result && result.retryable)
    };
  } finally {
    await patchTranscriptionProgress((current) => {
      if (!current || current.sessionId !== transcriptSession.id) {
        return null;
      }

      const nextCompletedChunks = Math.min(current.totalChunks, current.completedChunks + 1);
      return {
        completedChunks: nextCompletedChunks,
        status: nextCompletedChunks >= current.totalChunks ? 'done' : current.status,
        updatedAt: Date.now()
      };
    });
    await maybeFinalizeTranscriptionProgress();
  }
}

// ── Auto-save transcript to history ──
async function autoSaveTranscript(prevState, transcriptSession) {
  const { transcript } = await chrome.storage.local.get('transcript');
  const transcriptText = transcript && transcript.final ? transcript.final.trim() : '';
  if (!transcriptText && (!transcriptSession || transcriptSession.status !== 'failed')) return;
  const duration = prevState.pausedAt
    ? (prevState.pausedAt - prevState.startTime - (prevState.pausedDuration || 0)) / 1000
    : (Date.now() - prevState.startTime - (prevState.pausedDuration || 0)) / 1000;
  const { audioLanguage } = await chrome.storage.local.get('audioLanguage');
  const providerAudit = transcriptionStore && typeof transcriptionStore.createProviderAuditSnapshot === 'function'
    ? transcriptionStore.createProviderAuditSnapshot(transcriptSession)
    : (transcriptSession
      ? {
          providerPlan: transcriptSession.providerPlan || [],
          attempts: transcriptSession.attempts || [],
          eligibleProviders: (transcriptSession.audit && transcriptSession.audit.eligibleProviders) || [],
          skippedProviders: (transcriptSession.audit && transcriptSession.audit.skippedProviders) || [],
          providerOverride: transcriptSession.providerOverride || null,
          defaultProvider: transcriptSession.defaultProvider || 'openai',
          activeProvider: transcriptSession.activeProvider || null,
          resolvedProvider: transcriptSession.resolvedProvider || transcriptSession.activeProvider || null,
          lastChunkError: transcriptSession.lastChunkError || null,
          status: transcriptSession.status || 'completed'
        }
      : null);

  await saveTranscription({
    title: prevState.tabTitle || 'Transcripción sin título',
    text: transcriptText,
    url: prevState.tabUrl || '',
    date: Date.now(),
    duration: Math.max(0, Math.floor(duration)),
    language: audioLanguage || 'es',
    resolvedProvider: (providerAudit && providerAudit.resolvedProvider) || 'openai',
    status: (providerAudit && providerAudit.status) || 'completed',
    providerAudit
  });
}

// ── Transcription CRUD ──
async function saveTranscription(entry) {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  const list = savedTranscriptions || [];
  const nextEntry = {
    id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ...entry
  };
  list.unshift(
    transcriptionStore && typeof transcriptionStore.normalizeSavedTranscription === 'function'
      ? transcriptionStore.normalizeSavedTranscription(nextEntry)
      : nextEntry
  );
  await chrome.storage.local.set({ savedTranscriptions: list });
}

async function getTranscriptions() {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  const list = savedTranscriptions || [];
  const normalized = transcriptionStore && typeof transcriptionStore.normalizeSavedTranscriptions === 'function'
    ? transcriptionStore.normalizeSavedTranscriptions(list, {
        logger: createScopedLogger({ scope: 'history.read' })
      })
    : list;

  if (JSON.stringify(list) !== JSON.stringify(normalized)) {
    await chrome.storage.local.set({ savedTranscriptions: normalized });
  }

  return Promise.all(normalized.map((entry) => enrichTranscriptionForSummary(entry)));
}

async function deleteTranscription(id) {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  const list = (savedTranscriptions || []).filter(t => t.id !== id);
  await chrome.storage.local.set({ savedTranscriptions: list });
  return { ok: true };
}

async function updateTranscription(id, updates) {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  const list = savedTranscriptions || [];
  const idx = list.findIndex(t => t.id === id);
  if (idx !== -1) {
    if (updates.title !== undefined) list[idx].title = updates.title;
    if (updates.text !== undefined) list[idx].text = updates.text;
    await chrome.storage.local.set({ savedTranscriptions: list });
  }
  return { ok: true };
}

// ── Download helper ──
function downloadAudio(dataUrl) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  chrome.downloads.download({
    url: dataUrl,
    filename: `pochoclo-${ts}.webm`,
    saveAs: true
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    buildRecordingAwarenessDefaults,
    buildRecordingInactivityAlarmName,
    buildRecordingReminderAlarmName,
    calculateRecordingInactivityDeadline,
    handleInactivityAlarm,
    getTranscriptionProgress,
    handleProcessChunk,
    handleReminderAlarm,
    maybeFinalizeTranscriptionProgress,
    normalizeRecordingState,
    parseRecordingAwarenessAlarmName,
    patchTranscriptionProgress,
    setTranscriptionProgress,
    syncTranscriptionProgress
  };
}
