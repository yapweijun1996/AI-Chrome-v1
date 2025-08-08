// background/background.js
// MV3 Service Worker - orchestrates messages, manages state, and integrates with Gemini via common/api.js

// Load dependency scripts in classic worker context (MV3 service worker is classic, not module)
// Add granular diagnostics to pinpoint which import or init fails.
(function () {
  function safeImport(path) {
    try {
      console.log("[BG] importScripts ->", path);
      self.importScripts(path);
      console.log("[BG] importScripts OK  ->", path);
      return true;
    } catch (e) {
      // This will appear in chrome://extensions → Errors
      console.error("[BG] importScripts FAILED ->", path, String(e && e.message || e), e && e.stack);
      throw e; // rethrow to preserve failure semantics for Status 15
    }
  }

  // Import in strict order; if any fails, we will know which.
  safeImport("../common/messages.js");        // defines globalThis.MessageTypes
  safeImport("../common/api.js");             // API wrapper (classic script)
  safeImport("../common/prompts.js");         // Prompt builders (classic script)
  safeImport("../common/planner.js");         // New multi-step planner
  safeImport("../common/enhanced-intent-classifier.js");  // Enhanced intent classification
  safeImport("../common/enhanced-planner.js");            // Enhanced multi-step planner
  safeImport("../common/pricing-research-tools.js");      // Pricing research tools
  safeImport("../common/clarification-manager.js");       // Clarification management
  safeImport("../common/storage.js");           // IndexedDB session storage
  safeImport("../common/success-criteria.js");  // Success criteria schemas and validator
  safeImport("../common/action-schema.js");     // Action validation schema
  safeImport("../common/tools-registry.js");    // Tool Registry (contracts, runTool)
  // Observer for structured timeline events
  safeImport("./observer.js");                  // AgentObserver (run/tool events to UI + storage)
  // Namespaced console logger (globalThis.Log)
  safeImport("../common/logger.js");           // Logger: globalThis.Log with levels/namespaces
  // Task Graph Engine (experimental)
  safeImport("../common/task-graph.js");
  // api-key-manager.js is optional; guard its absence
  try {
    safeImport("../common/api-key-manager.js");  // API key rotation/manager (if present)
  } catch (e) {
    console.warn("[BG] api-key-manager optional import failed; continuing without rotation:", e && e.message);
  }

  // Provide safe fallback if apiKeyManager was not loaded
  if (!globalThis.apiKeyManager) {
    globalThis.apiKeyManager = {
      keys: [],
      async initialize() { /* no-op fallback */ },
      getCurrentKey() { return null; },
      markKeySuccess() {},
      rotateOnSuccess() {},
      async rotateToNextKey() { return null; }
    };
  }
  const apiKeyManager = globalThis.apiKeyManager;

  // Early top-level sanity checks
  try {
    if (!globalThis.MessageTypes || !globalThis.MessageTypes.MSG) {
      throw new Error("MessageTypes.MSG missing after imports");
    }
    console.log("[BG] MessageTypes present with keys:", Object.keys(globalThis.MessageTypes.MSG || {}));
  } catch (e) {
    console.error("[BG] Top-level init check failed:", String(e && e.message || e), e && e.stack);
    throw e;
  }
})();
 
// Initialize namespaced logger for background (optional if Log not loaded)
try { globalThis.Log?.init?.(); } catch (_) {}
const BG_LOG = (globalThis.Log && globalThis.Log.createLogger) ? globalThis.Log.createLogger('agent') : null;

// Extract centralized message types and constants
const { MSG, PARAM_LIMITS, TIMEOUTS, ERROR_TYPES, LOG_LEVELS, API_KEY_ROTATION } = MessageTypes;
// Capability Registry to define risky actions
const CapabilityRegistry = {
  'click_element': { risky: true },
  'type_text': { risky: true },
  'select_option': { risky: true },
  // Canonical navigation tool
  'navigate': { risky: true, crossOrigin: true },
  // Back-compat alias (to be removed after schema/tooling migration)
  'goto_url': { risky: true, crossOrigin: true },
  'close_tab': { risky: true },
  'download_link': { risky: true },
  'set_cookie': { risky: true },
  // Non-risky actions
  'wait_for_selector': { risky: false },
  'scroll_to': { risky: false },
  'take_screenshot': { risky: false },
  'create_tab': { risky: false },
  'switch_tab': { risky: false },
  'read_page_content': { risky: false },
  'scrape': { risky: false },
  'think': { risky: false },
  'tabs.query': { risky: false },
  'record_finding': { risky: false },
};

class PermissionManager {
  constructor(storage) {
    this.storage = storage;
    this.pendingRequests = new Map(); // correlationId -> { resolve, reject }
  }

  async hasPermission(tabId, action) {
    const { tool, params } = action;
    const capability = CapabilityRegistry[tool];

    // Non-risky actions: always allowed
    if (!capability || !capability.risky) {
      return { granted: true };
    }

    // Determine origin safely (may be chrome:// or restricted)
    let origin = 'unknown';
    try {
      const tab = await chrome.tabs.get(tabId);
      try {
        origin = new URL(tab.url).origin;
      } catch (_) {
        origin = 'unknown';
      }
    } catch (_) {
      // ignore inability to read tab
    }

    // Full-auto mode: auto-grant all risky actions, no user prompt
    try {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.INFO,
        msg: "Permission auto-granted",
        tool,
        origin,
        autoGrant: true
      });
    } catch (_) {}

    // Mirror legacy "remember for 24h" behavior to keep downstream logic simple
    try {
      const permissionKey = `permission_${origin}_${tool}`;
      const expiry = Date.now() + (24 * 60 * 60 * 1000);
      await this.storage.set(permissionKey, { granted: true, expires: expiry, autoGrant: true });
    } catch (_) {
      // non-fatal
    }

    return { granted: true };
  }

  async requestPermission(tabId, origin, tool, action) {
    const correlationId = `perm_${tabId}_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(correlationId, { resolve, reject });

      chrome.runtime.sendMessage({
        type: MSG.AGENT_PERMISSION_REQUEST,
        tabId,
        payload: {
          correlationId,
          origin,
          tool,
          params: action.params,
          rationale: action.rationale,
        }
      }).catch(err => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Failed to send permission request: ${err.message}`));
      });

      // Timeout for the permission request
      setTimeout(() => {
        if (this.pendingRequests.has(correlationId)) {
          this.pendingRequests.delete(correlationId);
          reject(new Error('Permission request timed out.'));
        }
      }, 60000); // 60 second timeout
    });
  }

  async handlePermissionDecision(decision) {
    const { correlationId, granted, remember, origin, tool } = decision;
    const request = this.pendingRequests.get(correlationId);

    if (!request) {
      console.warn(`No pending permission request found for correlationId: ${correlationId}`);
      return;
    }

    this.pendingRequests.delete(correlationId);

    if (granted) {
      if (remember) {
        const permissionKey = `permission_${origin}_${tool}`;
        const expiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        await this.storage.set(permissionKey, { granted: true, expires: expiry });
      }
      request.resolve({ granted: true });
    } else {
      request.reject(new Error('Permission denied by user.'));
    }
  }
}

const permissionManager = new PermissionManager({
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => await chrome.storage.local.set({ [key]: value }),
});

// Simple in-memory agent sessions keyed by tabId
const agentSessions = new Map(); // tabId -> { running, stopped, step, goal, subTasks: [], currentTaskIndex: 0, settings, logs: [], history: [], lastAction, lastObservation }

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

// Enhanced functionality instances
let enhancedIntentClassifier = null;
let enhancedPlanner = null;
let pricingResearchTools = null;
let clarificationManager = null;

// Initialize enhanced functionality
function initializeEnhancedFeatures() {
  try {
    enhancedIntentClassifier = new EnhancedIntentClassifier({
      confidenceThreshold: 0.7,
      ambiguityThreshold: 0.3,
      maxClarificationAttempts: 2
    });
    
    enhancedPlanner = new EnhancedPlanner({
      model: "gemini-2.5-flash",
      maxRetries: 3,
      searchAPIs: ['google', 'bing', 'duckduckgo'],
      pricingAPIs: ['google_shopping', 'amazon', 'local_stores']
    });
    
    pricingResearchTools = new PricingResearchTools({
      userLocation: getUserLocationFromTimezone(),
      currency: 'SGD',
      maxRetries: 3,
      timeout: 30000
    });
    
    clarificationManager = new ClarificationManager({
      maxClarificationAttempts: 3,
      clarificationTimeout: 300000
    });
    
    console.log('[BG] Enhanced features initialized successfully');
  } catch (error) {
    console.error('[BG] Failed to initialize enhanced features:', error);
  }
}

// Progress message throttling to prevent chat spam
const progressThrottle = new Map(); // tabId -> { lastProgressTime, messageCount, lastMessage }
const PROGRESS_THROTTLE_MS = 2000; // Minimum 2 seconds between progress messages
const MAX_PROGRESS_BURST = 3; // Maximum 3 messages in quick succession

// Session persistence functions using IndexedDB
async function saveSessionToStorage(tabId, session) {
  try {
    // Ensure the session object has the key for IndexedDB
    const sessionData = {
      ...session,
      sessionId: tabId,
      // Limit logs to avoid excessive storage usage
      logs: session.logs ? session.logs.slice(-100) : [],
      history: session.history ? session.history.slice(-20) : [],
    };
    await saveSession(sessionData);
  } catch (e) {
    console.warn('[BG] Failed to save session to IndexedDB:', e);
  }
}

async function restoreSessionFromStorage(tabId) {
  try {
    const sessionData = await loadSession(tabId);
    
    if (sessionData) {
      // Restore session but mark as not running (service worker restart)
      const restoredSession = {
        ...sessionData,
        running: false, // Always reset running state after restart
        stopped: true   // Mark as stopped to prevent auto-continuation
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

// No cleanup needed for now with IndexedDB, but can be added later if necessary.
async function cleanupOldSessions() {
    // This function is now a no-op but kept for structural integrity.
    // In a production scenario, you might implement a cleanup based on session timestamps.
    console.log("[BG] Skipping session cleanup for IndexedDB implementation.");
}

// Timeout wrapper functions
function withTimeout(promise, timeoutMs, operation) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

async function callModelWithTimeout(apiKey, prompt, options, timeoutMs = TIMEOUTS.MODEL_CALL_MS) {
  try {
    return await withTimeout(
      callGeminiGenerateText(apiKey, prompt, options),
      timeoutMs,
      'Model call'
    );
  } catch (error) {
    return { 
      ok: false, 
      error: error.message,
      errorType: error.message.includes('timeout') ? ERROR_TYPES.TIMEOUT : ERROR_TYPES.MODEL_ERROR
    };
  }
}

// Enhanced model call with automatic API key rotation
async function callModelWithRotation(prompt, options, timeoutMs = TIMEOUTS.MODEL_CALL_MS) {
  await apiKeyManager.initialize();

  let attempts = 0;
  const totalKeys = apiKeyManager.keys?.length || 1;
  const maxAttempts = Math.min(totalKeys, API_KEY_ROTATION.MAX_KEYS); // Try all available keys up to configured cap

  const currentKey = apiKeyManager.getCurrentKey();
  if (currentKey) {
    const result = await callModelWithTimeout(currentKey.key, prompt, options, timeoutMs);
    if (result.ok) {
      apiKeyManager.markKeySuccess();
      return result;
    }
  }

  while (attempts < maxAttempts) {
    const currentKey = apiKeyManager.getCurrentKey();

    if (!currentKey) {
      return {
        ok: false,
        error: "No available API keys. Please add valid keys in settings.",
        errorType: ERROR_TYPES.API_KEY_ERROR
      };
    }

    console.log(`[BG] Attempting model call with key: ${currentKey.name} (attempt ${attempts + 1}/${maxAttempts})`);

    try {
      const result = await callModelWithTimeout(currentKey.key, prompt, options, timeoutMs);

      if (result.ok) {
        // Success - mark key as good
        apiKeyManager.markKeySuccess();
        apiKeyManager.rotateOnSuccess();
        return result;
      } else {
        // Prefer structured errorType from API wrapper; fallback to heuristics
        const errorText = (result.error || "").toLowerCase();
        let rotationErrorType = result.errorType;

        if (!rotationErrorType) {
          if (errorText.match(/rate[_\s-]?limit|quota|too many requests|limit exceeded|resource exhausted/)) {
            rotationErrorType = ERROR_TYPES.QUOTA_EXCEEDED;
          } else if (errorText.match(/unauthenticated|authentication|unauthorized|forbidden|invalid.*api.*key|api[_-]?key/)) {
            rotationErrorType = ERROR_TYPES.AUTHENTICATION_ERROR;
          } else if (errorText.match(/billing|payment required|insufficient credit|account suspended/)) {
            rotationErrorType = ERROR_TYPES.QUOTA_EXCEEDED;
          } else {
            rotationErrorType = ERROR_TYPES.API_KEY_ERROR;
          }
        }

        const isKeyError =
          rotationErrorType === ERROR_TYPES.AUTHENTICATION_ERROR ||
          rotationErrorType === ERROR_TYPES.QUOTA_EXCEEDED ||
          rotationErrorType === ERROR_TYPES.API_KEY_ERROR;

        if (isKeyError) {
          console.warn(`[BG] API key-related error detected (${rotationErrorType}): ${result.error}`);

          // Rotate to next key
          const nextKey = await apiKeyManager.rotateToNextKey(rotationErrorType);

          // Count this attempt regardless; we tried one key
          attempts++;

          if (nextKey) {
            emitAgentLog?.(typeof options?.tabId === "number" ? options.tabId : -1, {
              level: LOG_LEVELS.WARN,
              msg: "Rotating API key due to error",
              errorType: rotationErrorType,
              fromKey: currentKey.name,
              toKey: nextKey.name
            });
            // Respect RetryInfo if present (e.g., 50s) else use configured delay with jitter
            let delayMs = API_KEY_ROTATION.RETRY_DELAY_MS;
            try {
              // Look for retry delay hints embedded in the error message
              // Example snippet may include 'retryDelay': '50s'
              const m = String(result.error || '').match(/retryDelay\"?\s*[:=]\s*\"?(\d+)(s|ms)?/i);
              if (m) {
                const val = parseInt(m[1], 10);
                const unit = (m[2] || 'ms').toLowerCase();
                delayMs = unit === 's' ? val * 1000 : val;
              }
            } catch (_) {}
            // Add jitter 0.5x-1.5x
            const jitter = 0.5 + Math.random();
            await new Promise(resolve => setTimeout(resolve, Math.max(500, Math.floor(delayMs * jitter))));
            continue; // Try again with the newly selected key
          } else {
            console.warn("[BG] No more API keys available for rotation");
            return {
              ok: false,
              error: `No available API keys after ${attempts} attempt(s). Last error: ${result.error}`,
              errorType: rotationErrorType
            };
          }
        }

        // Not a key-specific error; return immediately
        return result;
      }
    } catch (error) {
      // Count this as an attempt to avoid loop lock
      attempts++;
      console.error(`[BG] Unexpected error during model call:`, error);
      // Try rotating as generic API_KEY_ERROR once, else bail if exhausted
      const nextKey = await apiKeyManager.rotateToNextKey(ERROR_TYPES.API_KEY_ERROR);
      if (attempts < maxAttempts && nextKey) {
        const jitter = 0.5 + Math.random();
        await new Promise(resolve => setTimeout(resolve, Math.floor(API_KEY_ROTATION.RETRY_DELAY_MS * jitter)));
        continue;
      }
      return {
        ok: false,
        error: error.message || "Unexpected error during model call",
        errorType: ERROR_TYPES.MODEL_ERROR
      };
    }
  }

  return {
    ok: false,
    error: `Failed to get response after trying ${maxAttempts} API key(s)`,
    errorType: ERROR_TYPES.API_KEY_ERROR
  };
}

async function dispatchActionWithTimeout(tabId, action, settings, timeoutMs = TIMEOUTS.DOM_ACTION_MS) {
  const startedAt = Date.now();
  try {
    // Emit tool_started to timeline
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolStarted === 'function') {
        await globalThis.AgentObserver.emitToolStarted(tabId, action?.tool || 'unknown', action?.params || {});
      }
    } catch (_) {}

    const res = await withTimeout(
      dispatchAgentAction(tabId, action, settings),
      timeoutMs,
      'DOM action'
    );

    // Emit tool_result to timeline
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolResult === 'function') {
        await globalThis.AgentObserver.emitToolResult(tabId, action?.tool || 'unknown', {
          ok: res?.ok !== false,
          observation: res?.observation || '',
          durationMs: Math.max(0, Date.now() - startedAt),
          data: res?.data,
          links: res?.links,
          tabs: res?.tabs,
          report: res?.report
        });
      }
    } catch (_) {}

    return res;
  } catch (error) {
    // Emit failure result as well
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolResult === 'function') {
        await globalThis.AgentObserver.emitToolResult(tabId, action?.tool || 'unknown', {
          ok: false,
          observation: `Action failed: ${error.message}`,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: String(error?.message || error)
        });
      }
    } catch (_) {}

    return {
      ok: false,
      observation: `Action failed: ${error.message}`,
      errorType: error.message.includes('timeout') ? ERROR_TYPES.TIMEOUT : ERROR_TYPES.DOM_ERROR
    };
  }
}

