const test = require('node:test');
const assert = require('node:assert/strict');

const { createSummaryViewModel } = require('../popup-summary-ui.js');

test('summary detail view starts idle when transcription has text and no summary yet', () => {
  const viewModel = createSummaryViewModel({
    transcription: { id: 'tx_1', text: 'texto fuente', summary: null },
    request: { id: 'tx_1', status: 'idle', error: null }
  });

  assert.equal(viewModel.state, 'idle');
  assert.equal(viewModel.actionLabel, 'Resumir');
  assert.equal(viewModel.actionDisabled, false);
  assert.equal(viewModel.showCard, false);
});

test('summary detail view shows loading state while a request is in progress', () => {
  const viewModel = createSummaryViewModel({
    transcription: { id: 'tx_1', text: 'texto fuente', summary: null },
    request: { id: 'tx_1', status: 'loading', error: null }
  });

  assert.equal(viewModel.state, 'loading');
  assert.equal(viewModel.actionLabel, 'Resumiendo...');
  assert.equal(viewModel.actionDisabled, true);
  assert.match(viewModel.statusText, /generando/i);
});

test('summary detail view renders ready summaries from persisted storage', () => {
  const viewModel = createSummaryViewModel({
    transcription: {
      id: 'tx_1',
      text: 'texto fuente',
      summary: {
        version: 1,
        status: 'ready',
        short: 'Resumen breve.',
        keyPoints: ['Punto 1', 'Punto 2'],
        updatedAt: Date.now(),
        sourceTextHash: 'hash',
        error: null
      }
    },
    request: { id: 'tx_1', status: 'idle', error: null }
  });

  assert.equal(viewModel.state, 'ready');
  assert.equal(viewModel.actionLabel, 'Actualizar');
  assert.equal(viewModel.showCard, true);
  assert.equal(viewModel.short, 'Resumen breve.');
  assert.deepEqual(viewModel.keyPoints, ['Punto 1', 'Punto 2']);
  assert.equal(viewModel.showStaleBadge, false);
});

test('summary detail view exposes retry state for persisted or transient failures', () => {
  const persistedError = createSummaryViewModel({
    transcription: {
      id: 'tx_1',
      text: 'texto fuente',
      summary: {
        version: 1,
        status: 'error',
        short: '',
        keyPoints: [],
        updatedAt: Date.now(),
        sourceTextHash: 'hash',
        error: { code: 'provider_error', message: 'Timeout del provider.' }
      }
    },
    request: { id: 'tx_1', status: 'idle', error: null }
  });

  assert.equal(persistedError.state, 'error');
  assert.equal(persistedError.actionLabel, 'Reintentar');
  assert.equal(persistedError.showCard, true);
  assert.match(persistedError.errorMessage, /timeout/i);

  const transientError = createSummaryViewModel({
    transcription: { id: 'tx_2', text: 'texto fuente', summary: null },
    request: { id: 'tx_2', status: 'idle', error: { message: 'Falta la API key.' } }
  });

  assert.equal(transientError.state, 'error');
  assert.equal(transientError.actionLabel, 'Reintentar');
  assert.equal(transientError.showCard, true);
  assert.match(transientError.errorMessage, /api key/i);
});

test('summary detail view marks ready summaries as stale when source text changed', () => {
  const viewModel = createSummaryViewModel({
    transcription: {
      id: 'tx_3',
      text: 'texto actualizado',
      summaryMeta: { isStale: true, isLoading: false },
      summary: {
        version: 1,
        status: 'ready',
        short: 'Resumen previo.',
        keyPoints: ['Punto 1'],
        updatedAt: Date.now(),
        sourceTextHash: 'hash-viejo',
        error: null
      }
    },
    request: { id: 'tx_3', status: 'idle', error: null }
  });

  assert.equal(viewModel.state, 'ready');
  assert.equal(viewModel.actionLabel, 'Actualizar resumen');
  assert.equal(viewModel.showStaleBadge, true);
  assert.match(viewModel.statusText, /cambió/i);
});

test('summary detail view keeps loading after popup reopen when background job is still active', () => {
  const viewModel = createSummaryViewModel({
    transcription: {
      id: 'tx_4',
      text: 'texto fuente',
      summaryMeta: { isStale: false, isLoading: true },
      summary: {
        version: 1,
        status: 'ready',
        short: 'Resumen previo.',
        keyPoints: ['Punto 1', 'Punto 2'],
        updatedAt: Date.now(),
        sourceTextHash: 'hash',
        error: null
      }
    },
    request: { id: 'tx_4', status: 'idle', error: null }
  });

  assert.equal(viewModel.state, 'loading');
  assert.equal(viewModel.actionDisabled, true);
  assert.equal(viewModel.showCard, true);
  assert.equal(viewModel.short, 'Resumen previo.');
});
