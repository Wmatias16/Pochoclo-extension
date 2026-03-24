const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDefaultProviderSettings } = require('../storage/settings.js');
const { createHarness } = require('./helpers/extension-harness.js');

function createSettings() {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = 'sk-openai';
  return settings;
}

function getAlarm(harness, name) {
  return harness.chrome.__createdAlarms.get(name);
}

function getLastNotification(harness, notificationId) {
  const matches = harness.chrome.__createdNotifications.filter((entry) => entry.notificationId === notificationId);
  return matches[matches.length - 1] || null;
}

test('startup recovery reconciles persisted recording awareness state', { concurrency: false }, async (t) => {
  const startedAt = 1_700_000_000_000;
  const harness = createHarness({
    initialStorage: {
      providerSettings: createSettings(),
      recState: {
        status: 'recording',
        startTime: startedAt,
        pausedAt: 0,
        pausedDuration: 0,
        tabId: 7,
        tabTitle: 'Recovered tab',
        tabUrl: 'https://example.com/recovered',
        awareness: {
          sessionId: 'session-recovered',
          reminderIntervalMin: 3,
          inactivityMs: 90_000,
          lastAudioAt: startedAt + 15_000,
          indicatorVisible: false,
          activeNotificationId: null
        }
      }
    }
  });
  t.after(() => harness.dispose());

  harness.dispatchStartup();
  await new Promise((resolve) => setImmediate(resolve));

  const recoveredState = harness.storageArea.store.recState;
  assert.equal(recoveredState.awareness.indicatorVisible, true);
  assert.equal(getAlarm(harness, 'recording-reminder:session-recovered').periodInMinutes, 3);
  assert.equal(
    getAlarm(harness, 'recording-inactive:session-recovered').when >= (startedAt + 15_000 + 90_000),
    true
  );
  assert.equal(harness.chrome.__actionCalls.some((call) => call.method === 'setBadgeText' && call.payload.text === 'REC'), true);
  assert.equal(harness.chrome.__tabMessages.at(-1).tabId, 7);
  assert.equal(harness.chrome.__tabMessages.at(-1).message.type, 'recording-state-changed');
});

test('reminder alarm creates notification and stop cleanup clears awareness artifacts', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const startResult = await harness.startCapture({ tabId: 4, tabTitle: 'Reminder tab', tabUrl: 'https://example.com/reminder' });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.transcriptSession.id;
  assert.equal(getAlarm(harness, `recording-reminder:${sessionId}`).delayInMinutes, 2);
  assert.equal(getAlarm(harness, `recording-reminder:${sessionId}`).periodInMinutes, 2);
  assert.equal(
    getAlarm(harness, `recording-inactive:${sessionId}`).when,
    harness.storageArea.store.recState.awareness.lastAudioAt + 60_000
  );

  harness.dispatchAlarm({
    name: `recording-reminder:${sessionId}`,
    scheduledTime: harness.storageArea.store.recState.startTime + (2 * 60 * 1000)
  });
  await new Promise((resolve) => setImmediate(resolve));

  const notification = getLastNotification(harness, `recording-reminder:${sessionId}`);
  assert.ok(notification);
  assert.match(notification.options.message, /Seguís grabando hace/);
  assert.equal(notification.options.buttons[0].title, 'Detener');

  const storedStateAfterReminder = harness.storageArea.store.recState;
  assert.equal(storedStateAfterReminder.awareness.activeNotificationId, `recording-reminder:${sessionId}`);

  const stopResult = await harness.stopCapture();
  assert.equal(stopResult.ok, true);
  assert.equal(harness.chrome.__clearedAlarms.includes(`recording-reminder:${sessionId}`), true);
  assert.equal(harness.chrome.__clearedAlarms.includes(`recording-inactive:${sessionId}`), true);
  assert.equal(harness.chrome.__clearedNotifications.includes(`recording-reminder:${sessionId}`), true);
  assert.equal(harness.storageArea.store.recState.status, 'idle');
  assert.equal(harness.storageArea.store.recState.awareness.sessionId, null);
  assert.equal(harness.chrome.__actionCalls.some((call) => call.method === 'setBadgeText' && call.payload.text === ''), true);
  assert.equal(
    harness.chrome.__actionCalls.some(
      (call) => call.method === 'setBadgeBackgroundColor'
        && Array.isArray(call.payload.color)
        && call.payload.color.length === 4
        && call.payload.color.every((value, index) => value === [0, 0, 0, 0][index])
    ),
    true
  );
  assert.equal(
    harness.chrome.__actionCalls.some((call) => call.method === 'setTitle' && call.payload.title === 'Pochoclo - Transcriptor'),
    true
  );
  assert.equal(
    harness.chrome.__actionCalls.some((call) => call.method === 'setIcon'),
    false
  );
});

