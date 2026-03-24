const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDefaultProviderSettings } = require('../storage/settings.js');
const { createHarness } = require('./helpers/extension-harness.js');

function createSettings() {
  const settings = buildDefaultProviderSettings();
  settings.providers.openai.apiKey = 'sk-openai';
  return settings;
}

test('background resets progress on start, keeps totals monotonic, rejects stale snapshots, and clears after drain completion', { concurrency: false }, async (t) => {
  const harness = createHarness({
    initialStorage: {
      providerSettings: createSettings(),
      transcriptionProgress: {
        sessionId: 'stale-session',
        totalChunks: 8,
        completedChunks: 8,
        status: 'done',
        updatedAt: 101
      }
    }
  });
  t.after(() => harness.dispose());

  const background = require('../background.js');
  const started = await harness.startCapture({ tabId: 41, tabTitle: 'Progress reset', tabUrl: 'https://example.com/progress-reset' });
  assert.equal(started.ok, true);

  const startedProgress = harness.storageArea.store.transcriptionProgress;
  assert.equal(startedProgress.sessionId, started.transcriptSession.id);
  assert.equal(startedProgress.totalChunks, 0);
  assert.equal(startedProgress.completedChunks, 0);
  assert.equal(startedProgress.status, 'active');

  const firstSync = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 3,
    status: 'active',
    updatedAt: 1_111
  });
  assert.equal(firstSync.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 0);

  const monotonicSync = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 1,
    status: 'active',
    updatedAt: 1_222
  });
  assert.equal(monotonicSync.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);

  const staleSync = await background.syncTranscriptionProgress({
    sessionId: 'old-session',
    totalChunks: 99,
    status: 'draining',
    updatedAt: 1_333
  });
  assert.deepEqual(staleSync, { ok: true, ignored: true, reason: 'stale-session' });
  assert.equal(harness.storageArea.store.transcriptionProgress.totalChunks, 3);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'active');

  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);
  assert.equal(harness.storageArea.store.recState.status, 'idle');

  const drainingSync = await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 3,
    status: 'draining',
    updatedAt: 1_444
  });
  assert.equal(drainingSync.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'draining');

  await background.patchTranscriptionProgress({
    completedChunks: 2,
    status: 'draining',
    updatedAt: 1_555
  });
  const stillVisible = await background.maybeFinalizeTranscriptionProgress();
  assert.equal(stillVisible.completedChunks, 2);
  assert.equal(stillVisible.status, 'draining');
  assert.equal('transcriptionProgress' in harness.storageArea.store, true);

  await background.patchTranscriptionProgress({
    completedChunks: 3,
    status: 'done',
    updatedAt: 1_666
  });
  const finalized = await background.maybeFinalizeTranscriptionProgress();
  assert.equal(finalized, null);
  assert.equal('transcriptionProgress' in harness.storageArea.store, false);
});

test('background counts successful and failed terminal chunk outcomes as completed exactly once before final cleanup', { concurrency: false }, async (t) => {
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
  const started = await harness.startCapture({ tabId: 42, tabTitle: 'Terminal completion', tabUrl: 'https://example.com/terminal-completion' });
  assert.equal(started.ok, true);

  await background.syncTranscriptionProgress({
    sessionId: started.transcriptSession.id,
    totalChunks: 2,
    status: 'active',
    updatedAt: 2_000
  });

  const firstChunk = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 0,
    body: 'good-audio'
  });
  assert.equal(firstChunk.ok, true);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 1);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'active');

  const secondChunk = await harness.dispatchChunk({
    sessionId: started.transcriptSession.id,
    chunkIndex: 1,
    body: 'bad-audio'
  });
  assert.equal(secondChunk.ok, false);
  assert.equal(harness.storageArea.store.transcriptionProgress.completedChunks, 2);
  assert.equal(harness.storageArea.store.transcriptionProgress.status, 'done');

  const stopped = await harness.stopCapture();
  assert.equal(stopped.ok, true);
  assert.equal('transcriptionProgress' in harness.storageArea.store, false);
});
