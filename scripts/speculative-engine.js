/**
 * Speculative Prefetch Engine for Keep Exploring
 *
 * Predicts user intent from mouse behavior and prefetches AI content
 * before the user clicks. Adapted from Vitamix's speculative engine
 * for Arco's NDJSON POST-based streaming.
 */

const CONFIDENCE_THRESHOLD = 60;
const MAX_SPECULATIVE_PER_MINUTE = 3;
const RING_BUFFER_SIZE = 5;
const PROJECTION_MS = 200;

/**
 * Ring buffer for mouse position samples.
 */
class MouseRingBuffer {
  constructor(size) {
    this.buffer = new Array(size);
    this.size = size;
    this.index = 0;
    this.count = 0;
  }

  push(sample) {
    this.buffer[this.index] = sample;
    this.index = (this.index + 1) % this.size;
    if (this.count < this.size) this.count += 1;
  }

  latest() {
    if (this.count === 0) return null;
    return this.buffer[(this.index - 1 + this.size) % this.size];
  }

  previous() {
    if (this.count < 2) return null;
    return this.buffer[(this.index - 2 + this.size) % this.size];
  }

  getVelocity() {
    const a = this.previous();
    const b = this.latest();
    if (!a || !b) return null;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return { speed: dist / dt, dx: dx / dt, dy: dy / dt };
  }

  getProjectedPosition() {
    const b = this.latest();
    const vel = this.getVelocity();
    if (!b || !vel) return null;
    const t = PROJECTION_MS / 1000;
    return { x: b.x + vel.dx * t, y: b.y + vel.dy * t };
  }
}

/**
 * Creates a speculative prefetch engine.
 *
 * @param {Object} config
 * @param {string} config.apiEndpoint - Base URL for the recommender API
 * @param {Function} config.getSessionContext - Returns session context for API body
 * @param {Function} [config.onSpeculationChange] - Callback for state changes
 * @returns {Object} Engine public API
 */