test('notification Detener action routes through stop flow', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const startResult = await harness.startCapture({ tabId: 8, tabTitle: 'Notification stop', tabUrl: 'https://example.com/notification-stop' });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.transcriptSession.id;
  harness.dispatchAlarm({
    name: `recording-reminder:${sessionId}`,
    scheduledTime: harness.storageArea.store.recState.startTime + (2 * 60 * 1000)
  });
  await new Promise((resolve) => setImmediate(resolve));

  harness.dispatchNotificationButton(`recording-reminder:${sessionId}`, 0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.storageArea.store.recState.status, 'idle');
  assert.equal(
    harness.chrome.__sentMessages.some((message) => message.target === 'offscreen' && message.action === 'stop'),
    true
  );
});

test('inactivity alarm auto-stops active session and ignores stale alarm sessions', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const startResult = await harness.startCapture({ tabId: 12, tabTitle: 'Inactivity tab', tabUrl: 'https://example.com/inactivity' });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.transcriptSession.id;
  const state = harness.storageArea.store.recState;
  const dueAt = state.awareness.lastAudioAt + state.awareness.inactivityMs;

  harness.dispatchAlarm({
    name: `recording-inactive:stale-session`,
    scheduledTime: dueAt + 1
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.storageArea.store.recState.status, 'recording');
  assert.equal(harness.chrome.__clearedAlarms.includes('recording-inactive:stale-session'), true);

  harness.dispatchAlarm({
    name: `recording-inactive:${sessionId}`,
    scheduledTime: dueAt
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.storageArea.store.recState.status, 'idle');
  const autoStopNotification = getLastNotification(harness, `recording-autostop:${sessionId}`);
  assert.ok(autoStopNotification);
  assert.match(autoStopNotification.options.title, /inactividad/i);
  assert.equal(autoStopNotification.options.iconUrl, 'icons/logo.png');
});

test('inactivity alarm refreshes state before reconcile so stopped sessions stay idle', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const startResult = await harness.startCapture({ tabId: 14, tabTitle: 'Race tab', tabUrl: 'https://example.com/race' });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.transcriptSession.id;
  const staleState = JSON.parse(JSON.stringify(harness.storageArea.store.recState));
  const dueAt = staleState.awareness.lastAudioAt + staleState.awareness.inactivityMs;

  const stopResult = await harness.stopCapture();
  assert.equal(stopResult.ok, true);
  assert.equal(harness.storageArea.store.recState.status, 'idle');

  harness.chrome.__actionCalls.length = 0;

  const result = await background.handleInactivityAlarm({
    type: 'inactive',
    sessionId
  }, staleState, dueAt - 1);

  assert.deepEqual(result, { ignored: true, reason: 'stale-after-refresh' });
  assert.equal(harness.chrome.__clearedAlarms.includes(`recording-inactive:${sessionId}`), true);
  assert.equal(
    harness.chrome.__actionCalls.some((call) => call.method === 'setBadgeText' && call.payload.text === 'REC'),
    false
  );
  assert.equal(
    harness.chrome.__actionCalls.some(
      (call) => call.method === 'setIcon'
    ),
    false
  );
});

test('audio heartbeat reschedules inactivity alarm for the active session only', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const startResult = await harness.startCapture({ tabId: 18, tabTitle: 'Heartbeat tab', tabUrl: 'https://example.com/heartbeat' });
  assert.equal(startResult.ok, true);

  const sessionId = startResult.transcriptSession.id;
  const initialState = harness.storageArea.store.recState;
  const nextAudioAt = initialState.awareness.lastAudioAt + 25_000;

  const ignored = await harness.chrome.runtime.sendMessage({
    target: 'background',
    action: 'audioActivity',
    sessionId: 'stale-session',
    at: nextAudioAt
  });
  assert.equal(ignored.ignored, true);

  const updated = await harness.chrome.runtime.sendMessage({
    target: 'background',
    action: 'audioActivity',
    sessionId,
    at: nextAudioAt
  });
  assert.equal(updated.ok, true);

  const updatedState = harness.storageArea.store.recState;
  assert.equal(updatedState.awareness.lastAudioAt, nextAudioAt);
  assert.equal(
    getAlarm(harness, `recording-inactive:${sessionId}`).when,
    nextAudioAt + updatedState.awareness.inactivityMs
  );
  assert.equal(harness.chrome.__tabMessages.at(-1).tabId, 18);
  assert.equal(harness.chrome.__tabMessages.at(-1).message.type, 'recording-state-changed');
});

