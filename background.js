// background.js — Service worker orchestrator
// Manages state, offscreen document lifecycle, and tab capture.

// ── State stored in chrome.storage.local ──
// { status: 'idle'|'recording'|'paused', startTime, pausedAt, pausedDuration }

// ── Serialized transcript writes (prevents race conditions) ──
let saveChain = Promise.resolve();
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
      handleStart(msg.tabId, msg.tabTitle, msg.tabUrl).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
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
      chrome.storage.local.get(['openaiApiKey', 'audioLanguage'], (data) => {
        sendResponse({ key: data.openaiApiKey || null, language: data.audioLanguage || 'es' });
      });
      return true;

    case 'saveTranscript':
      saveTranscriptQueued(msg.text).then(() => sendResponse({ ok: true }));
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
async function handleStart(tabId, tabTitle, tabUrl) {
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

  // Tell offscreen to start recording with this stream ID
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'start',
    streamId
  });

  if (!resp.ok) throw new Error(resp.error);

  // Clear previous transcript for fresh start
  await chrome.storage.local.remove('transcript');

  await setState({
    status: 'recording',
    startTime: Date.now(),
    pausedAt: 0,
    pausedDuration: 0,
    tabId,
    tabTitle: tabTitle || '',
    tabUrl: tabUrl || ''
  });

  return { ok: true };
}

async function handleStop() {
  const prevState = await getState();
  // Set state to idle first for responsive UI
  await setState({ status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0, tabId: null, tabTitle: '', tabUrl: '' });
  try {
    // stop is now async — waits for final chunk + queue to drain
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
  } catch (e) {
    // Offscreen may already be gone — that's fine
  }
  // Auto-save complete transcript to history
  if (prevState.status !== 'idle') {
    await autoSaveTranscript(prevState);
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
  return { ok: true };
}

// ── Auto-save transcript to history ──
async function autoSaveTranscript(prevState) {
  const { transcript } = await chrome.storage.local.get('transcript');
  if (!transcript || !transcript.final || !transcript.final.trim()) return;
  const duration = prevState.pausedAt
    ? (prevState.pausedAt - prevState.startTime - (prevState.pausedDuration || 0)) / 1000
    : (Date.now() - prevState.startTime - (prevState.pausedDuration || 0)) / 1000;
  const { audioLanguage } = await chrome.storage.local.get('audioLanguage');
  await saveTranscription({
    title: prevState.tabTitle || 'Transcripción sin título',
    text: transcript.final.trim(),
    url: prevState.tabUrl || '',
    date: Date.now(),
    duration: Math.max(0, Math.floor(duration)),
    language: audioLanguage || 'es'
  });
}

// ── Transcription CRUD ──
async function saveTranscription(entry) {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  const list = savedTranscriptions || [];
  list.unshift({
    id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ...entry
  });
  await chrome.storage.local.set({ savedTranscriptions: list });
}

async function getTranscriptions() {
  const { savedTranscriptions } = await chrome.storage.local.get('savedTranscriptions');
  return savedTranscriptions || [];
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
    filename: `pochocla-${ts}.webm`,
    saveAs: true
  });
}
