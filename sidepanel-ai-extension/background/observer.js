/**
 * background/observer.js
 * Structured event observer for the agent runtime.
 * Classic script (MV3 service worker) with a global namespace: globalThis.AgentObserver
 *
 * Emits compact, structured events to:
 * 1) chrome.runtime (sidepanel) via MessageTypes.MSG.AGENT_TRACE_UPDATE
 * 2) chrome.storage.local for replay (bounded buffer)
 */
(function initAgentObserver(global) {
  if (global.AgentObserver && global.AgentObserver.__LOCKED__) {
    return;
  }

  const MSG = (global.MessageTypes && global.MessageTypes.MSG) || {
    AGENT_TRACE_UPDATE: "AGENT_TRACE_UPDATE"
  };

  const TIMELINE_KEY = "SP_TIMELINE_V1";
  const MAX_EVENTS = 500;
  const LOGGER = (global.Log && global.Log.createLogger) ? global.Log.createLogger('observer') : null;

  async function persistEvent(evt) {
    try {
      const got = await chrome.storage.local.get(TIMELINE_KEY);
      const arr = Array.isArray(got[TIMELINE_KEY]) ? got[TIMELINE_KEY] : [];
      arr.push(evt);
      // keep bounded
      const trimmed = arr.length > MAX_EVENTS ? arr.slice(arr.length - MAX_EVENTS) : arr;
      await chrome.storage.local.set({ [TIMELINE_KEY]: trimmed });
    } catch (e) {
      // non-fatal
      console.warn("[Observer] persist failed:", e);
    }
  }

  function emitToUI(tabId, evt) {
    try {
      chrome.runtime.sendMessage({
        type: MSG.AGENT_TRACE_UPDATE,
        tabId,
        event: evt
      });
    } catch (_) {
      // ignore
    }
  }

  function makeEvent(tabId, kind, data) {
    return {
      ts: Date.now(),
      tabId: Number.isFinite(tabId) ? tabId : -1,
      kind,
      ...data
    };
  }

  async function emit(tabId, kind, data) {
    const evt = makeEvent(tabId, kind, data || {});
    try { LOGGER?.debug?.("emit", { kind, tabId, ...(evt?.status ? { status: evt.status } : {}) }); } catch (_) {}
    emitToUI(tabId, evt);
    await persistEvent(evt);
    return evt;
  }

  const AgentObserver = {
    // when an agent run changes state: started | stopped | resumed | finished
    async emitRunState(tabId, state, meta) {
      return emit(tabId, "run_state", {
        state, // started | stopped | resumed | finished
        meta: meta || {}
      });
    },

    // when a tool starts
    async emitToolStarted(tabId, toolId, input) {
      return emit(tabId, "tool_started", {
        toolId,
        input
      });
    },

    // when a tool finishes
    async emitToolResult(tabId, toolId, output) {
      // Expect output.ok, output.observation, output.durationMs, etc.
      const status = output?.ok === false ? "error" : "success";
      return emit(tabId, "tool_result", {
        toolId,
        status,
        output
      });
    },

    // generic emitter for other future events
    async emitGeneric(tabId, kind, data) {
      return emit(tabId, kind, data);
    },

    // read last N events from storage
    async listRecent(limit = 100) {
      try {
        const got = await chrome.storage.local.get(TIMELINE_KEY);
        const arr = Array.isArray(got[TIMELINE_KEY]) ? got[TIMELINE_KEY] : [];
        if (!Number.isFinite(limit) || limit <= 0) return arr.slice(-100);
        return arr.slice(Math.max(0, arr.length - limit));
      } catch (e) {
        console.warn("[Observer] listRecent failed:", e);
        return [];
      }
    },

    __LOCKED__: true
  };

  global.AgentObserver = AgentObserver;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));