test('content query returns indicator state only for the active recording tab', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const startResult = await harness.startCapture({ tabId: 21, tabTitle: 'Indicator tab', tabUrl: 'https://example.com/indicator' });
  assert.equal(startResult.ok, true);

  const activeTabResponse = await harness.sendRuntimeMessageAs(
    { action: 'getRecordingIndicatorState' },
    { tab: { id: 21 } }
  );
  assert.equal(activeTabResponse.ok, true);
  assert.equal(activeTabResponse.state.indicatorVisible, true);
  assert.equal(activeTabResponse.state.sessionId, startResult.transcriptSession.id);

  const otherTabResponse = await harness.sendRuntimeMessageAs(
    { action: 'getRecordingIndicatorState' },
    { tab: { id: 22 } }
  );
  assert.equal(otherTabResponse.ok, true);
  assert.equal(otherTabResponse.state.indicatorVisible, false);
  assert.equal(otherTabResponse.state.sessionId, startResult.transcriptSession.id);
});

test('content stopCapture message works without explicit background target', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const startResult = await harness.startCapture({ tabId: 24, tabTitle: 'Stop from page', tabUrl: 'https://example.com/page-stop' });
  assert.equal(startResult.ok, true);

  const stopResult = await harness.sendRuntimeMessageAs(
    { action: 'stopCapture' },
    { tab: { id: 24 } }
  );
  assert.equal(stopResult.ok, true);
  assert.equal(harness.storageArea.store.recState.status, 'idle');
});

test('background progress resets on start, merges active snapshots, rejects stale sessions, and clears after drain', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 30, tabTitle: 'Progress tab', tabUrl: 'https://example.com/progress' });
  assert.equal(started.ok, true);

  assert.deepEqual(harness.storageArea.store.transcriptionProgress, {
    sessionId: started.transcriptSession.id,
    totalChunks: 0,
    completedChunks: 0,
    status: 'active',
    updatedAt: harness.storageArea.store.transcriptionProgress.updatedAt
  });

  const merged = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 3,
    status: 'active',
    updatedAt: 1_111
  });
  assert.equal(merged.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 0);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'active');

  const stale = await background.syncTranscriptionProgress({
    sessionId: 'old-session',
    totalChunks: 99,
    status: 'draining',
    updatedAt: 1_222
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.ignored, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);

  await harness.stopCapture();
  assert.equal(harness.storageArea.store.recState.status, 'idle');
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);

  await background.patchTranscriptionProgress({
    completedChunks: 3,
    status: 'done',
    updatedAt: 1_333
  });
  const finalized = await background.maybeFinalizeTranscriptionProgress();
  assert.equal(finalized, null);
  assert.equal('transcriptionProgress' in harness.storageArea.store, false);
});

test('handleProcessChunk counts terminal success and failure exactly once', { concurrency: false }, async (t) => {
  let transcribeCalls = 0;
  const harness = createHarness({
    initialStorage: { providerSettings: createSettings() },
    adapterBehaviors: {
      openai: {
        async transcribe() {
          transcribeCalls += 1;
          if (transcribeCalls === 1) {
            return { text: 'chunk ok' };
          }
          const error = new Error('temporary unavailable');
          error.code = 'temporary_unavailable';
          throw error;
        }
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 31, tabTitle: 'Chunk progress', tabUrl: 'https://example.com/chunk-progress' });
  assert.equal(started.ok, true);

  await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 2,
    status: 'active',
    updatedAt: 2_000
  });

  const success = await harness.dispatchChunk({ chunkIndex: 0, body: 'good-audio' });
  assert.equal(success.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 1);

  const failure = await harness.dispatchChunk({ chunkIndex: 1, body: 'bad-audio' });
  assert.equal(failure.ok, false);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 2);

  await harness.stopCapture();
  assert.equal('transcriptionProgress' in harness.storageArea.store, false);
});
