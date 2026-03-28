(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  const api = factory();
  root.PochocloRecordingIndicator = api;

  if (root && root.document && root.chrome && root.chrome.runtime) {
    api.initContentScript();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const INDICATOR_HOST_ID = 'pochoclo-recording-indicator';
  const VIDEO_SELECTOR_HEURISTIC = Object.freeze(['playing', 'visible', 'largest', 'mostRecent']);
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

  function toFiniteNumber(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function readVideoDimensions(videoElement) {
    if (!videoElement) {
      return { width: 0, height: 0 };
    }

    if (typeof videoElement.getBoundingClientRect === 'function') {
      const rect = videoElement.getBoundingClientRect();
      const width = Math.max(0, Number(rect && rect.width) || 0);
      const height = Math.max(0, Number(rect && rect.height) || 0);
      return { width, height };
    }

    const width = Math.max(0, Number(videoElement.clientWidth || videoElement.width || videoElement.videoWidth) || 0);
    const height = Math.max(0, Number(videoElement.clientHeight || videoElement.height || videoElement.videoHeight) || 0);
    return { width, height };
  }

  function isVideoVisible(videoElement, dimensions) {
    if (!videoElement) {
      return false;
    }

    const style = videoElement.style || {};
    if (videoElement.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    return Number(dimensions && dimensions.width) > 0 && Number(dimensions && dimensions.height) > 0;
  }

  function buildVideoCandidateMeta(videoElement, previousMeta, fallbackToken) {
    const dimensions = readVideoDimensions(videoElement);
    const width = dimensions.width;
    const height = dimensions.height;
    const paused = !!videoElement.paused;
    const playing = !paused && !videoElement.ended;
    const visible = isVideoVisible(videoElement, dimensions);

    return {
      element: videoElement,
      paused,
      playing,
      visible,
      width,
      height,
      area: width * height,
      currentTimeSec: toFiniteNumber(videoElement.currentTime),
      durationSec: toFiniteNumber(videoElement.duration),
      lastUpdatedToken: previousMeta ? previousMeta.lastUpdatedToken : fallbackToken
    };
  }

  function compareVideoCandidates(leftCandidate, rightCandidate) {
    if (!!leftCandidate.playing !== !!rightCandidate.playing) {
      return leftCandidate.playing ? -1 : 1;
    }

    if (!!leftCandidate.visible !== !!rightCandidate.visible) {
      return leftCandidate.visible ? -1 : 1;
    }

    if ((leftCandidate.area || 0) !== (rightCandidate.area || 0)) {
      return (rightCandidate.area || 0) - (leftCandidate.area || 0);
    }

    if ((leftCandidate.lastUpdatedToken || 0) !== (rightCandidate.lastUpdatedToken || 0)) {
      return (rightCandidate.lastUpdatedToken || 0) - (leftCandidate.lastUpdatedToken || 0);
    }

    return 0;
  }

  function selectBestVideoCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    return [...candidates].sort(compareVideoCandidates)[0] || null;
  }

  function collectVideoElements(documentRef) {
    if (!documentRef) {
      return [];
    }

    const discoveredVideos = [];
    const visitedNodes = new Set();

    function visit(node) {
      if (!node || visitedNodes.has(node)) {
        return;
      }

      visitedNodes.add(node);

      if (String(node.tagName || '').toLowerCase() === 'video') {
        discoveredVideos.push(node);
      }

      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach(visit);

      if (node.shadowRoot) {
        visit(node.shadowRoot);
      }
    }

    visit(documentRef.documentElement);
    if (documentRef.body) {
      visit(documentRef.body);
    }

    return discoveredVideos;
  }

  function createActiveVideoTracker(deps = {}) {
    const runtime = deps.runtime || (globalThis.chrome && globalThis.chrome.runtime) || null;
    const documentRef = deps.document || globalThis.document || null;
    const MutationObserverImpl = deps.MutationObserver || globalThis.MutationObserver || null;

    let initialized = false;
    let updateCounter = 0;
    let mutationObserver = null;
    let candidateMap = new Map();
    const listenerRegistry = new Map();

    function nextUpdateToken() {
      updateCounter += 1;
      return updateCounter;
    }

    function detachVideoListeners(videoElement) {
      const registration = listenerRegistry.get(videoElement);
      if (!registration) {
        return;
      }

      if (typeof videoElement.removeEventListener === 'function') {
        registration.events.forEach((eventName) => {
          videoElement.removeEventListener(eventName, registration.handler);
        });
      }

      listenerRegistry.delete(videoElement);
    }

    function touchVideoCandidate(videoElement) {
      if (!candidateMap.has(videoElement)) {
        refreshCandidates();
        return;
      }

      const previousMeta = candidateMap.get(videoElement);
      const nextMeta = buildVideoCandidateMeta(videoElement, previousMeta, previousMeta.lastUpdatedToken);
      nextMeta.lastUpdatedToken = nextUpdateToken();
      candidateMap.set(videoElement, nextMeta);
    }

    function attachVideoListeners(videoElement) {
      if (!videoElement || listenerRegistry.has(videoElement) || typeof videoElement.addEventListener !== 'function') {
        return;
      }

      const events = ['play', 'pause', 'playing', 'ended'];
      const handler = () => {
        touchVideoCandidate(videoElement);
      };

      events.forEach((eventName) => {
        videoElement.addEventListener(eventName, handler);
      });

      listenerRegistry.set(videoElement, { events, handler });
    }

    function refreshCandidates() {
      const discoveredVideos = collectVideoElements(documentRef);
      const nextCandidateMap = new Map();

      discoveredVideos.forEach((videoElement) => {
        attachVideoListeners(videoElement);
        const previousMeta = candidateMap.get(videoElement);
        const nextMeta = buildVideoCandidateMeta(
          videoElement,
          previousMeta,
          previousMeta ? previousMeta.lastUpdatedToken : nextUpdateToken()
        );
        nextCandidateMap.set(videoElement, nextMeta);
      });

      Array.from(candidateMap.keys()).forEach((videoElement) => {
        if (!nextCandidateMap.has(videoElement)) {
          detachVideoListeners(videoElement);
        }
      });

      candidateMap = nextCandidateMap;
      return getBestCandidate();
    }

    function getBestCandidate() {
      return selectBestVideoCandidate(Array.from(candidateMap.values()));
    }

    function getActiveVideoSnapshot() {
      refreshCandidates();
      const bestCandidate = getBestCandidate();

      if (!bestCandidate) {
        return { hasVideo: false };
      }

      const snapshot = buildVideoCandidateMeta(
        bestCandidate.element,
        bestCandidate,
        bestCandidate.lastUpdatedToken
      );
      snapshot.lastUpdatedToken = bestCandidate.lastUpdatedToken;
      candidateMap.set(bestCandidate.element, snapshot);

      return {
        hasVideo: true,
        currentTimeSec: snapshot.currentTimeSec,
        durationSec: snapshot.durationSec,
        paused: snapshot.paused
      };
    }

    function handleRuntimeMessage(message, sender, sendResponse) {
      if (!message || message.action !== 'getActiveVideoTime') {
        return undefined;
      }

      const response = getActiveVideoSnapshot();
      if (typeof sendResponse === 'function') {
        sendResponse(response);
        return true;
      }

      return response;
    }

    function init() {
      if (initialized) {
        return tracker;
      }

      initialized = true;
      refreshCandidates();

      if (MutationObserverImpl) {
        const observerTarget = documentRef && (documentRef.documentElement || documentRef);
        if (observerTarget) {
          mutationObserver = new MutationObserverImpl(() => {
            refreshCandidates();
          });

          if (typeof mutationObserver.observe === 'function') {
            mutationObserver.observe(observerTarget, { childList: true, subtree: true });
          }
        }
      }

      if (runtime && runtime.onMessage && typeof runtime.onMessage.addListener === 'function') {
        runtime.onMessage.addListener(handleRuntimeMessage);
      }

      return tracker;
    }

    function destroy() {
      if (mutationObserver && typeof mutationObserver.disconnect === 'function') {
        mutationObserver.disconnect();
      }

      mutationObserver = null;
      Array.from(listenerRegistry.keys()).forEach(detachVideoListeners);
      candidateMap.clear();
      initialized = false;
    }

    function getCandidateSummaries() {
      return Array.from(candidateMap.values());
    }

    const tracker = {
      init,
      destroy,
      refreshCandidates,
      getBestCandidate,
      getActiveVideoSnapshot,
      getCandidateSummaries,
      handleRuntimeMessage,
      getSelectorHeuristic() {
        return [...VIDEO_SELECTOR_HEURISTIC];
      }
    };

    return tracker;
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
  let activeVideoTracker = null;

  function initRecordingIndicator(deps = {}) {
    if (!activeController) {
      activeController = createRecordingIndicatorController(deps);
      void activeController.init();
    }

    return activeController;
  }

  function initVideoTracking(deps = {}) {
    if (!activeVideoTracker) {
      activeVideoTracker = createActiveVideoTracker(deps);
      activeVideoTracker.init();
    }

    return activeVideoTracker;
  }

  function initContentScript(deps = {}) {
    return {
      recordingIndicator: initRecordingIndicator(deps),
      videoTracker: initVideoTracking(deps)
    };
  }

  return {
    INDICATOR_HOST_ID,
    VIDEO_SELECTOR_HEURISTIC,
    formatElapsedTime,
    sendRuntimeMessage,
    compareVideoCandidates,
    selectBestVideoCandidate,
    createActiveVideoTracker,
    createRecordingIndicatorController,
    initRecordingIndicator,
    initVideoTracking,
    initContentScript
  };
});
