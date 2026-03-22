(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaProviderSettings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROVIDER_IDS = ['openai', 'deepgram', 'assemblyai', 'groq', 'google', 'whisperLocal'];

  function logEvent(logger, level, event, context) {
    if (logger && typeof logger[level] === 'function') {
      logger[level](event, context);
    }
  }

  function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function buildDefaultProviderSettings() {
    return {
      defaultProvider: 'openai',
      providers: {
        openai: { enabled: true, apiKey: '' },
        deepgram: { enabled: false, apiKey: '' },
        assemblyai: { enabled: false, apiKey: '' },
        groq: { enabled: false, apiKey: '' },
        google: { enabled: false, apiKey: '' },
        whisperLocal: {
          enabled: false,
          baseUrl: 'http://127.0.0.1:8765',
          healthPath: '/health',
          transcribePath: '/transcribe'
        }
      }
    };
  }

  function normalizeProviderId(providerId) {
    if (!hasText(providerId)) return 'openai';
    const normalized = providerId.trim();
    return PROVIDER_IDS.includes(normalized) ? normalized : 'openai';
  }

  function normalizeProviderSettings(input = {}, options = {}) {
    const defaults = buildDefaultProviderSettings();
    const legacyOpenAiKey = hasText(options.legacyOpenAiKey) ? options.legacyOpenAiKey.trim() : '';
    const merged = {
      defaultProvider: normalizeProviderId(input.defaultProvider || defaults.defaultProvider),
      providers: {}
    };

    PROVIDER_IDS.forEach((providerId) => {
      const current = {
        ...defaults.providers[providerId],
        ...((input.providers && input.providers[providerId]) || {})
      };

      if (providerId === 'openai' && legacyOpenAiKey && !hasText(current.apiKey)) {
        current.apiKey = legacyOpenAiKey;
      }

      if (providerId === 'openai' && hasText(current.apiKey) && current.enabled === undefined) {
        current.enabled = true;
      }

      merged.providers[providerId] = current;
    });

    return merged;
  }

  function migrateLegacyOpenAiKey(openAiKey) {
    const settings = buildDefaultProviderSettings();
    const normalizedKey = hasText(openAiKey) ? openAiKey.trim() : '';
    settings.providers.openai.apiKey = normalizedKey;
    settings.providers.openai.enabled = hasText(normalizedKey);
    return settings;
  }

  async function readProviderSettings(storageArea, options = {}) {
    const area = storageArea || chrome.storage.local;
    const data = await area.get(['providerSettings', 'openaiApiKey']);
    const logger = options.logger;

    if (!data.providerSettings && hasText(data.openaiApiKey)) {
      const migrated = migrateLegacyOpenAiKey(data.openaiApiKey);
      await area.set({ providerSettings: migrated });
      logEvent(logger, 'info', 'settings.legacy-openai-migrated', {
        defaultProvider: migrated.defaultProvider,
        openaiEnabled: !!migrated.providers.openai.enabled,
        migration: 'legacy_openai_key'
      });
      return migrated;
    }

    if (!data.providerSettings) {
      return buildDefaultProviderSettings();
    }

    const normalized = normalizeProviderSettings(data.providerSettings, {
      legacyOpenAiKey: data.openaiApiKey
    });

    const serializedRaw = JSON.stringify(data.providerSettings);
    const serializedNormalized = JSON.stringify(normalized);
    if (serializedRaw !== serializedNormalized) {
      await area.set({ providerSettings: normalized });
      logEvent(logger, 'info', 'settings.provider-settings-normalized', {
        migration: hasText(data.openaiApiKey) ? 'compat_merge_or_shape_fix' : 'shape_fix',
        defaultProvider: normalized.defaultProvider,
        providersConfigured: PROVIDER_IDS.filter((providerId) => {
          const config = normalized.providers[providerId] || {};
          return Object.values(config).some((value) => hasText(value) || value === true);
        }).length
      });
    }

    return normalized;
  }

  async function saveProviderSettings(nextSettings, storageArea, options = {}) {
    const area = storageArea || chrome.storage.local;
    const normalized = normalizeProviderSettings(nextSettings);
    await area.set({ providerSettings: normalized });
    const logger = options.logger;
    if (JSON.stringify(nextSettings || {}) !== JSON.stringify(normalized)) {
      logEvent(logger, 'info', 'settings.provider-settings-sanitized', {
        defaultProvider: normalized.defaultProvider,
        migration: 'save_normalization'
      });
    }
    return normalized;
  }

  return {
    PROVIDER_IDS,
    buildDefaultProviderSettings,
    migrateLegacyOpenAiKey,
    normalizeProviderSettings,
    readProviderSettings,
    saveProviderSettings
  };
});