export default function createSpeculativeEngine(config) {
  const mouseBuffer = new MouseRingBuffer(RING_BUFFER_SIZE);
  const buttonStates = new WeakMap();

  let activeSpeculation = null;
  let speculativeTimestamps = [];
  let rafId = null;
  let destroyed = false;
  const listeners = [];

  // --- Mouse Physics ---

  function onMouseMove(e) {
    if (destroyed) return;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      mouseBuffer.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    });
  }

  document.addEventListener('mousemove', onMouseMove, { passive: true });
  listeners.push([document, 'mousemove', onMouseMove]);

  // --- Button State Management ---

  function getButtonState(element) {
    let state = buttonStates.get(element);
    if (!state) {
      state = {
        query: element.dataset.query || '',
        type: element.dataset.type || 'explore',
        label: element.dataset.label || element.textContent.trim(),
        element,
        confidence: 0,
        hoverCount: 0,
        lastHoverStart: 0,
        hoverTimer200: null,
        got200Points: false,
      };
      buttonStates.set(element, state);
    }
    return state;
  }

  function checkDeceleration(element) {
    const vel = mouseBuffer.getVelocity();
    if (!vel) return false;
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const pos = mouseBuffer.latest();
    if (!pos) return false;
    const dx = cx - pos.x;
    const dy = cy - pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return vel.speed < 100 && dist < 80;
  }

  // --- Rate Limiting ---

  function canSpeculate() {
    const now = Date.now();
    speculativeTimestamps = speculativeTimestamps.filter((t) => now - t < 60000);
    return speculativeTimestamps.length < MAX_SPECULATIVE_PER_MINUTE;
  }

  // --- Visual States ---

  function setLoadingState(speculation) {
    if (!speculation.buttonElement) return;
    speculation.buttonElement.classList.add('chip-loading');
  }

  function clearLoadingState(speculation) {
    if (!speculation.buttonElement) return;
    speculation.buttonElement.classList.remove('chip-loading');
  }

  function setReadyState(speculation) {
    if (!speculation.buttonElement) return;
    clearLoadingState(speculation);
    speculation.buttonElement.classList.add('chip-ready');
  }

  // --- Speculative Fetch ---

  async function doSpeculativeFetch(speculation) {
    try {
      const sessionContext = config.getSessionContext();
      const body = {
        query: speculation.query,
        speculative: true,
        context: sessionContext,
        followUp: speculation.followUp || { type: 'explore', label: speculation.query },
      };

      const response = await fetch(`${config.apiEndpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: speculation.abortController.signal,
      });

      if (!response.ok) {
        speculation.resolveReady(false);
        clearLoadingState(speculation);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        // eslint-disable-next-line no-restricted-syntax
        for (const line of lines) {
          if (line.trim()) speculation.responseBuffer.push(line);
        }
      }

      if (buffer.trim()) speculation.responseBuffer.push(buffer.trim());

      speculation.ready = true;
      speculation.resolveReady(true);
      setReadyState(speculation);

      if (config.onSpeculationChange) {
        config.onSpeculationChange({
          event: 'ready',
          query: speculation.query,
          buttonElement: speculation.buttonElement,
        });
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.warn('[SpeculativeEngine] Fetch error:', err);
      }
      clearLoadingState(speculation);
      speculation.resolveReady(false);
    }
  }

  function triggerSpeculation(state) {
    if (destroyed) return;
    if (!canSpeculate()) return;

    // Already speculating for this query
    if (activeSpeculation && activeSpeculation.query === state.query) return;

    // Abort any existing speculation
    if (activeSpeculation) {
      clearLoadingState(activeSpeculation);
      activeSpeculation.resolveReady(false);
      activeSpeculation.abortController.abort();
    }

    const abortController = new AbortController();
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

    activeSpeculation = {
      query: state.query,
      followUp: { type: state.type, label: state.label },
      abortController,
      responseBuffer: [],
      ready: false,
      readyPromise,
      resolveReady,
      buttonElement: state.element,
    };

    speculativeTimestamps.push(Date.now());
    setLoadingState(activeSpeculation);

    if (config.onSpeculationChange) {
      config.onSpeculationChange({
        event: 'loading',
        query: activeSpeculation.query,
        buttonElement: activeSpeculation.buttonElement,
      });
    }

    doSpeculativeFetch(activeSpeculation);
  }

  function onConfidenceChange(state) {
    if (state.confidence >= CONFIDENCE_THRESHOLD) {
      triggerSpeculation(state);
    }
  }

  // --- Chip Event Handlers ---

  function onChipEnter(e) {
    const state = getButtonState(e.currentTarget);
    state.hoverCount += 1;
    state.lastHoverStart = performance.now();

    // Base hover: +15
    state.confidence += 15;

    // Re-hover bonus: +30
    if (state.hoverCount > 1) state.confidence += 30;

    // Deceleration bonus: +20
    if (checkDeceleration(e.currentTarget)) state.confidence += 20;

    onConfidenceChange(state);

    // 200ms dwell guarantees speculation trigger
    state.hoverTimer200 = setTimeout(() => {
      state.confidence = Math.max(state.confidence, CONFIDENCE_THRESHOLD);
      state.got200Points = true;
      onConfidenceChange(state);
    }, 200);
  }

  function onChipLeave(e) {
    const state = getButtonState(e.currentTarget);
    clearTimeout(state.hoverTimer200);
    state.got200Points = false;
  }

  function onChipTouch(e) {
    const state = getButtonState(e.currentTarget);
    state.confidence += 60;
    onConfidenceChange(state);
  }

  // --- Public API ---

  return {
    /**
     * Attach mouse/touch listeners to suggestion chip elements.
     * @param {NodeList|Array} chips The chip button elements
     */
    attachToChips(chips) {
      chips.forEach((chip) => {
        // Skip buy chips (they navigate directly)
        if (chip.dataset.type === 'buy' || chip.tagName === 'A') return;

        chip.addEventListener('mouseenter', onChipEnter);
        chip.addEventListener('mouseleave', onChipLeave);
        chip.addEventListener('touchstart', onChipTouch, { passive: true });
        listeners.push(
          [chip, 'mouseenter', onChipEnter],
          [chip, 'mouseleave', onChipLeave],
          [chip, 'touchstart', onChipTouch],
        );
      });
    },

    /**
     * Get a speculative result for a query if available.
     * @param {string} query The query to check
     * @returns {Object|null} { ready, responseBuffer, readyPromise } or null
     */
    getResult(query) {
      if (!activeSpeculation || activeSpeculation.query !== query) return null;
      return {
        ready: activeSpeculation.ready,
        responseBuffer: activeSpeculation.responseBuffer,
        readyPromise: activeSpeculation.readyPromise,
      };
    },

    /**
     * Abort any active speculation.
     */
    abort() {
      if (activeSpeculation) {
        clearLoadingState(activeSpeculation);
        activeSpeculation.abortController.abort();
        activeSpeculation = null;
      }
    },

    /**
     * Clean up all listeners and state.
     */
    destroy() {
      destroyed = true;
      this.abort();
      listeners.forEach(([el, event, handler]) => {
        el.removeEventListener(event, handler);
      });
      listeners.length = 0;
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
}
