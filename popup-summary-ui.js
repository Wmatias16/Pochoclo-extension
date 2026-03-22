(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaPopupSummaryUI = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function normalizeKeyPoints(keyPoints) {
    if (!Array.isArray(keyPoints)) {
      return [];
    }

    return keyPoints
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }

  function getSummaryMeta(transcription) {
    const meta = transcription && transcription.summaryMeta && typeof transcription.summaryMeta === 'object'
      ? transcription.summaryMeta
      : null;

    return {
      isLoading: !!(meta && meta.isLoading),
      isStale: !!(meta && meta.isStale)
    };
  }

  function getPersistedSummaryState(transcription) {
    if (!transcription || !transcription.summary || typeof transcription.summary !== 'object') {
      return null;
    }

    const summary = transcription.summary;
    if (summary.status === 'ready' && hasText(summary.short)) {
      return {
        kind: 'ready',
        short: summary.short.trim(),
        keyPoints: normalizeKeyPoints(summary.keyPoints),
        updatedAt: Number.isFinite(Number(summary.updatedAt)) ? Number(summary.updatedAt) : null,
        errorMessage: ''
      };
    }

    if (summary.status === 'error' && summary.error && hasText(summary.error.message)) {
      return {
        kind: 'error',
        short: '',
        keyPoints: [],
        updatedAt: Number.isFinite(Number(summary.updatedAt)) ? Number(summary.updatedAt) : null,
        errorMessage: summary.error.message.trim()
      };
    }

    return null;
  }

  function createSummaryViewModel(options = {}) {
    const transcription = options.transcription || null;
    const request = options.request || null;
    const hasSourceText = hasText(transcription && transcription.text);
    const persistedState = getPersistedSummaryState(transcription);
    const summaryMeta = getSummaryMeta(transcription);
    const transientErrorMessage = hasText(request && request.error && request.error.message)
      ? request.error.message.trim()
      : '';
    const isLoading = !!(request && request.status === 'loading') || summaryMeta.isLoading;

    function withMeta(viewModel) {
      return {
        ...viewModel,
        staleBadgeText: summaryMeta.isStale ? 'Resumen desactualizado' : '',
        showStaleBadge: summaryMeta.isStale
      };
    }

    if (!hasSourceText) {
      return withMeta({
        state: 'idle',
        canSummarize: false,
        actionLabel: 'Resumir',
        actionDisabled: true,
        statusText: 'No hay texto disponible para resumir.',
        showCard: false,
        short: '',
        keyPoints: [],
        errorMessage: ''
      });
    }

    if (isLoading) {
      return withMeta({
        state: 'loading',
        canSummarize: true,
        actionLabel: 'Resumiendo...',
        actionDisabled: true,
        statusText: summaryMeta.isStale
          ? 'Estamos actualizando el resumen para reflejar el texto actual.'
          : 'Estamos generando un resumen breve con los puntos clave.',
        showCard: !!(persistedState && persistedState.kind === 'ready'),
        short: persistedState && persistedState.kind === 'ready' ? persistedState.short : '',
        keyPoints: persistedState && persistedState.kind === 'ready' ? persistedState.keyPoints : [],
        errorMessage: ''
      });
    }

    if (transientErrorMessage) {
      return withMeta({
        state: 'error',
        canSummarize: true,
        actionLabel: 'Reintentar',
        actionDisabled: false,
        statusText: 'No se pudo generar el resumen.',
        showCard: true,
        short: '',
        keyPoints: [],
        errorMessage: transientErrorMessage
      });
    }

    if (persistedState && persistedState.kind === 'ready') {
      return withMeta({
        state: 'ready',
        canSummarize: true,
        actionLabel: summaryMeta.isStale ? 'Actualizar resumen' : 'Actualizar',
        actionDisabled: false,
        statusText: summaryMeta.isStale
          ? 'El texto cambió desde la última generación. Conviene actualizar el resumen.'
          : 'Resumen listo para leer.',
        showCard: true,
        short: persistedState.short,
        keyPoints: persistedState.keyPoints,
        errorMessage: ''
      });
    }

    if (persistedState && persistedState.kind === 'error') {
      return withMeta({
        state: 'error',
        canSummarize: true,
        actionLabel: 'Reintentar',
        actionDisabled: false,
        statusText: 'La última generación falló. Podés probar de nuevo.',
        showCard: true,
        short: '',
        keyPoints: [],
        errorMessage: persistedState.errorMessage
      });
    }

    return withMeta({
      state: 'idle',
      canSummarize: true,
      actionLabel: 'Resumir',
      actionDisabled: false,
      statusText: 'Generá una síntesis corta con los puntos más importantes.',
      showCard: false,
      short: '',
      keyPoints: [],
      errorMessage: ''
    });
  }

  return {
    createSummaryViewModel
  };
});