// JSON extraction with retry capability
function extractJSONWithRetry(text, context = 'JSON') {
  // Try fenced code block first
  const fencedMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/i);
  if (fencedMatch) {
    try {
      const raw = fencedMatch[1];
      try {
        return { success: true, data: JSON.parse(raw) };
      } catch (e1) {
        const cleaned = sanitizeModelJson(raw);
        return { success: true, data: JSON.parse(cleaned) };
      }
    } catch (e) {
      console.warn('Failed to parse fenced JSON:', e);
    }
  }
  
  // Fallback to brace search
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const jsonStr = text.slice(jsonStart, jsonEnd + 1);
    try {
      try {
        return { success: true, data: JSON.parse(jsonStr) };
      } catch (e1) {
        const cleaned = sanitizeModelJson(jsonStr);
        return { success: true, data: JSON.parse(cleaned) };
      }
    } catch (e) {
      console.warn('Failed to parse brace-extracted JSON:', e);
    }
  }
  
  return { 
    success: false, 
    error: `Failed to extract valid JSON from ${context}`,
    rawText: text.substring(0, 500) + (text.length > 500 ? '...' : '')
  };
}

// Attempt to repair common model JSON issues: comments, trailing commas, single quotes
function sanitizeModelJson(input) {
  let s = String(input || '');
  // Strip surrounding code fences if present (any fence)
  s = s.replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/m, '$1');
  // Remove block comments /* ... */
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments // ... (to end of line)
  s = s.replace(/^\s*\/\/.*$/gm, '');
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Convert single-quoted property names to double-quoted
  s = s.replace(/'([A-Za-z0-9_]+)'\s*:/g, '"$1":');
  // Convert single-quoted string values to double-quoted (simple case)
  s = s.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"');
  // Normalize whitespace
  s = s.trim();
  return s;
}

// Deep merge utility for findings
function deepMerge(target, source) {
  const output = { ...target };

  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else if (Array.isArray(source[key])) {
        const targetArray = target[key] || [];
        // Simple concat, can be improved with unique checks if needed
        output[key] = targetArray.concat(source[key]);
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }

  return output;
}

function isObject(item) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

// Template variable resolution system
function resolveTemplateVariables(params, sess, tabId) {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const resolvedParams = { ...params };
  const context = buildTemplateContext(sess, tabId);

  // DEBUG: Log template resolution process
  // DEBUG logging can be noisy; gate behind a flag
  const DEBUG = false;
  if (DEBUG) {
    console.log("[TEMPLATE DEBUG] Original params:", params);
    console.log("[TEMPLATE DEBUG] Substitution context:", context);
  }

  // Recursively resolve template variables in all string parameters
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (typeof value === 'string') {
      const originalValue = value;
      resolvedParams[key] = substituteTemplateVariables(value, context);
      
      // DEBUG: Log each substitution
      if (DEBUG) {
        if (originalValue !== resolvedParams[key]) {
          console.log(`[TEMPLATE DEBUG] Substituted ${key}: "${originalValue}" -> "${resolvedParams[key]}"`);
        } else if (originalValue.includes('{{')) {
          console.log(`[TEMPLATE DEBUG] No substitution for ${key}: "${originalValue}" (contains template variables)`);
        }
      }
    }
  }

  if (DEBUG) console.log("[TEMPLATE DEBUG] Resolved params:", resolvedParams);
  return resolvedParams;
}

// Build context for template variable substitution
function buildTemplateContext(sess, tabId) {
  const context = {
    // Current page context
    CURRENT_URL: '',
    CURRENT_TITLE: '',
    
    // Research context
    PREVIOUS_RESEARCHED_URL: '',
    PREVIOUS_STEP_RESULT_URL_1: '', // Support for numbered URL variables
    PREVIOUS_STEP_RESULT_URL_2: '',
    PREVIOUS_STEP_RESULT_URL_3: '',
    
    // URL analysis results
    url_from_analyze_urls_result_1: '',
    url_from_analyze_urls_result_2: '',
    url_from_analyze_urls_result_3: '',
    
    LAST_SEARCH_QUERY: '',
    CURRENT_SEARCH_RESULTS: '',
    
    // Multi-search context
    CURRENT_SEARCH_TERM: '',
    NEXT_SEARCH_TERM: '',
    
    // Session context
    CURRENT_GOAL: sess?.goal || '',
    CURRENT_SUBTASK: sess?.subTasks?.[sess?.currentTaskIndex] || '',
    USER_LOCATION: getUserLocationFromTimezone()
  };

  // DEBUG: Log session state for context building
  const DEBUG = false;
  if (DEBUG) console.log("[CONTEXT DEBUG] Building context for tabId:", tabId);
  if (DEBUG) console.log("[CONTEXT DEBUG] Session state:", {
    hasHistory: !!(sess?.history && sess.history.length > 0),
    historyLength: sess?.history?.length || 0,
    hasAnalyzedUrls: !!(sess?.analyzedUrls && Array.isArray(sess.analyzedUrls)),
    analyzedUrlsLength: sess?.analyzedUrls?.length || 0,
    goal: sess?.goal,
    currentTaskIndex: sess?.currentTaskIndex
  });

  // Extract research context from session history
  if (sess?.history && sess.history.length > 0) {
    const recentActions = sess.history.slice(-5);
    
    // DEBUG: Log recent actions
    if (DEBUG) console.log("[CONTEXT DEBUG] Recent actions:", recentActions.map(h => ({
      tool: h.action?.tool,
      url: h.action?.params?.url,
      observation: h.observation?.substring(0, 100)
    })));
    
    // Find multiple researched URLs for numbered variables
    const researchActions = recentActions.filter(h =>
      h.action?.tool === 'research_url' ||
      h.action?.tool === 'navigate' ||
      h.action?.tool === 'smart_navigate'
    ).reverse(); // Most recent first
    
    // DEBUG: Log research actions found
    if (DEBUG) console.log("[CONTEXT DEBUG] Research actions found:", researchActions.map(h => ({
      tool: h.action?.tool,
      url: h.action?.params?.url
    })));
    
    // Populate numbered URL variables
    if (researchActions.length > 0) {
      context.PREVIOUS_RESEARCHED_URL = researchActions[0].action?.params?.url || '';
      context.PREVIOUS_STEP_RESULT_URL_1 = researchActions[0].action?.params?.url || '';
      if (DEBUG) console.log("[CONTEXT DEBUG] Set PREVIOUS_STEP_RESULT_URL_1:", context.PREVIOUS_STEP_RESULT_URL_1);
    }
    if (researchActions.length > 1) {
      context.PREVIOUS_STEP_RESULT_URL_2 = researchActions[1].action?.params?.url || '';
      if (DEBUG) console.log("[CONTEXT DEBUG] Set PREVIOUS_STEP_RESULT_URL_2:", context.PREVIOUS_STEP_RESULT_URL_2);
    }
    if (researchActions.length > 2) {
      context.PREVIOUS_STEP_RESULT_URL_3 = researchActions[2].action?.params?.url || '';
      if (DEBUG) console.log("[CONTEXT DEBUG] Set PREVIOUS_STEP_RESULT_URL_3:", context.PREVIOUS_STEP_RESULT_URL_3);
    }
    
    // Find URLs from analyze_urls results stored in session
    if (sess.analyzedUrls && Array.isArray(sess.analyzedUrls)) {
      if (DEBUG) console.log("[CONTEXT DEBUG] Found analyzedUrls:", sess.analyzedUrls);
      // Populate the url_from_analyze_urls_result_* variables
      if (sess.analyzedUrls.length > 0) {
        context.url_from_analyze_urls_result_1 = sess.analyzedUrls[0];
      }
      if (sess.analyzedUrls.length > 1) {
        context.url_from_analyze_urls_result_2 = sess.analyzedUrls[1];
      }
      if (sess.analyzedUrls.length > 2) {
        context.url_from_analyze_urls_result_3 = sess.analyzedUrls[2];
      }
    }
    
    // Find last search query
    const lastSearchAction = recentActions.find(h =>
      h.action?.tool === 'multi_search' ||
      h.action?.tool === 'smart_navigate'
    );
    
    if (lastSearchAction?.action?.params?.query) {
      context.LAST_SEARCH_QUERY = lastSearchAction.action.params.query;
    }
  }

  // Multi-search context
  if (sess?.multiSearchTerms && sess?.multiSearchIndex !== undefined) {
    const currentIndex = sess.multiSearchIndex || 0;
    context.CURRENT_SEARCH_TERM = sess.multiSearchTerms[currentIndex] || '';
    context.NEXT_SEARCH_TERM = sess.multiSearchTerms[currentIndex + 1] || '';
  }

  // DEBUG: Log final context with non-empty values
  const nonEmptyContext = Object.entries(context)
    .filter(([key, value]) => value !== '')
    .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});
  if (DEBUG) console.log("[CONTEXT DEBUG] Final context (non-empty values):", nonEmptyContext);

  return context;
}

// Substitute template variables in a string
function substituteTemplateVariables(text, context) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let result = text;
  
  // DEBUG: Log substitution attempt
  const DEBUG = false;
  const templateMatches = text.match(/\{\{([A-Za-z_]+)\}\}/g);
  if (DEBUG && templateMatches) {
    console.log("[SUBSTITUTION DEBUG] Found template variables in text:", templateMatches);
  }
  
  // Replace template variables like {{VARIABLE_NAME}} or {{variable_name}}
  const templateRegex = /\{\{([A-Za-z_]+)\}\}/g;
  result = result.replace(templateRegex, (match, variableName) => {
    const DEBUG = false;
    if (DEBUG) console.log(`[SUBSTITUTION DEBUG] Processing variable: ${variableName}`);
    
    const value = context[variableName];
    if (DEBUG) console.log(`[SUBSTITUTION DEBUG] Context value for ${variableName}:`, value);
    
    if (value !== undefined && value !== '') {
      if (DEBUG) console.log(`[SUBSTITUTION DEBUG] Using context value for ${variableName}: "${value}"`);
      return value;
    }
    
    // If template variable can't be resolved, try to provide a sensible fallback
    const fallbackValue = getFallbackValue(variableName, context);
    if (DEBUG) console.log(`[SUBSTITUTION DEBUG] Using fallback value for ${variableName}: "${fallbackValue}"`);
    return fallbackValue;
  });

  return result;
}

// Provide fallback values for unresolved template variables
function getFallbackValue(variableName, context) {
  // Handle numbered URL variables
  if (variableName.startsWith('PREVIOUS_STEP_RESULT_URL_')) {
    const urlNumber = parseInt(variableName.split('_').pop());
    if (urlNumber && urlNumber >= 1) {
      // Fallback to PREVIOUS_RESEARCHED_URL for any numbered URL variable
      if (context.PREVIOUS_RESEARCHED_URL) {
        return context.PREVIOUS_RESEARCHED_URL;
      }
      // If no previous URL, generate a search URL based on current goal
      if (context.LAST_SEARCH_QUERY) {
        return `https://www.google.com/search?q=${encodeURIComponent(context.LAST_SEARCH_QUERY)}`;
      }
      if (context.CURRENT_GOAL) {
        return `https://www.google.com/search?q=${encodeURIComponent(context.CURRENT_GOAL)}`;
      }
      return 'https://www.google.com';
    }
  }
  
  // Handle analyze_urls result variables
  if (variableName.startsWith('url_from_analyze_urls_result_')) {
    const urlNumber = parseInt(variableName.split('_').pop());
    if (urlNumber && urlNumber >= 1) {
      // Fallback to previous researched URL or generate search URL
      if (context.PREVIOUS_RESEARCHED_URL) {
        return context.PREVIOUS_RESEARCHED_URL;
      }
      if (context.LAST_SEARCH_QUERY) {
        return `https://www.google.com/search?q=${encodeURIComponent(context.LAST_SEARCH_QUERY)}`;
      }
      if (context.CURRENT_GOAL) {
        return `https://www.google.com/search?q=${encodeURIComponent(context.CURRENT_GOAL)}`;
      }
      return 'https://www.google.com';
    }
  }
  
  switch (variableName) {
    case 'PREVIOUS_RESEARCHED_URL':
      // If no previous URL, use current URL or a search URL
      if (context.CURRENT_URL && context.CURRENT_URL !== 'about:blank') {
        return context.CURRENT_URL;
      }
      if (context.LAST_SEARCH_QUERY) {
        return `https://www.google.com/search?q=${encodeURIComponent(context.LAST_SEARCH_QUERY)}`;
      }
      return 'https://www.google.com';
      
    case 'LAST_SEARCH_QUERY':
      return context.CURRENT_GOAL || 'information';
      
    case 'CURRENT_SEARCH_TERM':
      return context.LAST_SEARCH_QUERY || context.CURRENT_GOAL || 'search';
      
    case 'USER_LOCATION':
      return 'singapore';
      
    default:
      // Return empty string for unknown variables
      return '';
  }
}

