(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaProviderSessionRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function cloneAttempts(session) {
    return Array.isArray(session && session.attempts)
      ? session.attempts.map((attempt) => ({ ...attempt }))
      : [];
  }

  function getAttemptOrder(session, providerId, attempts) {
    const plan = Array.isArray(session && session.providerPlan) ? session.providerPlan : [];
    const planIndex = plan.indexOf(providerId);
    if (planIndex >= 0) {
      return planIndex + 1;
    }

    return (Array.isArray(attempts) ? attempts.length : 0) + 1;
  }

  function asChunkIndex(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function logEvent(logger, level, event, context) {
    if (logger && typeof logger[level] === 'function') {
      logger[level](event, context);
    }
  }

  function upsertAttempt(session, providerId, patch = {}, timestamp) {
    const attempts = cloneAttempts(session);
    const now = typeof timestamp === 'number' ? timestamp : Date.now();
    const index = attempts.findIndex((attempt) => attempt.providerId === providerId);
    const current = index >= 0 ? attempts[index] : null;
    const next = {
      providerId,
      order: getAttemptOrder(session, providerId, attempts),
      status: patch.status || (current && current.status) || 'active',
      startedAt: patch.startedAt || (current && current.startedAt) || now,
      endedAt: patch.status === 'active'
        ? null
        : (patch.endedAt || (current && current.endedAt) || now),
      chunkIndex: asChunkIndex(patch.chunkIndex, asChunkIndex(current && current.chunkIndex, 0)),
      errorCode: patch.errorCode !== undefined ? patch.errorCode : ((current && current.errorCode) || null),
      errorSummary: patch.errorSummary !== undefined ? patch.errorSummary : ((current && current.errorSummary) || null)
    };

    if (index >= 0) {
      attempts[index] = next;
    } else {
      attempts.push(next);
    }

    return attempts;
  }

  function ensureActiveAttempt(session, providerId, timestamp) {
    if (!providerId) {
      return cloneAttempts(session);
    }

    return upsertAttempt(session, providerId, { status: 'active' }, timestamp);
  }

  function getNextProviderId(session, providerId) {
    const plan = Array.isArray(session && session.providerPlan) ? session.providerPlan : [];
    const currentIndex = plan.indexOf(providerId);
    if (currentIndex < 0) {
      return plan[0] || null;
    }

    return plan[currentIndex + 1] || null;
  }

  function createNoProviderResponse(session) {
    return {
      ok: false,
      providerId: null,
      code: 'unavailable',
      retryable: false,
      error: 'No hay providers elegibles para continuar la sesión.',
      session: {
        ...(session || {}),
        status: 'failed',
        endedAt: Date.now()
      }
    };
  }

  async function executeChunkWithFallback(input = {}) {
    const now = typeof input.now === 'function' ? input.now : () => Date.now();
    const normalizeProviderError = typeof input.normalizeProviderError === 'function'
      ? input.normalizeProviderError
      : (error) => ({
          code: 'unknown',
          summary: error && error.message ? error.message : 'Falló la transcripción por un error inesperado.',
          retryable: false,
          status: error && error.status ? error.status : 0
        });
    const getProviderAdapter = typeof input.getProviderAdapter === 'function'
      ? input.getProviderAdapter
      : () => null;
    const getProviderLabel = typeof input.getProviderLabel === 'function'
      ? input.getProviderLabel
      : (providerId) => providerId;
    const appendTranscriptText = typeof input.appendTranscriptText === 'function'
      ? input.appendTranscriptText
      : async () => {};
    const isHallucination = typeof input.isHallucination === 'function'
      ? input.isHallucination
      : () => false;
    const log = input.log || console;

    let session = {
      ...(input.session || {}),
      attempts: cloneAttempts(input.session),
      providerPlan: Array.isArray(input.session && input.session.providerPlan)
        ? input.session.providerPlan.slice()
        : []
    };

    let providerId = session.activeProvider || session.providerPlan[0] || null;
    if (!providerId) {
      logEvent(log, 'warn', 'chunk.no-provider-available', {
        sessionId: session.id || null,
        chunkIndex: input.message && input.message.chunkIndex,
        providerPlan: session.providerPlan
      });
      return createNoProviderResponse(session);
    }

    while (providerId) {
      const attemptStartedAt = now();
      session.attempts = ensureActiveAttempt(session, providerId, attemptStartedAt);

      const providerLabel = getProviderLabel(providerId);
      const currentAttempt = session.attempts.find((attempt) => attempt.providerId === providerId) || null;
      const attemptOrder = currentAttempt && currentAttempt.order ? currentAttempt.order : null;
      const adapter = getProviderAdapter(providerId);
      logEvent(log, 'info', 'chunk.attempt-started', {
        sessionId: session.id || null,
        providerId,
        providerLabel,
        attemptOrder,
        chunkIndex: input.message && input.message.chunkIndex
      });
      if (!adapter || typeof adapter.transcribe !== 'function') {
        const normalized = normalizeProviderError(new Error(`No existe un adapter cargado para ${providerLabel}.`), { providerId });
        session.attempts = upsertAttempt(session, providerId, {
          status: 'failed',
          startedAt: attemptStartedAt,
          endedAt: now(),
          chunkIndex: input.message && input.message.chunkIndex,
          errorCode: normalized.code,
          errorSummary: normalized.summary
        });
        session.status = 'failed';
        session.lastChunkError = {
          providerId,
          chunkIndex: input.message && Number.isFinite(Number(input.message.chunkIndex)) ? Number(input.message.chunkIndex) : 0,
          code: normalized.code,
          summary: normalized.summary,
          at: now()
        };
        session.endedAt = now();

        logEvent(log, 'error', 'chunk.adapter-missing', {
          sessionId: session.id || null,
          providerId,
          providerLabel,
          attemptOrder,
          chunkIndex: input.message && input.message.chunkIndex,
          code: normalized.code,
          summary: normalized.summary
        });

        return {
          ok: false,
          providerId,
          error: normalized.summary,
          code: normalized.code,
          retryable: false,
          session
        };
      }

      const providerSettings = input.providerSettings || {};
      const providerConfig = (providerSettings.providers && providerSettings.providers[providerId]) || {};

      try {
        if (typeof adapter.preflight === 'function') {
          logEvent(log, 'info', 'chunk.preflight-started', {
            sessionId: session.id || null,
            providerId,
            providerLabel,
            attemptOrder,
            chunkIndex: input.message && input.message.chunkIndex
          });

          const preflight = await adapter.preflight(providerConfig, {
            fetchImpl: input.fetchImpl
          });

          if (!preflight || !preflight.ok) {
            logEvent(log, 'warn', 'chunk.preflight-failed', {
              sessionId: session.id || null,
              providerId,
              providerLabel,
              attemptOrder,
              chunkIndex: input.message && input.message.chunkIndex,
              reason: (preflight && preflight.reason) || 'preflight_failed',
              status: preflight && preflight.status ? preflight.status : 0
            });
            const error = new Error(`Preflight falló para ${providerLabel}`);
            error.code = 'unavailable';
            error.status = preflight && preflight.status ? preflight.status : 503;
            throw error;
          }

          logEvent(log, 'info', 'chunk.preflight-succeeded', {
            sessionId: session.id || null,
            providerId,
            providerLabel,
            attemptOrder,
            chunkIndex: input.message && input.message.chunkIndex
          });
        }

        const result = await adapter.transcribe(
          {
            blob: input.message && input.message.blob,
            language: session.language || 'es',
            targetLanguage: session.targetLanguage || 'es',
            settings: providerConfig,
            context: {
              sessionId: session.id,
              chunkIndex: input.message && Number.isFinite(Number(input.message.chunkIndex))
                ? Number(input.message.chunkIndex)
                : 0,
              audioSampleRate: input.message
                && input.message.audioMetadata
                && Number.isFinite(Number(input.message.audioMetadata.sampleRate))
                ? Number(input.message.audioMetadata.sampleRate)
                : undefined
            }
          },
          {
            fetchImpl: input.fetchImpl,
            setTimeoutImpl: input.setTimeoutImpl,
            clearTimeoutImpl: input.clearTimeoutImpl
          }
        );

        const transcriptText = result && typeof result.text === 'string' ? result.text.trim() : '';
        const shouldAppend = transcriptText && !isHallucination(transcriptText);
        if (shouldAppend) {
          await appendTranscriptText(`${transcriptText} `);
        }

        session.status = 'recording';
        session.activeProvider = providerId;
        session.resolvedProvider = providerId;
        session.lastChunkAt = now();
        session.lastChunkError = null;

        logEvent(log, 'info', 'chunk.attempt-succeeded', {
          sessionId: session.id || null,
          providerId,
          providerLabel,
          attemptOrder,
          chunkIndex: input.message && input.message.chunkIndex,
          transcriptAppended: !!shouldAppend
        });

        return {
          ok: true,
          providerId,
          transcriptAppended: !!shouldAppend,
          session
        };
      } catch (error) {
        const normalized = normalizeProviderError(error, { providerId });
        session.attempts = upsertAttempt(session, providerId, {
          status: 'failed',
          startedAt: attemptStartedAt,
          endedAt: now(),
          chunkIndex: input.message && input.message.chunkIndex,
          errorCode: normalized.code,
          errorSummary: normalized.summary
        });
        session.lastChunkError = {
          providerId,
          chunkIndex: input.message && Number.isFinite(Number(input.message.chunkIndex)) ? Number(input.message.chunkIndex) : 0,
          code: normalized.code,
          summary: normalized.summary,
          at: now()
        };

        logEvent(log, 'warn', 'chunk.attempt-failed', {
          sessionId: session.id || null,
          providerId,
          providerLabel,
          attemptOrder,
          chunkIndex: input.message && input.message.chunkIndex,
          code: normalized.code,
          summary: normalized.summary,
          retryable: !!normalized.retryable,
          status: normalized.status || 0
        });

        const nextProviderId = normalized.retryable ? getNextProviderId(session, providerId) : null;
        if (nextProviderId) {
          session.activeProvider = nextProviderId;
          logEvent(log, 'info', 'chunk.provider-rotated', {
            sessionId: session.id || null,
            fromProviderId: providerId,
            toProviderId: nextProviderId,
            chunkIndex: input.message && input.message.chunkIndex,
            code: normalized.code,
            attemptOrder
          });
          providerId = nextProviderId;
          continue;
        }

        session.status = 'failed';
        session.endedAt = now();
        logEvent(log, 'warn', 'chunk.fallback-exhausted', {
          sessionId: session.id || null,
          providerId,
          providerLabel,
          attemptOrder,
          chunkIndex: input.message && input.message.chunkIndex,
          code: normalized.code,
          retryable: !!normalized.retryable,
          attemptedProviders: session.attempts.map((attempt) => attempt.providerId)
        });
        return {
          ok: false,
          providerId,
          error: normalized.summary,
          code: normalized.code,
          retryable: false,
          session
        };
      }
    }

    return createNoProviderResponse(session);
  }

  function finalizeSession(session, options = {}) {
    if (!session) {
      return session;
    }

    const endedAt = typeof options.endedAt === 'number' ? options.endedAt : Date.now();
    const status = options.status || (session.status === 'failed' ? 'failed' : 'completed');
    const finalProvider = options.finalProvider || session.resolvedProvider || session.activeProvider || null;
    const next = {
      ...session,
      status,
      endedAt,
      attempts: cloneAttempts(session)
    };

    if (status !== 'failed' && finalProvider) {
      next.resolvedProvider = finalProvider;
      next.attempts = upsertAttempt(next, finalProvider, {
        status: 'succeeded',
        endedAt
      }, endedAt);
    }

    return next;
  }

  return {
    cloneAttempts,
    ensureActiveAttempt,
    executeChunkWithFallback,
    finalizeSession,
    getNextProviderId,
    upsertAttempt
  };
});
