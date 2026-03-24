const test = require('node:test');
const assert = require('node:assert/strict');

const recordingAwareness = require('../runtime/recording-awareness.js');

test('toolbar presentation switches badge and title while recording', () => {
  const idle = recordingAwareness.buildToolbarPresentation({ status: 'idle' });
  const recording = recordingAwareness.buildToolbarPresentation({ status: 'recording' });

  assert.equal(idle.badgeText, '');
  assert.deepEqual(idle.badgeBackgroundColor, recordingAwareness.TRANSPARENT_BADGE_BACKGROUND_COLOR);
  assert.equal(idle.title, 'Pochoclo - Transcriptor');

  assert.equal(recording.badgeText, 'REC');
  assert.equal(recording.badgeBackgroundColor, '#dc2626');
  assert.equal(recording.title, 'Pochoclo - Transcriptor • Grabando');
});

test('recording awareness defaults use 2-minute reminders and 60-second inactivity window', () => {
  assert.equal(recordingAwareness.DEFAULT_RECORDING_AWARENESS.reminderIntervalMin, 2);
  assert.equal(recordingAwareness.DEFAULT_RECORDING_AWARENESS.inactivityMs, 60_000);
  assert.equal(recordingAwareness.DEFAULT_RECORDING_AWARENESS.amplitudeThreshold, 0.05);
});

test('recording alarm names stay session scoped', () => {
  assert.equal(
    recordingAwareness.buildRecordingReminderAlarmName('session-42'),
    'recording-reminder:session-42'
  );
  assert.equal(
    recordingAwareness.buildRecordingInactivityAlarmName('session-42'),
    'recording-inactive:session-42'
  );
});

test('inactivity deadline uses last audio heartbeat and falls back to start time', () => {
  const baseState = {
    status: 'recording',
    startTime: 1_000,
    awareness: {
      inactivityMs: 30_000,
      lastAudioAt: 0
    }
  };

  assert.equal(recordingAwareness.calculateInactivityDeadline(baseState), 31_000);
  assert.equal(recordingAwareness.calculateRemainingInactivityMs(baseState, 10_000), 21_000);

  const resetState = {
    ...baseState,
    awareness: {
      ...baseState.awareness,
      lastAudioAt: 25_000
    }
  };

  assert.equal(recordingAwareness.calculateInactivityDeadline(resetState), 55_000);
  assert.equal(recordingAwareness.calculateRemainingInactivityMs(resetState, 40_000), 15_000);
  assert.equal(recordingAwareness.calculateRemainingInactivityMs(resetState, 56_000), 0);
});

test('non-recording states do not produce inactivity deadlines', () => {
  assert.equal(
    recordingAwareness.calculateInactivityDeadline({ status: 'paused', awareness: { inactivityMs: 10_000 } }),
    null
  );
});
