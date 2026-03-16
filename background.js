// background.js — Service worker orchestrator
// Manages state, offscreen document lifecycle, and tab capture.

// ── State stored in chrome.storage.local ──
// { status: 'idle'|'recording'|'paused', startTime, pausedAt, pausedDuration }

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
      handleStart(msg.tabId).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
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
      chrome.storage.local.get('openaiApiKey', (data) => {
        sendResponse({ key: data.openaiApiKey || null });
      });
      return true;

    case 'saveTranscript':
      chrome.storage.local.get('transcript', ({ transcript }) => {
        const current = transcript || { final: '', interim: '' };
        current.final = (current.final || '') + msg.text;
        current.interim = '';
        chrome.storage.local.set({ transcript: current }, () => sendResponse({ ok: true }));
      });
      return true;
  }
});

// ── Handlers ──
async function handleStart(tabId) {
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
    pausedDuration: 0
  });

  return { ok: true };
}

async function handleStop() {
  // Set state FIRST so the UI can update even if offscreen is gone
  await setState({ status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0 });
  // Keep transcript in storage (don't clear it, user might want to copy)
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop' });
    // Keep offscreen alive for last transcription chunk + download
    setTimeout(() => closeOffscreen(), 15000);
  } catch (e) {
    // Offscreen may already be gone — that's fine
    await closeOffscreen().catch(() => {});
  }
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
  await setState({ status: 'idle', startTime: 0, pausedAt: 0, pausedDuration: 0 });
  await chrome.storage.local.remove('transcript');
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
