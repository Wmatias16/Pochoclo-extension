(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaRecordingAwareness = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const IDLE_ACTION_ICON_PATH = 'icons/logo.png';

  const TRANSPARENT_BADGE_BACKGROUND_COLOR = Object.freeze([0, 0, 0, 0]);

  const DEFAULT_RECORDING_AWARENESS = Object.freeze({
    sessionId: null,
    reminderIntervalMin: 2,
    inactivityMs: 60 * 1000,
    amplitudeThreshold: 0.05,
    lastAudioAt: 0,
    indicatorVisible: false,
    activeNotificationId: null
  });

  function toFiniteNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function buildRecordingAwarenessDefaults(overrides = {}) {
    return {
      ...DEFAULT_RECORDING_AWARENESS,
      ...(overrides && typeof overrides === 'object' ? overrides : {}),
      reminderIntervalMin: toFiniteNumber(overrides && overrides.reminderIntervalMin, DEFAULT_RECORDING_AWARENESS.reminderIntervalMin),
      inactivityMs: toFiniteNumber(overrides && overrides.inactivityMs, DEFAULT_RECORDING_AWARENESS.inactivityMs),
      amplitudeThreshold: toFiniteNumber(overrides && overrides.amplitudeThreshold, DEFAULT_RECORDING_AWARENESS.amplitudeThreshold),
      lastAudioAt: toFiniteNumber(overrides && overrides.lastAudioAt, DEFAULT_RECORDING_AWARENESS.lastAudioAt)
    };
  }

  function normalizeRecordingState(state = {}) {
    return {
      status: typeof state.status === 'string' ? state.status : 'idle',
      startTime: toFiniteNumber(state.startTime, 0),
      pausedAt: toFiniteNumber(state.pausedAt, 0),
      pausedDuration: toFiniteNumber(state.pausedDuration, 0),
      tabId: Number.isInteger(state.tabId) ? state.tabId : null,
      tabTitle: typeof state.tabTitle === 'string' ? state.tabTitle : '',
      tabUrl: typeof state.tabUrl === 'string' ? state.tabUrl : '',
      awareness: buildRecordingAwarenessDefaults(state.awareness)
    };
  }

  function buildRecordingReminderAlarmName(sessionId) {
    return `recording-reminder:${sessionId || 'unknown'}`;
  }

  function buildRecordingInactivityAlarmName(sessionId) {
    return `recording-inactive:${sessionId || 'unknown'}`;
  }

  function buildRecordingAlarmName(type, sessionId) {
    if (type === 'reminder') {
      return buildRecordingReminderAlarmName(sessionId);
    }

    if (type === 'inactive') {
      return buildRecordingInactivityAlarmName(sessionId);
    }

    return `${String(type || 'unknown')}:${sessionId || 'unknown'}`;
  }

  function parseRecordingAlarmName(name) {
    if (typeof name !== 'string' || name.length === 0) {
      return null;
    }

    const separatorIndex = name.indexOf(':');
    if (separatorIndex === -1) {
      return null;
    }

    const rawType = name.slice(0, separatorIndex);
    const sessionId = name.slice(separatorIndex + 1) || null;
    const type = rawType === 'recording-reminder'
      ? 'reminder'
      : (rawType === 'recording-inactive' ? 'inactive' : rawType);

    return {
      rawType,
      type,
      sessionId
    };
  }

  function buildToolbarPresentation(state, options = {}) {
    const normalizedState = normalizeRecordingState(state);
    const productName = typeof options.productName === 'string' && options.productName.trim().length > 0
      ? options.productName.trim()
      : 'Pochoclo - Transcriptor';
    const isRecording = normalizedState.status === 'recording';

    return {
      badgeText: isRecording ? 'REC' : '',
      badgeBackgroundColor: isRecording ? '#dc2626' : TRANSPARENT_BADGE_BACKGROUND_COLOR,
      title: isRecording ? `${productName} • Grabando` : productName,
      isRecording
    };
  }

  function getInactivityBaseTimestamp(state, now = Date.now()) {
    const normalizedState = normalizeRecordingState(state);
    const lastAudioAt = normalizedState.awareness.lastAudioAt;
    if (lastAudioAt > 0) {
      return lastAudioAt;
    }

    if (normalizedState.startTime > 0) {
      return normalizedState.startTime;
    }

    return toFiniteNumber(now, Date.now());
  }

  function calculateInactivityDeadline(state, now = Date.now()) {
    const normalizedState = normalizeRecordingState(state);
    if (normalizedState.status !== 'recording') {
      return null;
    }

    return getInactivityBaseTimestamp(normalizedState, now) + normalizedState.awareness.inactivityMs;
  }

  function calculateRemainingInactivityMs(state, now = Date.now()) {
    const deadline = calculateInactivityDeadline(state, now);
    if (!Number.isFinite(deadline)) {
      return null;
    }

    return Math.max(0, deadline - toFiniteNumber(now, Date.now()));
  }

  return {
    AWARENESS_DEFAULTS: DEFAULT_RECORDING_AWARENESS,
    DEFAULT_RECORDING_AWARENESS,
    IDLE_ACTION_ICON_PATH,
    TRANSPARENT_BADGE_BACKGROUND_COLOR,
    alarmKey: buildRecordingAlarmName,
    parseAlarmKey: parseRecordingAlarmName,
    toolbarProps: buildToolbarPresentation,
    nextInactivityDeadline: calculateInactivityDeadline,
    buildRecordingAwarenessDefaults,
    buildRecordingAlarmName,
    normalizeRecordingState,
    parseRecordingAlarmName,
    buildRecordingReminderAlarmName,
    buildRecordingInactivityAlarmName,
    buildToolbarPresentation,
    getInactivityBaseTimestamp,
    calculateInactivityDeadline,
    calculateRemainingInactivityMs
  };
});
