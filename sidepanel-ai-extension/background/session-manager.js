// background/session-manager.js
// Manages agent sessions, including creation, storage, and retrieval.

(function (global) {
  const { MSG, LOG_LEVELS } = global.MessageTypes;

  // Simple in-memory agent sessions keyed by tabId
  const agentSessions = new Map();

  function initializeNewSession(tabId, goal, subTasks, settings, selectedModel, taskContext) {
    return {
      running: false,
      stopped: false,
      step: 0,
      goal,
      subTasks,
      currentTaskIndex: 0,
      settings,
      selectedModel,
      logs: [],
      lastAction: "",
      lastObservation: "",
      history: [],
      scratchpad: [],
      requestId: `agent_${tabId}_${Date.now()}`,
      taskContext: taskContext || {},
      contextCache: {},
      failureCount: 0,
      consecutiveFailures: 0,
      findings: {},
      successCriteria: {},
      subTaskStep: 0,
      maxSubTaskSteps: 15,
      domainVisitCount: {},
      maxDomainVisits: 5,
      noProgressCounter: 0,
      maxNoProgressSteps: 4,
      lastProgressObservation: "",
      chatTranscript: [],
      sessionId: tabId,
    };
  }

  async function saveSessionToStorage(tabId, session) {
    try {
      const sessionData = {
        ...session,
        sessionId: tabId,
        logs: session.logs ? session.logs.slice(-100) : [],
        history: session.history ? session.history.slice(-20) : [],
      };
      await global.saveSession(sessionData);
    } catch (e) {
      console.warn('[BG] Failed to save session to IndexedDB:', e);
    }
  }

  async function restoreSessionFromStorage(tabId) {
    try {
      const sessionData = await global.loadSession(tabId);
      
      if (sessionData) {
        const restoredSession = {
          ...sessionData,
          running: false,
          stopped: true
        };
        agentSessions.set(tabId, restoredSession);
        console.log(`[BG] Restored session for tab ${tabId} from IndexedDB`);
        return restoredSession;
      }
    } catch (e) {
      console.warn(`[BG] Failed to restore session for tab ${tabId} from IndexedDB:`, e);
    }
    return null;
  }

  async function cleanupOldSessions() {
    console.log("[BG] Skipping session cleanup for IndexedDB implementation.");
  }

  function getSession(tabId) {
    return agentSessions.get(tabId);
  }

  function setSession(tabId, session) {
    agentSessions.set(tabId, session);
  }

  function deleteSession(tabId) {
    agentSessions.delete(tabId);
  }

  global.SessionManager = {
    initializeNewSession,
    saveSessionToStorage,
    restoreSessionFromStorage,
    cleanupOldSessions,
    getSession,
    setSession,
    deleteSession,
    agentSessions, // Exposing for direct access in background.js for now
  };

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));