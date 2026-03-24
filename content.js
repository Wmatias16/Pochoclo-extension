(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  const api = factory();
  root.PochocloRecordingIndicator = api;

  if (root && root.document && root.chrome && root.chrome.runtime) {
    api.initRecordingIndicator();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const INDICATOR_HOST_ID = 'pochoclo-recording-indicator';
  // The manifest injects this script on <all_urls> so the floating indicator can appear on whichever
  // tab the user chooses to record. Actual UI rendering still stays gated by background recording state.
  // Open shadow root keeps the floating indicator isolated from page CSS while remaining testable/debuggable.
  const INDICATOR_SHADOW_MODE = 'open';

  function formatElapsedTime(elapsedMs) {
    const safeMs = Math.max(0, Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0);
    const totalSeconds = Math.floor(safeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function sendRuntimeMessage(runtime, message) {
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      return Promise.resolve(undefined);
    }

    if (runtime.sendMessage.length >= 2) {
      return new Promise((resolve, reject) => {
        try {
          runtime.sendMessage(message, (response) => {
            const lastError = runtime.lastError || (globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.lastError);
            if (lastError) {
              reject(new Error(lastError.message || 'No se pudo enviar el mensaje al background.'));
              return;
            }
            resolve(response);
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    try {
      const maybePromise = runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.then === 'function') {
        return maybePromise;
      }
    } catch (error) {
      return Promise.reject(error);
    }

    return Promise.resolve(undefined);
  }

  function createRecordingIndicatorController(deps = {}) {
    const runtime = deps.runtime || (globalThis.chrome && globalThis.chrome.runtime) || null;
    const documentRef = deps.document || globalThis.document;
    const setIntervalImpl = deps.setInterval || globalThis.setInterval.bind(globalThis);
    const clearIntervalImpl = deps.clearInterval || globalThis.clearInterval.bind(globalThis);
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    let state = null;
    let host = null;
    let shadowRoot = null;
    let elapsedNode = null;
    let stopButton = null;
    let elapsedTimerId = null;
    let initialized = false;

    function isIndicatorVisible(nextState) {
      return !!(nextState && nextState.status === 'recording' && nextState.indicatorVisible);
    }

    function ensureHost() {
      if (!documentRef || typeof documentRef.createElement !== 'function') {
        return null;
      }

      if (host && shadowRoot) {
        return host;
      }

      host = typeof documentRef.getElementById === 'function'
        ? documentRef.getElementById(INDICATOR_HOST_ID)
        : null;

      if (!host) {
        host = documentRef.createElement('div');
        host.id = INDICATOR_HOST_ID;
        const mountTarget = documentRef.body || documentRef.documentElement;
        if (!mountTarget || typeof mountTarget.appendChild !== 'function') {
          return null;
        }
        mountTarget.appendChild(host);
      }

      shadowRoot = host.shadowRoot || (typeof host.attachShadow === 'function'
        ? host.attachShadow({ mode: INDICATOR_SHADOW_MODE })
        : host);

      if (!shadowRoot.__pochocloMounted) {
        const style = documentRef.createElement('style');
        style.textContent = [
          ':host { all: initial; }',
          '.indicator {',
          '  position: fixed;',
          '  right: 16px;',
          '  bottom: 16px;',
          '  z-index: 2147483647;',
          '  display: inline-flex;',
          '  align-items: center;',
          '  gap: 10px;',
          '  padding: 12px 14px;',
          '  border: 0;',
          '  border-radius: 999px;',
          '  background: rgba(17, 24, 39, 0.96);',
          '  color: #ffffff;',
          '  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);',
          '  font: 600 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
          '  cursor: pointer;',
          '}',
          '.dot { font-size: 12px; }',
          '.label { white-space: nowrap; }',
          '.time { font-variant-numeric: tabular-nums; opacity: 0.9; }'
        ].join(' ');

        stopButton = documentRef.createElement('button');
        stopButton.type = 'button';
        stopButton.className = 'indicator';
        stopButton.title = 'Detener grabación de Pochoclo';
        stopButton.setAttribute('aria-label', 'Detener grabación de Pochoclo');

        const dotNode = documentRef.createElement('span');
        dotNode.className = 'dot';
        dotNode.textContent = '🔴';

        const labelNode = documentRef.createElement('span');
        labelNode.className = 'label';
        labelNode.textContent = 'Grabando';

        elapsedNode = documentRef.createElement('span');
        elapsedNode.className = 'time';
        elapsedNode.textContent = '00:00';

        stopButton.appendChild(dotNode);
        stopButton.appendChild(labelNode);
        stopButton.appendChild(elapsedNode);
        stopButton.addEventListener('click', () => {
          void sendRuntimeMessage(runtime, { action: 'stopCapture' }).catch(() => {});
        });

        shadowRoot.appendChild(style);
        shadowRoot.appendChild(stopButton);
        shadowRoot.__pochocloMounted = true;
      } else if (!elapsedNode || !stopButton) {
        const children = Array.from(shadowRoot.children || []);
        stopButton = children.find((child) => child && child.className === 'indicator') || stopButton;
        if (stopButton) {
          elapsedNode = Array.from(stopButton.children || []).find((child) => child && child.className === 'time') || elapsedNode;
        }
      }

      return host;
    }

    function clearElapsedTimer() {
      if (elapsedTimerId) {
        clearIntervalImpl(elapsedTimerId);
        elapsedTimerId = null;
      }
    }

    function updateElapsed() {
      if (!elapsedNode || !state) {
        return;
      }

      const baseElapsed = Math.max(0, Number(state.elapsedMs) || 0);
      const baseUpdatedAt = Number.isFinite(Number(state.lastUpdatedAt)) ? Number(state.lastUpdatedAt) : now();
      const liveElapsed = state.status === 'recording'
        ? baseElapsed + Math.max(0, now() - baseUpdatedAt)
        : baseElapsed;

      elapsedNode.textContent = formatElapsedTime(liveElapsed);
    }

    function startElapsedTimer() {
      clearElapsedTimer();
      updateElapsed();
      elapsedTimerId = setIntervalImpl(() => {
        updateElapsed();
      }, 1000);
    }

    function removeIndicator() {
      clearElapsedTimer();
      // Cleanup is always destructive: once recording stops, pauses, or this tab loses ownership,
      // the host is removed so stale UI cannot survive reloads or tab switches.
      if (host && typeof host.remove === 'function') {
        host.remove();
      }
      host = null;
      shadowRoot = null;
      elapsedNode = null;
      stopButton = null;
    }

    function applyState(nextState) {
      state = nextState
        ? {
          ...nextState,
          lastUpdatedAt: now()
        }
        : null;

      if (!isIndicatorVisible(state)) {
        removeIndicator();
        return;
      }

      if (!ensureHost()) {
        return;
      }

      startElapsedTimer();
    }

    async function syncState() {
      const response = await sendRuntimeMessage(runtime, { action: 'getRecordingIndicatorState' });
      if (response && response.ok) {
        applyState(response.state || null);
      }
      return response;
    }

    function handleRuntimeMessage(message) {
      if (!message || message.type !== 'recording-state-changed') {
        return undefined;
      }

      applyState(message.state || null);
      return undefined;
    }

    async function init() {
      if (initialized) {
        return controller;
      }
      initialized = true;

      if (runtime && runtime.onMessage && typeof runtime.onMessage.addListener === 'function') {
        runtime.onMessage.addListener(handleRuntimeMessage);
      }

      await syncState().catch(() => {});
      return controller;
    }

    function destroy() {
      clearElapsedTimer();
      removeIndicator();
      initialized = false;
    }

    function getHost() {
      return host;
    }

    function getShadowRoot() {
      return shadowRoot;
    }

    function getElapsedText() {
      return elapsedNode ? elapsedNode.textContent : null;
    }

    const controller = {
      init,
      destroy,
      applyState,
      syncState,
      getHost,
      getShadowRoot,
      getElapsedText,
      handleRuntimeMessage
    };

    return controller;
  }

  let activeController = null;

  function initRecordingIndicator(deps = {}) {
    if (!activeController) {
      activeController = createRecordingIndicatorController(deps);
      void activeController.init();
    }

    return activeController;
  }

  return {
    INDICATOR_HOST_ID,
    formatElapsedTime,
    sendRuntimeMessage,
    createRecordingIndicatorController,
    initRecordingIndicator
  };
});