// [SCHEMA VALIDATION] Validate an action against the defined schema
function validateAction(action) {
  const errors = [];
  const schema = globalThis.ACTION_SCHEMA;

  if (!action || typeof action !== 'object') {
    return { valid: false, errors: ['Action must be an object.'] };
  }

  // Check for required top-level properties
  for (const key of schema.required) {
    if (!(key in action)) {
      errors.push(`Missing required property: '${key}'`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Validate 'tool'
  if (!schema.properties.tool.enum.includes(action.tool)) {
    errors.push(`Invalid tool: '${action.tool}'. Must be one of: ${schema.properties.tool.enum.join(', ')}`);
  }

  // Validate 'params'
  if (action.params && typeof action.params === 'object') {
    for (const [param, value] of Object.entries(action.params)) {
      const paramSchema = schema.properties.params.properties[param];
      // For record_finding, ignore unknown extra params (will be normalized)
      if (!paramSchema) {
        if (action.tool === 'record_finding') {
          // Silently ignore unknown params for this tool; the dispatcher will normalize
          continue;
        }
        errors.push(`Unknown parameter '${param}' for tool '${action.tool}'.`);
        continue;
      }
      const expectedTypes = Array.isArray(paramSchema.type) ? paramSchema.type : [paramSchema.type];
      if (!expectedTypes.includes(typeof value)) {
          // Allow number for integer type
        if (!(expectedTypes.includes('integer') && typeof value === 'number')) {
          errors.push(`Invalid type for param '${param}'. Expected ${expectedTypes.join(' or ')}, got ${typeof value}.`);
        }
      }
      if (paramSchema.maxLength && value.length > paramSchema.maxLength) {
        errors.push(`Parameter '${param}' is too long.`);
      }
       if (paramSchema.enum && !paramSchema.enum.includes(value)) {
        errors.push(`Invalid value for param '${param}'. Must be one of: ${paramSchema.enum.join(', ')}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}
// Action pre-normalizer and repair helpers
function tryParseJSONMaybe(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeRecordFindingParams(params) {
  const normalized = { ...(params || {}) };

  // If finding exists as string JSON, parse it
  if (typeof normalized.finding === 'string') {
    const parsed = tryParseJSONMaybe(normalized.finding);
    if (parsed && typeof parsed === 'object') {
      normalized.finding = parsed;
    }
  }

  // If finding missing or invalid, attempt to construct it from common synonyms
  const findingIsObject = normalized.finding && typeof normalized.finding === 'object' && !Array.isArray(normalized.finding);
  if (!findingIsObject) {
    let candidate = null;

    // Prefer explicit 'data' object
    if (normalized.data && typeof normalized.data === 'object') {
      candidate = { ...normalized.data };
    }

    // Pair: finding_name + finding_value
    if (!candidate && typeof normalized.finding_name === 'string' && normalized.finding_value !== undefined) {
      candidate = { [normalized.finding_name]: normalized.finding_value };
    }

    // Single summary/value
    if (!candidate && typeof normalized.summary === 'string') {
      candidate = { summary: normalized.summary };
    }

    if (!candidate && typeof normalized.value === 'string') {
      candidate = { value: normalized.value };
    }

    // If still not found, aggregate all non-meta params into a finding object
    if (!candidate) {
      const metaKeys = new Set(['timeout', 'timeoutMs', 'thought', 'tabId']);
      const temp = {};
      for (const [k, v] of Object.entries(normalized)) {
        if (k === 'finding') continue;
        if (metaKeys.has(k)) continue;
        temp[k] = v;
      }
      if (Object.keys(temp).length > 0) {
        candidate = temp;
      }
    }

    if (candidate) {
      normalized.finding = candidate;
    }
  }

  // Attach common metadata fields into the finding.meta bucket
  if (normalized.finding && typeof normalized.finding === 'object') {
    const metaFields = ['source', 'date_extracted', 'explanation', 'data_type', 'sub_task_goal'];
    for (const key of metaFields) {
      if (normalized[key] !== undefined) {
        if (!normalized.finding.meta || typeof normalized.finding.meta !== 'object') {
          normalized.finding.meta = {};
        }
        normalized.finding.meta[key] = normalized[key];
      }
    }
  }

  // Drop all extra params; leave only { finding } plus safe meta timing fields if needed
  const finalParams = {};
  if (normalized.finding && typeof normalized.finding === 'object') {
    finalParams.finding = normalized.finding;
  }
  // Preserve timeout if present
  if (typeof normalized.timeoutMs === 'number') finalParams.timeoutMs = normalized.timeoutMs;
  if (typeof normalized.timeout === 'number') finalParams.timeout = normalized.timeout;

  return finalParams;
}

function preNormalizeAction(action) {
  if (!action || typeof action !== 'object') return action;
  const out = { ...action, params: { ...(action.params || {}) } };
  if (out.tool === 'record_finding') {
    out.params = normalizeRecordFindingParams(out.params);
  }
  return out;
}

// Action normalization shim: map aliases and remove unknown params to satisfy schema
function normalizeActionAliases(action) {
  if (!action || typeof action !== 'object') return action;

  const schema = globalThis.ACTION_SCHEMA || {};
  const allowedParamKeys = Object.keys(
    (schema.properties && schema.properties.params && schema.properties.params.properties) || {}
  );

  const toolAliasMap = {
    click: 'click_element',
    fill: 'type_text',
    waitForSelector: 'wait_for_selector',
    screenshot: 'take_screenshot',
    readPageContent: 'read_page_content',
    extractStructuredContent: 'extract_structured_content',
    analyzeUrls: 'analyze_urls',
    getPageLinks: 'get_page_links',
  };

  const out = {
    ...action,
    tool: toolAliasMap[action.tool] || action.tool,
    params: { ...(action.params || {}) }
  };

  // Normalize common parameter aliases and cleanups
  if (typeof out.params.selector === 'string') {
    out.params.selector = out.params.selector.trim();
  }

  // Remove non-canonical/LLM-only fields
  if ('selector_type' in out.params) delete out.params.selector_type;
  if ('state' in out.params) delete out.params.state;

  // Normalize typing parameter
  if (out.tool === 'type_text' && typeof out.params.text === 'undefined' && typeof out.params.value !== 'undefined') {
    out.params.text = out.params.value;
  }

  // Drop any params not present in the global schema to pass validation
  for (const k of Object.keys(out.params)) {
    if (!allowedParamKeys.includes(k)) {
      delete out.params[k];
    }
  }

  return out;
}


// [SUCCESS CRITERIA] Check if the agent has met the goal's success criteria
function checkSuccessCriteria(sess, tabId) {
  if (!sess || !sess.successCriteria) {
    return { success: false, errors: ["Success criteria not defined for this session."] };
  }
  
  const { isValid, errors } = globalThis.validateFindings(sess.findings, sess.successCriteria);
  
  if (isValid) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.SUCCESS,
      msg: "Success criteria met."
    });
    return { success: true };
  } else {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.WARN,
      msg: "Success criteria not yet met.",
      errors: errors
    });
    return { success: false, errors };
  }
}

// Side panel open helper (MV3 sidePanel API)
async function openSidePanel(tabId) {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ tabId });
    }
  } catch (e) {
    // Some Chrome versions gate sidePanel API or require manifest flag
    console.warn("sidePanel.open not available:", e);
  }
}


chrome.action.onClicked.addListener(async (tab) => {
  await openSidePanel(tab.id);
});

function emitAgentLog(tabId, entry) {
  const sess = agentSessions.get(tabId);
  if (!sess) return;
  
  // Sanitize large data for logging to avoid clutter
  const sanitizedEntry = { ...entry };
  if (sanitizedEntry.pageContent) {
      sanitizedEntry.pageContent = sanitizedEntry.pageContent.substring(0, 200) + "...";
  }
  if (sanitizedEntry.result?.tabs) {
      sanitizedEntry.result.tabs = `Found ${sanitizedEntry.result.tabs.length} tabs`;
  }

  const logEntry = {
    ts: Date.now(),
    step: sess.step ?? 0,
    ...sanitizedEntry
  };

  // Also log to the service worker console for easier debugging
  console.log(`[AGENT LOG][Tab: ${tabId}]`, logEntry);

  sess.logs.push(logEntry);
  
  // Session is now persisted after each action in updateSessionContext.
  // The call here is removed to avoid redundant writes.
  
  try {
    chrome.runtime.sendMessage({ type: MSG.AGENT_LOG, tabId, entry: logEntry });
  } catch (_) {}

  // Send progress updates to chat for key events (with throttling)
  if (shouldSendProgressToChat(entry)) {
    const progressMessage = formatProgressMessage(entry, sess);
    // Only send if we have a valid message (formatProgressMessage can return null to skip)
    if (progressMessage && shouldThrottleProgressMessage(tabId, progressMessage)) {
      try {
        // Add agent message to transcript
        sess.chatTranscript.push({
          role: 'agent',
          content: progressMessage,
          timestamp: Date.now()
        });

        chrome.runtime.sendMessage({
          type: MSG.AGENT_PROGRESS,
          tabId,
          message: progressMessage,
          step: Math.max(1, sess.step ?? 1),
          timestamp: Date.now()
        });
      } catch (_) {}
    }
  }
}

// Throttle progress messages to prevent chat spam
function shouldThrottleProgressMessage(tabId, message) {
  const now = Date.now();
  const throttleData = progressThrottle.get(tabId) || {
    lastProgressTime: 0,
    messageCount: 0,
    lastMessage: ''
  };
  
  // Don't send duplicate messages
  if (throttleData.lastMessage === message) {
    return false;
  }
  
  // Reset message count if enough time has passed
  if (now - throttleData.lastProgressTime > PROGRESS_THROTTLE_MS * 2) {
    throttleData.messageCount = 0;
  }
  
  // Check if we should throttle based on time and burst limit
  const timeSinceLastMessage = now - throttleData.lastProgressTime;
  const shouldThrottle = timeSinceLastMessage < PROGRESS_THROTTLE_MS &&
                        throttleData.messageCount >= MAX_PROGRESS_BURST;
  
  if (!shouldThrottle) {
    // Update throttle data
    throttleData.lastProgressTime = now;
    throttleData.messageCount++;
    throttleData.lastMessage = message;
    progressThrottle.set(tabId, throttleData);
    return true;
  }
  
  return false;
}

// Determine which log entries should be sent as chat progress updates
function shouldSendProgressToChat(entry) {
  // Always send errors (they're important)
  if (entry.level === LOG_LEVELS.ERROR) return true;
  
  // Send progress for key milestones and important events
  if (entry.level === LOG_LEVELS.INFO && entry.msg) {
    const msg = entry.msg.toLowerCase();
    // Key progress indicators - be more selective
    if (msg.includes('agent started') ||
        msg.includes('plan generated') ||
        msg.includes('executing tool') ||
        msg.includes('multi-search initiated') ||
        msg.includes('report generated')) {
      return true;
    }
    
    // Skip generic "completed" messages to reduce noise
    if (msg.includes('completed') && !msg.includes('plan completed')) {
      return false;
    }
  }
  
  // Send success messages for important tools only
  if (entry.level === LOG_LEVELS.SUCCESS && entry.tool) {
    const importantTools = ['navigate', 'smart_navigate', 'research_url', 'multi_search', 'generate_report'];
    if (importantTools.includes(entry.tool)) {
      return true;
    }
  }
  
  return false;
}

// Format log entries into user-friendly chat messages
function formatProgressMessage(entry, sess) {
  const step = Math.max(1, sess.step ?? 1); // Ensure step starts at 1, not 0
  const maxSteps = sess.settings?.maxSteps || 12;
  const stepPrefix = `[Step ${step}/${maxSteps}]`;
  
  // Handle different types of progress messages
  if (entry.level === LOG_LEVELS.ERROR) {
    return `${stepPrefix} ❌ Error: ${entry.msg || 'Something went wrong'}`;
  }
  
  const msg = entry.msg || '';
  
  // Agent lifecycle messages (no step prefix for these)
  if (msg.includes('Agent started')) {
    return `🚀 Agent started working on your task...`;
  }
  
  if (msg.includes('plan generated') || msg.includes('Multi-step plan generated')) {
    const planCount = entry.plan?.length || 'several';
    return `📋 Generated plan with ${planCount} steps`;
  }
  
  // Tool execution messages - be more specific about what's happening
  if (msg.includes('Executing Tool')) {
    const tool = entry.tool || entry.action?.tool || 'action';
    return `${stepPrefix} 🔧 ${getToolEmoji(tool)} ${getToolDescription(tool)}`;
  }
  
  // Action completion messages - only show for important tools
  if (entry.level === LOG_LEVELS.SUCCESS && entry.tool) {
    const importantTools = ['navigate', 'smart_navigate', 'research_url', 'multi_search', 'generate_report'];
    if (importantTools.includes(entry.tool)) {
      return `${stepPrefix} ✅ ${getToolDescription(entry.tool)} completed`;
    }
  }
  
  // Navigation messages
  if (msg.includes('Navigated to') || msg.includes('Navigation')) {
    return `${stepPrefix} 🌐 Navigating to new page...`;
  }
  
  // Search and analysis messages
  if (msg.includes('searching') || msg.includes('Multi-search')) {
    return `${stepPrefix} 🔍 Searching for information...`;
  }
  
  if (msg.includes('analyzing') || msg.includes('URL analysis')) {
    return `${stepPrefix} 🔍 Analyzing page content...`;
  }
  
  // Don't show generic "completed" messages to reduce noise
  if (msg.includes('completed') || msg.includes('finished')) {
    return null; // Skip generic completion messages
  }
  
  if (msg.includes('found') && entry.observation) {
    return `${stepPrefix} 📍 Found relevant information`;
  }
  
  if (msg.includes('report generated')) {
    return `${stepPrefix} 📄 Generated summary report`;
  }
  
  // Generic progress message
  return `${stepPrefix} ⚡ ${msg}`;
}

// Get emoji for different tools
function getToolEmoji(tool) {
  const emojiMap = {
    'navigate': '🌐',
    'click': '👆',
    'fill': '✏️',
    'scroll': '📜',
    'screenshot': '📸',
    'scrape': '✂️',
    'think': '🤔',
    'waitForSelector': '⏳',
    'tabs.query': '🗂️',
    'tabs.activate': '🔄',
    'tabs.close': '❌',
    'smart_navigate': '🧭',
    'research_url': '🔬',
    'multi_search': '🔍',
    'analyze_urls': '🔍',
    'generate_report': '📄'
  };
  return emojiMap[tool] || '🔧';
}

// Get user-friendly description for tools
function getToolDescription(tool) {
  const descriptionMap = {
    'navigate': 'Opening webpage',
    'click': 'Clicking element',
    'fill': 'Filling form field',
    'scroll': 'Scrolling page',
    'scrape': 'Scraping content',
    'think': 'Thinking',
    'screenshot': 'Taking screenshot',
    'waitForSelector': 'Waiting for element',
    'tabs.query': 'Searching tabs',
    'tabs.activate': 'Switching tab',
    'tabs.close': 'Closing tab',
    'smart_navigate': 'Smart navigation',
    'research_url': 'Researching content',
    'multi_search': 'Multi-source search',
    'analyze_urls': 'Analyzing links',
    'generate_report': 'Creating report'
  };
  return descriptionMap[tool] || `Using ${tool}`;
}

function stopAgent(tabId, reason = "STOP requested") {
  const sess = agentSessions.get(tabId);
  if (!sess) return;
  sess.stopped = true;
  sess.running = false;
  emitAgentLog(tabId, { level: "warn", msg: "Agent stopped", reason });

  // Emit run_state: stopped
  try {
    if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitRunState === 'function') {
      globalThis.AgentObserver.emitRunState(tabId, 'stopped', { reason });
    }
  } catch (_) {}
  
  // Persist final session state
  saveSessionToStorage(tabId, sess);

  // If the agent is stopping because the goal is achieved, clear the session from DB
  if (reason.includes("Goal achieved") || reason.includes("done")) {
    console.log(`[BG] Task for tab ${tabId} is complete. Clearing session from IndexedDB.`);
    clearSession(tabId).catch(e => console.warn(`[BG] Failed to clear session ${tabId}:`, e));
  }
}

async function getPageInfoForPlanning(tabId) {
  // Try to get title/url via tabs API; content script may add more later
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === tabId) {
    return { title: tab.title || "", url: tab.url || "" };
  }
  const t = await chrome.tabs.get(tabId);
  return { title: t?.title || "", url: t?.url || "" };
}

function isRestrictedUrl(url = "") {
  return url.startsWith("chrome://") || url.startsWith("about:") || url.startsWith("edge://");
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "__PING_CONTENT__" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["common/messages.js", "content/content.js"]
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Core Tools Registration via ToolsRegistry
 * - navigateToUrl: open a URL in the current tab
 * - extractLinks: extract relevant links via content script
 */
(function registerCoreTools() {
  try {
    if (!globalThis.ToolsRegistry) {
      console.warn("[BG] ToolsRegistry not available; skipping core tool registration");
      return;
    }

    // navigateToUrl
    globalThis.ToolsRegistry.registerTool({
      id: "navigateToUrl",
      title: "Navigate to URL",
      description: "Open the specified URL in the current tab.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", maxLength: 2048 }
        },
        required: ["url"]
      },
      retryPolicy: { maxAttempts: 1 },
      preconditions: async (_ctx, input) => {
        const url = String(input?.url || "");
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, observation: "Invalid or unsupported URL (must start with http/https)" };
        }
        return { ok: true };
      },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        const url = String(input.url);
        await chrome.tabs.update(tabId, { url });
        return { ok: true, observation: `Navigated to ${url}` };
      }
    });

    // extractLinks
    globalThis.ToolsRegistry.registerTool({
      id: "extractLinks",
      title: "Extract Page Links",
      description: "Extract relevant links from the current page.",
      inputSchema: {
        type: "object",
        properties: {
          includeExternal: { type: "boolean" },
          maxLinks: { type: ["integer", "number"] }
        }
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 300 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        const includeExternal = input?.includeExternal !== false;
        const maxLinks = Number(input?.maxLinks || 20);

        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_LINKS", includeExternal, maxLinks });
        if (res?.ok) {
          return {
            ok: true,
            observation: `Found ${res.links?.length || 0} relevant links`,
            links: res.links
          };
        }
        return { ok: false, observation: res?.error || "Link extraction failed" };
      }
    });

    // readPageContent
    globalThis.ToolsRegistry.registerTool({
      id: "readPageContent",
      title: "Read Page Content",
      description: "Reads textual content from the current page.",
      inputSchema: {
        type: "object",
        properties: {
          maxChars: { type: ["integer", "number"] }
        }
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const maxChars = Number(input?.maxChars || 15000);
        const res = await chrome.tabs.sendMessage(tabId, { type: "READ_PAGE_CONTENT", maxChars });
        if (res?.ok) {
          return { ok: true, observation: `Read page content (${res.text?.length || 0} chars)`, pageContent: res.text };
        }
        return { ok: false, observation: res?.error || "Failed to read page content" };
      }
    });

    // analyzeUrls
    globalThis.ToolsRegistry.registerTool({
      id: "analyzeUrls",
      title: "Analyze Page URLs",
      description: "Analyzes current page for relevant links/URLs.",
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: MSG.ANALYZE_PAGE_URLS });
        if (res?.ok) {
          return {
            ok: true,
            observation: `URL analysis completed. Found ${res.analysis?.relevantUrls?.length || 0} relevant URLs.`,
            analysis: res.analysis
          };
        }
        return { ok: false, observation: res?.error || "URL analysis failed" };
      }
    });

    // extractStructuredContent
    globalThis.ToolsRegistry.registerTool({
      id: "extractStructuredContent",
      title: "Extract Structured Content",
      description: "Extracts structured content (JSON-LD, metadata) from the page.",
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT_STRUCTURED_CONTENT });
        if (res?.ok) {
          return { ok: true, observation: `Structured content extracted via ${res.content?.source || 'unknown'}`, content: res.content };
        }
        return { ok: false, observation: res?.error || "Content extraction failed" };
      }
    });

    // recordFinding (session-coupled)
    globalThis.ToolsRegistry.registerTool({
      id: "recordFinding",
      title: "Record Finding",
      description: "Stores a structured finding into the current session.",
      inputSchema: {
        type: "object",
        properties: {
          finding: { type: "object" }
        },
        required: ["finding"]
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        const finding = input?.finding;
        if (!finding || typeof finding !== 'object') {
          return { ok: false, observation: "Invalid 'finding' parameter" };
        }
        const sess = agentSessions.get(tabId);
        if (!sess) {
          return { ok: false, observation: "No active session" };
        }
        try {
          sess.findings = deepMerge(sess.findings || {}, finding);
          emitAgentLog(tabId, { level: LOG_LEVELS.SUCCESS, msg: "Recorded finding to session (via ToolsRegistry)", finding });
          await saveSessionToStorage(tabId, sess);
          return { ok: true, observation: "Finding recorded" };
        } catch (e) {
          return { ok: false, observation: `Failed to record finding: ${String(e?.message || e)}` };
        }
      }
    });

    console.log("[BG] Core tools registered: navigateToUrl, extractLinks, readPageContent, analyzeUrls, extractStructuredContent, recordFinding");
  } catch (e) {
    console.warn("[BG] Core tool registration failed:", e);
  }
})();

/**
 * Wrapper to run a registered tool with standardized timeline events.
 */
async function runRegisteredTool(tabId, toolId, input) {
  const startedAt = Date.now();
  // Best-effort namespaced logger
  const log = BG_LOG?.withContext?.({ tabId, toolId }) || BG_LOG;

  // Console summary for start
  try { log?.info?.("tool_started", { input: sanitizeForLog(input) }); } catch (_) {}

  // Emit tool_started
  try {
    if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolStarted === "function") {
      await globalThis.AgentObserver.emitToolStarted(tabId, toolId, input || {});
    }
  } catch (_) {}

  try {
    const ctx = {
      tabId,
      ensureContentScript,
      chrome
    };
    const result = await globalThis.ToolsRegistry.runTool(toolId, ctx, input || {});

    // Emit tool_result
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolResult === "function") {
        await globalThis.AgentObserver.emitToolResult(tabId, toolId, {
          ...result,
          durationMs: result?.durationMs ?? Math.max(0, Date.now() - startedAt)
        });
      }
    } catch (_) {}

    // Console summary for result (avoid huge payloads)
    try {
      const summary = {
        ok: result?.ok !== false,
        status: result?.status,
        observation: (result?.observation || "").slice(0, 200),
        durationMs: result?.durationMs ?? Math.max(0, Date.now() - startedAt)
      };
      log?.info?.("tool_result", summary);
    } catch (_) {}

    return result;
  } catch (e) {
    // Emit failure result
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolResult === "function") {
        await globalThis.AgentObserver.emitToolResult(tabId, toolId, {
          ok: false,
          observation: String(e?.message || e),
          durationMs: Math.max(0, Date.now() - startedAt),
          errors: [String(e?.message || e)]
        });
      }
    } catch (_) {}

    // Console error
    try { log?.error?.("tool_error", { error: String(e?.message || e) }); } catch (_) {}

    throw e;
  }

  // Helper to cap verbose inputs in logs
  function sanitizeForLog(obj) {
    try {
      const json = JSON.stringify(obj);
      if (json.length <= 500) return obj;
      // Truncate safely
      return JSON.parse(json.slice(0, 500));
    } catch {
      return obj;
    }
  }
}

async function dispatchAgentAction(tabId, action, settings) {
  const { tool, params = {}, rationale = "" } = action || {};
  const sess = agentSessions.get(tabId);
  if (!sess) throw new Error("No agent session");

  // Normalize legacy tool names from prompts into schema/dispatcher names
  const legacyToolMap = {
    navigate: "goto_url",
    click: "click_element",
    fill: "type_text",
    scroll: "scroll_to",
    waitForSelector: "wait_for_selector",
    screenshot: "take_screenshot",
    "tabs.activate": "switch_tab",
    "tabs.close": "close_tab"
  };
  const normalizedTool = legacyToolMap[tool] || tool;

  // Apply template variable substitution to params
  const resolvedParams = resolveTemplateVariables(params, sess, tabId);
  const normalizedParams = { ...resolvedParams };
  if (normalizedTool === 'type_text' && typeof normalizedParams.text === 'undefined' && typeof normalizedParams.value !== 'undefined') {
    normalizedParams.text = normalizedParams.value;
  }
  const actionWithResolvedParams = { ...action, tool: normalizedTool, params: normalizedParams };

  // Check for permission before executing the action
  try {
    const permission = await permissionManager.hasPermission(tabId, actionWithResolvedParams);
    if (!permission.granted) {
      return { ok: false, observation: "Permission denied by user." };
    }
  } catch (error) {
    return { ok: false, observation: error.message };
  }

  // URL restriction logic has been disabled by user request.

  switch (normalizedTool) {
    case "navigate":
    case "goto_url": {
      const url = String(normalizedParams.url || "");
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, observation: "Invalid URL for navigate" };
      }
      await chrome.tabs.update(tabId, { url });
      return { ok: true, observation: `Navigated to ${url}` };
    }
    case "click_element": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.ERROR,
          msg: "Content script unavailable: cannot execute DOM tool",
          tool: "click_element",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "CLICK_SELECTOR", selector: normalizedParams.selector || "" });
      return res?.ok ? { ok: true, observation: res.msg || "Clicked" } : { ok: false, observation: res?.error || "Click failed" };
    }
    case "type_text": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.ERROR,
          msg: "Content script unavailable: cannot execute DOM tool",
          tool: "type_text",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "FILL_SELECTOR", selector: normalizedParams.selector || "", value: normalizedParams.text ?? "" });
      return res?.ok ? { ok: true, observation: res.msg || "Text entered" } : { ok: false, observation: res?.error || "Typing failed" };
    }
    case "scroll_to": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.ERROR,
          msg: "Content script unavailable: cannot execute DOM tool",
          tool: "scroll_to",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "SCROLL_TO_SELECTOR", selector: normalizedParams.selector || "", direction: normalizedParams.direction || "" });
      return res?.ok ? { ok: true, observation: res.msg || "Scrolled" } : { ok: false, observation: res?.error || "Scroll failed" };
    }
    case "wait_for_selector": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.ERROR,
          msg: "Content script unavailable: cannot execute DOM tool",
          tool: "wait_for_selector",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "WAIT_FOR_SELECTOR", selector: normalizedParams.selector || "", timeoutMs: normalizedParams.timeoutMs || 5000 });
      return res?.ok ? { ok: true, observation: res.msg || "Selector found" } : { ok: false, observation: res?.error || "Wait failed" };
    }
    case "scrape": {
        if (!(await ensureContentScript(tabId))) {
            return { ok: false, observation: "Content script unavailable" };
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: MSG.SCRAPE_SELECTOR, selector: normalizedParams.selector || "" });
        
        if (res?.ok) {
            // Truncate potentially large scraped data for the observation log
            const observationText = `Scraped ${res.data?.length} items. Content: ${JSON.stringify(res.data).substring(0, 500)}...`;
            return { ok: true, observation: observationText, data: res.data };
        } else {
            return { ok: false, observation: res?.error || "Scrape failed" };
        }
    }
    case "think": {
        const thought = String(normalizedParams.thought || "...");
        return { ok: true, observation: `Thought recorded: ${thought}` };
    }
    case "take_screenshot": {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
        return { ok: true, observation: "Screenshot captured", dataUrl };
      } catch (e) {
        return { ok: false, observation: "Screenshot failed: " + String(e?.message || e) };
      }
    }
    case "tabs.query": {
      const titleContains = normalizedParams.titleContains || "";
      const urlContains = normalizedParams.urlContains || "";
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter(t => (titleContains ? (t.title || "").toLowerCase().includes(titleContains.toLowerCase()) : true) &&
                                       (urlContains ? (t.url || "").toLowerCase().includes(urlContains.toLowerCase()) : true))
                          .map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
      return { ok: true, observation: `Found ${matches.length} tabs`, tabs: matches };
    }
    case "create_tab": {
      const { url, active = true } = normalizedParams;
      const newTab = await chrome.tabs.create({ url, active });
      return { ok: true, observation: `Created new tab with ID ${newTab.id}`, tabId: newTab.id };
    }
    case "switch_tab": {
      const tgt = Number(normalizedParams.tabId);
      if (!Number.isFinite(tgt)) return { ok: false, observation: "Invalid tabId" };
      await chrome.tabs.update(tgt, { active: true });
      return { ok: true, observation: `Activated tab ${tgt}` };
    }
    case "close_tab": {
      const tgt = Number(normalizedParams.tabId);
      if (!Number.isFinite(tgt)) return { ok: false, observation: "Invalid tabId" };
      await chrome.tabs.remove(tgt);
      return { ok: true, observation: `Closed tab ${tgt}` };
    }
    case "done": {
      const { success, errors } = checkSuccessCriteria(sess, tabId);
      if (success) {
        return { ok: true, observation: "Goal marked done after meeting success criteria." };
      } else {
        return {
          ok: false,
          observation: `Cannot mark as done. Success criteria not met: ${errors.join(', ')}`,
          errorType: ERROR_TYPES.CRITERIA_NOT_MET
        };
      }
    }
    case "generate_report": {
      const { format = 'markdown' } = resolvedParams;
      const { success, errors } = checkSuccessCriteria(sess, tabId);

      if (!success) {
        return {
          ok: false,
          observation: `Cannot generate report. Success criteria not met: ${errors.join(', ')}`,
          errorType: ERROR_TYPES.CRITERIA_NOT_MET
        };
      }

      const reportPrompt = buildReportGenerationPrompt(sess.goal, JSON.stringify(sess.findings, null, 2), format);
      const reportRes = await callModelWithRotation(reportPrompt, { model: sess.selectedModel, tabId });

      if (reportRes.ok) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.SUCCESS,
          msg: "User-facing report generated from validated findings",
          report: reportRes.text
        });
        chrome.runtime.sendMessage({
          type: MSG.SHOW_REPORT,
          tabId: tabId,
          report: reportRes.text,
          format: format
        });
        return { ok: true, observation: "Report generated successfully", report: reportRes.text };
      } else {
        return { ok: false, observation: "Failed to generate report from findings" };
      }
    }
    case "analyze_urls": {
      if (!(await ensureContentScript(tabId))) {
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "ANALYZE_PAGE_URLS" });
      
      if (res?.ok && res.analysis) {
        // Store the analysis results in session for template variable access
        const sess = agentSessions.get(tabId);
        if (sess) {
          sess.lastUrlAnalysis = res.analysis;
          
          // Extract URLs from analysis and store them for template variables
          if (res.analysis.relevantUrls && Array.isArray(res.analysis.relevantUrls)) {
            sess.analyzedUrls = res.analysis.relevantUrls.map(urlInfo =>
              typeof urlInfo === 'string' ? urlInfo : urlInfo.url || urlInfo.href || ''
            ).filter(url => url && url.startsWith('http'));
          }
        }
        
        return {
          ok: true,
          observation: `URL analysis completed. Found ${res.analysis.relevantUrls?.length || 0} relevant URLs.`,
          analysis: res.analysis,
          urls: sess?.analyzedUrls || []
        };
      }
      
      return { ok: false, observation: res?.error || "URL analysis failed" };
    }
    case "get_page_links": {
      if (!(await ensureContentScript(tabId))) {
        return { ok: false, observation: "Content script unavailable" };
      }
      const includeExternal = resolvedParams.includeExternal !== false;
      const maxLinks = resolvedParams.maxLinks || 20;
      const res = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_LINKS", includeExternal, maxLinks });
      return res?.ok ? { ok: true, observation: `Found ${res.links?.length || 0} relevant links`, links: res.links } : { ok: false, observation: res?.error || "Link extraction failed" };
    }
    case "read_page_content": {
      if (!(await ensureContentScript(tabId))) {
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "READ_PAGE_CONTENT", maxChars: 15000 });
      if (res?.ok) {
        const observationText = `Successfully read page content. Length: ${res.text?.length}.`;
        return { ok: true, observation: observationText, pageContent: res.text };
      } else {
        return { ok: false, observation: res?.error || "Failed to read page content" };
      }
    }
    case "extract_structured_content": {
        if (!(await ensureContentScript(tabId))) {
            return { ok: false, observation: "Content script unavailable" };
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
        // Handle new structured content format
        if (res?.ok && res.content) {
            const { source, data, ...rest } = res.content;
            let findingToRecord = source === 'json-ld' ? data : rest;

            // If data from JSON-LD is an array, merge each item
            if (Array.isArray(findingToRecord)) {
                findingToRecord.forEach(item => {
                    sess.findings = deepMerge(sess.findings, item);
                });
            } else {
                sess.findings = deepMerge(sess.findings, findingToRecord);
            }

            emitAgentLog(tabId, {
                level: LOG_LEVELS.INFO,
                msg: `Automatically recorded finding from structured extraction (source: ${source})`,
                finding: findingToRecord
            });
            return { ok: true, observation: `Structured content extracted via ${source}`, content: res.content };
        }
        return { ok: false, observation: res?.error || "Content extraction failed" };
    }
    case "record_finding": {
        const { finding } = resolvedParams;

        if (typeof finding !== 'object' || finding === null) {
            return { ok: false, observation: "Invalid finding object provided. The 'finding' parameter must be a valid JSON object." };
        }
        const findingToRecord = finding;
        // Deep merge the new finding with existing findings
        sess.findings = deepMerge(sess.findings, findingToRecord);
        
        emitAgentLog(tabId, {
            level: LOG_LEVELS.SUCCESS,
            msg: "Recorded finding to session",
            finding: findingToRecord
          });
        
        // Send a dedicated message to the chat to make the finding visible
        chrome.runtime.sendMessage({
          type: MSG.AGENT_FINDING,
          tabId: tabId,
          finding: findingToRecord,
          timestamp: Date.now()
        });

        // Persist session after recording a finding
        saveSessionToStorage(tabId, sess);
        return { ok: true, observation: "Finding recorded successfully." };
        }
    case "smart_navigate": {
      // Enhanced navigation that analyzes URLs and suggests the best approach
      const query = String(resolvedParams.query || "");
      const url = String(resolvedParams.url || "");
      const currentUrl = (await chrome.tabs.get(tabId)).url;
      
      // Handle direct URL navigation
      if (url && /^https?:\/\//i.test(url)) {
        await chrome.tabs.update(tabId, { url });
        return { ok: true, observation: `Smart navigation to: ${url}` };
      }
      
      // Handle search query navigation
      if (query) {
        const searchUrl = determineSearchUrl(query, currentUrl);
        await chrome.tabs.update(tabId, { url: searchUrl });
        return { ok: true, observation: `Smart navigation to: ${searchUrl}` };
      }
      
      return { ok: false, observation: "No search query or URL provided for smart navigation" };
    }
    case "research_url": {
      // Automatically research a specific URL by navigating and extracting content
      const url = String(resolvedParams.url || "");
      const depth = Number(resolvedParams.depth || 1);
      const maxDepth = Number(resolvedParams.maxDepth || 2);
      
      // Log template resolution for debugging
      if (params.url !== resolvedParams.url) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.INFO,
          msg: "Template variable resolved",
          original: params.url,
          resolved: resolvedParams.url,
          tool: "research_url"
        });
      }
      
      if (!url || !/^https?:\/\//i.test(url)) {
        return { ok: false, observation: "Invalid URL for research" };
      }
      
      // Navigate to the URL
      await chrome.tabs.update(tabId, { url });
      
      // Wait for page load
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Extract structured content
      let content = null;
      if (await ensureContentScript(tabId)) {
        const res = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
        if (res?.ok) {
          content = res.content;
        }
      }
      
      // If depth is less than maxDepth, analyze URLs for deeper research
      let deeperUrls = [];
      if (depth < maxDepth && content) {
        const urlAnalysis = await chrome.tabs.sendMessage(tabId, { type: "ANALYZE_PAGE_URLS" });
        if (urlAnalysis?.ok && urlAnalysis.analysis?.relevantUrls) {
          deeperUrls = urlAnalysis.analysis.relevantUrls.slice(0, 3); // Limit to top 3 URLs
        }
      }
      
      return {
        ok: true,
        observation: `Researched URL: ${url} (depth ${depth}/${maxDepth})`,
        content: content,
        deeperUrls: deeperUrls,
        currentDepth: depth
      };
    }
    case "multi_search": {
      // Perform multiple location-aware searches for comprehensive results
      const query = String(resolvedParams.query || "");
      const userLocation = resolvedParams.location || getUserLocationFromTimezone();
      const maxSearches = Number(resolvedParams.maxSearches || 3);
      
      if (!query) {
        return { ok: false, observation: "No search query provided for multi-search" };
      }
      
      // Generate multiple search terms
      const searchTerms = generateLocationAwareSearchTerms(query, userLocation);
      const selectedTerms = searchTerms.slice(0, maxSearches);
      
      emitAgentLog(tabId, {
        level: LOG_LEVELS.INFO,
        msg: "Multi-search initiated",
        originalQuery: query,
        location: userLocation,
        searchTerms: selectedTerms
      });
      
      // Store search terms for sequential execution
      const sess = agentSessions.get(tabId);
      if (sess) {
        sess.multiSearchTerms = selectedTerms;
        sess.multiSearchIndex = 0;
        sess.multiSearchResults = [];
      }
      
      // Start with first search term
      const firstSearchUrl = determineSearchUrl(selectedTerms[0], "", userLocation);
      await chrome.tabs.update(tabId, { url: firstSearchUrl });
      
      return {
        ok: true,
        observation: `Multi-search started: ${selectedTerms.length} searches planned for "${query}" in ${userLocation}`,
        searchTerms: selectedTerms,
        currentSearch: selectedTerms[0]
      };
    }
    case "continue_multi_search": {
      // Continue to next search in multi-search sequence
      const sess = agentSessions.get(tabId);
      if (!sess || !sess.multiSearchTerms) {
        return { ok: false, observation: "No multi-search session found" };
      }
      
      sess.multiSearchIndex = (sess.multiSearchIndex || 0) + 1;
      
      if (sess.multiSearchIndex >= sess.multiSearchTerms.length) {
        return {
          ok: true,
          observation: "Multi-search completed - all search terms exhausted",
          completed: true,
          totalResults: sess.multiSearchResults?.length || 0
        };
      }
      
      const nextSearchTerm = sess.multiSearchTerms[sess.multiSearchIndex];
      const userLocation = getUserLocationFromTimezone();
      const nextSearchUrl = determineSearchUrl(nextSearchTerm, "", userLocation);
      
      await chrome.tabs.update(tabId, { url: nextSearchUrl });
      
      return {
        ok: true,
        observation: `Continuing multi-search: ${sess.multiSearchIndex + 1}/${sess.multiSearchTerms.length} - "${nextSearchTerm}"`,
        currentSearch: nextSearchTerm,
        progress: `${sess.multiSearchIndex + 1}/${sess.multiSearchTerms.length}`
      };
    }
    case "analyze_url_depth": {
      // Analyze if current page URLs are worth reading deeper
      if (!(await ensureContentScript(tabId))) {
        return { ok: false, observation: "Content script unavailable" };
      }
      
      const currentDepth = Number(resolvedParams.currentDepth || 1);
      const maxDepth = Number(resolvedParams.maxDepth || 3);
      const researchGoal = String(resolvedParams.researchGoal || "");
      
      // Get URL analysis
      const urlAnalysis = await chrome.tabs.sendMessage(tabId, { type: "ANALYZE_PAGE_URLS" });
      if (!urlAnalysis?.ok) {
        return { ok: false, observation: "Failed to analyze page URLs" };
      }
      
      // Get current page content quality
      const contentRes = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
      const contentQuality = contentRes?.ok ? analyzeContentQuality(contentRes.content, researchGoal) : 'low';
      
      // Decision logic for deeper reading
      const shouldGoDeeper = shouldReadDeeper(urlAnalysis.analysis, contentQuality, currentDepth, maxDepth, researchGoal);
      
      return {
        ok: true,
        observation: `URL depth analysis completed (depth ${currentDepth}/${maxDepth})`,
        shouldGoDeeper: shouldGoDeeper.decision,
        reasoning: shouldGoDeeper.reasoning,
        recommendedUrls: shouldGoDeeper.urls,
        contentQuality: contentQuality,
        currentDepth: currentDepth
      };
    }
    case "extract_with_regex": {
      const { pattern, text } = resolvedParams;
      if (!pattern || !text) {
        return { ok: false, observation: "Missing pattern or text for regex extraction." };
      }
      try {
        const regex = new RegExp(pattern, 'g');
        const matches = [...text.matchAll(regex)].map(match => match[1] || match[0]);
        return { ok: true, observation: `Found ${matches.length} matches.`, matches };
      } catch (e) {
        return { ok: false, observation: `Invalid regex pattern: ${e.message}` };
      }
    }
    default:
      return { ok: false, observation: "Unknown tool: " + String(tool) };
  }
}

async function sendActionResultToChat(tabId, sess, action, execRes) {
  if (!execRes.ok) return;

  let payload;
  const { tool, params } = action;

  switch (tool) {
    case 'record_finding':
      payload = {
        tool,
        data: params.finding,
      };
      break;
    case 'read_page_content':
      if (execRes.pageContent) {
        const pageInfo = await getPageInfoForPlanning(tabId);
        payload = {
          tool,
          data: {
            summary: execRes.pageContent.substring(0, 500) + (execRes.pageContent.length > 500 ? '...' : ''),
            url: pageInfo.url,
            title: pageInfo.title,
          }
        };
      }
      break;
    case 'navigate':
    case 'goto_url':
      // Wait a bit for the page to load before getting title
      await new Promise(resolve => setTimeout(resolve, 1500));
      const pageInfo = await getPageInfoForPlanning(tabId);
      payload = {
        tool,
        data: {
          url: params.url,
          title: pageInfo.title,
        }
      };
      break;
  }

  if (payload) {
    chrome.runtime.sendMessage({
      type: MSG.AGENT_ACTION_RESULT,
      tabId: tabId,
      payload: sanitizePayload(payload),
      timestamp: Date.now()
    });
  }
}

function sanitizePayload(payload) {
  const redactedPayload = JSON.parse(JSON.stringify(payload));

  // Redact PII
  if (redactedPayload.data && redactedPayload.data.summary) {
    redactedPayload.data.summary = redactedPayload.data.summary.replace(/\b\d{10,}\b/g, '[REDACTED]');
  }

  // Truncate oversized payloads
  if (JSON.stringify(redactedPayload).length > 5000) {
    if (redactedPayload.data && redactedPayload.data.summary) {
      redactedPayload.data.summary = redactedPayload.data.summary.substring(0, 500) + '...';
    }
  }

  return redactedPayload;
}


async function runAgentLoop(tabId, goal, settings) {
  const sess = agentSessions.get(tabId);
  if (!sess) return;

  sess.running = true;
  sess.stopped = false;
  sess.step = 0;

  emitAgentLog(tabId, {
    level: LOG_LEVELS.INFO,
    msg: "Agentic loop started",
    goal,
    model: sess.selectedModel,
    settings
  });

  // Emit run_state: started
  try {
    if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitRunState === 'function') {
      await globalThis.AgentObserver.emitRunState(tabId, 'started', {
        goal,
        model: sess.selectedModel,
        settings,
        requestId: sess.requestId
      });
    }
  } catch (_) {}

  // Start the agentic loop
  agenticLoop(tabId, goal, settings);
}

async function agenticLoop(tabId, goal, settings) {
  const sess = agentSessions.get(tabId);
  if (!sess || sess.stopped) {
    return;
  }

  // Check if all sub-tasks are completed
  if (sess.currentTaskIndex >= sess.subTasks.length) {
    emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "All sub-tasks completed. Generating final report." });
    await generateFinalReport(tabId, sess);
    stopAgent(tabId, "Goal achieved");
    return;
  }

  const currentSubTask = sess.subTasks[sess.currentTaskIndex];

  // 1. Perceive: Gather enhanced context
  const contextData = await gatherEnhancedContext(tabId, sess, currentSubTask);
  if (!contextData) {
    stopAgent(tabId, "Failed to gather context");
    return;
  }

  // 2. Reason: Select appropriate prompt based on task type
  const { taskType } = sess.taskContext || { taskType: 'AUTOMATION' };
  let reasoningPrompt;
  switch (taskType) {
    case 'RESEARCH':
      reasoningPrompt = buildResearchAgentPrompt(goal, currentSubTask, contextData);
      break;
    case 'YOUTUBE':
      reasoningPrompt = buildYouTubeActionPrompt(goal, contextData);
      break;
    case 'NAVIGATION':
      reasoningPrompt = buildNavigationActionPrompt(goal, contextData);
      break;
    default:
      reasoningPrompt = buildAgentPlanPrompt(goal, currentSubTask, contextData);
  }
  
  const modelResponse = await callModelWithRotation(reasoningPrompt, { model: sess.selectedModel, tabId });

  // 3. Parse and Validate Action
  let action;
  if (modelResponse.ok) {
    const validationResult = parseAndValidateAction(tabId, sess, modelResponse.text);
    if (validationResult.success) {
      action = validationResult.action;
    } else {
      emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Failed to parse valid action", error: validationResult.error, rawText: validationResult.rawText });
      // Attempt recovery planning
      const recoveryResult = await attemptRecoveryPlanning(tabId, sess, goal, currentSubTask, contextData);
      if (recoveryResult?.success) {
        action = recoveryResult.action;
      }
    }
  }

  if (!action) {
    emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Stopping agent due to parsing failure after recovery attempt." });
    stopAgent(tabId, "Failed to parse action");
    return;
  }

  // 4. Act: Execute the action, with a guard against premature 'done'
  if (action.tool === 'done' && Object.keys(sess.findings).length === 0) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.WARN,
      msg: "Premature 'done' action detected. Overriding with 'think' to force re-evaluation.",
      originalAction: action
    });
    action = {
      tool: 'think',
      params: { thought: "I was about to mark the task as done, but I haven't recorded any findings yet. I need to re-evaluate my plan and gather information first." },
      rationale: "Overriding premature 'done' action to ensure findings are gathered before completion.",
      confidence: 0.99,
      done: false
    };
  }
  const execRes = await executeActionWithContext(tabId, sess, action, settings);

  // 5. Observe and Update Context
  updateSessionContext(tabId, sess, action, execRes);

  // 6. Handle Failures and Self-Correction
  if (!execRes.ok) {
    sess.failureCount = (sess.failureCount || 0) + 1;
    sess.consecutiveFailures = (sess.consecutiveFailures || 0) + 1;
    
    const correctedAction = await handleActionFailure(tabId, sess, goal, currentSubTask, contextData, action, execRes);
    
    if (correctedAction) {
      emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "Re-executing with corrected action." });
      // Immediately execute the corrected action and update context
      const correctedExecRes = await executeActionWithContext(tabId, sess, correctedAction, settings);
      updateSessionContext(tabId, sess, correctedAction, correctedExecRes);
      
      // If the corrected action also fails, stop the agent
      if (!correctedExecRes.ok) {
        emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Corrected action also failed. Stopping agent." });
        stopAgent(tabId, "Stopping after failed self-correction.");
        return;
      }
      // Replace the original failed action with the successful corrected one for the rest of the loop logic
      action = correctedAction;
    } else {
      // If no correction, stop the agent
      stopAgent(tabId, "Stopping after failed self-correction.");
      return;
    }
  } else {
    // Reset consecutive failures on success
    sess.consecutiveFailures = 0;
  }

  // 7. Advance to the next sub-task if 'done' is signaled for the current one
  if (action.tool === 'done' || action.done === true) {
    emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: `Sub-task "${currentSubTask}" completed.` });
    sess.currentTaskIndex++;
    sess.subTaskStep = 0; // Reset sub-task step counter
    sess.noProgressCounter = 0; // Reset no-progress counter
    // Send a step update to the sidepanel
    chrome.runtime.sendMessage({
      type: MSG.AGENT_STEP_UPDATE,
      tabId: tabId,
      currentTaskIndex: sess.currentTaskIndex
    });
  }

  // 8. Check for overall completion or max steps
  if (sess.step >= settings.maxSteps) {
    emitAgentLog(tabId, { level: LOG_LEVELS.WARN, msg: "Max steps reached. Generating final report." });
    await generateFinalReport(tabId, sess);
    stopAgent(tabId, "Max steps reached");
    return;
  }

  // 9. Increment step counters
  sess.step++;
  sess.subTaskStep = (sess.subTaskStep || 0) + 1;

  // 10. Run Watchdogs
  const watchdogTriggered = runWatchdogs(tabId, sess, action, execRes);
  if (watchdogTriggered) {
    // If a watchdog forces a 'think' action, we skip the normal delay and loop immediately
    // to re-evaluate with the new context.
    agenticLoop(tabId, goal, settings);
    return;
  }

  // 11. Continue the loop
  const delay = calculateAdaptiveDelay(action, execRes.ok);
  await new Promise(r => setTimeout(r, delay));
  agenticLoop(tabId, goal, settings);
}

function parseModelResponse(responseText) {
  try {
    const jsonResult = extractJSONWithRetry(responseText, 'model response');
    if (jsonResult.success) {
      return { action: jsonResult.data.action, rationale: jsonResult.data.rationale };
    }
  } catch (e) {
    // Fallback for non-json response
  }
  return { action: null, rationale: null };
}

async function gatherContextForReasoning(tabId, sess) {
  const pageInfo = await getPageInfoForPlanning(tabId);
  let pageContent = "";
  let interactiveElements = [];

  if (!isRestrictedUrl(pageInfo.url)) {
    if (await ensureContentScript(tabId)) {
      try {
        const textExtract = await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT_PAGE_TEXT, maxChars: 8000 });
        if (textExtract?.ok) pageContent = textExtract.text;

        const elementsExtract = await chrome.tabs.sendMessage(tabId, { type: MSG.GET_INTERACTIVE_ELEMENTS });
        if (elementsExtract?.ok) interactiveElements = elementsExtract.elements;
      } catch (e) {
        console.warn("Failed to get page context", e);
      }
    }
  }

  return {
    pageInfo,
    pageContent,
    interactiveElements,
  };
}

async function generateFinalReport(tabId, sess) {
  emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "Generating final report for user." });

  // Use the structured findings for a more reliable report
  const findingsSummary = JSON.stringify(sess.findings, null, 2);

  const reportPrompt = buildReportGenerationPrompt(
    sess.goal,
    findingsSummary,
    'markdown'
  );

  const reportRes = await callModelWithRotation(reportPrompt, { model: sess.selectedModel, tabId });

  if (reportRes.ok) {
    chrome.runtime.sendMessage({
      type: MSG.SHOW_REPORT,
      tabId: tabId,
      report: reportRes.text,
      format: 'markdown'
    });
  } else {
    // Fallback message if report generation fails
    chrome.runtime.sendMessage({
      type: MSG.SHOW_REPORT,
      tabId: tabId,
      report: `I have completed the task, but encountered an issue generating the final summary. The goal was: "${sess.goal}".`,
      format: 'markdown'
    });
  }
}

// Initialize enhanced features on startup
chrome.runtime.onStartup.addListener(async () => {
  console.log("[BG] Startup");
  // Initialize API key manager
  await apiKeyManager.initialize();
  // Clean up old sessions on startup
  await cleanupOldSessions();
  // Initialize enhanced features
  initializeEnhancedFeatures();
  
  // Attempt to restore any active sessions
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        await restoreSessionFromStorage(tab.id);
      }
    }
  } catch (e) {
    console.warn("[BG] Failed to restore sessions on startup:", e);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[BG] Installed");
  // Initialize API key manager
  await apiKeyManager.initialize();
  // Clean up old sessions on install
  await cleanupOldSessions();
  // Initialize enhanced features
  initializeEnhancedFeatures();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case MSG.PING:
          sendResponse({ ok: true, ts: Date.now() });
          break;

        case MSG.AGENT_RUN: {
          const { goal = "", settings: userSettings = {} } = message || {};
          const settings = {
            maxSteps: 150, // Increased default max steps
            ...userSettings
          };
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });

          // Check for a restorable session
          const restoredSession = await restoreSessionFromStorage(tab.id);
          if (restoredSession && restoredSession.subTasks && restoredSession.currentTaskIndex < restoredSession.subTasks.length) {
            emitAgentLog(tab.id, {
              level: LOG_LEVELS.INFO,
              msg: "Resuming agent from a previous session.",
              goal: restoredSession.goal,
              currentTaskIndex: restoredSession.currentTaskIndex
            });
            agentSessions.set(tab.id, restoredSession);
            runAgentLoop(tab.id, restoredSession.goal, restoredSession.settings);
            return sendResponse({ ok: true, resumed: true });
          }

          // Prevent concurrent runs on the same tab
          const existingSession = agentSessions.get(tab.id);
          if (existingSession?.running) {
            emitAgentLog(tab.id, {
              level: LOG_LEVELS.WARN,
              msg: "Agent run blocked: already running on this tab"
            });
            return sendResponse({
              ok: false,
              error: "Agent already running on this tab. Press STOP first.",
              errorType: ERROR_TYPES.AGENT_ALREADY_RUNNING
            });
          }

          // Initialize API key manager and check availability
          await apiKeyManager.initialize();
          const currentKey = apiKeyManager.getCurrentKey();
          if (!currentKey) {
              return sendResponse({ ok: false, error: "No available API keys. Please add valid keys in settings." });
          }

          // Get model settings
          const { GEMINI_MODEL } = await chrome.storage.sync.get(["GEMINI_MODEL"]);
          
          // Enhanced task decomposition with AI-powered classification
          // Enhanced task decomposition with AI-powered classification
          const pageInfo = await getPageInfoForPlanning(tab.id);
          const taskClassification = await classifyAndDecomposeTask(tab.id, goal, pageInfo);
          let subTasks = taskClassification.subTasks || [goal];
          let taskContext = taskClassification.context || {};
          
          emitAgentLog(tab.id, {
            level: LOG_LEVELS.INFO,
            msg: "Task decomposition completed",
            taskType: taskContext.taskType,
            complexity: taskContext.complexity,
            subTaskCount: subTasks.length,
            dependencies: taskContext.dependencies
          });

          // 2. Initialize session with enhanced context
          const newSession = initializeNewSession(tab.id, goal, subTasks, settings, GEMINI_MODEL || "gemini-2.5-flash", taskContext);
          agentSessions.set(tab.id, newSession);
          
          // Persist new session
          await saveSessionToStorage(tab.id, newSession);
          
          emitAgentLog(tab.id, {
            level: LOG_LEVELS.INFO,
            msg: "Enhanced goal decomposition completed",
            subTasks,
            taskContext: taskContext,
            enhancedFeatures: ["context_caching", "failure_tracking", "adaptive_planning", "success_criteria"]
          });

          // Determine and set the success criteria schema for the session
          const schemaKey = taskContext.taskType?.toLowerCase() || 'default';
          newSession.successCriteria = globalThis.SUCCESS_CRITERIA_SCHEMAS[schemaKey] || globalThis.SUCCESS_CRITERIA_SCHEMAS.default;
          emitAgentLog(tab.id, {
            level: LOG_LEVELS.INFO,
            msg: `Success criteria schema set to '${schemaKey}'`,
            schema: newSession.successCriteria
          });
// 3. Start execution engine (graph mode or legacy loop) but don't block sendResponse
try {
  const { EXPERIMENTAL_GRAPH_MODE } = await chrome.storage.local.get("EXPERIMENTAL_GRAPH_MODE");
  if (globalThis.TaskGraphEngine && EXPERIMENTAL_GRAPH_MODE) {
    const graph = buildSimpleGraphForSession(tab.id, newSession);
    runGraphForSession(tab.id, newSession, graph).catch(e => {
      console.error("[BG] Graph run error:", e);
      emitAgentLog(tab.id, { level: "error", msg: "Graph run error", error: String(e?.message || e) });
    });
  } else {
    runAgentLoop(tab.id, goal, settings).catch(e => {
      console.error("[BG] Agent loop error:", e);
      emitAgentLog(tab.id, { level: "error", msg: "Agent loop error", error: String(e?.message || e) });
    });
  }
} catch (e) {
  runAgentLoop(tab.id, goal, settings).catch(err => {
    console.error("[BG] Agent loop error:", err);
    emitAgentLog(tab.id, { level: "error", msg: "Agent loop error", error: String(err?.message || err) });
  });
}

        
          // Send the generated plan to the sidepanel
          chrome.runtime.sendMessage({
            type: MSG.AGENT_PLAN_GENERATED,
            tabId: tab.id,
            plan: subTasks
          });
        
          sendResponse({ ok: true });
          break;
        }

        case MSG.AGENT_STOP: {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });
          stopAgent(tab.id, "User pressed STOP");
          sendResponse({ ok: true });
          break;
        }

        case MSG.AGENT_STATUS: {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });
          
          let sess = agentSessions.get(tab.id);
          
          // If no session in memory, try to restore from storage
          if (!sess) {
            sess = await restoreSessionFromStorage(tab.id);
          }
          
          sendResponse({ ok: true, session: sess });
          break;
        }

        case MSG.OPEN_SIDE_PANEL: {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) await openSidePanel(tab.id);
          sendResponse({ ok: true });
          break;
        }

        case MSG.GET_ACTIVE_TAB: {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          sendResponse({ ok: true, tab });
          break;
        }

        case MSG.EXTRACT_PAGE_TEXT: {
          // Ensure a content script is present. On some pages or after reloads, there may be no listener yet.
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });

          if (isRestrictedUrl(tab.url)) {
            return sendResponse({ ok: false, error: "Cannot access this page. Content scripts are blocked on this URL." });
          }

          try {
            // Try sending first
            const result = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXTRACT_PAGE_TEXT });
            sendResponse(result);
          } catch (err) {
            // If no receiver, inject our content script dynamically, then retry
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["common/messages.js", "content/content.js"]
              });
              const result = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXTRACT_PAGE_TEXT });
              sendResponse(result);
            } catch (innerErr) {
              sendResponse({ ok: false, error: "Cannot access this page. Content scripts are blocked on this URL." });
            }
          }
          break;
        }

        case MSG.SAVE_API_KEY: {
          const { apiKey } = message;
          await chrome.storage.sync.set({ GEMINI_API_KEY: apiKey || "" });
          sendResponse({ ok: true });
          break;
        }

        case MSG.READ_API_KEY: {
          // Use key manager presence to determine availability (supports single and multi-key)
          await apiKeyManager.initialize();
          const currentKey = apiKeyManager.getCurrentKey();
          sendResponse({ ok: true, apiKey: currentKey?.key || "" });
          break;
        }

        // Execute a registered tool via ToolsRegistry and emit timeline events
        case MSG.AGENT_EXECUTE_TOOL: {
          try {
            const { toolId, input = {}, tabId: providedTabId } = message;

            // Determine target tab
            let targetTabId = providedTabId;
            if (!Number.isFinite(targetTabId)) {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              targetTabId = activeTab?.id;
            }
            if (!Number.isFinite(targetTabId)) {
              return sendResponse({ ok: false, error: "No active tab to run tool against" });
            }

            // Run the tool (emits tool_started/tool_result via AgentObserver)
            const result = await runRegisteredTool(targetTabId, toolId, input);

            // Notify UI of tool result (optional; timeline already receives events)
            try {
              chrome.runtime.sendMessage({
                type: MSG.AGENT_TOOL_RESULT,
                tabId: targetTabId,
                toolId,
                result
              });
            } catch (_) {}

            sendResponse({ ok: true, result });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;
        }

        case MSG.SUMMARIZE_PAGE: {
          const { maxChars = 20000, userPrompt = "" } = message;
          
          // Phase 2: Fast path - if maxChars is 0, skip page extraction entirely
          if (maxChars === 0) {
            // Fast chat mode - no page context needed
            await apiKeyManager.initialize();
            const currentKey = apiKeyManager.getCurrentKey();
            if (!currentKey) {
              return sendResponse({ ok: false, error: "No available API keys. Please add valid keys in settings." });
            }
            
            const { GEMINI_MODEL } = await chrome.storage.sync.get("GEMINI_MODEL");
            const selectedModel = (GEMINI_MODEL || "gemini-2.5-flash");
            
            // Build a direct prompt without page context
            const prompt = userPrompt || "Please provide a helpful response.";
            const result = await callModelWithRotation(prompt, { model: selectedModel });
            
            sendResponse({ ok: true, summary: result.text || result.raw || "(no output)" });
            break;
          }
          
          // Original behavior: Extract page content when maxChars > 0
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });

          if (isRestrictedUrl(tab.url)) {
            return sendResponse({ ok: false, error: "Cannot access this page. Content scripts are blocked on this URL." });
          }

          // 1) Extract page text with fallback injection
          let extract;
          try {
            extract = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXTRACT_PAGE_TEXT, maxChars });
          } catch {
            // Inject content script if no receiver, then retry
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["common/messages.js", "content/content.js"]
              });
              extract = await chrome.tabs.sendMessage(tab.id, { type: MSG.EXTRACT_PAGE_TEXT, maxChars });
            } catch (injErr) {
              return sendResponse({ ok: false, error: "Cannot access this page. Content scripts are blocked on this URL." });
            }
          }
          if (!extract?.ok) return sendResponse({ ok: false, error: extract?.error || "Extraction failed" });

          // 2) Check API key availability
          await apiKeyManager.initialize();
          const currentKey = apiKeyManager.getCurrentKey();
          if (!currentKey) {
            return sendResponse({ ok: false, error: "No available API keys. Please add valid keys in settings." });
          }
          
          const { GEMINI_MODEL } = await chrome.storage.sync.get("GEMINI_MODEL");
          const selectedModel = (GEMINI_MODEL || "gemini-2.5-flash");
 
          // 3) Build prompt and call Gemini with rotation
          const prompt = buildSummarizePrompt(extract.text || "", userPrompt);
          const result = await callModelWithRotation(prompt, { model: selectedModel });

          sendResponse({ ok: true, summary: result.text || result.raw || "(no output)" });
          break;
        }

        case MSG.CLASSIFY_INTENT: {
          const { userMessage, currentContext = {} } = message;
          
          // Check API key availability
          await apiKeyManager.initialize();
          const currentKey = apiKeyManager.getCurrentKey();
          if (!currentKey) {
            return sendResponse({ ok: false, error: "No available API keys. Please add valid keys in settings." });
          }
          
          try {
            // Build classification prompt
            const classificationPrompt = buildIntentClassificationPrompt(userMessage, currentContext);
            
            // Call model for intent classification (use fast model for quick classification)
            const result = await callModelWithRotation(classificationPrompt, { model: "gemini-2.5-flash" });
            
            if (!result?.ok) {
              return sendResponse({ ok: false, error: result?.error || "Classification failed" });
            }
            
            // Parse the JSON response
            try {
              const jsonStart = result.text.indexOf("{");
              const jsonEnd = result.text.lastIndexOf("}");
              if (jsonStart >= 0 && jsonEnd > jsonStart) {
                const jsonStr = result.text.slice(jsonStart, jsonEnd + 1);
                const classification = JSON.parse(jsonStr);
                
                // Validate the classification
                if (classification.intent && classification.confidence && classification.reasoning) {
                  return sendResponse({ ok: true, classification });
                }
              }
            } catch (parseError) {
              console.warn('Failed to parse intent classification:', parseError);
            }
            
            return sendResponse({ ok: false, error: "Failed to parse classification result" });
          } catch (error) {
            return sendResponse({ ok: false, error: error.message || "Classification error" });
          }
          break;
        }

        case MSG.CHAT_DIRECT: {
          // Phase 2: Direct chat without page context for fast responses
          const { userPrompt = "" } = message;
          
          // Check API key availability
          await apiKeyManager.initialize();
          const currentKey = apiKeyManager.getCurrentKey();
          if (!currentKey) {
            return sendResponse({ ok: false, error: "No available API keys. Please add valid keys in settings." });
          }
          
          const { GEMINI_MODEL } = await chrome.storage.sync.get("GEMINI_MODEL");
          const selectedModel = (GEMINI_MODEL || "gemini-2.5-flash");
          
          // Build a direct prompt without page context
          const prompt = userPrompt || "Please provide a helpful response.";
          const result = await callModelWithRotation(prompt, { model: selectedModel });
          
          sendResponse({ ok: true, summary: result.text || result.raw || "(no output)" });
          break;
        }

        case MSG.CLASSIFY_INTENT_ENHANCED: {
          const { userMessage, currentContext = {} } = message;
          
          if (!enhancedIntentClassifier) {
            initializeEnhancedFeatures();
          }
          
          if (!enhancedIntentClassifier) {
            return sendResponse({ ok: false, error: "Enhanced intent classifier not available" });
          }
          
          try {
            const result = await enhancedIntentClassifier.classifyWithAmbiguityDetection(userMessage, currentContext);
            return sendResponse({ ok: true, result });
          } catch (error) {
            return sendResponse({ ok: false, error: error.message || "Enhanced classification error" });
          }
          break;
        }

        case MSG.REQUEST_CLARIFICATION: {
          const { sessionId, userMessage, classificationResult, context = {} } = message;
          
          if (!clarificationManager) {
            initializeEnhancedFeatures();
          }
          
          if (!clarificationManager) {
            return sendResponse({ ok: false, error: "Clarification manager not available" });
          }
          
          try {
            const result = clarificationManager.createClarificationRequest(sessionId, userMessage, classificationResult, context);
            return sendResponse({ ok: true, result });
          } catch (error) {
            return sendResponse({ ok: false, error: error.message || "Clarification request failed" });
          }
          break;
        }

        case MSG.RESPOND_CLARIFICATION: {
          const { clarificationId, response } = message;
          
          if (!clarificationManager) {
            return sendResponse({ ok: false, error: "Clarification manager not available" });
          }
          
          try {
            const result = clarificationManager.processClarificationResponse(clarificationId, response);
            return sendResponse({ ok: true, result });
          } catch (error) {
            return sendResponse({ ok: false, error: error.message || "Clarification response processing failed" });
          }
          break;
        }

        case MSG.CHAT_MESSAGE: {
          const { tabId, message } = message;
          const sess = agentSessions.get(tabId);
          if (sess) {
            sess.chatTranscript.push({
              role: 'user',
              content: message,
              timestamp: Date.now()
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case MSG.COORDINATE_AND_EXECUTE: {
          const { userMessage } = message;
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });

          // 1. Get API Key
          await apiKeyManager.initialize();
          const currentKey = apiKeyManager.getCurrentKey();
          if (!currentKey) {
            return sendResponse({ ok: false, error: "No available API keys." });
          }
          const { GEMINI_MODEL } = await chrome.storage.sync.get("GEMINI_MODEL");
          const selectedModel = GEMINI_MODEL || "gemini-2.5-flash";

          // 2. Build Coordinator Prompt
          const pageInfo = await getPageInfoForPlanning(tab.id);
          const coordinatorPrompt = buildCoordinatorPrompt(userMessage, pageInfo);

          // 3. Call Model to get the tool and parameters
          const modelRes = await callModelWithRotation(coordinatorPrompt, { model: selectedModel, tabId: tab.id });
          if (!modelRes.ok) {
            return sendResponse({ ok: false, error: "Coordinator model call failed.", details: modelRes.error });
          }

          const extracted = extractJSONWithRetry(modelRes.text, 'coordinator response');
          if (!extracted.success) {
            // If JSON parsing fails, fall back to a general chat response.
            const fallbackPrompt = buildSummarizePrompt("", `I couldn't determine a specific action for your request: "${userMessage}". Please try rephrasing. Here's a general response:`);
            const fallbackRes = await callModelWithRotation(fallbackPrompt, { model: selectedModel, tabId: tab.id });
            return sendResponse({ ok: true, summary: fallbackRes.text });
          }

          const { tool, params } = extracted.data;

          // 4. Execute the chosen tool
          switch (tool) {
            case 'quick_answer':
              const chatPrompt = buildSummarizePrompt("", params.question);
              const chatRes = await callModelWithRotation(chatPrompt, { model: selectedModel, tabId: tab.id });
              sendResponse({ ok: true, summary: chatRes.text });
              break;
            case 'web_automation':
              // This re-uses the existing AGENT_RUN logic.
              const agentGoal = params.goal;
              const agentSettings = { maxSteps: 50, allowCrossDomain: true, allowTabMgmt: true };
              
              // De-duplicate agent run logic by calling the existing handler function internally
              // This requires refactoring the AGENT_RUN case slightly. For now, we duplicate a bit.
              const newSession = initializeNewSession(tab.id, agentGoal, [agentGoal], agentSettings, selectedModel, { taskType: 'AUTOMATION' });
              agentSessions.set(tab.id, newSession);
              await saveSessionToStorage(tab.id, newSession);
              runAgentLoop(tab.id, agentGoal, agentSettings).catch(e => console.error("[BG] Agent loop error:", e));
              
              sendResponse({ ok: true, agentStarted: true, goal: agentGoal });
              break;
            default:
              sendResponse({ ok: false, error: `Unknown tool from coordinator: ${tool}` });
          }
          break;
        }
        case MSG.AGENT_EXECUTE_TOOL: {
          try {
            // Determine target tabId: prefer explicit, fallback to active tab
            let targetTabId = Number.isFinite(message.tabId) ? message.tabId : null;
            if (!Number.isFinite(targetTabId)) {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (!tab?.id) {
                return sendResponse({ ok: false, error: "No active tab" });
              }
              targetTabId = tab.id;
            }

            const toolId = message.toolId;
            const input = message.input || {};
            if (!toolId || typeof toolId !== "string") {
              return sendResponse({ ok: false, error: "Missing toolId" });
            }

            // Execute the registered tool (emits timeline events internally)
            const result = await runRegisteredTool(targetTabId, toolId, input);

            // Notify UI (optional convenience channel in addition to direct response)
            try {
              chrome.runtime.sendMessage({
                type: MSG.AGENT_TOOL_RESULT,
                tabId: targetTabId,
                toolId,
                result,
                timestamp: Date.now()
              });
            } catch (_) {}

            sendResponse({ ok: true, result });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;
        }
        case MSG.AGENT_PERMISSION_DECISION: {
          await permissionManager.handlePermissionDecision(message.payload);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      // Avoid throwing for restricted pages; surface friendly message if detectable
      const msg = String(err?.message || err);
      console.error("[BG] Error:", err);
      try {
        sendResponse({ ok: false, error: msg });
      } catch (_) {
        // ignore if channel closed
      }
    }
  })();

  // Return true to keep the message channel open for async sendResponse
  return true;
});

// Enhanced task classification and decomposition with context engineering
async function classifyAndDecomposeTask(tabId, goal, pageInfo) {
  try {
    // First, classify the task type using AI, now with page context
    const classificationPrompt = buildIntentClassificationPrompt(goal, {
      url: pageInfo.url || 'unknown',
      title: pageInfo.title || 'Task Planning'
    });
    
    const classificationRes = await callModelWithRotation(classificationPrompt, {
      model: "gemini-2.5-flash",
      tabId: tabId
    });
    
    let taskType = 'AUTOMATION'; // Default fallback
    let confidence = 0.5;
    
    if (classificationRes?.ok) {
      const jsonResult = extractJSONWithRetry(classificationRes.text, 'task classification');
      if (jsonResult.success) {
        taskType = jsonResult.data.intent || 'AUTOMATION';
        confidence = jsonResult.data.confidence || 0.5;
        
        emitAgentLog(tabId, {
          level: LOG_LEVELS.INFO,
          msg: "Task type classified",
          taskType: taskType,
          confidence: confidence,
          reasoning: jsonResult.data.reasoning
        });
      }
    }
    
    // Select appropriate decomposition strategy based on task type
    let decompPrompt;
    switch (taskType) {
      case 'RESEARCH':
        decompPrompt = buildResearchTaskDecompositionPrompt(goal);
        break;
      case 'YOUTUBE':
      case 'NAVIGATION':
      case 'AUTOMATION':
      default:
        decompPrompt = buildTaskDecompositionPrompt(goal, pageInfo);
        break;
    }
    
    // Decompose the task with enhanced context
    const decompRes = await callModelWithRotation(decompPrompt, {
      model: "gemini-2.5-flash",
      tabId: tabId
    });
    
    let subTasks = [goal]; // Fallback
    let context = {
      taskType: taskType,
      complexity: 'moderate',
      dependencies: []
    };
    
    if (decompRes?.ok) {
      const jsonResult = extractJSONWithRetry(decompRes.text, 'task decomposition');
      if (jsonResult.success) {
        const parsed = jsonResult.data;
        
        if (Array.isArray(parsed.subTasks)) {
          subTasks = parsed.subTasks;
        }
        
        // Extract enhanced context if available
        if (parsed.context) {
          context = {
            taskType: parsed.context.taskType || taskType,
            complexity: parsed.context.complexity || 'moderate',
            dependencies: parsed.context.dependencies || [],
            expectedDuration: parsed.context.expectedDuration || 'medium'
          };
        }
        
        emitAgentLog(tabId, {
          level: LOG_LEVELS.INFO,
          msg: "Task decomposition successful",
          subTaskCount: subTasks.length,
          complexity: context.complexity,
          dependencies: context.dependencies
        });
      } else {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.WARN,
          msg: "Task decomposition parsing failed, using fallback",
          error: jsonResult.error
        });
      }
    } else {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.ERROR,
        msg: "Task decomposition request failed",
        error: decompRes?.error || "Unknown error"
      });
    }
    
    return {
      subTasks: subTasks,
      context: context
    };
    
  } catch (error) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.ERROR,
      msg: "Task classification and decomposition failed",
      error: error.message
    });
    
    return {
      subTasks: [goal],
      context: {
        taskType: 'AUTOMATION',
        complexity: 'moderate',
        dependencies: []
      }
    };
  }
}

// [SCHEMA VALIDATION] New parse and validate function using the schema
function parseAndValidateAction(tabId, sess, responseText) {
  const jsonResult = extractJSONWithRetry(responseText, 'planning response');

  if (!jsonResult.success) {
    return {
      success: false,
      error: 'Failed to extract JSON from response.',
      rawText: responseText.substring(0, 500)
    };
  }

  let action = jsonResult.data.action || jsonResult.data; // Handle cases where 'action' is nested

  // Pre-normalize action (especially for record_finding)
  action = preNormalizeAction(action);

  // Normalize aliases and strip unknown params to satisfy schema
  const normalized = normalizeActionAliases(action);
  const changed =
    (normalized.tool !== action.tool) ||
    (JSON.stringify(normalized.params || {}) !== JSON.stringify(action.params || {}));
  if (changed) {
    try {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.INFO,
        msg: 'Action normalized for schema compatibility',
        before: { tool: action.tool, params: Object.keys(action.params || {}) },
        after: { tool: normalized.tool, params: Object.keys(normalized.params || {}) }
      });
    } catch (_) {}
  }
  action = normalized;

  let { valid, errors } = validateAction(action);

  // One-shot repair attempt for record_finding
  if (!valid && action.tool === 'record_finding') {
    const repaired = preNormalizeAction(action);
    const res2 = validateAction(repaired);
    if (res2.valid) {
      action = repaired;
      valid = true; errors = [];
    }
  }

  if (valid) {
    // Set default confidence if not provided
    if (typeof action.confidence !== 'number') {
      action.confidence = 0.8;
    }
    emitAgentLog(tabId, {
      level: LOG_LEVELS.INFO,
      msg: `Action parsed and validated successfully`,
      tool: action.tool,
      confidence: action.confidence
    });
    return { success: true, action: action };
  } else {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.ERROR,
      msg: `Action validation failed`,
      errors: errors,
      rawText: responseText.substring(0, 500)
    });
    return {
      success: false,
      error: `Validation failed: ${errors.join(', ')}`,
      rawText: responseText.substring(0, 500)
    };
  }
}

// [FALLBACK LOGIC] Generate a deterministic fallback action when planning fails
function generateFallbackAction(sess, contextData) {
  const { pageContent, interactiveElements, taskContext } = contextData;

  // 1. If the page is empty or just loaded, the best action is to read it.
  if (!pageContent) {
    return {
      tool: 'read_page_content',
      params: {},
      rationale: 'Fallback: The page content is unknown. Reading the page to gain context.',
      confidence: 0.95,
      done: false,
    };
  }

  // 2. If the task is research and there are links, analyze them.
  if (taskContext?.taskType === 'RESEARCH' && interactiveElements?.some(el => el.tag === 'A')) {
    return {
      tool: 'analyze_urls',
      params: {},
      rationale: 'Fallback: In a research task, analyzing links is a good next step to find relevant information.',
      confidence: 0.9,
      done: false,
    };
  }

  // 3. If there are input fields and the goal involves filling something, try to fill.
  const goal = sess.goal.toLowerCase();
  const inputs = interactiveElements?.filter(el => el.tag === 'INPUT' && el.type !== 'hidden');
  if (inputs?.length > 0 && (goal.includes('fill') || goal.includes('enter') || goal.includes('search'))) {
    return {
      tool: 'smart_navigate',
      params: { query: sess.goal },
      rationale: 'Fallback: The page has input fields and the goal suggests searching or filling. Attempting a smart navigation to perform a search.',
      confidence: 0.85,
      done: false,
    };
  }

  // 4. Default fallback: If all else fails, use 'think' to re-evaluate.
  return {
    tool: 'think',
    params: {
      thought: 'Planning failed. The model returned an invalid action, and no deterministic fallback was suitable. Re-evaluating the state to find a new path.'
    },
    rationale: 'Fallback: Critical planning failure. Pausing to re-evaluate the situation.',
    confidence: 0.98,
    done: false,
  };
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Recovery planning for when main planning fails
async function attemptRecoveryPlanning(tabId, sess, goal, currentSubTask, contextData) {
  emitAgentLog(tabId, {
    level: LOG_LEVELS.WARN,
    msg: "Attempting recovery with deterministic fallback action."
  });

  const fallbackAction = generateFallbackAction(sess, contextData);

  emitAgentLog(tabId, {
    level: LOG_LEVELS.INFO,
    msg: "Generated fallback action",
    action: fallbackAction
  });

  // We return the action object directly, not a model response
  return { success: true, action: fallbackAction };
}
// [CONTEXT ENGINEERING] Enhanced context gathering from session state
async function gatherEnhancedContext(tabId, sess, currentSubTask) {
  emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Gathering context from session state" });

  try {
    const pageInfo = await getPageInfoForPlanning(tabId);

    // Context is now primarily built from session history, not active polling.
    // The agent must explicitly use tools like `read_page_content` or `get_interactive_elements`.
    const chatSummary = await summarizeChatTranscript(sess.chatTranscript, sess.selectedModel, tabId);

    const contextData = {
      pageInfo,
      pageContent: sess.currentPageContent || "", // Get content from session
      interactiveElements: sess.currentInteractiveElements || [], // Get elements from session
      history: sess.history || [],
      scratchpad: sess.scratchpad || [],
      lastAction: sess.lastAction,
      lastObservation: sess.lastObservation,
      taskContext: sess.taskContext,
      chatSummary: chatSummary, // Add chat summary to context
      progress: {
        step: sess.step,
        currentSubTask,
        subTaskIndex: sess.currentTaskIndex,
        totalSubTasks: sess.subTasks.length,
        failureCount: sess.failureCount,
        consecutiveFailures: sess.consecutiveFailures
      }
    };

    return contextData;
  } catch (error) {
    emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Failed to gather enhanced context", error: error.message });
    return null;
  }
  
}

// [CONTEXT ENGINEERING] Enhanced action execution
async function executeActionWithContext(tabId, sess, action, settings) {
  // Log with redacted params
  const redactedAction = {
    ...action,
    params: action.params ? Object.fromEntries(
      Object.entries(action.params).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > 100 ? v.substring(0, 100) + '...' : v
      ])
    ) : action.params
  };

  emitAgentLog(tabId, {
    level: LOG_LEVELS.INFO,
    msg: `Executing Tool: ${action.tool}`,
    action: redactedAction,
    rationale: action.rationale, // Add rationale to the log
    requestId: sess.requestId
  });

  const execRes = await dispatchActionWithTimeout(tabId, action, settings);

  emitAgentLog(tabId, {
    level: execRes?.ok === false ? LOG_LEVELS.ERROR : LOG_LEVELS.SUCCESS,
    msg: "Action completed",
    tool: action.tool,
    success: execRes?.ok !== false,
    observation: execRes?.observation?.substring(0, 300) + (execRes?.observation?.length > 300 ? '...' : ''),
    errorType: execRes?.errorType,
    requestId: sess.requestId
  });

  sendActionResultToChat(tabId, sess, action, execRes);

  // Auto-sense: if navigation was successful, immediately read the new page content
  if (execRes.ok && ['navigate', 'goto_url', 'smart_navigate', 'research_url'].includes(action.tool)) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.INFO,
      msg: "Auto-sensing new page content after navigation",
      triggeringTool: action.tool
    });
    const readAction = { tool: 'read_page_content', params: {} };
    const readRes = await dispatchActionWithTimeout(tabId, readAction, settings);
    if (readRes.ok && readRes.pageContent) {
      sess.currentPageContent = readRes.pageContent;
      emitAgentLog(tabId, {
        level: LOG_LEVELS.DEBUG,
        msg: `Auto-read successful, stored page content in session (length: ${readRes.pageContent.length})`
      });
    }
  }

  return execRes;
}

// [CONTEXT ENGINEERING] Session state update logic
function updateSessionContext(tabId, sess, action, execRes) {
  sess.lastAction = action;
  sess.lastObservation = execRes?.observation || "";

  // Add to history and keep it trimmed
  const historyEntry = { action, observation: execRes?.observation || "" };
  sess.history.push(historyEntry);
  if (sess.history.length > 20) {
    sess.history.shift();
  }

  // Add a concise summary to the scratchpad
  const scratchpadEntry = `Step ${sess.step}:
- Tool: ${action.tool}
- Params: ${JSON.stringify(action.params)}
- Result: ${execRes.ok ? 'SUCCESS' : 'FAILURE'}
- Observation: ${(execRes.observation || "").substring(0, 4000)}...`;
  sess.scratchpad.push(scratchpadEntry);
  if (sess.scratchpad.length > 15) { // Keep scratchpad from getting too long
      sess.scratchpad.shift();
  }

  // If the page content was read, store it in the session
  if (action.tool === 'read_page_content' && execRes.ok && execRes.pageContent) {
    sess.currentPageContent = execRes.pageContent;
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: `Stored page content in session (length: ${execRes.pageContent.length})` });
  }

  // If we navigate away, the content is now stale and must be cleared
  if (action.tool === 'navigate' || action.tool === 'goto_url' || action.tool === 'smart_navigate') {
    sess.currentPageContent = "";
    sess.currentInteractiveElements = [];
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Cleared stale page content from session after navigation." });
  }

  // Persist session state after each action
  saveSessionToStorage(tabId, sess);

  // Update domain visit count for the watchdog
  if (execRes.ok && ['navigate', 'goto_url', 'smart_navigate', 'research_url'].includes(action.tool)) {
    try {
      const url = new URL(action.params.url);
      const domain = url.hostname;
      sess.domainVisitCount[domain] = (sess.domainVisitCount[domain] || 0) + 1;
    } catch (e) {
      // Ignore invalid URLs
    }
  }

  // Update no-progress detector state
  const observation = execRes?.observation || "";
  // Consider progress made if the observation is new and substantive
  if (observation.length > 50 && observation !== sess.lastProgressObservation) {
      sess.noProgressCounter = 0;
      sess.lastProgressObservation = observation;
  } else {
      sess.noProgressCounter = (sess.noProgressCounter || 0) + 1;
  }
}

// [CONTEXT ENGINEERING] Adaptive failure handling and self-correction
async function handleActionFailure(tabId, sess, goal, currentSubTask, contextData, failedAction, execRes) {
  const MAX_CONSECUTIVE_FAILURES = 3;

  if (sess.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.ERROR,
      msg: `Stopping agent after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`
    });
    return null;
  }

  emitAgentLog(tabId, {
    level: LOG_LEVELS.WARN,
    msg: `Action failed. Attempting self-correction. (Attempt ${sess.consecutiveFailures + 1}/${MAX_CONSECUTIVE_FAILURES})`,
    failedAction: failedAction,
    observation: execRes.observation
  });

  const correctionPrompt = buildSelfCorrectPrompt(goal, currentSubTask, {
    ...contextData,
    failedAction,
    observation: execRes.observation
  });

  const correctionRes = await callModelWithRotation(correctionPrompt, { model: sess.selectedModel, tabId });

  if (correctionRes?.ok) {
    const validationResult = parseAndValidateAction(tabId, sess, correctionRes.text);
    if (validationResult.success) {
      emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "Self-correction plan generated successfully." });
      return validationResult.action;
    } else {
      emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Failed to parse self-correction plan.", error: validationResult.error });
    }
  } else {
    emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Self-correction planning failed.", error: correctionRes?.error });
  }

  return null;
}

// [CONTEXT ENGINEERING] Dynamic delay between steps
function calculateAdaptiveDelay(action, success) {
  if (action.tool === 'navigate') {
    return TIMEOUTS.PAGE_LOAD_DELAY;
  }
  if (!success) {
    return TIMEOUTS.RETRY_DELAY;
  }
  return TIMEOUTS.ACTION_DELAY;
}
// Enhanced location-aware search term generation
function generateLocationAwareSearchTerms(query, userLocation = 'singapore') {
  const baseQuery = query.toLowerCase().trim();
  const searchTerms = [];
  
  // Base search term
  searchTerms.push(baseQuery);
  
  // Location-specific variations
  if (userLocation) {
    searchTerms.push(`${baseQuery} ${userLocation}`);
    searchTerms.push(`${baseQuery} price ${userLocation}`);
    searchTerms.push(`${baseQuery} buy ${userLocation}`);
    searchTerms.push(`${baseQuery} store ${userLocation}`);
    searchTerms.push(`${baseQuery} shop ${userLocation}`);
  }
  
  // Product-specific enhancements
  if (baseQuery.includes('ipad') || baseQuery.includes('iphone') || baseQuery.includes('apple')) {
    searchTerms.push(`apple ${baseQuery} ${userLocation}`);
    searchTerms.push(`${baseQuery} official store ${userLocation}`);
    searchTerms.push(`${baseQuery} authorized dealer ${userLocation}`);
  }
  
  // Price-specific searches
  if (baseQuery.includes('price') || baseQuery.includes('cost') || baseQuery.includes('buy')) {
    searchTerms.push(`best price ${baseQuery} ${userLocation}`);
    searchTerms.push(`cheapest ${baseQuery} ${userLocation}`);
    searchTerms.push(`${baseQuery} comparison ${userLocation}`);
  }
  
  // Remove duplicates and return unique terms
  return [...new Set(searchTerms)];
}

// Get user's location based on timezone
function getUserLocationFromTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    // Map common timezones to locations
    const timezoneLocationMap = {
      'Asia/Singapore': 'singapore',
      'Asia/Kuala_Lumpur': 'malaysia',
      'Asia/Jakarta': 'indonesia',
      'Asia/Bangkok': 'thailand',
      'Asia/Manila': 'philippines',
      'Asia/Hong_Kong': 'hong kong',
      'Asia/Tokyo': 'japan',
      'Asia/Seoul': 'south korea',
      'America/New_York': 'usa',
      'America/Los_Angeles': 'usa',
      'America/Chicago': 'usa',
      'Europe/London': 'uk',
      'Europe/Paris': 'france',
      'Europe/Berlin': 'germany',
      'Australia/Sydney': 'australia',
      'Australia/Melbourne': 'australia'
    };
    
    return timezoneLocationMap[timezone] || 'singapore'; // Default to singapore
  } catch (error) {
    console.warn('[BG] Failed to detect user location from timezone:', error);
    return 'singapore'; // Fallback
  }
}

// Smart URL determination for research tasks with location awareness
function determineSearchUrl(query, currentUrl = "", userLocation = null) {
  const lowerQuery = query.toLowerCase();
  const location = userLocation || getUserLocationFromTimezone();
  
  // If already on Google, return a search URL
  if (currentUrl.includes('google.com')) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }
  
  // For specific site searches
  if (lowerQuery.includes('wikipedia') || lowerQuery.includes('wiki')) {
    return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query.replace(/wikipedia|wiki/gi, '').trim())}`;
  }
  
  if (lowerQuery.includes('youtube') || lowerQuery.includes('video')) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query.replace(/youtube|video/gi, '').trim())}`;
  }
  
  if (lowerQuery.includes('github') || lowerQuery.includes('code')) {
    return `https://github.com/search?q=${encodeURIComponent(query.replace(/github|code/gi, '').trim())}`;
  }
  
  if (lowerQuery.includes('stackoverflow') || lowerQuery.includes('programming')) {
    return `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`;
  }
  
  if (lowerQuery.includes('reddit')) {
    return `https://www.reddit.com/search/?q=${encodeURIComponent(query.replace(/reddit/gi, '').trim())}`;
  }
  
  if (lowerQuery.includes('news') || lowerQuery.includes('latest')) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=nws`;
  }
  
  if (lowerQuery.includes('academic') || lowerQuery.includes('research paper') || lowerQuery.includes('scholar')) {
    return `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`;
  }
  
  // For shopping/price queries, use location-aware search
  if (lowerQuery.includes('price') || lowerQuery.includes('buy') || lowerQuery.includes('shop') ||
      lowerQuery.includes('ipad') || lowerQuery.includes('iphone') || lowerQuery.includes('product')) {
    const locationQuery = `${query} ${location}`;
    return `https://www.google.com/search?q=${encodeURIComponent(locationQuery)}`;
  }
  
  // Default to Google search
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// Analyze content quality for research purposes
function analyzeContentQuality(content, researchGoal = "") {
  if (!content || typeof content !== 'object') {
    return 'low';
  }
  
  const { title = "", text = "", links = [], metadata = {} } = content;
  let score = 0;
  
  // Content length scoring
  if (text.length > 2000) score += 2;
  else if (text.length > 500) score += 1;
  
  // Link quality scoring
  if (links.length > 10) score += 2;
  else if (links.length > 3) score += 1;
  
  // Title relevance scoring
  if (researchGoal && title.toLowerCase().includes(researchGoal.toLowerCase())) {
    score += 2;
  }
  
  // Metadata scoring
  if (metadata.description) score += 1;
  if (metadata.keywords) score += 1;
  
  // Authority scoring based on domain patterns
  const url = metadata.url || "";
  if (url.includes('.edu') || url.includes('.gov') || url.includes('wikipedia.org')) {
    score += 3;
  } else if (url.includes('.org') || url.includes('scholar.google')) {
    score += 2;
  }
  
  // Return quality rating
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

// Decision logic for whether to read URLs deeper
function shouldReadDeeper(urlAnalysis, contentQuality, currentDepth, maxDepth, researchGoal) {
  const decision = {
    decision: false,
    reasoning: "",
    urls: []
  };
  
  // Don't go deeper if at max depth
  if (currentDepth >= maxDepth) {
    decision.reasoning = `Maximum depth (${maxDepth}) reached`;
    return decision;
  }
  
  // Don't go deeper if no relevant URLs found
  if (!urlAnalysis?.relevantUrls || urlAnalysis.relevantUrls.length === 0) {
    decision.reasoning = "No relevant URLs found for deeper analysis";
    return decision;
  }
  
  // Go deeper if current content quality is low but relevant URLs exist
  if (contentQuality === 'low' && urlAnalysis.relevantUrls.length > 0) {
    decision.decision = true;
    decision.reasoning = "Current content quality is low, exploring better sources";
    decision.urls = urlAnalysis.relevantUrls.slice(0, 2);
    return decision;
  }
  
  // Go deeper if high-quality URLs are available and we haven't reached depth limit
  if (contentQuality === 'medium' && currentDepth < maxDepth - 1) {
    const highQualityUrls = urlAnalysis.relevantUrls.filter(url =>
      url.relevanceScore > 0.7 ||
      url.url.includes('.edu') ||
      url.url.includes('.gov') ||
      url.url.includes('wikipedia.org')
    );
    
    if (highQualityUrls.length > 0) {
      decision.decision = true;
      decision.reasoning = "High-quality authoritative sources found for deeper research";
      decision.urls = highQualityUrls.slice(0, 2);
      return decision;
    }
  }
  
  // Go deeper if research goal keywords are found in URL titles
  if (researchGoal) {
    const goalKeywords = researchGoal.toLowerCase().split(' ');
    const relevantUrls = urlAnalysis.relevantUrls.filter(url =>
      goalKeywords.some(keyword =>
        url.title?.toLowerCase().includes(keyword) ||
        url.url.toLowerCase().includes(keyword)
      )
    );
    
    if (relevantUrls.length > 0 && currentDepth < maxDepth) {
      decision.decision = true;
      decision.reasoning = "Found URLs highly relevant to research goal";
      decision.urls = relevantUrls.slice(0, 2);
      return decision;
    }
  }
  
  decision.reasoning = "Current content quality sufficient, no compelling reason to go deeper";
  return decision;
}

// [WATCHDOGS] Monitor agent's progress and intervene if it gets stuck
function runWatchdogs(tabId, sess, lastAction, lastExecRes) {
  // 1. Per-subtask step budget
  if (sess.subTaskStep >= sess.maxSubTaskSteps) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.WARN,
      msg: `Watchdog: Sub-task step budget reached (${sess.maxSubTaskSteps}). Advancing to next sub-task.`
    });
    sess.currentTaskIndex++;
    sess.subTaskStep = 0; // Reset for next sub-task
    sess.noProgressCounter = 0;
    return true; // Indicates intervention
  }

  // 2. Per-domain visit cap
  if (['navigate', 'goto_url', 'smart_navigate', 'research_url'].includes(lastAction.tool) && lastExecRes.ok) {
    try {
      const url = new URL(lastAction.params.url);
      const domain = url.hostname;
      if (sess.domainVisitCount[domain] > sess.maxDomainVisits) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.WARN,
          msg: `Watchdog: Domain visit limit reached for ${domain} (${sess.maxDomainVisits}). Forcing a 'think' action.`
        });
        // Force a think action by modifying the session history to guide the next step
        sess.lastAction = { tool: 'think', params: { thought: `I seem to be stuck on ${domain}. I need to try a different approach or domain.` } };
        sess.lastObservation = `Forced to rethink strategy due to excessive visits to the same domain.`;
        return true;
      }
    } catch (e) { /* ignore invalid URLs */ }
  }

  // 3. No-progress detector
  if (sess.noProgressCounter >= sess.maxNoProgressSteps) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.WARN,
      msg: `Watchdog: No significant progress detected for ${sess.noProgressCounter} steps. Forcing a 'think' action.`
    });
    sess.lastAction = { tool: 'think', params: { thought: `I seem to be stuck. My last few actions resulted in similar observations. I need to re-evaluate my plan.` } };
    sess.lastObservation = `Forced to rethink strategy due to lack of progress.`;
    sess.noProgressCounter = 0; // Reset after intervention
    return true;
  }

  // 4. Invalid action watchdog
  if (sess.consecutiveFailures >= 3) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.WARN,
      msg: `Watchdog: ${sess.consecutiveFailures} consecutive invalid actions. Forcing a 'think' action to repair.`
    });
    sess.lastAction = { tool: 'think', params: { thought: 'I produced invalid actions repeatedly. I will repair by proposing a simpler, schema-compliant action next.' } };
    sess.lastObservation = `Forced reflection to repair invalid action sequence.`;
    sess.consecutiveFailures = 0; // Reset after intervention
    return true;
  }

  return false; // No intervention
}

