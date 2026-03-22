(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaTranscriptionStorage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function logEvent(logger, level, event, context) {
    if (logger && typeof logger[level] === 'function') {
      logger[level](event, context);
    }
  }

  function normalizeStatus(status, fallback = 'completed') {
    if (!hasText(status)) return fallback;
    return status.trim();
  }

  function normalizeAttempt(attempt, index) {
    if (!attempt || typeof attempt !== 'object') {
      return null;
    }

    return {
      providerId: hasText(attempt.providerId) ? attempt.providerId.trim() : 'openai',
      order: Number.isFinite(Number(attempt.order)) ? Number(attempt.order) : index + 1,
      status: normalizeStatus(attempt.status, 'failed'),
      startedAt: Number.isFinite(Number(attempt.startedAt)) ? Number(attempt.startedAt) : null,
      endedAt: Number.isFinite(Number(attempt.endedAt)) ? Number(attempt.endedAt) : null,
      chunkIndex: Number.isFinite(Number(attempt.chunkIndex)) ? Number(attempt.chunkIndex) : 0,
      errorCode: hasText(attempt.errorCode) ? attempt.errorCode.trim() : null,
      errorSummary: hasText(attempt.errorSummary) ? attempt.errorSummary.trim() : null
    };
  }

  function createProviderAuditSnapshot(session) {
    if (!session || typeof session !== 'object') {
      return null;
    }

    return {
      providerPlan: Array.isArray(session.providerPlan) ? session.providerPlan.slice() : [],
      attempts: Array.isArray(session.attempts)
        ? session.attempts
          .map((attempt, index) => normalizeAttempt(attempt, index))
          .filter(Boolean)
        : [],
      eligibleProviders: Array.isArray(session.audit && session.audit.eligibleProviders)
        ? session.audit.eligibleProviders.slice()
        : [],
      skippedProviders: Array.isArray(session.audit && session.audit.skippedProviders)
        ? session.audit.skippedProviders.map((entry) => ({ ...entry }))
        : [],
      providerOverride: hasText(session.providerOverride) ? session.providerOverride.trim() : null,
      defaultProvider: hasText(session.defaultProvider) ? session.defaultProvider.trim() : 'openai',
      activeProvider: hasText(session.activeProvider) ? session.activeProvider.trim() : null,
      resolvedProvider: hasText(session.resolvedProvider)
        ? session.resolvedProvider.trim()
        : (hasText(session.activeProvider) ? session.activeProvider.trim() : null),
      lastChunkError: session.lastChunkError
        ? {
            providerId: hasText(session.lastChunkError.providerId) ? session.lastChunkError.providerId.trim() : null,
            chunkIndex: Number.isFinite(Number(session.lastChunkError.chunkIndex)) ? Number(session.lastChunkError.chunkIndex) : 0,
            code: hasText(session.lastChunkError.code) ? session.lastChunkError.code.trim() : null,
            summary: hasText(session.lastChunkError.summary) ? session.lastChunkError.summary.trim() : null,
            at: Number.isFinite(Number(session.lastChunkError.at)) ? Number(session.lastChunkError.at) : null
          }
        : null,
      status: normalizeStatus(session.status, 'completed')
    };
  }

  function normalizeProviderAudit(providerAudit, entry = {}) {
    if (!providerAudit || typeof providerAudit !== 'object') {
      return null;
    }

    const attempts = Array.isArray(providerAudit.attempts)
      ? providerAudit.attempts
        .map((attempt, index) => normalizeAttempt(attempt, index))
        .filter(Boolean)
        .sort((left, right) => left.order - right.order)
      : [];

    const fallbackResolvedProvider = hasText(entry.resolvedProvider) ? entry.resolvedProvider.trim() : null;
    const fallbackStatus = hasText(entry.status) ? entry.status.trim() : 'completed';

    return {
      providerPlan: Array.isArray(providerAudit.providerPlan) ? providerAudit.providerPlan.slice() : [],
      attempts,
      eligibleProviders: Array.isArray(providerAudit.eligibleProviders) ? providerAudit.eligibleProviders.slice() : [],
      skippedProviders: Array.isArray(providerAudit.skippedProviders)
        ? providerAudit.skippedProviders.map((item) => ({ ...item }))
        : [],
      providerOverride: hasText(providerAudit.providerOverride) ? providerAudit.providerOverride.trim() : null,
      defaultProvider: hasText(providerAudit.defaultProvider) ? providerAudit.defaultProvider.trim() : 'openai',
      activeProvider: hasText(providerAudit.activeProvider) ? providerAudit.activeProvider.trim() : null,
      resolvedProvider: hasText(providerAudit.resolvedProvider)
        ? providerAudit.resolvedProvider.trim()
        : fallbackResolvedProvider,
      lastChunkError: providerAudit.lastChunkError
        ? {
            providerId: hasText(providerAudit.lastChunkError.providerId) ? providerAudit.lastChunkError.providerId.trim() : null,
            chunkIndex: Number.isFinite(Number(providerAudit.lastChunkError.chunkIndex)) ? Number(providerAudit.lastChunkError.chunkIndex) : 0,
            code: hasText(providerAudit.lastChunkError.code) ? providerAudit.lastChunkError.code.trim() : null,
            summary: hasText(providerAudit.lastChunkError.summary) ? providerAudit.lastChunkError.summary.trim() : null,
            at: Number.isFinite(Number(providerAudit.lastChunkError.at)) ? Number(providerAudit.lastChunkError.at) : null
          }
        : null,
      status: normalizeStatus(providerAudit.status, fallbackStatus)
    };
  }

  function normalizeSummaryError(summaryError) {
    if (!summaryError || typeof summaryError !== 'object') {
      return null;
    }

    const code = hasText(summaryError.code) ? summaryError.code.trim() : null;
    const message = hasText(summaryError.message) ? summaryError.message.trim() : null;

    if (!code || !message) {
      return null;
    }

    return { code, message };
  }

  function normalizeTranscriptionSummary(summary) {
    if (!summary || typeof summary !== 'object') {
      return null;
    }

    const status = hasText(summary.status) ? summary.status.trim() : '';
    if (status !== 'ready' && status !== 'error') {
      return null;
    }

    const version = Number(summary.version);
    if (!Number.isFinite(version) || version < 1) {
      return null;
    }

    const updatedAt = Number(summary.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      return null;
    }

    const sourceTextHash = hasText(summary.sourceTextHash) ? summary.sourceTextHash.trim() : '';
    if (!sourceTextHash) {
      return null;
    }

    const short = typeof summary.short === 'string' ? summary.short.trim() : '';
    const keyPoints = Array.isArray(summary.keyPoints)
      ? summary.keyPoints
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
      : null;

    if (!keyPoints) {
      return null;
    }

    const error = normalizeSummaryError(summary.error);

    if (status === 'ready') {
      if (!short || keyPoints.length === 0 || error !== null) {
        return null;
      }
    }

    if (status === 'error') {
      if (!error) {
        return null;
      }
    }

    return {
      version,
      status,
      short,
      keyPoints,
      model: hasText(summary.model) ? summary.model.trim() : null,
      updatedAt,
      sourceTextHash,
      error
    };
  }

  function normalizeSavedTranscription(entry = {}) {
    const providerAudit = normalizeProviderAudit(entry.providerAudit, entry);
    const summary = normalizeTranscriptionSummary(entry.summary);
    const resolvedProvider = hasText(entry.resolvedProvider)
      ? entry.resolvedProvider.trim()
      : (providerAudit && hasText(providerAudit.resolvedProvider) ? providerAudit.resolvedProvider.trim() : 'openai');
    const status = normalizeStatus(entry.status || (providerAudit && providerAudit.status), 'completed');

    return {
      ...entry,
      text: typeof entry.text === 'string' ? entry.text : '',
      resolvedProvider,
      status,
      providerAudit,
      summary
    };
  }

  function normalizeSavedTranscriptions(entries, options = {}) {
    if (!Array.isArray(entries)) {
      return [];
    }

    let migratedEntries = 0;
    const normalizedEntries = entries.map((entry) => {
      const normalizedEntry = normalizeSavedTranscription(entry);
      if (JSON.stringify(entry) !== JSON.stringify(normalizedEntry)) {
        migratedEntries += 1;
      }
      return normalizedEntry;
    });

    if (migratedEntries > 0) {
      logEvent(options.logger, 'info', 'transcriptions.history-normalized', {
        migratedEntries,
        totalEntries: entries.length,
        migration: 'lazy_history_normalization'
      });
    }

    return normalizedEntries;
  }

  return {
    createProviderAuditSnapshot,
    normalizeProviderAudit,
    normalizeTranscriptionSummary,
    normalizeSavedTranscription,
    normalizeSavedTranscriptions
  };
});
