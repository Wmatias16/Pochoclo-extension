// background.js — Service worker orchestrator
// Manages state, offscreen document lifecycle, tab capture, and provider session setup.

if (typeof importScripts === 'function') {
  importScripts(
    'diagnostics/provider-logger.js',
    'runtime/provider-session-runtime.js',
    'runtime/offscreen-bridge.js',
    'providers/errors.js',
    'providers/registry.js',
    'storage/transcriptions.js',
    'providers/adapters/shared.js',
    'providers/adapters/openai.js',
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

const DEFAULT_TRANSCRIPTION_CHUNK_MS = 7000;
const OPENAI_LIVE_TRANSCRIPTION_CHUNK_MS = 3000;

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

async function readProviderSettings() {
  if (providerSettingsStore && typeof providerSettingsStore.readProviderSettings === 'function') {
    return providerSettingsStore.readProviderSettings(chrome.storage.local, {
      logger: createScopedLogger({ scope: 'provider-settings.read' })
    });
  }

  const { openaiApiKey } = await chrome.storage.local.get('openaiApiKey');
  return {
    defaultProvider: 'openai',
    providers: {
      openai: { enabled: !!openaiApiKey, apiKey: openaiApiKey || '' }
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

function getProviderLabel(providerId) {
  if (!providerRegistry || typeof providerRegistry.getProviderDefinition !== 'function') {
    return providerId;
  }

  const definition = providerRegistry.getProviderDefinition(providerId);
  return (definition && definition.label) || providerId;
}

async function getState() {
  const { recState } = await chrome.storage.local.get('recState');
  return recState || { status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0 };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ recState: next });
  return next;
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
  if (msg.target !== 'background') return;

  switch (msg.action) {
    case 'startCapture':
      handleStart(msg.tabId, msg.tabTitle, msg.tabUrl, msg.providerOverride).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'stopCapture':
      handleStop().then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
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

    case 'getApiKey':
      handleGetApiKey().then(sendResponse).catch(e => sendResponse({ key: null, language: 'es', error: e.message }));
      return true;

    case 'getProviderSettings':
      handleGetProviderSettings().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'saveProviderSettings':
      handleSaveProviderSettings(msg.providerSettings).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
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

    case 'getTranscriptions':
      getTranscriptions().then(list => sendResponse(list));
      return true;

    case 'deleteTranscription':
      deleteTranscription(msg.id).then(r => sendResponse(r));
      return true;

    case 'updateTranscription':
      updateTranscription(msg.id, msg.updates).then(r => sendResponse(r));
      return true;
  }
});

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

  // Clear previous transcript for fresh start
  await chrome.storage.local.remove('transcript');

  await patchTranscriptSession({
    status: 'recording',
    startedAt: Date.now()
  });

  await setState({
    status: 'recording',
    startTime: Date.now(),
    pausedAt: 0,
    pausedDuration: 0,
    tabId,
    tabTitle: tabTitle || '',
    tabUrl: tabUrl || ''
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
  const prevState = await getState();
  const transcriptSession = await getTranscriptSession();
  let finalizedSession = transcriptSession;
  // Set state to idle first for responsive UI
  await setState({ status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0, tabId: null, tabTitle: '', tabUrl: '' });
  try {
    // stop is now async — waits for final chunk + queue to drain
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
  } catch (e) {
    // Offscreen may already be gone — that's fine
  }
  if (transcriptSession && providerSessionRuntime && typeof providerSessionRuntime.finalizeSession === 'function') {
    finalizedSession = providerSessionRuntime.finalizeSession(transcriptSession, {
      status: transcriptSession.status === 'failed' ? 'failed' : 'completed',
      endedAt: Date.now()
    });
    await setTranscriptSession(finalizedSession);
  }
  // Auto-save complete transcript to history
  if (prevState.status !== 'idle') {
    await autoSaveTranscript(prevState, finalizedSession);
  }
  setTimeout(() => closeOffscreen().catch(() => {}), 2000);
  return { ok: true };
}

async function handlePause() {
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause' });
  await setState({ status: 'paused', pausedAt: Date.now() });
  return { ok: true };
}

async function handleResume() {
  const state = await getState();
  const extraPaused = Date.now() - (state.pausedAt || Date.now());
  await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume' });
  await setState({
    status: 'recording',
    pausedAt: 0,
    pausedDuration: (state.pausedDuration || 0) + extraPaused
  });
  return { ok: true };
}

async function handleReset() {
  const state = await getState();
  if (state.status !== 'idle') {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
    setTimeout(() => closeOffscreen(), 1000);
  }
  await setState({ status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0, tabId: null, tabTitle: '', tabUrl: '' });
  await chrome.storage.local.remove('transcript');
  await clearTranscriptSession();
  return { ok: true };
}

async function handleGetApiKey() {
  const providerSettings = await readProviderSettings();
  const transcriptSession = await getTranscriptSession();
  const { audioLanguage } = await chrome.storage.local.get('audioLanguage');
  const activeProvider = transcriptSession && transcriptSession.activeProvider ? transcriptSession.activeProvider : 'openai';
  const key = providerSettings.providers && providerSettings.providers.openai
    ? providerSettings.providers.openai.apiKey || null
    : null;

  return {
    key: activeProvider === 'openai' ? key : null,
    language: audioLanguage || 'es',
    providerId: activeProvider
  };
}

async function handleGetProviderSettings() {
  const providerSettings = await readProviderSettings();
  return {
    ok: true,
    providerSettings,
    providers: providerRegistry.listProviders()
  };
}

async function handleSaveProviderSettings(nextProviderSettings) {
  const providerSettings = await saveProviderSettings(nextProviderSettings || {});
  return {
    ok: true,
    providerSettings,
    providers: providerRegistry.listProviders()
  };
}

async function handleProcessChunk(message) {
  const hydratedMessage = hydrateProcessChunkMessage(message);
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

  const result = await runtime.executeChunkWithFallback({
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

  return normalized;
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