// [CONTEXT ENGINEERING] Summarize the chat transcript for prompt injection
async function summarizeChatTranscript(transcript, model, tabId) {
  if (!transcript || transcript.length === 0) {
    return "";
  }

  // If the transcript is short, just concatenate messages to avoid a slow LLM call.
  if (transcript.length <= 4) {
    return transcript.map(m => `${m.role}: ${m.content}`).join('\n');
  }

  // For longer transcripts, summarize the last 10 messages for context
  const recentMessages = transcript.slice(-10);
  const summaryPrompt = buildChatSummaryPrompt(recentMessages);

  const summaryRes = await callModelWithRotation(summaryPrompt, { model, tabId });

  if (summaryRes.ok) {
    return summaryRes.text;
  }

  // Fallback to a simple concatenation if summarization fails
  return recentMessages.map(m => `${m.role}: ${m.content}`).join('\n');
}
// DEBUG: Manual test function for template substitution
function testTemplateSubstitution() {
  console.log("[TEMPLATE TEST] Starting manual template substitution test...");
  
  // Create a mock session with some history
  const mockSession = {
    goal: "find ipad price",
    history: [
      {
        action: { tool: "navigate", params: { url: "https://www.google.com" } },
        observation: "Navigated to Google"
      },
      {
        action: { tool: "research_url", params: { url: "https://www.apple.com/sg/ipad/" } },
        observation: "Researched Apple iPad page"
      },
      {
        action: { tool: "smart_navigate", params: { query: "ipad price singapore" } },
        observation: "Smart navigation completed"
      }
    ],
    analyzedUrls: [
      "https://www.apple.com/sg/ipad/",
      "https://www.courts.com.sg/ipad",
      "https://www.challenger.sg/apple-ipad"
    ]
  };
  
  // Test parameters with template variables
  const testParams = {
    url: "{{PREVIOUS_STEP_RESULT_URL_1}}",
    fallbackUrl: "{{PREVIOUS_RESEARCHED_URL}}",
    analyzeUrl: "{{url_from_analyze_urls_result_1}}",
    query: "price comparison for {{CURRENT_GOAL}}"
  };
  
  console.log("[TEMPLATE TEST] Mock session:", mockSession);
  console.log("[TEMPLATE TEST] Test params:", testParams);
  
  // Test the resolution
  const resolvedParams = resolveTemplateVariables(testParams, mockSession, 123);
  
  console.log("[TEMPLATE TEST] Resolved params:", resolvedParams);
  console.log("[TEMPLATE TEST] Test completed.");
  
  return resolvedParams;
}

