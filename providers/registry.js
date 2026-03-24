(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaProviderRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROVIDER_ORDER = ['openai', 'deepgram', 'assemblyai', 'groq', 'google', 'whisperLocal'];
  const MAX_PROVIDER_ATTEMPTS = 3;

  function logEvent(logger, level, event, context) {
    if (logger && typeof logger[level] === 'function') {
      logger[level](event, context);
    }
  }

  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function normalizeProviderId(providerId) {
    if (!hasText(providerId)) return null;
    const normalized = providerId.trim();
    return PROVIDER_ORDER.includes(normalized) ? normalized : null;
  }

  function sanitizeBaseUrl(baseUrl) {
    if (!hasText(baseUrl)) return '';
    return baseUrl.trim().replace(/\/+$/, '');
  }

  function normalizeMode(mode) {
    return mode === 'live' ? 'live' : 'batch';
  }

  async function whisperLocalPreflight(config, deps = {}) {
    const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (typeof fetchImpl !== 'function') {
      return { ok: false, reason: 'missing_fetch' };
    }

    const baseUrl = sanitizeBaseUrl(config.baseUrl);
    const healthPath = hasText(config.healthPath) ? config.healthPath.trim() : '/health';

    try {
      const response = await fetchImpl(`${baseUrl}${healthPath}`, { method: 'GET' });
      if (response && response.ok) {
        return { ok: true };
      }

      return {
        ok: false,
        reason: 'healthcheck_failed',
        status: response && typeof response.status === 'number' ? response.status : 0
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'healthcheck_failed',
        error
      };
    }
  }

  const PROVIDERS = {
    openai: {
      id: 'openai',
      label: 'OpenAI',
      liveNative: false,
      liveAudioFormat: null,
      // Future OpenAI Realtime rollout will flip this to `pcm16` with a transcoder path.
      requiresPCM: false,
      supportsBatchFallback: true,
      isConfigured(config) {
        return hasText(config.apiKey);
      }
    },
    deepgram: {
      id: 'deepgram',
      label: 'Deepgram',
      liveNative: true,
      // Deepgram live stays on direct MediaRecorder WebM/Opus; no PCM transcoding.
      liveAudioFormat: 'webm/opus',
      requiresPCM: false,
      supportsBatchFallback: true,
      isConfigured(config) {
        return hasText(config.apiKey);
      }
    },
    assemblyai: {
      id: 'assemblyai',
      label: 'AssemblyAI',
      liveNative: false,
      liveAudioFormat: null,
      // Future AssemblyAI rollout will flip this to `pcm16` with a transcoder path.
      requiresPCM: false,
      // TODO: Phase future — PCM transcoding for AssemblyAI/OpenAI Realtime.
      supportsBatchFallback: true,
      isConfigured(config) {
        return hasText(config.apiKey);
      }
    },
    groq: {
      id: 'groq',
      label: 'Groq',
      liveNative: false,
      liveAudioFormat: null,
      requiresPCM: false,
      supportsBatchFallback: true,
      isConfigured(config) {
        return hasText(config.apiKey);
      }
    },
    google: {
      id: 'google',
      label: 'Google',
      liveNative: false,
      liveAudioFormat: null,
      requiresPCM: false,
      supportsBatchFallback: true,
      isConfigured(config) {
        return hasText(config.apiKey);
      }
    },
    whisperLocal: {
      id: 'whisperLocal',
      label: 'Whisper local',
      liveNative: false,
      liveAudioFormat: null,
      requiresPCM: false,
      supportsBatchFallback: true,
      isConfigured(config) {
        return hasText(config.baseUrl);
      },
      preflight: whisperLocalPreflight
    }
  };

  function listProviders() {
    return PROVIDER_ORDER.map((providerId) => ({
      id: providerId,
      label: PROVIDERS[providerId].label
    }));
  }

  function getProviderDefinition(providerId) {
    const normalized = normalizeProviderId(providerId);
    return normalized ? PROVIDERS[normalized] : null;
  }

  async function getProviderEligibility(providerId, providerSettings, deps = {}) {
    const definition = getProviderDefinition(providerId);
    const logger = deps.logger;
    if (!definition) {
      logEvent(logger, 'warn', 'provider.eligibility-skipped', {
        providerId,
        reason: 'unknown_provider'
      });
      return { providerId, eligible: false, reason: 'unknown_provider' };
    }

    const config = (providerSettings && providerSettings.providers && providerSettings.providers[providerId]) || {};
    const enabled = config.enabled !== false;

    if (!enabled) {
      logEvent(logger, 'info', 'provider.eligibility-skipped', {
        providerId,
        reason: 'disabled'
      });
      return { providerId, eligible: false, reason: 'disabled' };
    }

    const requestedMode = normalizeMode(deps.mode);
    if (requestedMode === 'live') {
      if (!definition.liveNative) {
        logEvent(logger, 'info', 'provider.eligibility-skipped', {
          providerId,
          reason: 'live_not_supported'
        });
        return { providerId, eligible: false, reason: 'live_not_supported' };
      }

      if (config.liveEnabled !== true) {
        logEvent(logger, 'info', 'provider.eligibility-skipped', {
          providerId,
          reason: 'live_disabled'
        });
        return { providerId, eligible: false, reason: 'live_disabled' };
      }
    }

    if (!definition.isConfigured(config, providerSettings)) {
      logEvent(logger, 'info', 'provider.eligibility-skipped', {
        providerId,
        reason: 'not_configured'
      });
      return { providerId, eligible: false, reason: 'not_configured' };
    }

    if (typeof definition.preflight === 'function') {
      logEvent(logger, 'info', 'provider.preflight-started', {
        providerId,
        reason: 'eligibility_check'
      });
      const result = await definition.preflight(config, deps);
      if (!result || !result.ok) {
        logEvent(logger, 'warn', 'provider.preflight-failed', {
          providerId,
          reason: (result && result.reason) || 'preflight_failed',
          status: result && result.status ? result.status : 0
        });
        return {
          providerId,
          eligible: false,
          reason: (result && result.reason) || 'preflight_failed',
          status: result && result.status,
          error: result && result.error
        };
      }

      logEvent(logger, 'info', 'provider.preflight-succeeded', {
        providerId,
        reason: 'eligibility_check'
      });
    }

    logEvent(logger, 'info', 'provider.eligible', {
      providerId
    });

    return { providerId, eligible: true, reason: 'eligible' };
  }

  function buildCandidateOrder(options = {}) {
    const ordered = [];

    function push(providerId) {
      const normalized = normalizeProviderId(providerId);
      if (normalized && !ordered.includes(normalized)) {
        ordered.push(normalized);
      }
    }

    push(options.overrideProvider);
    push(options.defaultProvider);
    PROVIDER_ORDER.forEach(push);

    return ordered;
  }

  async function resolveProviderPlan(input = {}, deps = {}) {
    const providerSettings = input.providerSettings || {};
    const overrideProvider = normalizeProviderId(input.providerOverride);
    const defaultProvider = normalizeProviderId(providerSettings.defaultProvider) || 'openai';
    const mode = normalizeMode(input.mode);
    const logger = deps.logger;
    const candidateOrder = buildCandidateOrder({
      overrideProvider,
      defaultProvider
    });

    const eligibilityResults = await Promise.all(
      candidateOrder.map(async (providerId) => [providerId, await getProviderEligibility(providerId, providerSettings, {
        ...deps,
        mode
      })])
    );

    const eligibilityMap = Object.fromEntries(eligibilityResults);
    const eligibleProviders = [];
    const skippedProviders = [];

    candidateOrder.forEach((providerId) => {
      const result = eligibilityMap[providerId];
      if (!result) return;

      if (result.eligible) {
        if (!eligibleProviders.includes(providerId)) {
          eligibleProviders.push(providerId);
        }
        return;
      }

      skippedProviders.push({
        providerId,
        reason: result.reason,
        status: result.status || 0
      });
    });

    const plan = eligibleProviders.slice(0, MAX_PROVIDER_ATTEMPTS);

    logEvent(logger, 'info', 'provider.plan-resolved', {
      overrideProvider,
      defaultProvider,
      mode,
      candidateOrder,
      eligibleProviders,
      skippedProviders,
      plan,
      maxAttempts: MAX_PROVIDER_ATTEMPTS
    });

    return {
      overrideProvider,
      defaultProvider,
      mode,
      candidateOrder,
      eligibleProviders,
      skippedProviders,
      plan,
      activeProvider: plan[0] || null,
      hasEligibleProviders: plan.length > 0,
      maxAttempts: MAX_PROVIDER_ATTEMPTS
    };
  }

  async function createTranscriptionSession(input = {}, deps = {}) {
    const providerSettings = input.providerSettings || {};
    const logger = deps.logger;
    const resolution = await resolveProviderPlan(
      {
        providerSettings,
        providerOverride: input.providerOverride,
        mode: input.mode
      },
      deps
    );

    if (!resolution.hasEligibleProviders) {
      logEvent(logger, 'warn', 'provider.session-start-blocked', {
        overrideProvider: resolution.overrideProvider,
        defaultProvider: resolution.defaultProvider,
        skippedProviders: resolution.skippedProviders,
        maxAttempts: resolution.maxAttempts
      });
      const error = new Error('No hay providers elegibles. Configurá al menos uno o revisá el bridge local de Whisper.');
      error.code = 'no_eligible_provider';
      error.details = resolution;
      throw error;
    }

    const now = typeof input.now === 'number' ? input.now : Date.now();

    const session = {
      id: `txs_${now}_${Math.random().toString(36).slice(2, 8)}`,
      providerOverride: resolution.overrideProvider,
      defaultProvider: resolution.defaultProvider,
      mode: resolution.mode,
      providerPlan: resolution.plan,
      activeProvider: resolution.activeProvider,
      attempts: [],
      resolvedProvider: null,
      status: 'pending',
      language: input.language || 'es',
      targetLanguage: input.targetLanguage || 'es',
      createdAt: now,
      audit: {
        eligibleProviders: resolution.eligibleProviders,
        skippedProviders: resolution.skippedProviders,
        mode: resolution.mode
      }
    };

    logEvent(logger, 'info', 'provider.session-created', {
      sessionId: session.id,
      activeProvider: session.activeProvider,
      providerPlan: session.providerPlan,
      overrideProvider: session.providerOverride,
      defaultProvider: session.defaultProvider,
      skippedProviders: session.audit.skippedProviders
    });

    return session;
  }

  return {
    MAX_PROVIDER_ATTEMPTS,
    PROVIDER_ORDER,
    buildCandidateOrder,
    createTranscriptionSession,
    getProviderDefinition,
    getProviderEligibility,
    listProviders,
    normalizeProviderId,
    normalizeMode,
    resolveProviderPlan,
    whisperLocalPreflight
  };
});
