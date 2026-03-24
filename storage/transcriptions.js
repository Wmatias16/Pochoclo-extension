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

  function normalizeMode(mode, fallback = 'batch') {
    return mode === 'live' ? 'live' : fallback;
  }

  function normalizeCount(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
  }

  function normalizeTimestamp(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function normalizeProviderAttribution(value, fallbackProvider) {
    const source = Array.isArray(value)
      ? value
      : (hasText(value) ? [value] : []);

    const normalized = source
      .map((entry) => (hasText(entry) ? entry.trim() : ''))
      .filter(Boolean)
      .filter((entry, index, list) => list.indexOf(entry) === index);

    if (normalized.length > 0) {
      return normalized;
    }

    return hasText(fallbackProvider) ? [fallbackProvider.trim()] : [];
  }

  function normalizeLiveMeta(liveMeta, fallback = {}) {
    if (!liveMeta || typeof liveMeta !== 'object') {
      liveMeta = {};
    }

    const normalized = {
      reconnectCount: normalizeCount(
        liveMeta.reconnectCount,
        normalizeCount(fallback.reconnectCount, 0)
      ),
      finalSegments: normalizeCount(
        liveMeta.finalSegments,
        normalizeCount(fallback.finalSegments, 0)
      ),
      startedAt: normalizeTimestamp(
        liveMeta.startedAt !== undefined ? liveMeta.startedAt : fallback.startedAt
      ),
      endedAt: normalizeTimestamp(
        liveMeta.endedAt !== undefined ? liveMeta.endedAt : fallback.endedAt
      )
    };

    return normalized;
  }

  function normalizeLiveEvent(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    return {
      event: hasText(entry.event) ? entry.event.trim() : 'live:unknown',
      sessionId: hasText(entry.sessionId) ? entry.sessionId.trim() : null,
      timestamp: normalizeTimestamp(entry.timestamp),
      provider: hasText(entry.provider) ? entry.provider.trim() : null,
      payload: entry.payload && typeof entry.payload === 'object'
        ? JSON.parse(JSON.stringify(entry.payload))
        : null
    };
  }

  function normalizeTranscription(record = {}, defaultMode = 'batch') {
    const text = typeof record.text === 'string'
      ? record.text
      : (typeof record.final === 'string' ? record.final : '');
    const final = typeof record.final === 'string' ? record.final : text;
    const mode = normalizeMode(record.mode, defaultMode);
    const reconnectCount = normalizeCount(
      record.reconnectCount,
      normalizeCount(record.liveMeta && record.liveMeta.reconnectCount, 0)
    );

    return {
      text,
      final,
      interim: typeof record.interim === 'string' ? record.interim : '',
      mode,
      fallbackReason: hasText(record.fallbackReason) ? record.fallbackReason.trim() : null,
      liveMeta: record.liveMeta && typeof record.liveMeta === 'object'
        ? normalizeLiveMeta(record.liveMeta, {
          reconnectCount,
          finalSegments: record.finalSegments,
          startedAt: record.startedAt,
          endedAt: record.endedAt
        })
        : null,
      reconnectCount,
      terminalStatus: hasText(record.terminalStatus)
        ? record.terminalStatus.trim()
        : null,
      providerAttribution: Array.isArray(record.providerAttribution) || hasText(record.providerAttribution)
        ? normalizeProviderAttribution(record.providerAttribution, null)
        : null
    };
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
      mode: normalizeMode(session.mode),
      fallbackReason: hasText(session.fallbackReason) ? session.fallbackReason.trim() : null,
      reconnectCount: normalizeCount(
        session.reconnectCount,
        normalizeCount(session.live && session.live.reconnects, 0)
      ),
      terminalStatus: hasText(session.terminalStatus)
        ? session.terminalStatus.trim()
        : normalizeStatus(session.status, 'completed'),
      providerAttribution: normalizeProviderAttribution(
        session.providerAttribution,
        hasText(session.resolvedProvider) ? session.resolvedProvider : session.activeProvider
      ),
      liveMeta: normalizeLiveMeta(session.liveMeta, {
        reconnectCount: session.reconnectCount,
        finalSegments: session.live && session.live.finalSegments,
        startedAt: session.startedAt,
        endedAt: session.endedAt
      }),
      liveEvents: Array.isArray(session.audit && session.audit.liveEvents)
        ? session.audit.liveEvents.map(normalizeLiveEvent).filter(Boolean)
        : [],
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
      mode: normalizeMode(providerAudit.mode, 'batch'),
      fallbackReason: hasText(providerAudit.fallbackReason) ? providerAudit.fallbackReason.trim() : null,
      reconnectCount: normalizeCount(providerAudit.reconnectCount, 0),
      terminalStatus: hasText(providerAudit.terminalStatus)
        ? providerAudit.terminalStatus.trim()
        : fallbackStatus,
      providerAttribution: normalizeProviderAttribution(
        providerAudit.providerAttribution,
        hasText(providerAudit.resolvedProvider) ? providerAudit.resolvedProvider : fallbackResolvedProvider
      ),
      liveMeta: normalizeLiveMeta(providerAudit.liveMeta, {
        reconnectCount: providerAudit.reconnectCount,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt
      }),
      liveEvents: Array.isArray(providerAudit.liveEvents)
        ? providerAudit.liveEvents.map(normalizeLiveEvent).filter(Boolean)
        : [],
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
    const transcript = normalizeTranscription(entry, providerAudit && providerAudit.mode ? providerAudit.mode : 'batch');
    const resolvedProvider = hasText(entry.resolvedProvider)
      ? entry.resolvedProvider.trim()
      : (providerAudit && hasText(providerAudit.resolvedProvider) ? providerAudit.resolvedProvider.trim() : 'openai');
    const status = normalizeStatus(entry.status || (providerAudit && providerAudit.status), 'completed');

    return {
      ...entry,
      ...transcript,
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

  async function getLiveTranscript(sessionId, storageArea) {
    if (!hasText(sessionId)) {
      return null;
    }

    const area = storageArea || chrome.storage.local;

    const liveData = await area.get('currentLiveTranscript');
    const currentLiveTranscript = liveData && liveData.currentLiveTranscript;

    if (currentLiveTranscript) {
      if (currentLiveTranscript.sessionId !== sessionId) {
        return null;
      }

      return {
        text: currentLiveTranscript.text || '',
        interim: currentLiveTranscript.interim || '',
        mode: currentLiveTranscript.mode || 'batch'
      };
    }

    const stored = await area.get(['transcript', 'transcriptSession']);
    const transcriptSession = stored && stored.transcriptSession ? stored.transcriptSession : null;

    if (!transcriptSession || transcriptSession.id !== sessionId) {
      return null;
    }

    const transcript = normalizeTranscription({
      ...(stored && stored.transcript ? stored.transcript : {}),
      text: stored && stored.transcript && typeof stored.transcript.text === 'string'
        ? stored.transcript.text
        : (transcriptSession.live && typeof transcriptSession.live.finalText === 'string' ? transcriptSession.live.finalText : ''),
      final: stored && stored.transcript && typeof stored.transcript.final === 'string'
        ? stored.transcript.final
        : (transcriptSession.live && typeof transcriptSession.live.finalText === 'string' ? transcriptSession.live.finalText : ''),
      interim: stored && stored.transcript && typeof stored.transcript.interim === 'string'
        ? stored.transcript.interim
        : (transcriptSession.live && typeof transcriptSession.live.partialText === 'string' ? transcriptSession.live.partialText : ''),
      mode: transcriptSession.mode === 'live' ? 'live' : 'batch',
      fallbackReason: transcriptSession.fallbackReason || (stored && stored.transcript ? stored.transcript.fallbackReason : null),
      reconnectCount: transcriptSession.reconnectCount,
      terminalStatus: transcriptSession.terminalStatus,
      providerAttribution: transcriptSession.providerAttribution || (stored && stored.transcript ? stored.transcript.providerAttribution : []),
      liveMeta: transcriptSession.liveMeta || (stored && stored.transcript ? stored.transcript.liveMeta : null)
    }, transcriptSession.mode === 'live' ? 'live' : 'batch');

    return {
      text: transcript.text,
      interim: transcript.interim,
      mode: transcript.mode,
      sessionId: transcriptSession.id,
      final: transcript.final,
      fallbackReason: transcript.fallbackReason,
      reconnectCount: transcript.reconnectCount,
      terminalStatus: transcript.terminalStatus,
      providerAttribution: Array.isArray(transcript.providerAttribution)
        ? transcript.providerAttribution.slice()
        : null,
      liveMeta: transcript.liveMeta ? { ...transcript.liveMeta } : null
    };
  }

  return {
    createProviderAuditSnapshot,
    getLiveTranscript,
    normalizeProviderAudit,
    normalizeTranscription,
    normalizeTranscriptionSummary,
    normalizeSavedTranscription,
    normalizeSavedTranscriptions
  };
});