// Expose test function globally for manual testing
globalThis.testTemplateSubstitution = testTemplateSubstitution;
// ===== Graph helpers (Phase A.1 minimal, appended) =====
(function attachGraphHelpers(global) {
  if (!global.TaskGraphEngine) return;

  const LOGGER = (global.Log && global.Log.createLogger) ? global.Log.createLogger('graph') : null;

  // Build a simple read -> analyze -> extract graph for current tab/session
  global.buildSimpleGraphForSession = function(tabId, sess) {
    const nodes = [
      {
        id: 'read_page',
        kind: 'tool',
        toolId: 'readPageContent',
        input: { maxChars: 15000 },
        retryPolicy: { maxAttempts: 1 }
      },
      {
        id: 'analyze_urls',
        kind: 'tool',
        toolId: 'analyzeUrls',
        dependsOn: ['read_page'],
        retryPolicy: { maxAttempts: 1 }
      },
      {
        id: 'extract_structured',
        kind: 'tool',
        toolId: 'extractStructuredContent',
        dependsOn: ['read_page'],
        retryPolicy: { maxAttempts: 1 }
      }
    ];
    try { LOGGER?.debug?.('graph_build', { nodes: nodes.length, requestId: sess?.requestId }); } catch (_) {}
    return global.TaskGraphEngine.createGraph(nodes, { requestId: sess?.requestId, goal: sess?.goal || '' });
  };

  // Run a graph and update session state on key node completions
  global.runGraphForSession = async function(tabId, sess, graph) {
    try { LOGGER?.info?.('graph_run_begin', { graphId: graph?.id, requestId: sess?.requestId }); } catch (_) {}

    const res = await global.TaskGraphEngine.run(tabId, graph, {
      ctx: { tabId, ensureContentScript, chrome },
      defaultToolTimeoutMs: (global.MessageTypes?.TIMEOUTS?.DOM_ACTION_MS || 10000),
      concurrency: 2,
      failFast: false,
      onNodeFinish: (node, out) => {
        try {
          // Persist meaningful artifacts into session
          if (node.kind === 'tool' && out && out.ok !== false) {
            if (node.toolId === 'readPageContent' && out.pageContent) {
              sess.currentPageContent = out.pageContent;
              emitAgentLog(tabId, { level: MessageTypes.LOG_LEVELS.DEBUG, msg: 'Graph: stored page content in session', length: out.pageContent.length });
            }
            if (node.toolId === 'extractStructuredContent' && out.content) {
              const { content } = out;
              let findingToRecord = content.source === 'json-ld' ? content.data : { ...content };
              if (Array.isArray(findingToRecord)) {
                findingToRecord.forEach(item => { sess.findings = deepMerge(sess.findings || {}, item); });
              } else {
                sess.findings = deepMerge(sess.findings || {}, findingToRecord);
              }
              emitAgentLog(tabId, { level: MessageTypes.LOG_LEVELS.SUCCESS, msg: 'Graph: recorded structured finding', source: content.source || 'unknown' });
            }
            // Persist after each successful node
            saveSessionToStorage(tabId, sess);
          }
        } catch (e) {
          try { LOGGER?.warn?.('graph_onNodeFinish_error', { nodeId: node?.id, error: String(e?.message || e) }); } catch (_) {}
        }
      }
    });

    try { LOGGER?.info?.('graph_run_end', { graphId: graph?.id, ok: res?.ok !== false, durationMs: res?.durationMs }); } catch (_) {}

    // Emit a concise agent log summary
    try {
      emitAgentLog(tabId, {
        level: (res?.ok !== false ? MessageTypes.LOG_LEVELS.SUCCESS : MessageTypes.LOG_LEVELS.ERROR),
        msg: 'Graph run completed',
        graphId: graph?.id,
        ok: res?.ok !== false,
        durationMs: res?.durationMs
      });
    } catch (_) {}

    return res;
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));

// ===== End Graph helpers =====