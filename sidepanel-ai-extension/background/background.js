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
      // Enhanced error handling for import failures
      const importError = {
        name: 'ImportError',
        message: `Failed to import script: ${path}`,
        originalError: e,
        path,
        timestamp: new Date().toISOString(),
        context: 'background-script-initialization'
      };
      
      // This will appear in chrome://extensions → Errors
      console.error("[BG] importScripts FAILED ->", path, String(e && e.message || e), e && e.stack);
      
      // Track error if ErrorTracker is available (it won't be for the first few imports)
      if (globalThis.ErrorTracker) {
        try {
          globalThis.ErrorTracker.trackError({
            name: 'ImportError',
            message: importError.message,
            category: 'background',
            severity: 'critical',
            code: 'IMPORT_FAILED',
            context: importError
          });
        } catch (trackingError) {
          console.warn("[BG] Failed to track import error:", trackingError);
        }
      }
      
      throw e; // rethrow to preserve failure semantics for Status 15
    }
  }

  // Import in strict order; if any fails, we will know which.
  safeImport("../common/messages.js");        // defines globalThis.MessageTypes
  safeImport("../common/utils.js");           // defines globalThis.Utils
  safeImport("../common/errors.js");          // Custom error classes and error handling
  safeImport("../common/error-boundary.js");  // Error boundary and circuit breaker patterns
  safeImport("../common/error-tracker.js");   // Centralized error tracking
  safeImport("../common/indexed-db.js");      // IndexedDB wrapper
  safeImport("../common/sync-manager.js");    // Background sync manager
  safeImport("../common/api.js");             // API wrapper (classic script)
  safeImport("../common/automation-templates.js");  // Automation templates library
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
  safeImport("./tools.js");                     // Browser automation tools
  // Observer for structured timeline events
  safeImport("./observer.js");                  // AgentObserver (run/tool events to UI + storage)
  safeImport("./session-manager.js");         // Session management
  safeImport("./permission-manager.js");      // Permission management (CapabilityRegistry, PermissionManager)
  // Namespaced console logger (globalThis.Log)
  safeImport("../common/logger.js");           // Logger: globalThis.Log with levels/namespaces
  // Task Graph Engine (experimental)
  safeImport("../common/task-graph.js");
  // ReAct planner (experimental)
  safeImport("../common/react-planner.js");
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

// Fast Mode (background) flag and per-tool Port RPC timeouts
let FAST_MODE_BG = false;
(async () => {
  try {
    const o = await chrome.storage.local.get("FAST_MODE");
    FAST_MODE_BG = !!o?.FAST_MODE;
  } catch (_) {}
})();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.prototype.hasOwnProperty.call(changes, "FAST_MODE")) {
      FAST_MODE_BG = !!changes.FAST_MODE.newValue;
    }
  });
} catch (_) {}

const FAST_PORT_TIMEOUTS = {
  settle: 1200,
  clickElement: 2000,
  typeText: 2500,
  waitForSelector: 3000,
  scrollTo: 1200,
  checkSelector: 1000,
  getInteractiveElements: 3000,
  readPageContent: 5000,
  extractStructuredContent: 5000
};

function getFastTimeout(toolId, normalMs) {
  if (FAST_MODE_BG) {
    const v = FAST_PORT_TIMEOUTS[toolId];
    return Number.isFinite(v) ? v : (Number.isFinite(normalMs) ? normalMs : 3000);
  }
  return Number.isFinite(normalMs) ? normalMs : undefined;
}
// CapabilityRegistry is provided by background/permission-manager.js
// Safe wrapper to consume chrome.runtime.lastError for fire-and-forget messages
function safeRuntimeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Consume lastError to avoid "Unchecked runtime.lastError" noise
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

// PermissionManager is provided by background/permission-manager.js

const permissionManager = new globalThis.PermissionManager({
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => await chrome.storage.local.set({ [key]: value }),
});

const agentSessions = globalThis.SessionManager.agentSessions;

// Per-tab content script capability cache
const contentScriptCaps = new Map(); // tabId -> { capabilities }

/**
 * BFCache/Navigation resilience: proactively invalidate Port + caps when tab navigates or history state changes.
 * This prevents "message channel is closed" errors caused by BFCache moving pages.
 */
function invalidateTabCommChannel(tabId, reason = "navigation") {
  try { AgentPortManager.invalidate(tabId); } catch (_) {}
  try { contentScriptCaps.delete(tabId); } catch (_) {}
  const sess = agentSessions.get(tabId);
  if (sess) {
    // Element caching removed for bfcache compatibility - always fetch fresh elements
    // sess.currentInteractiveElements = [];
    sess.currentPageContent = "";
  }
  try {
    emitAgentLog?.(tabId, { level: LOG_LEVELS.DEBUG, msg: `Comm channel invalidated due to ${reason}` });
  } catch (_) {}
}

// Invalidate on tab URL change/loading (covers hard navigations)
try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Invalidate when URL changes or page starts loading to avoid stale ports
    if ((typeof changeInfo.status === 'string' && changeInfo.status === 'loading') ||
        (typeof changeInfo.url === 'string' && changeInfo.url)) {
      invalidateTabCommChannel(tabId, changeInfo.url ? "url_change" : "loading");
      
      // Clear all caches on navigation
      try {
        clearElementCache(tabId, changeInfo.url ? "url_change" : "loading");
        // Also clear connection health cache and retry state on navigation
        connectionHealthCache.delete(tabId);
        refreshRetryState.delete(tabId);
      } catch (error) {
        console.warn(`[BG] Failed to clear caches:`, error);
      }
    }
  });
} catch (_) {}

// Invalidate on SPA route changes (pushState/replaceState updates)
try {
  if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      if (Number.isFinite(details.tabId)) {
        invalidateTabCommChannel(details.tabId, "history_state_updated");
      }
    });
  }
} catch (_) {}

// Invalidate on committed navigation (new document)
try {
  if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (Number.isFinite(details.tabId)) {
        invalidateTabCommChannel(details.tabId, "navigation_committed");
      }
    });
  }
} catch (_) {}

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


async function callModelWithTimeout(apiKey, prompt, options, timeoutMs = TIMEOUTS.MODEL_CALL_MS) {
  try {
    return await Utils.withTimeout(
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
            // The user has requested to remove the delay.
            // const jitter = 0.5 + Math.random();
            // await new Promise(resolve => setTimeout(resolve, Math.max(500, Math.floor(delayMs * jitter))));
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

  // Inline mapper: translate legacy/canonical action.tool to ToolsRegistry tool + input
  function mapActionToRegistry(a) {
    if (!a || typeof a !== 'object') return null;
    const tool = String(a.tool || '').trim();
    const p = a.params || {};

    // Navigation
    if (tool === 'navigate' || tool === 'goto_url' || tool === 'navigateToUrl') {
      return { toolId: 'navigateToUrl', input: { url: String(p.url || '') } };
    }
    // Composite click-and-wait (aliases)
    if (tool === 'click_and_wait' || tool === 'clickAndWait') {
      const input = { selector: String(p.selector || '') };
      const waitFor = {};
      if (typeof p.waitForSelector === 'string' && p.waitForSelector) {
        waitFor.selector = p.waitForSelector;
      }
      if (p.waitForDisappear === true) {
        waitFor.disappear = true;
      }
      if (p.urlChange === true) {
        waitFor.urlChange = true;
      }
      if (typeof p.timeoutMs === 'number') {
        waitFor.timeoutMs = p.timeoutMs;
      }
      if (Object.keys(waitFor).length > 0) input.waitFor = waitFor;
      return { toolId: 'clickAndWait', input };
    }

    // Page reading and analysis
    if (tool === 'read_page_content' || tool === 'readPageContent') {
      return { toolId: 'readPageContent', input: { maxChars: Number(p.maxChars || 15000) } };
    }
    if (tool === 'analyze_urls' || tool === 'analyzeUrls') {
      return { toolId: 'analyzeUrls', input: {} };
    }
    if (tool === 'extract_structured_content' || tool === 'extractStructuredContent') {
      return { toolId: 'extractStructuredContent', input: {} };
    }
    if (tool === 'get_page_links' || tool === 'getPageLinks' || tool === 'extractLinks') {
      return {
        toolId: 'extractLinks',
        input: {
          includeExternal: p.includeExternal !== false,
          maxLinks: Number(p.maxLinks || 20)
        }
      };
    }

    // DOM interactions
    if (tool === 'click_element' || tool === 'click' || tool === 'clickElement') {
      const input = {};
      // Priority: semantic_selector -> selector -> elementIndex
      try {
        if (typeof p.semantic_selector === 'string' && p.semantic_selector.trim()) {
          const sem = p.semantic_selector.trim();
          // Convert semantic selector to a robust selector the content script understands
          // Supported:
          //   text:Send   -> text=Send
          //   aria:Send   -> [aria-label="Send"]
          //   role:button name:Send -> text=Send (fallback to text-based)
          //   already in text=... or [aria-label="..."] passes through via selector normalization
          let sel = '';
          const mText = sem.match(/^text\s*:\s*(.+)$/i);
          const mAria = sem.match(/^aria\s*:\s*(.+)$/i);
          const mRoleName = sem.match(/^role\s*:\s*([a-z]+)\s+name\s*:\s*(.+)$/i);
          if (mText) {
            sel = `text=${mText[1].trim()}`;
          } else if (mAria) {
            const val = mAria[1].trim().replace(/^["']|["']$/g, '');
            sel = `[aria-label="${val}"]`;
          } else if (mRoleName) {
            const name = mRoleName[2].trim().replace(/^["']|["']$/g, '');
            sel = `text=${name}`;
          } else if (/^\s*text\s*=/.test(sem) || /^\s*\[?\s*aria-label\s*=/.test(sem)) {
            sel = sem;
          } else {
            sel = `text=${sem}`;
          }
          if (sel) input.selector = sel;
        }
      } catch (_) {}
      if (!input.selector && typeof p.selector === 'string' && p.selector) input.selector = String(p.selector);
      const idx = Number(p.elementIndex);
      if (Number.isFinite(idx) && idx > 0) input.elementIndex = idx;
      return { toolId: 'clickElement', input };
    }
    if (tool === 'type_text' || tool === 'fill' || tool === 'typeText') {
      const input = {
        text: String((p.text ?? p.value) || '')
      };
      // Priority: semantic_selector -> selector
      try {
        if (typeof p.semantic_selector === 'string' && p.semantic_selector.trim()) {
          const sem = p.semantic_selector.trim();
          let sel = '';
          const mText = sem.match(/^text\s*:\s*(.+)$/i);
          const mAria = sem.match(/^aria\s*:\s*(.+)$/i);
          const mRoleName = sem.match(/^role\s*:\s*([a-z]+)\s+name\s*:\s*(.+)$/i);
          if (mText) {
            sel = `text=${mText[1].trim()}`;
          } else if (mAria) {
            const val = mAria[1].trim().replace(/^["']|["']$/g, '');
            sel = `[aria-label="${val}"]`;
          } else if (mRoleName) {
            const name = mRoleName[2].trim().replace(/^["']|["']$/g, '');
            sel = `text=${name}`;
          } else if (/^\s*text\s*=/.test(sem) || /^\s*\[?\s*aria-label\s*=/.test(sem)) {
            sel = sem;
          } else {
            sel = `text=${sem}`;
          }
          if (sel) input.selector = sel;
        }
      } catch (_) {}
      if (!input.selector && typeof p.selector === 'string' && p.selector) input.selector = String(p.selector);
      // Preserve label hint for selector inference in ToolsRegistry.typeText
      if (typeof p.label === 'string' && p.label) input.label = String(p.label);
      const idx = Number(p.elementIndex);
      if (Number.isFinite(idx) && idx > 0) input.elementIndex = idx;
      return { toolId: 'typeText', input };
    }
    if (tool === 'wait_for_selector' || tool === 'waitForSelector') {
      return {
        toolId: 'waitForSelector',
        input: {
          selector: String(p.selector || ''),
          timeoutMs: Number(p.timeoutMs || 5000)
        }
      };
    }
    if (tool === 'scroll_to' || tool === 'scroll' || tool === 'scrollTo') {
      const input = {};
      if (typeof p.selector === 'string' && p.selector) input.selector = p.selector;
      if (typeof p.direction === 'string' && p.direction) input.direction = p.direction;
      if (typeof p.amountPx !== 'undefined') input.amountPx = Number(p.amountPx);
      return { toolId: 'scrollTo', input };
    }
    if (tool === 'scrape' || tool === 'scrapeSelector') {
      return { toolId: 'scrapeSelector', input: { selector: String(p.selector || '') } };
    }
    if (tool === 'get_interactive_elements' || tool === 'getInteractiveElements') {
      return { toolId: 'getInteractiveElements', input: {} };
    }
    if (tool === 'record_finding' || tool === 'recordFinding') {
      return { toolId: 'recordFinding', input: { finding: p.finding } };
    }
    // Yield two frames to allow DOM to settle in Fast Mode pipelines or when explicitly requested
    if (tool === 'settle') {
      return { toolId: 'settle', input: {} };
    }

    return null;
  }

  // If this action is backed by a ToolsRegistry tool, delegate via runRegisteredTool
  const mapped = mapActionToRegistry(action);
  if (mapped) {
    // Preserve permission checks for risky capabilities
    try {
      const permission = await permissionManager.hasPermission(tabId, action);
      if (!permission.granted) {
        return { ok: false, observation: "Permission denied by user." };
      }
    } catch (e) {
      return { ok: false, observation: e.message || "Permission check failed" };
    }

    // Delegate to registry. Avoid duplicate timeline events:
    // runRegisteredTool already emits tool_started/tool_result via AgentObserver.
    try {
      const result = await runRegisteredTool(tabId, mapped.toolId, mapped.input);
      return result;
    } catch (error) {
      return {
        ok: false,
        observation: `Action failed: ${error.message}`,
        errorType: ERROR_TYPES.DOM_ERROR
      };
    }
  }

  // Legacy path (non-registered actions): maintain existing behavior with timeout + explicit timeline events
  try {
    // Emit tool_started to timeline
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolStarted === 'function') {
        await globalThis.AgentObserver.emitToolStarted(tabId, action?.tool || 'unknown', action?.params || {});
      }
    } catch (_) {}

    const res = await Utils.withTimeout(
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

  // Tool-specific required parameters
  const toolRequirements = {
    'click_element': [['selector', 'semantic_selector', 'elementIndex']],
    'type_text': [['text'], ['selector', 'semantic_selector', 'elementIndex']],
    'wait_for_selector': [['selector']],
    'scroll_to': [['selector', 'direction']],
  };

  if (toolRequirements[action.tool]) {
    for (const requirement of toolRequirements[action.tool]) {
      if (!requirement.some(param => action.params && param in action.params)) {
        errors.push(`Tool '${action.tool}' requires one of '${requirement.join("', '")}'.`);
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

  // If finding exists as string JSON, parse it; otherwise coerce to an object
  if (typeof normalized.finding === 'string') {
    const parsed = tryParseJSONMaybe(normalized.finding);
    if (parsed && typeof parsed === 'object') {
      normalized.finding = parsed;
    } else {
      // Coerce plain string to a minimal structured object
      normalized.finding = { summary: normalized.finding };
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
  if (out.tool === 'record_finding' || out.tool === 'recordFinding') {
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
   clearElement: 'type_text', // Map clearElement to type_text
   waitForSelector: 'wait_for_selector',
   screenshot: 'take_screenshot',
   readPageContent: 'read_page_content',
   extractStructuredContent: 'extract_structured_content',
   analyzeUrls: 'analyze_urls',
   getPageLinks: 'get_page_links',
   recordFinding: 'record_finding'
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
 
 // Normalize element index aliases and coerce to integer
 try {
   const idxCandidates = ['elementIndex', 'element_index', 'index', 'elementId', 'element_id'];
   for (const key of idxCandidates) {
     const v = out.params[key];
     if (typeof v === 'string' && /^\d+$/.test(v)) {
       out.params.elementIndex = Math.max(1, parseInt(v, 10));
       break;
     }
     if (typeof v === 'number' && Number.isFinite(v)) {
       out.params.elementIndex = Math.max(1, Math.floor(v));
       break;
     }
   }
   // Cleanup aliases to avoid schema noise
   ['element_index', 'index', 'elementId', 'element_id'].forEach(k => { if (k in out.params) delete out.params[k]; });
 } catch (_) {}
 
 // Remove non-canonical/LLM-only fields
 if ('selector_type' in out.params) delete out.params.selector_type;
 if ('state' in out.params) delete out.params.state;
 
 // Normalize typing parameter
 if (out.tool === 'type_text' && typeof out.params.text === 'undefined' && typeof out.params.value !== 'undefined') {
   out.params.text = out.params.value;
 }
 // Preserve label and map name to label if label is not present
 if (typeof out.params.label === 'undefined' && typeof out.params.name === 'string') {
   out.params.label = out.params.name;
 }
 // If the original tool was clearElement, ensure the text is an empty string.
 if (action.tool === 'clearElement') {
   out.params.text = "";
 }

 // Drop any params not present in the global schema to pass validation
 for (const k of Object.keys(out.params)) {
   if (!allowedParamKeys.includes(k)) {
     delete out.params[k];
   }
 }

 // If not recording a finding, drop stray 'finding' param to avoid schema/type errors from LLM noise
 if (out.tool !== 'record_finding' && 'finding' in out.params) {
   delete out.params.finding;
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
    safeRuntimeSendMessage({ type: MSG.AGENT_LOG, tabId, entry: logEntry });
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

        safeRuntimeSendMessage({
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

  if (FAST_MODE_BG) {
    const lowerMsg = (entry.msg || '').toLowerCase();

    // Allow key DOM actions even in Fast Mode
    if (lowerMsg.includes('executing tool')) {
      const toolId = entry.tool || entry.action?.tool;
      if (['click','click_element','clickElement','type_text','typeText','fill','wait_for_selector','waitForSelector','scroll_to','scrollTo'].includes(toolId)) {
        return true;
      }
      // Otherwise suppress execution chatter
      return false;
    }

    // Surface watchdog/self-correction warnings
    if (entry.level === LOG_LEVELS.WARN && (lowerMsg.includes('watchdog') || lowerMsg.includes('self-correction') || lowerMsg.includes('re-executing'))) {
      return true;
    }

    if (entry.level === LOG_LEVELS.INFO && entry.msg) {
      const m = String(entry.msg || '').trim().toLowerCase();

      // Planning milestones
      if (
        m.startsWith('plan generated') ||
        m.startsWith('multi-step plan generated') ||
        m.startsWith('react plan generated')
      ) {
        return true;
      }

      // Navigation milestones
      if (
        m.startsWith('navigated to') ||
        m.startsWith('navigation') ||
        m.startsWith('smart navigation')
      ) {
        return true;
      }

      // Report milestones
      if (
        m.startsWith('generating final report') ||
        m.includes('report generated')
      ) {
        return true;
      }

      // Graph engine milestones
      if (
        m.startsWith('graph mode starting') ||
        m.includes('graph run completed')
      ) {
        return true;
      }

      return false;
    }

    if (entry.level === LOG_LEVELS.SUCCESS && entry.tool) {
      const allowedTools = ['generate_report', 'generateReport', 'done'];
      return allowedTools.includes(entry.tool);
    }

    return false;
  }

  // Non-fast mode: Send progress for key milestones and important events
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

  // Surface warnings for stuck/correction events
  if (entry.level === LOG_LEVELS.WARN && entry.msg) {
    const m = entry.msg.toLowerCase();
    if (m.includes('watchdog') || m.includes('self-correction') || m.includes('re-executing')) {
      return true;
    }
  }

  // Send success messages for important tools only
  if (entry.level === LOG_LEVELS.SUCCESS && entry.tool) {
    const importantTools = ['navigate', 'navigateToUrl', 'smart_navigate', 'research_url', 'multi_search', 'generate_report', 'generateReport', 'done'];
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
    const p = entry.action?.params || {};
    // Click actions
    if (['click', 'click_element', 'clickElement'].includes(tool)) {
      const target = Number.isFinite(p.elementIndex) ? `#${p.elementIndex}` : (p.selector ? `"${String(p.selector).slice(0, 80)}"` : 'element');
      return `${stepPrefix} 👆 Clicking ${target}`;
    }
    // Typing actions
    if (['type_text', 'typeText', 'fill'].includes(tool)) {
      const txt = typeof p.text === 'string' ? String(p.text).slice(0, 50) : '';
      const target = Number.isFinite(p.elementIndex) ? `#${p.elementIndex}` : (p.selector ? `"${String(p.selector).slice(0, 80)}"` : '');
      const into = target ? ` into ${target}` : '';
      return `${stepPrefix} ✏️ Typing "${txt}"${into}`;
    }
    // Wait/scroll actions
    if (['wait_for_selector', 'waitForSelector'].includes(tool)) {
      const sel = p.selector ? `"${String(p.selector).slice(0,80)}"` : '';
      return `${stepPrefix} ⏳ Waiting for ${sel || 'selector'}`;
    }
    if (['scroll_to','scrollTo'].includes(tool)) {
      const dir = p.direction ? `towards ${p.direction}` : '';
      return `${stepPrefix} 📜 Scrolling ${dir}`.trim();
    }
    // Fallback
    return `${stepPrefix} 🔧 ${getToolEmoji(tool)} ${getToolDescription(tool)}`;
  }
  
  // Action completion messages - only show for important tools
  if (entry.level === LOG_LEVELS.SUCCESS && entry.tool) {
    const importantTools = ['navigate', 'navigateToUrl', 'smart_navigate', 'research_url', 'multi_search', 'generate_report', 'generateReport'];
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
    // Canonical tool ids
    'navigate': '🌐',
    'goto_url': '🌐',
    'navigateToUrl': '🌐',

    'click_element': '👆',
    'clickElement': '👆',

    'type_text': '✏️',
    'typeText': '✏️',

    'select_option': '🎚️',

    'scroll_to': '📜',
    'scrollTo': '📜',

    'wait_for_selector': '⏳',
    'waitForSelector': '⏳',

    'take_screenshot': '📸',

    'create_tab': '🆕',
    'close_tab': '❌',
    'switch_tab': '🔄',

    'tabs.query': '🗂️',
    'tabs.activate': '🔄',
    'tabs.close': '❌',

    'scrape': '✂️',
    'scrapeSelector': '✂️',

    'read_page_content': '📖',
    'readPageContent': '📖',

    'extract_structured_content': '🧩',
    'extractStructuredContent': '🧩',

    'record_finding': '📝',
    'recordFinding': '📝',

    'analyze_urls': '🔍',
    'analyzeUrls': '🔍',

    'get_page_links': '🔗',
    'extractLinks': '🔗',
    'getInteractiveElements': '🔗',

    'smart_navigate': '🧭',
    'research_url': '🔬',
    'multi_search': '🔍',
    'continue_multi_search': '➡️',
    'analyze_url_depth': '📊',

    'generate_report': '📄',
    'generateReport': '📄',

    'think': '🤔',
    'done': '✅',
    // Legacy synonyms (back-compat for logs)
    'click': '👆',
    'fill': '✏️',
    'scroll': '📜',
    'waitForSelector': '⏳',
    'screenshot': '📸'
  };
  return emojiMap[tool] || '🔧';
}

// Get user-friendly description for tools
function getToolDescription(tool) {
  const descriptionMap = {
    // Canonical tool ids
    'navigate': 'Opening webpage',
    'goto_url': 'Opening webpage',
    'navigateToUrl': 'Opening webpage',

    'click_element': 'Clicking element',
    'clickElement': 'Clicking element',

    'type_text': 'Filling form field',
    'typeText': 'Filling form field',

    'select_option': 'Selecting option',

    'scroll_to': 'Scrolling page',
    'scrollTo': 'Scrolling page',

    'wait_for_selector': 'Waiting for element',
    'waitForSelector': 'Waiting for element',

    'take_screenshot': 'Taking screenshot',

    'create_tab': 'Creating new tab',
    'close_tab': 'Closing tab',
    'switch_tab': 'Switching tab',
    'tabs.query': 'Searching tabs',
    'tabs.activate': 'Switching tab',
    'tabs.close': 'Closing tab',

    'scrape': 'Scraping content',
    'scrapeSelector': 'Scraping content',

    'read_page_content': 'Reading page content',
    'readPageContent': 'Reading page content',

    'extract_structured_content': 'Extracting structured content',
    'extractStructuredContent': 'Extracting structured content',

    'record_finding': 'Recording finding',
    'recordFinding': 'Recording finding',

    'analyze_urls': 'Analyzing links',
    'analyzeUrls': 'Analyzing links',

    'get_page_links': 'Extracting links',
    'extractLinks': 'Extracting links',
    'getInteractiveElements': 'Listing interactive elements',

    'smart_navigate': 'Smart navigation',
    'research_url': 'Researching content',
    'multi_search': 'Multi-source search',
    'continue_multi_search': 'Continuing multi-search',
    'analyze_url_depth': 'Analyzing URL depth',

    'generate_report': 'Creating report',
    'generateReport': 'Creating report',

    'think': 'Thinking',
    'done': 'Task complete',
    // Legacy synonyms (back-compat for logs)
    'click': 'Clicking element',
    'fill': 'Filling form field',
    'scroll': 'Scrolling page',
    'waitForSelector': 'Waiting for element',
    'screenshot': 'Taking screenshot'
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
  SessionManager.saveSessionToStorage(tabId, sess);

  // If the agent is stopping because the goal is achieved, clear the session from DB
  if (reason.includes("Goal achieved") || reason.includes("done")) {
    console.log(`[BG] Task for tab ${tabId} is complete. Clearing session from IndexedDB.`);
    try {
      SessionManager.clearSession
        ? SessionManager.clearSession(tabId).catch(e => console.warn(`[BG] Failed to clear session ${tabId}:`, e))
        : null;
    } catch (e) {
      console.warn(`[BG] Failed to clear session ${tabId}:`, e);
    }
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
  // Enhanced tab validation with detailed error reporting
  try {
    const tab = await chrome.tabs.get(tabId);
    
    // Validate tab state
    if (!tab) {
      console.warn(`[BG] Tab ${tabId} not found`);
      return false;
    }
    
    // Check for restricted URLs that don't support content scripts
    if (isRestrictedUrl(tab.url)) {
      console.warn(`[BG] Tab ${tabId} has restricted URL: ${tab.url}`);
      return false;
    }
    
    // Check tab loading state
    if (tab.status === 'loading') {
      console.warn(`[BG] Tab ${tabId} is still loading, content script injection may fail`);
      // Continue anyway as content script can be injected during loading
    }
    
    console.log(`[BG] Tab ${tabId} validation passed - URL: ${tab.url}, Status: ${tab.status}`);
  } catch (error) {
    console.warn(`[BG] Tab ${tabId} is not accessible: ${error.message}`);
    return false;
  }
  // Manual timeout wrapper for sendMessage (since the API has no timeout option)
  const ping = (timeoutMs = 400) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("PING_TIMEOUT"));
      }, timeoutMs);

      try {
        chrome.tabs.sendMessage(tabId, { type: "__PING_CONTENT__" }, (res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

  try {
    // Try a quick ping to see if the current content script is responsive
    console.log(`[BG] Attempting to ping existing content script in tab ${tabId}`);
    const resp = await ping(300);
    if (resp && resp.ok === true) {
      console.log(`[BG] Content script ping successful for tab ${tabId}, checking capabilities`);
      // Full capability handshake
      try {
        const caps = await sendContentRPC(tabId, { type: MSG.AGENT_CAPS }, 800);
        if (caps?.ok) {
          const capabilities = caps.capabilities || {};
          contentScriptCaps.set(tabId, capabilities);
          const sess = agentSessions.get(tabId);
          if (sess) {
            sess.contentScriptCaps = capabilities;
          }
          console.log(`[BG] Content script capabilities confirmed for tab ${tabId}:`, capabilities);
          return true;
        } else {
          console.warn(`[BG] Content script capabilities check failed for tab ${tabId}:`, caps);
        }
      } catch (e) {
        // Handshake failed; attempt injection below
        console.warn(`[BG] AGENT_CAPS handshake failed for tab ${tabId}:`, e.message);
      }
    } else {
      console.log(`[BG] Content script ping failed for tab ${tabId}, response:`, resp);
    }
  } catch (pingError) {
    // No listener or timed out — attempt to inject the latest scripts
    console.log(`[BG] Content script ping threw error for tab ${tabId}:`, pingError.message);
  }

  try {
    console.log(`[BG] Injecting content scripts into tab ${tabId}`);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // Ensure ranker is present before DOMAgent so DOMAgent.getInteractiveElements works
      files: ["common/messages.js", "content/element-ranker.js", "content/dom-agent.js", "content/content.js"]
    });
    console.log(`[BG] Content script injection completed for tab ${tabId}`);
    
    // Confirm the newly injected script is responsive
    console.log(`[BG] Verifying injected content script in tab ${tabId}`);
    const resp2 = await ping(800);
    if (resp2 && resp2.ok === true) {
      console.log(`[BG] Content script injection verified for tab ${tabId}`);
      // Retry handshake after injection
      try {
        const caps = await sendContentRPC(tabId, { type: MSG.AGENT_CAPS }, 800);
        if (caps?.ok) {
          const capabilities = caps.capabilities || {};
          contentScriptCaps.set(tabId, capabilities);
          const sess = agentSessions.get(tabId);
          if (sess) {
            sess.contentScriptCaps = capabilities;
          }
          console.log(`[BG] Content script capabilities confirmed after injection for tab ${tabId}:`, capabilities);
          return true;
        } else {
          console.warn(`[BG] Content script capabilities check failed after injection for tab ${tabId}:`, caps);
        }
      } catch (e) {
        console.warn(`[BG] AGENT_CAPS handshake failed after injection for tab ${tabId}:`, e.message);
      }
      console.log(`[BG] Assuming basic functionality for tab ${tabId} despite handshake failure`);
      return true; // Assume basic functionality even if handshake fails
    } else {
      console.error(`[BG] Content script injection verification failed for tab ${tabId}, response:`, resp2);
      return false;
    }
  } catch (injectionError) {
    console.error(`[BG] Failed to inject content script for tab ${tabId}:`, injectionError.message, injectionError);
    return false;
  }
}

// Persistent Port channel manager to reduce per-action message overhead
const AgentPortManager = (() => {
  const ports = new Map();   // tabId -> { port, pending: Map<id, {resolve,reject,to}>, heartbeat: intervalId }
  let nextId = 1;

  function getEntry(tabId) {
    let entry = ports.get(tabId);
    if (entry && entry.port) return entry;

    const port = chrome.tabs.connect(tabId, { name: "agent-port" });
    const pending = new Map();

    port.onMessage.addListener((packet) => {
      try {
        const id = packet && packet.id;
        if (id === '__HEARTBEAT_PONG__') return; // Ignore heartbeat responses
        const res = pending.get(id);
        if (!res) return;
        pending.delete(id);
        try { clearTimeout(res.to); } catch (_) {}
        try { res.resolve(packet.result); } catch (_) {}
      } catch (_) {}
    });

    port.onDisconnect.addListener(() => {
      try {
        const e = ports.get(tabId);
        if (e) {
          if (e.heartbeat) clearInterval(e.heartbeat);
          if (e.pending) {
            e.pending.forEach((p) => {
              try { clearTimeout(p.to); } catch (_) {}
              try { p.reject(new Error("Port disconnected")); } catch (_) {}
            });
            e.pending.clear();
          }
        }
      } catch (_) {}
      ports.delete(tabId);
    });

    // Heartbeat to detect BFCache disconnections
    const heartbeat = setInterval(() => {
      try {
        port.postMessage({ id: '__HEARTBEAT_PING__' });
      } catch (e) {
        // Port is likely closed, trigger disconnect logic
        port.disconnect();
      }
    }, 15000); // Send a ping every 15 seconds

    entry = { port, pending, heartbeat };
    ports.set(tabId, entry);
    return entry;
  }

  async function request(tabId, message, timeoutMs) {
    const entry = getEntry(tabId);
    const id = (nextId++ & 0x7fffffff);
    const payload = { id, message };
    return await new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        try { entry.pending.delete(id); } catch (_) {}
        reject(new Error(`Port RPC timeout after ${timeoutMs || (MessageTypes?.TIMEOUTS?.DOM_ACTION_MS || 10000)}ms`));
      }, Math.max(500, Number(timeoutMs || (MessageTypes?.TIMEOUTS?.DOM_ACTION_MS || 10000))));
      entry.pending.set(id, { resolve, reject, to });
      try {
        entry.port.postMessage(payload);
      } catch (e) {
        try { clearTimeout(to); } catch (_) {}
        try { entry.pending.delete(id); } catch (_) {}
        reject(e);
      }
    });
  }

  function invalidate(tabId) {
    const entry = ports.get(tabId);
    try { entry?.port?.disconnect(); } catch (_) {}
    ports.delete(tabId);
  }

  return { request, invalidate };
})();

// Enhanced action executor with immediate element refresh strategy
// Cache for recent element fetches to avoid redundancy
const elementFetchCache = new Map(); // tabId -> { timestamp, elements, operationType }

// Adaptive cache TTL based on operation complexity
const CACHE_TTL_CONFIG = {
  'click': 1500,      // Clicks may cause navigation, longer TTL
  'type': 2000,       // Typing often follows clicks, longer TTL
  'navigation': 500,  // Navigation changes everything, short TTL
  'wait': 3000,       // Wait operations need stable state, longest TTL
  'default': 1000     // Default TTL
};

// Connection health cache to prevent excessive checking
const connectionHealthCache = new Map(); // tabId -> { timestamp, isHealthy }
const CONNECTION_HEALTH_TTL = 500; // 500ms throttling for connection checks

// Retry coordination to prevent redundant refresh cycles
const refreshRetryState = new Map(); // tabId -> { timestamp, attemptCount, actionType }
const MAX_REFRESH_ATTEMPTS = 2;
const RETRY_COOLDOWN = 1000; // 1 second cooldown between retry cycles

// Get adaptive TTL based on operation type
function getAdaptiveTTL(operationType) {
  return CACHE_TTL_CONFIG[operationType] || CACHE_TTL_CONFIG.default;
}

// Clear element cache on navigation or BFCache events
function clearElementCache(tabId, reason = 'unknown') {
  if (elementFetchCache.has(tabId)) {
    console.log(`[BG] Clearing element cache for tab ${tabId}, reason: ${reason}`);
    elementFetchCache.delete(tabId);
  }
}

// Enhanced BFCache error detection
function isBFCacheError(error) {
  const errorMsg = String(error?.message || error || '').toLowerCase();
  return /back.*forward.*cache|message channel.*closed|port.*disconnected|extension port.*moved|keeping.*extension.*moved|page.*keeping.*extension.*port.*moved|moved.*into.*back.*forward.*cache/.test(errorMsg);
}

// Global error handler for uncaught BFCache errors
if (typeof window !== 'undefined' && window.chrome?.runtime) {
  // Handle uncaught runtime errors that might be BFCache related
  const originalAddListener = chrome.runtime.onMessage.addListener;
  chrome.runtime.onMessage.addListener = function(callback) {
    const wrappedCallback = function(message, sender, sendResponse) {
      try {
        return callback(message, sender, sendResponse);
      } catch (error) {
        if (isBFCacheError(error)) {
          console.log(`[BG] Caught BFCache error in message handler:`, error.message);
          if (sender?.tab?.id) {
            clearElementCache(sender.tab.id, 'uncaught_bfcache_error');
          }
        }
        throw error;
      }
    };
    return originalAddListener.call(this, wrappedCallback);
  };
}

// Enhanced timing safeguards for page interactivity
async function waitForPageStability(tabId, maxWaitMs = 4000, skipIfRecentFetch = true) {
  // Check DOM readiness first before element fetching
  const domCheck = await checkDOMReadiness(tabId, 500);
  if (!domCheck.ready) {
    console.warn(`[BG] DOM not ready for tab ${tabId}: ${domCheck.readyState}, elements: ${domCheck.elementCount}`);
    // Continue anyway but with awareness of DOM state
  }
  
  // Check if we have a recent element fetch to avoid redundancy
  if (skipIfRecentFetch) {
    const cached = elementFetchCache.get(tabId);
    if (cached && Date.now() - cached.timestamp < getAdaptiveTTL('stability_check')) {
      console.log(`[BG] Using recent element fetch (${cached.elements.length} elements) from ${Date.now() - cached.timestamp}ms ago`);
      return cached.elements.length;
    }
  }
  
  const start = Date.now();
  let lastElementCount = 0;
  let stableCount = 0;
  let retries = 3; // Number of retries
  
  while (Date.now() - start < maxWaitMs && retries > 0) {
    try {
      const mapRes = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
      const currentCount = (mapRes?.ok && mapRes.elements) ? mapRes.elements.length : 0;
      
      if (currentCount === lastElementCount && currentCount > 0) {
        stableCount++;
        if (stableCount >= 2) { // Elements stable for 2 checks
          console.log(`[BG] Page stable with ${currentCount} elements after ${Date.now() - start}ms`);
          
          // Cache the result to avoid redundant fetches
          elementFetchCache.set(tabId, {
            timestamp: Date.now(),
            elements: mapRes.elements || [],
            operationType: 'stability_check'
          });
          
          return currentCount;
        }
      } else {
        stableCount = 0;
        lastElementCount = currentCount;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500)); // Increased delay between checks
    } catch (error) {
      console.warn(`[BG] Page stability check failed:`, error.message);
      retries--; // Decrement retries on error
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  console.warn(`[BG] Page stability timeout after ${maxWaitMs}ms, proceeding anyway`);
  return lastElementCount;
}

async function refreshElementsAndExecute(tabId, targetSelector, targetIndex, actionType = "interaction") {
  // Check retry state to prevent excessive refresh cycles
  const retryState = refreshRetryState.get(tabId);
  if (retryState && retryState.actionType === actionType) {
    const timeSinceLastAttempt = Date.now() - retryState.timestamp;
    if (timeSinceLastAttempt < RETRY_COOLDOWN && retryState.attemptCount >= MAX_REFRESH_ATTEMPTS) {
      console.warn(`[BG] Skipping refresh for ${actionType} on tab ${tabId} - max attempts reached (${retryState.attemptCount}/${MAX_REFRESH_ATTEMPTS})`);
      // Return cached elements if available
      const cached = elementFetchCache.get(tabId);
      if (cached) {
        return { element: null, allElements: cached.elements, usedFallback: false };
      }
      throw new Error(`Max refresh attempts reached for ${actionType}`);
    }
  }
  
  // Update retry state
  const currentAttempts = (retryState && retryState.actionType === actionType && Date.now() - retryState.timestamp < RETRY_COOLDOWN) 
    ? retryState.attemptCount + 1 : 1;
  refreshRetryState.set(tabId, {
    timestamp: Date.now(),
    attemptCount: currentAttempts,
    actionType: actionType
  });
  
  console.log(`[BG] Refreshing elements before ${actionType} on tab ${tabId} (attempt ${currentAttempts}/${MAX_REFRESH_ATTEMPTS})`);
  
  try {
    // Check for recent cached elements first to avoid redundant calls
    const cached = elementFetchCache.get(tabId);
    let mapRes;
    
    const adaptiveTTL = getAdaptiveTTL(actionType);
    if (cached && Date.now() - cached.timestamp < adaptiveTTL) {
      console.log(`[BG] Using cached elements from ${Date.now() - cached.timestamp}ms ago for ${actionType} (TTL: ${adaptiveTTL}ms)`);
      mapRes = { ok: true, elements: cached.elements };
    } else {
      // Enhanced timing safeguards - wait for page stability and use its results
      const stableElements = await waitForPageStability(tabId, 2000, false); // Don't skip, get fresh elements
      
      // Check if waitForPageStability already populated our cache
      const newCached = elementFetchCache.get(tabId);
      if (newCached && Date.now() - newCached.timestamp < 200) { // Very recent cache from stability check
        console.log(`[BG] Using elements from stability check (${newCached.elements.length} elements)`);
        mapRes = { ok: true, elements: newCached.elements };
      } else {
        // Fallback: do one more fetch but with minimal delay
        console.log(`[BG] Stability check didn't cache elements, doing direct fetch`);
        await sendContentRPC(tabId, { type: MSG.SETTLE }, getFastTimeout("settle")).catch(() => {});
        mapRes = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
        
        // Cache the fresh result
        if (mapRes?.ok && mapRes.elements) {
          elementFetchCache.set(tabId, {
            timestamp: Date.now(),
            elements: mapRes.elements,
            operationType: actionType
          });
        }
      }
    }
    
    if (!mapRes?.ok) {
      throw new Error(`Failed to refresh elements: ${mapRes?.error || "Unknown error"}`);
    }
    
    const elements = (mapRes.elements || (mapRes.map && mapRes.map.elements)) || [];
    console.log(`[BG] Refreshed ${elements.length} elements on tab ${tabId}`);
    
    // Enhanced element selection with fuzzy matching
    if (targetSelector) {
      // Normalize selector to fix common quote issues
      let normalizedSelector = targetSelector
        .replace(/\[([^=]+)='([^']*)'([^\]]*)\]/g, '[$1="$2"$3]') // Fix mixed quotes
        .replace(/\[([^=]+)="([^"]*)'\]/g, '[$1="$2"]'); // Fix trailing quote issues
      
      // First try exact match
      let matchingElement = elements.find(el => el.selector === normalizedSelector || el.selector === targetSelector);
      
      if (!matchingElement) {
        console.warn(`[BG] Exact selector '${targetSelector}' not found, trying fuzzy matching`);
        
        // Try partial matches (for dynamic selectors that may change)
        const selectorToMatch = normalizedSelector !== targetSelector ? normalizedSelector : targetSelector;
        const selectorParts = selectorToMatch.split(/[\s>+~]/).filter(p => p.trim());
        if (selectorParts.length > 0) {
          const mainPart = selectorParts[selectorParts.length - 1]; // Get the last part
          matchingElement = elements.find(el => 
            el.selector && el.selector.includes(mainPart)
          );
          
          if (matchingElement) {
            console.log(`[BG] Found fuzzy match for '${mainPart}': ${matchingElement.selector}`);
          }
        }
        
        // Try text/label based matching if selector matching fails
        if (!matchingElement && elements.length > 0) {
          const textToMatch = targetSelector.match(/text\(["']([^"']+)["']\)|:has-text\(["']([^"']+)["']\)|\[[^\]]*=["']([^"']+)["']\]/)?.[1];
          if (textToMatch) {
            matchingElement = elements.find(el => 
              el.text?.includes(textToMatch) ||
              el.ariaLabel?.includes(textToMatch) ||
              el.name?.includes(textToMatch)
            );
            
            if (matchingElement) {
              console.log(`[BG] Found text-based match for '${textToMatch}': ${matchingElement.selector}`);
            }
          }
        }
        
        // Final fallback to index if available
        if (!matchingElement && Number.isFinite(targetIndex) && targetIndex > 0 && targetIndex <= elements.length) {
          const fallbackElement = elements[targetIndex - 1];
          console.log(`[BG] Using element index ${targetIndex} as final fallback:`, fallbackElement);
          return { element: fallbackElement, allElements: elements, usedFallback: true };
        }
      } else {
        console.log(`[BG] Found exact matching element for selector '${targetSelector}':`, matchingElement);
      }
      
      if (matchingElement) {
        return { element: matchingElement, allElements: elements, usedFallback: false };
      }
    }
    
    // If we have an index, use it
    if (Number.isFinite(targetIndex) && targetIndex > 0 && targetIndex <= elements.length) {
      const indexElement = elements[targetIndex - 1];
      console.log(`[BG] Using element at index ${targetIndex}:`, indexElement);
      return { element: indexElement, allElements: elements, usedFallback: false };
    }
    
    // Clear retry state on successful completion
    refreshRetryState.delete(tabId);
    
    // Return all elements for further selection
    return { element: null, allElements: elements, usedFallback: false };
  } catch (error) {
    console.error(`[BG] Failed to refresh elements for ${actionType}:`, error);
    throw error;
  }
}

// Enhanced communication layer with robust connection checking
async function checkConnectionHealth(tabId, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("HEALTH_CHECK_TIMEOUT"));
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, { type: "__PING_CONTENT__" }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (res?.ok === true) {
          resolve(true);
        } else {
          reject(new Error("UNHEALTHY_RESPONSE"));
        }
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

// Enhanced DOM ready state checking
async function checkDOMReadiness(tabId, timeoutMs = 1000) {
  try {
    // First check tab loading status
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') {
      throw new Error(`Tab status is ${tab.status}, not complete`);
    }
    
    // Then check document readiness via content script
    const result = await sendContentRPC(tabId, { 
      type: "GET_DOM_STATE" 
    }, timeoutMs).catch(() => null);
    
    if (result?.readyState === 'complete' && result?.elementCount > 0) {
      return {
        ready: true,
        elementCount: result.elementCount,
        readyState: result.readyState
      };
    }
    
    return {
      ready: false,
      elementCount: result?.elementCount || 0,
      readyState: result?.readyState || 'unknown'
    };
  } catch (error) {
    return {
      ready: false,
      elementCount: 0,
      readyState: 'error',
      error: error.message
    };
  }
}

// Enhanced connection manager with automatic recovery
async function ensureRobustConnection(tabId) {
  // Check if we recently verified this connection
  const cached = connectionHealthCache.get(tabId);
  if (cached && Date.now() - cached.timestamp < CONNECTION_HEALTH_TTL) {
    if (cached.isHealthy) {
      console.log(`[BG] Using cached connection health for tab ${tabId} (${Date.now() - cached.timestamp}ms ago)`);
      return true;
    }
  }
  
  console.log(`[BG] Ensuring robust connection for tab ${tabId}`);
  
  try {
    // Step 1: Quick health check
    await checkConnectionHealth(tabId, 300);
    console.log(`[BG] Connection healthy for tab ${tabId}`);
    
    // Cache positive result
    connectionHealthCache.set(tabId, {
      timestamp: Date.now(),
      isHealthy: true
    });
    
    return true;
  } catch (healthError) {
    console.warn(`[BG] Connection unhealthy for tab ${tabId}:`, healthError.message);
    
    // Cache negative result for shorter time
    connectionHealthCache.set(tabId, {
      timestamp: Date.now(),
      isHealthy: false
    });
    
    // Step 2: Attempt content script re-injection
    try {
      console.log(`[BG] Re-injecting content scripts for tab ${tabId}`);
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["common/messages.js", "content/element-ranker.js", "content/dom-agent.js", "content/content.js"]
      });
      
      // Step 3: Verify connection after injection
      await checkConnectionHealth(tabId, 800);
      console.log(`[BG] Connection restored for tab ${tabId}`);
      return true;
    } catch (injectionError) {
      console.error(`[BG] Failed to restore connection for tab ${tabId}:`, injectionError);
      return false;
    }
  }
}

// Helper that prefers Port RPC and falls back to sendMessage for resilience
async function sendContentRPC(tabId, message, timeoutMs) {
  // Pre-flight connection check for critical operations
  const isCriticalOperation = message.type === "GET_ELEMENT_MAP" || 
                              message.type === "GET_DOM_STATE" ||
                              message.type === "CLICK_SELECTOR" || 
                              message.type === "FILL_SELECTOR" ||
                              message.type === "DEBUG_CLICK_INDEX" ||
                              message.type === "DEBUG_FILL_INDEX";
  
  if (isCriticalOperation) {
    try {
      await ensureRobustConnection(tabId);
    } catch (connectionError) {
      throw new Error(`Failed to establish robust connection: ${connectionError.message}`);
    }
  }
  
  try {
    // Add diagnostic logging for critical operations
    if (isCriticalOperation) {
      console.log(`[BG] Executing critical operation ${message.type} on tab ${tabId}`);
    }
    
    const result = await AgentPortManager.request(tabId, message, timeoutMs);
    
    // Log successful results for debugging
    if (message.type === "GET_DOM_STATE") {
      console.log(`[BG] DOM State: readyState=${result?.readyState}, elements=${result?.elementCount}`);
    } else if (message.type === "GET_ELEMENT_MAP") {
      console.log(`[BG] Element Map: found ${result?.elements?.length || 0} elements`);
    }
    
    return result;
  } catch (e) {
    const msg = String(e?.message || e || "");
    const retriable = /Port RPC timeout|Port disconnected|message channel is closed|back\/forward cache|Could not establish connection/i.test(msg);
    
    // Enhanced error logging with better serialization
    let errorDetails;
    try {
      errorDetails = {
        message: msg,
        type: e?.constructor?.name || 'Unknown',
        stack: e?.stack ? e.stack.split('\n').slice(0, 3).join('\n') : 'No stack',
        retriable,
        timeout: timeoutMs,
        isCritical: isCriticalOperation
      };
    } catch (serializationError) {
      errorDetails = `Failed to serialize error: ${String(serializationError)}`;
    }
    
    console.error(`[BG] sendContentRPC failed for ${message.type} on tab ${tabId}:`, JSON.stringify(errorDetails, null, 2));
      
      // Enhanced BFCache error handling with better logging
      if (isBFCacheError(msg)) {
        console.warn(`[BG] BFCache error detected for tab ${tabId}: ${msg}`);
        try {
          clearElementCache(tabId, 'bfcache_error');
        } catch (error) {
          console.warn(`[BG] Failed to clear element cache on BFCache error:`, error);
        }
      }
    if (retriable) {
      console.warn(`[BG] Retriable error for tab ${tabId}, attempting recovery:`, msg);
      
      // Invalidate any stale channel and ensure content script is present before retry
      try { AgentPortManager.invalidate(tabId); } catch (_) {}
      
      // Enhanced connection recovery
      const connectionRestored = await ensureRobustConnection(tabId);
      if (!connectionRestored) {
        throw new Error("Failed to restore connection after multiple attempts");
      }
      
      // Attempt one fresh Port retry after ensuring content script
      try {
        return await AgentPortManager.request(tabId, message, timeoutMs);
      } catch (e2) {
        // Fallback to classic sendMessage on second failure
        return new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
              // Consume the error but reject the promise to signal failure
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            // Handle structured errors from content script
            if (response && response.ok === false && response.errorCode) {
              const error = new Error(response.error || "Content script error");
              error.errorCode = response.errorCode;
              reject(error);
            } else {
              resolve(response);
            }
          });
        });
      }
    }
    // If not a retriable port error, re-throw
    throw e;
  }
}

// Debug overlay helpers (best-effort; never throw)
async function showOverlayForDebug(tabId, options = {}) {
  try {
    if (!(await ensureContentScript(tabId))) return;
    const payload = {
      type: MSG.DEBUG_SHOW_OVERLAY,
      limit: Number.isFinite(options.limit) ? options.limit : 50,
      minScore: Number.isFinite(options.minScore) ? options.minScore : 0,
      colorScheme: options.colorScheme || "type",
      fixedColor: options.fixedColor,
      clickableBadges: !!options.clickableBadges
    };
    await sendContentRPC(tabId, payload, getFastTimeout("getInteractiveElements"));
  } catch (_) {}
}

async function updateOverlayForDebug(tabId) {
  try {
    if (!(await ensureContentScript(tabId))) return;
    await sendContentRPC(tabId, { type: MSG.DEBUG_UPDATE_OVERLAY }, getFastTimeout("getInteractiveElements"));
  } catch (_) {}
}

async function highlightSelectorForDebug(tabId, selector, label, color = "#ff9800", durationMs = 1200) {
  try {
    if (!selector) return;
    if (!(await ensureContentScript(tabId))) return;
    await sendContentRPC(tabId, { type: MSG.DEBUG_HIGHLIGHT_SELECTOR, selector, label, color, durationMs }, 1500);
  } catch (_) {}
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
      capabilities: {
        readOnly: false,
        requiresVisibleElement: false,
        requiresContentScript: false,
        framesSupport: "all",
        shadowDom: "none",
        navigation: { causesNavigation: true, waitsForLoad: true }
      },
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
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "same-origin",
        shadowDom: "partial",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
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
        const res = await sendContentRPC(tabId, { type: "GET_PAGE_LINKS", includeExternal, maxLinks });
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
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "same-origin",
        shadowDom: "partial",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
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
        const res = await sendContentRPC(tabId, { type: "READ_PAGE_CONTENT", maxChars });
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
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "same-origin",
        shadowDom: "partial",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.ANALYZE_PAGE_URLS });
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
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "same-origin",
        shadowDom: "partial",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.EXTRACT_STRUCTURED_CONTENT });
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
      capabilities: {
        readOnly: false,
        requiresVisibleElement: false,
        requiresContentScript: false,
        framesSupport: "none",
        shadowDom: "none",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
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
          sess.findings = Utils.deepMerge(sess.findings || {}, finding);
          emitAgentLog(tabId, { level: LOG_LEVELS.SUCCESS, msg: "Recorded finding to session (via ToolsRegistry)", finding });
          await SessionManager.saveSessionToStorage(tabId, sess);
          return { ok: true, observation: "Finding recorded" };
        } catch (e) {
          return { ok: false, observation: `Failed to record finding: ${String(e?.message || e)}` };
        }
      }
    });

    // DOM interaction tools leveraging content script + DOMAgent (when present)
    // clickElement
    globalThis.ToolsRegistry.registerTool({
      id: "clickElement",
      title: "Click Element",
      description: "Click an element specified by CSS selector.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 },
          elementIndex: { type: ["integer","number"] }
        }
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 200 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        
        const idx = Number(input?.elementIndex);
        const selector = input?.selector;
        
        // SMART LOGIC LAYER: Always refresh elements before interaction
        try {
          const elementData = await refreshElementsAndExecute(tabId, selector, idx, "click");
          
          // Strategy 1: If we have a specific element from refresh, use its current selector
          if (elementData.element) {
            const currentSelector = elementData.element.selector;
            const currentIndex = elementData.allElements.findIndex(el => el.selector === currentSelector) + 1;
            
            console.log(`[BG] Using refreshed element for click: selector=${currentSelector}, index=${currentIndex}`);
            
            // Try selector-based click first (more reliable than index)
            const selectorRes = await sendContentRPC(tabId, { type: MSG.CLICK_SELECTOR, selector: currentSelector }, getFastTimeout('clickElement'));
            if (selectorRes?.ok) {
              return { ok: true, observation: selectorRes.msg || "Clicked refreshed element" };
            }
            
            // Fallback to index-based clicking if selector failed
            if (currentIndex > 0) {
              console.log(`[BG] Selector click failed, trying index ${currentIndex}`);
              const res = await sendContentRPC(tabId, { type: "DEBUG_CLICK_INDEX", index: currentIndex }, getFastTimeout('clickElement'));
              if (res?.ok) {
                return { ok: true, observation: res.msg || `Clicked refreshed element at index ${currentIndex}` };
              }
            }
            
            console.log(`[BG] Both selector and index click failed for refreshed element`);
          }
          
          // Strategy 2: Try selector-based click if provided
          if (selector) {
            const res = await sendContentRPC(tabId, { type: MSG.CLICK_SELECTOR, selector: selector }, getFastTimeout('clickElement'));
            if (res?.ok) {
              return { ok: true, observation: res.msg || "Clicked" };
            }
            console.log(`[BG] Direct selector click failed: ${res?.error}`);
          }
          
          // Strategy 3: Try index-based click with overlay refresh
          if (Number.isFinite(idx) && idx > 0 && idx <= elementData.allElements.length) {
            // First ensure overlay is updated for reliable index mapping
            try {
              await sendContentRPC(tabId, { type: MSG.DEBUG_UPDATE_OVERLAY }, getFastTimeout('debugUpdate'));
            } catch (e) {
              console.warn(`[BG] Could not update overlay before click: ${e.message}`);
            }
            
            const res = await sendContentRPC(tabId, { type: "DEBUG_CLICK_INDEX", index: idx }, getFastTimeout('clickElement'));
            if (res?.ok) {
              return { ok: true, observation: res.msg || `Clicked index ${idx}` };
            }
            console.log(`[BG] Index click failed: ${res?.error}`);
          }
          
          // Enhanced error reporting with element context and better guidance
          const availableElements = elementData.allElements.slice(0, 10).map((el, i) => {
            const description = el.purpose || el.accessibleName || el.text || el.tagName || 'element';
            const shortDesc = String(description).slice(0, 50);
            const isClickable = el.tagName && ['A', 'BUTTON', 'INPUT'].includes(el.tagName.toUpperCase());
            const clickIcon = isClickable ? '👆' : '◦';
            return `${clickIcon} ${i+1}. ${shortDesc} (${el.selector})`;
          }).join('\n');
          
          return { 
            ok: false, 
            observation: `Click failed - please specify elementIndex (1-${elementData.allElements.length}) or valid selector. Available elements:\n${availableElements}\n\n💡 Tip: Use elementIndex like {"elementIndex": 1} to click the first element.` 
          };
        } catch (error) {
          return { ok: false, observation: `Element refresh failed: ${error.message}` };
        }
      }
    });

    // typeText
    globalThis.ToolsRegistry.registerTool({
      id: "typeText",
      title: "Type Text",
      description: "Type text into a form field specified by CSS selector.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 },
          elementIndex: { type: ["integer","number"] },
          text: { type: "string", maxLength: 8000 },
          label: { "type": "string", "maxLength": 500 }
        },
        required: ["text"]
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 200 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        
        const idx = Number(input?.elementIndex);
        const selector = input?.selector;
        const sess = agentSessions.get(tabId);
        const caps = sess?.contentScriptCaps || contentScriptCaps.get(tabId) || {};

        // SMART LOGIC LAYER: Always refresh elements before interaction
        try {
          const elementData = await refreshElementsAndExecute(tabId, selector, idx, "type");
          
          // If we have a specific element from refresh, use its current index/selector
          if (elementData.element) {
            const currentSelector = elementData.element.selector;
            const currentIndex = elementData.allElements.findIndex(el => el.selector === currentSelector) + 1;
            
            console.log(`[BG] Using refreshed element for typing: selector=${currentSelector}, index=${currentIndex}`);
            
            // Strategy: Prefer index-based fill if overlay is active and content script supports it
            if (caps.supportsIndexFill && currentIndex > 0) {
              try {
                const fillRes = await sendContentRPC(tabId, { type: MSG.DEBUG_FILL_INDEX, index: currentIndex, value: input.text }, getFastTimeout('typeText'));
                if (fillRes?.ok) {
                  return { ok: true, observation: fillRes.msg || `Filled refreshed element at index ${currentIndex}` };
                }
                const observation = fillRes?.error || "Typing by refreshed index failed";
                return { ok: false, observation, errorCode: fillRes?.errorCode };
              } catch (e) {
                const observation = e.message || "Typing by refreshed index failed";
                return { ok: false, observation, errorCode: e.errorCode };
              }
            } else {
              // Use selector-based approach with fresh selector
              const res = await sendContentRPC(tabId, { type: MSG.FILL_SELECTOR, selector: currentSelector, value: input.text }, getFastTimeout('typeText'));
              return res?.ok ? { ok: true, observation: res.msg || "Filled refreshed element" } : { ok: false, observation: res?.error || "Typing failed", errorCode: res?.errorCode };
            }
          }
          
          // Legacy strategy with refreshed context
          if (caps.supportsIndexFill && Number.isFinite(idx) && idx > 0 && idx <= elementData.allElements.length) {
            try {
              const fillRes = await sendContentRPC(tabId, { type: MSG.DEBUG_FILL_INDEX, index: idx, value: input.text }, getFastTimeout('typeText'));
              if (fillRes?.ok) {
                return { ok: true, observation: fillRes.msg || `Filled index ${idx}` };
              }
              const observation = fillRes?.error || "Typing by index failed";
              return { ok: false, observation, errorCode: fillRes?.errorCode };
            } catch (e) {
              const observation = e.message || "Typing by index failed";
              return { ok: false, observation, errorCode: e.errorCode };
            }
          }
        } catch (error) {
          console.error(`[BG] Element refresh failed for typeText:`, error);
          // Continue with legacy behavior as fallback
        }
      
        let sel = (input.selector || "").trim();

        // Use already refreshed elements for inference if no selector provided
        if (!sel) {
          const elements = elementData?.allElements || [];
          console.log(`[BG] Using already refreshed ${elements.length} elements for selector inference`);
          
          if (elements.length > 0) {
            let candidate = null;
            if (input.label) {
              const label = String(input.label).toLowerCase();
              candidate = elements.find(e => {
                const name = String(e.name || '').toLowerCase();
                const aria = String(e.ariaLabel || e.aria_label || '').toLowerCase();
                const lbl = String(e.label || e.labelText || e.nearbyLabel || '').toLowerCase();
                const ph = String(e.placeholder || '').toLowerCase();
                const id = String(e.id || '').toLowerCase();
                return (
                  (name && name.includes(label)) ||
                  (aria && aria.includes(label)) ||
                  (lbl && lbl.includes(label)) ||
                  (ph && ph.includes(label)) ||
                  (id && id.includes(label))
                );
              });
            }
            if (!candidate) {
              // Prefer visible text inputs or textareas (non-hidden)
              candidate = elements.find(e => {
                const tag = String(e.tag || e.tagName || '').toLowerCase();
                const role = String(e.role || '').toLowerCase();
                const inputType = String(e.inputType || e.type || '').toLowerCase();
                return (tag === 'input' || tag === 'textarea' || role === 'textbox') && inputType !== 'hidden';
              }) || elements.find(e => String(e.tag || e.tagName || '').toLowerCase() === 'input');
            }
            if (candidate) {
              sel = candidate.selector;
              emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: `Inferred selector from fresh elements: ${sel}` });
              highlightSelectorForDebug(tabId, sel, 'Inferred Type', '#4caf50', 1200);
            }
          }
        }

        // Preflight: ensure selector exists & is visible before attempting a selector-based fill.
        if (sel) {
          try {
            const check = await sendContentRPC(tabId, { type: MSG.CHECK_SELECTOR, selector: sel, visibleOnly: true }, getFastTimeout('checkSelector'));
            const found = !!(check && (check.exists === true || check.found === true || check.visible === true));
            if (!found) {
              // Give the page a brief chance to render then retry
              try { await sendContentRPC(tabId, { type: MSG.SETTLE }, getFastTimeout("settle")); } catch (_) {}
              const check2 = await sendContentRPC(tabId, { type: MSG.CHECK_SELECTOR, selector: sel, visibleOnly: true }, getFastTimeout('checkSelector'));
              const found2 = !!(check2 && (check2.exists === true || check2.found === true || check2.visible === true));
              if (!found2) {
                return { ok: false, observation: `Selector not found or not visible: ${sel}` };
              }
            }
          } catch (_) {
            // If CHECK failed, we'll attempt the fill directly below as a best-effort
          }
        } else {
            return { ok: false, observation: "No selector provided and could not infer one.", errorCode: "MISSING_SELECTOR" };
        }
      
        try {
          const res = await sendContentRPC(tabId, { type: MSG.FILL_SELECTOR, selector: sel, value: input.text }, getFastTimeout('typeText'));
          if (res?.ok) {
            return { ok: true, observation: res.msg || "Text entered" };
          }
          const observation = res?.error || "Typing failed";
          return { ok: false, observation, errorCode: res?.errorCode };
        } catch (e) {
          const observation = e.message || "Typing failed";
          return { ok: false, observation, errorCode: e.errorCode };
        }
      }
    });

    // waitForSelector
    globalThis.ToolsRegistry.registerTool({
      id: "waitForSelector",
      title: "Wait For Selector",
      description: "Wait until a selector appears (visible by default).",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 },
          timeoutMs: { type: ["integer", "number"] }
        },
        required: ["selector"]
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const defaultTimeout = FAST_MODE_BG ? 2000 : 5000;
        const timeoutMs = Number(input?.timeoutMs || defaultTimeout);
        const res = await sendContentRPC(tabId, { type: MSG.WAIT_FOR_SELECTOR, selector: input.selector, timeoutMs }, timeoutMs);
        return res?.ok ? { ok: true, observation: res.msg || "Selector found" } : { ok: false, observation: res?.error || "Wait failed" };
      }
    });

    // checkSelector (instant existence/visibility check; no waiting)
// settle (double rAF yield)
globalThis.ToolsRegistry.registerTool({
  id: "settle",
  title: "Settle (yield two frames)",
  description: "Waits for two requestAnimationFrame cycles to let the DOM settle.",
  capabilities: {
    readOnly: true,
    requiresVisibleElement: false,
    requiresContentScript: true,
    framesSupport: "all",
    shadowDom: "full",
    navigation: { causesNavigation: false, waitsForLoad: false }
  },
  inputSchema: { type: "object", properties: {} },
  retryPolicy: { maxAttempts: 1 },
  run: async (ctx) => {
    const tabId = ctx?.tabId;
    if (!(await ctx.ensureContentScript(tabId))) {
      return { ok: false, observation: "Content script unavailable" };
    }
    // Use Fast Mode-aware timeout without relying on a global flag
    let timeoutMs = 2500;
    try {
      const o = await chrome.storage.local.get("FAST_MODE");
      const fm = !!o?.FAST_MODE;
      timeoutMs = fm ? 1200 : 2500;
    } catch (_) {}
    const res = await sendContentRPC(tabId, { type: MSG.SETTLE }, timeoutMs);
    if (res?.ok) {
      return { ok: true, observation: "Settled DOM (2 frames)" };
    }
    return { ok: false, observation: res?.error || "Settle failed" };
  }
});
    globalThis.ToolsRegistry.registerTool({
      id: "checkSelector",
      title: "Check Selector",
      description: "Check if a selector exists (and optionally visible) without waiting.",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 },
          visibleOnly: { type: "boolean" }
        },
        required: ["selector"]
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.CHECK_SELECTOR, selector: input.selector, visibleOnly: input.visibleOnly !== false }, getFastTimeout('checkSelector'));
        if (res?.ok) {
          return { ok: true, observation: res.msg || (res.visible ? "Selector visible" : "Selector present"), found: res.exists ?? res.found, visible: res.visible === true };
        }
        return { ok: false, observation: res?.error || "Check selector failed" };
      }
    });

    // clickAndWait (composite) - uses checkSelector and URL change monitoring
    globalThis.ToolsRegistry.registerTool({
      id: "clickAndWait",
      title: "Click And Wait",
      description: "Click a selector and wait for a condition (selector appear/disappear or URL change).",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: true }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 },
          waitFor: {
            type: "object",
            properties: {
              selector: { type: "string", maxLength: 2000 },
              disappear: { type: "boolean" },
              urlChange: { type: "boolean" },
              timeoutMs: { type: ["integer", "number"] }
            }
          }
        },
        required: ["selector"]
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }

        // Pre-capture URL if urlChange is requested
        let initialUrl = null;
        const wantsUrlChange = !!(input?.waitFor && input.waitFor.urlChange);
        if (wantsUrlChange) {
          try { const t = await chrome.tabs.get(tabId); initialUrl = t?.url || null; } catch (_) {}
        }

        // Click first
        const clickRes = await sendContentRPC(tabId, { type: MSG.CLICK_SELECTOR, selector: input.selector });
        if (!clickRes?.ok) {
          return { ok: false, observation: clickRes?.error || "Click failed" };
        }

        // Determine waiting condition
        const wf = input?.waitFor || {};
        const defaultTimeout = FAST_MODE_BG ? 2500 : 6000;
        const timeoutAt = Date.now() + Number(wf.timeoutMs || defaultTimeout);
        const pollInterval = FAST_MODE_BG ? 75 : 150;

        async function checkCondition() {
          // URL change condition
          if (wantsUrlChange) {
            try {
              const t = await chrome.tabs.get(tabId);
              if (initialUrl && t?.url && t.url !== initialUrl) {
                return { ok: true, observation: "URL changed after click" };
              }
            } catch (_) {}
          }

          // Selector appear/disappear
          if (typeof wf.selector === 'string' && wf.selector) {
            const res = await sendContentRPC(tabId, { type: MSG.CHECK_SELECTOR, selector: wf.selector, visibleOnly: true }).catch(() => null);
            const foundVisible = !!(res && (res.visible || res.found));
            if (wf.disappear === true) {
              if (!foundVisible) return { ok: true, observation: `Wait condition met: selector disappeared (${wf.selector})` };
            } else {
              if (foundVisible) return { ok: true, observation: `Wait condition met: selector appeared (${wf.selector})` };
            }
          }

          // Timeout?
          if (Date.now() > timeoutAt) {
            return { ok: false, observation: "clickAndWait timeout" };
          }
          return null;
        }

        // Poll condition
        while (true) {
          const cond = await checkCondition();
          if (cond) {
            return { ok: cond.ok !== false, observation: cond.observation };
          }
          await new Promise(r => setTimeout(r, pollInterval));
        }
      }
    });

    // scrollTo
    globalThis.ToolsRegistry.registerTool({
      id: "scrollTo",
      title: "Scroll To",
      description: "Scroll the page by direction or to a specific element.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 },
          direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
          amountPx: { type: ["integer", "number"] }
        }
      },
      // Validate at runtime that either selector or direction is provided
      preconditions: async (_ctx, input) => {
        if (!input?.selector && !input?.direction) {
          return { ok: false, observation: "Provide either 'selector' or 'direction' for scrollTo" };
        }
        return { ok: true };
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const amountPx = Number(input?.amountPx || 600);
        const res = await sendContentRPC(tabId, { type: MSG.SCROLL_TO_SELECTOR, selector: input.selector || "", direction: input.direction || "", amountPx }, getFastTimeout('scrollTo'));
        return res?.ok ? { ok: true, observation: res.msg || "Scrolled" } : { ok: false, observation: res?.error || "Scroll failed" };
      }
    });

    // scrapeSelector
    globalThis.ToolsRegistry.registerTool({
      id: "scrapeSelector",
      title: "Scrape Selector",
      description: "Scrape elements matching a selector into structured data.",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000 }
        },
        required: ["selector"]
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.SCRAPE_SELECTOR, selector: input.selector });
        if (res?.ok) {
          const observationText = `Scraped ${res.data?.length || 0} items.`;
          return { ok: true, observation: observationText, data: res.data };
        }
        return { ok: false, observation: res?.error || "Scrape failed" };
      }
    });

    // getInteractiveElements
    globalThis.ToolsRegistry.registerTool({
      id: "getInteractiveElements",
      title: "Get Interactive Elements",
      description: "List visible interactive elements (buttons, links, inputs).",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }

        // First attempt
        let res = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
        let elements = (res?.ok && (res.elements || (res.map && res.map.elements))) ? (res.elements || res.map.elements) : [];

        if (Array.isArray(elements) && elements.length > 0) {
          return { ok: true, observation: `Found ${elements.length} interactive elements`, data: elements };
        }

        // Settle two frames and retry to wait for SPA render
        try { await sendContentRPC(tabId, { type: MSG.SETTLE }, getFastTimeout("settle")); } catch (_) {}
        res = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
        elements = (res?.ok && (res.elements || (res.map && res.map.elements))) ? (res.elements || res.map.elements) : [];

        if (Array.isArray(elements) && elements.length > 0) {
          return { ok: true, observation: `Found ${elements.length} interactive elements (after settle)`, data: elements };
        }

        // Last fallback: capture page text so the planner isn't blind
        try {
          const textRes = await sendContentRPC(tabId, { type: "READ_PAGE_CONTENT", maxChars: 12000 }, getFastTimeout('readPageContent'));
          if (textRes?.ok && typeof textRes.text === "string") {
            return { ok: true, observation: `No interactive elements found; captured page text (${textRes.text.length} chars)`, data: [], pageContent: textRes.text };
          }
        } catch (_) {}

        // Return empty data rather than failing hard to enable planner fallback paths
        const obs = res?.error ? `Failed to get interactive elements: ${res.error}` : "No interactive elements found";
        return { ok: true, observation: obs, data: [] };
      }
    });

    // Debug overlay tools
    globalThis.ToolsRegistry.registerTool({
      id: "debugShowOverlay",
      title: "Debug: Show Overlay",
      description: "Render numbered borders and labels over interactive elements.",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: ["integer","number"] },
          minScore: { type: ["integer","number"] },
          colorScheme: { type: "string", enum: ["type","score","fixed"] },
          fixedColor: { type: "string" },
          clickableBadges: { type: "boolean" }
        }
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const payload = {
          type: MSG.DEBUG_SHOW_OVERLAY,
          limit: Number.isFinite(input?.limit) ? input.limit : 50,
          minScore: Number.isFinite(input?.minScore) ? input.minScore : 0,
          colorScheme: input?.colorScheme || "type",
          fixedColor: input?.fixedColor,
          clickableBadges: !!input?.clickableBadges
        };
        const res = await sendContentRPC(tabId, payload, getFastTimeout("getInteractiveElements"));
        return res?.ok ? { ok: true, observation: "Overlay shown" } : { ok: false, observation: res?.error || "Failed to show overlay" };
      }
    });

    globalThis.ToolsRegistry.registerTool({
      id: "debugHideOverlay",
      title: "Debug: Hide Overlay",
      description: "Remove the debug overlay from the page.",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.DEBUG_HIDE_OVERLAY }, getFastTimeout("getInteractiveElements"));
        return res?.ok ? { ok: true, observation: "Overlay hidden" } : { ok: false, observation: res?.error || "Failed to hide overlay" };
      }
    });

    globalThis.ToolsRegistry.registerTool({
      id: "debugUpdateOverlay",
      title: "Debug: Update Overlay",
      description: "Recompute and refresh overlay positions.",
      capabilities: {
        readOnly: true,
        requiresVisibleElement: false,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: { type: "object", properties: {} },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.DEBUG_UPDATE_OVERLAY }, getFastTimeout("getInteractiveElements"));
        return res?.ok ? { ok: true, observation: "Overlay updated" } : { ok: false, observation: res?.error || "Failed to update overlay" };
      }
    });

    globalThis.ToolsRegistry.registerTool({
      id: "debugClickIndex",
      title: "Debug: Click Indexed Element",
      description: "Click an element by its overlay index number.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          index: { type: ["integer","number"] }
        },
        required: ["index"]
      },
      retryPolicy: { maxAttempts: 1 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }
        const res = await sendContentRPC(tabId, { type: MSG.DEBUG_CLICK_INDEX, index: Number(input.index) }, getFastTimeout("clickElement"));
        return res?.ok ? { ok: true, observation: res?.msg || `Clicked index ${input.index}` } : { ok: false, observation: res?.error || "Click by index failed" };
      }
    });

    /* ---------- Advanced Interaction Tools ---------- */

    // uploadFile - Handle file input elements
    globalThis.ToolsRegistry.registerTool({
      id: "uploadFile",
      title: "Upload File",
      description: "Upload a file to a file input element. Creates a temporary file for upload testing.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000, description: "CSS selector for file input element" },
          fileName: { type: "string", description: "Name for the test file (optional)" },
          fileContent: { type: "string", description: "Content for the test file (optional)" },
          fileType: { type: "string", description: "MIME type (optional, default: text/plain)" }
        },
        required: ["selector"]
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 300 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }

        const fileName = input.fileName || 'test-upload.txt';
        const fileContent = input.fileContent || 'This is a test file for automation purposes.';
        const fileType = input.fileType || 'text/plain';

        try {
          // Create a data URL for the file
          const dataUrl = `data:${fileType};base64,${btoa(fileContent)}`;
          
          const res = await sendContentRPC(tabId, { 
            type: "UPLOAD_FILE", 
            selector: input.selector,
            fileName: fileName,
            dataUrl: dataUrl,
            fileType: fileType
          }, getFastTimeout('uploadFile'));
          
          return res?.ok ? 
            { ok: true, observation: res.msg || `File uploaded: ${fileName}` } : 
            { ok: false, observation: res?.error || "File upload failed" };
        } catch (error) {
          return { ok: false, observation: `Upload error: ${error.message}` };
        }
      }
    });

    // fillForm - Complete multi-step forms intelligently
    globalThis.ToolsRegistry.registerTool({
      id: "fillForm",
      title: "Fill Form",
      description: "Intelligently fill out complex forms with multiple fields and sections.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all", 
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          formData: { 
            type: "object", 
            description: "Form data as key-value pairs (field name/label -> value)" 
          },
          formSelector: { 
            type: "string", 
            description: "CSS selector for the form container (optional)" 
          },
          submitAfter: { 
            type: "boolean", 
            description: "Whether to submit the form after filling (default: false)" 
          }
        },
        required: ["formData"]
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 500 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }

        try {
          const res = await sendContentRPC(tabId, { 
            type: "FILL_FORM", 
            formData: input.formData,
            formSelector: input.formSelector,
            submitAfter: input.submitAfter || false
          }, 10000); // Longer timeout for complex forms
          
          return res?.ok ? 
            { ok: true, observation: res.msg || `Form filled with ${Object.keys(input.formData).length} fields` } : 
            { ok: false, observation: res?.error || "Form filling failed" };
        } catch (error) {
          return { ok: false, observation: `Form filling error: ${error.message}` };
        }
      }
    });

    // selectOption - Enhanced dropdown/select handling
    globalThis.ToolsRegistry.registerTool({
      id: "selectOption",
      title: "Select Option",
      description: "Select an option from dropdowns, multi-selects, or custom select components.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full", 
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", maxLength: 2000, description: "CSS selector for select element" },
          optionValue: { type: "string", description: "Value attribute of option to select" },
          optionText: { type: "string", description: "Display text of option to select" },
          optionIndex: { type: ["integer","number"], description: "Zero-based index of option" }
        },
        required: ["selector"]
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 300 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }

        const res = await sendContentRPC(tabId, { 
          type: "SELECT_OPTION", 
          selector: input.selector,
          optionValue: input.optionValue,
          optionText: input.optionText,
          optionIndex: input.optionIndex
        }, getFastTimeout('selectOption'));
        
        return res?.ok ? 
          { ok: true, observation: res.msg || "Option selected" } : 
          { ok: false, observation: res?.error || "Option selection failed" };
      }
    });

    // dragAndDrop - Handle drag and drop interactions
    globalThis.ToolsRegistry.registerTool({
      id: "dragAndDrop",
      title: "Drag and Drop",
      description: "Perform drag and drop operations between elements.",
      capabilities: {
        readOnly: false,
        requiresVisibleElement: true,
        requiresContentScript: true,
        framesSupport: "all",
        shadowDom: "full",
        navigation: { causesNavigation: false, waitsForLoad: false }
      },
      inputSchema: {
        type: "object",
        properties: {
          sourceSelector: { type: "string", maxLength: 2000, description: "CSS selector for element to drag" },
          targetSelector: { type: "string", maxLength: 2000, description: "CSS selector for drop target" },
          offsetX: { type: ["integer","number"], description: "X offset for drop position" },
          offsetY: { type: ["integer","number"], description: "Y offset for drop position" }
        },
        required: ["sourceSelector", "targetSelector"]
      },
      retryPolicy: { maxAttempts: 2, backoffMs: 400 },
      run: async (ctx, input) => {
        const tabId = ctx?.tabId;
        if (!(await ctx.ensureContentScript(tabId))) {
          return { ok: false, observation: "Content script unavailable" };
        }

        const res = await sendContentRPC(tabId, { 
          type: "DRAG_AND_DROP", 
          sourceSelector: input.sourceSelector,
          targetSelector: input.targetSelector,
          offsetX: input.offsetX || 0,
          offsetY: input.offsetY || 0
        }, getFastTimeout('dragDrop'));
        
        return res?.ok ? 
          { ok: true, observation: res.msg || "Drag and drop completed" } : 
          { ok: false, observation: res?.error || "Drag and drop failed" };
      }
    });

    console.log("[BG] Advanced tools registered: uploadFile, fillForm, selectOption, dragAndDrop");
    console.log("[BG] Core tools registered: navigateToUrl, extractLinks, readPageContent, analyzeUrls, extractStructuredContent, recordFinding, clickElement, typeText, waitForSelector, scrollTo, scrapeSelector, getInteractiveElements, debugShowOverlay, debugHideOverlay, debugUpdateOverlay, debugClickIndex");
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

  // Resolve capabilities for observability
  let capabilities = null;
  try {
    capabilities = globalThis.ToolsRegistry?.getCapabilities?.(toolId) || null;
  } catch (_) {}

  // Console summary for start
  try { log?.info?.("tool_started", { input: sanitizeForLog(input), capabilities }); } catch (_) {}

  // Emit tool_started
  try {
    if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolStarted === "function") {
      await globalThis.AgentObserver.emitToolStarted(tabId, toolId, {
        ...(input || {}),
        __meta: { capabilities }
      });
    }
  } catch (_) {}

  try {
    const ctx = {
      tabId,
      ensureContentScript,
      chrome
    };
    const result = await globalThis.ToolsRegistry.runTool(toolId, ctx, input || {});

    // Emit tool_result (include capabilities)
    try {
      if (globalThis.AgentObserver && typeof globalThis.AgentObserver.emitToolResult === "function") {
        await globalThis.AgentObserver.emitToolResult(tabId, toolId, {
          ...result,
          durationMs: result?.durationMs ?? Math.max(0, Date.now() - startedAt),
          capabilities
        });
      }
    } catch (_) {}

    // Console summary for result (avoid huge payloads)
    try {
      const summary = {
        ok: result?.ok !== false,
        status: result?.status,
        observation: (result?.observation || "").slice(0, 200),
        durationMs: result?.durationMs ?? Math.max(0, Date.now() - startedAt),
        capabilities
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
          errors: [String(e?.message || e)],
          capabilities
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
    "tabs.close": "close_tab",

    // CamelCase aliases → canonical snake-case for legacy handlers
    navigateToUrl: "goto_url",
    clickElement: "click_element",
    typeText: "type_text",
    scrollTo: "scroll_to",
    readPageContent: "read_page_content",
    extractStructuredContent: "extract_structured_content",
    analyzeUrls: "analyze_urls",
    extractLinks: "get_page_links",
    scrapeSelector: "scrape",
    getInteractiveElements: "get_interactive_elements",
    recordFinding: "record_finding",
    generateReport: "generate_report"
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
      const result = await globalThis.navigateTo(url);
      return { ok: result.ok, observation: result.ok ? `Navigated to ${url}` : result.error };
    }
    case "click_element": {
      const selector = normalizedParams.selector || "";
      const result = await globalThis.click(tabId, selector);
      return { ok: result.ok, observation: result.ok ? `Clicked element: ${selector}` : result.error };
    }
    case "type_text": {
      const selector = normalizedParams.selector || "";
      const text = normalizedParams.text ?? "";
      const result = await globalThis.type(tabId, selector, text);
      return { ok: result.ok, observation: result.ok ? `Typed text into element: ${selector}` : result.error };
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
      const res = await sendContentRPC(tabId, { type: "SCROLL_TO_SELECTOR", selector: normalizedParams.selector || "", direction: normalizedParams.direction || "" });
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
      const res = await sendContentRPC(tabId, { type: "WAIT_FOR_SELECTOR", selector: normalizedParams.selector || "", timeoutMs: normalizedParams.timeoutMs || 5000 });
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
      // Heuristic: if taskType is AUTOMATION, auto-mark minimal success when recent actions show real UI work
      try {
        const schemaKey = (sess?.taskContext?.taskType || '').toLowerCase();
        if (schemaKey === 'automation') {
          // Ensure an automation schema exists on the session even if the global registry lacks it
          const automationSchema = (globalThis.SUCCESS_CRITERIA_SCHEMAS && globalThis.SUCCESS_CRITERIA_SCHEMAS.automation) || {
            type: "object",
            properties: {
              completed: { type: "boolean" },
              steps: { type: "array", items: { type: "string" } },
              summary: { type: "string" }
            },
            required: ["completed"]
          };
          if (!sess.successCriteria || sess.successCriteria === globalThis.SUCCESS_CRITERIA_SCHEMAS?.default) {
            sess.successCriteria = automationSchema;
          }

          // If not marked yet, infer completion from recent concrete actions
          const recent = Array.isArray(sess.history) ? sess.history.slice(-8) : [];
          const hasTyped = recent.some(h => ['type_text', 'typeText', 'fill'].includes(h?.action?.tool));
          const hasClicked = recent.some(h => ['click_element', 'click', 'clickElement'].includes(h?.action?.tool));
          if (hasTyped && hasClicked) {
            const steps = recent.map(h => `${h?.action?.tool || 'action'} -> ${(h?.observation || '').slice(0, 120)}`);
            const pageInfo = await getPageInfoForPlanning(tabId).catch(() => ({}));
            const summary = `Automation completed on ${pageInfo?.url || 'current page'} with ${steps.length} recent steps.`;
            sess.findings = Utils.deepMerge(sess.findings || {}, { automation: { completed: true, steps, summary } });
            emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "Heuristically marked automation as completed", stepCount: steps.length, url: pageInfo?.url });
            await SessionManager.saveSessionToStorage(tabId, sess);
          }
        }
      } catch (_) {}

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
        safeRuntimeSendMessage({
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
      const res = await sendContentRPC(tabId, { type: "ANALYZE_PAGE_URLS" });
      
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
      const res = await sendContentRPC(tabId, { type: "GET_PAGE_LINKS", includeExternal, maxLinks });
      return res?.ok ? { ok: true, observation: `Found ${res.links?.length || 0} relevant links`, links: res.links } : { ok: false, observation: res?.error || "Link extraction failed" };
    }
    case "read_page_content": {
      if (!(await ensureContentScript(tabId))) {
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await sendContentRPC(tabId, { type: "READ_PAGE_CONTENT", maxChars: 15000 });
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
        const res = await sendContentRPC(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
        // Handle new structured content format
        if (res?.ok && res.content) {
            const { source, data, ...rest } = res.content;
            let findingToRecord = source === 'json-ld' ? data : rest;

            // If data from JSON-LD is an array, merge each item
            if (Array.isArray(findingToRecord)) {
                findingToRecord.forEach(item => {
                    sess.findings = Utils.deepMerge(sess.findings, item);
                });
            } else {
                sess.findings = Utils.deepMerge(sess.findings, findingToRecord);
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
        sess.findings = Utils.deepMerge(sess.findings, findingToRecord);
        
        emitAgentLog(tabId, {
            level: LOG_LEVELS.SUCCESS,
            msg: "Recorded finding to session",
            finding: findingToRecord
          });
        
        // Send a dedicated message to the chat to make the finding visible
        safeRuntimeSendMessage({
          type: MSG.AGENT_FINDING,
          tabId: tabId,
          finding: findingToRecord,
          timestamp: Date.now()
        });

        // Persist session after recording a finding
        SessionManager.saveSessionToStorage(tabId, sess);
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
        const res = await sendContentRPC(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
        if (res?.ok) {
          content = res.content;
        }
      }
      
      // If depth is less than maxDepth, analyze URLs for deeper research
      let deeperUrls = [];
      if (depth < maxDepth && content) {
        const urlAnalysis = await sendContentRPC(tabId, { type: "ANALYZE_PAGE_URLS" });
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
      const urlAnalysis = await sendContentRPC(tabId, { type: "ANALYZE_PAGE_URLS" });
      if (!urlAnalysis?.ok) {
        return { ok: false, observation: "Failed to analyze page URLs" };
      }
      
      // Get current page content quality
      const contentRes = await sendContentRPC(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
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
   case 'recordFinding':
     payload = {
       tool,
       data: params.finding,
     };
     break;
   case 'read_page_content':
   case 'readPageContent':
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
   case 'navigateToUrl':
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
   case 'click_element':
   case 'clickElement':
   case 'click': {
     payload = {
       tool,
       data: {
         selector: params.selector || null,
         elementIndex: Number.isFinite(params.elementIndex) ? params.elementIndex : null
       }
     };
     break;
   }
   case 'type_text':
   case 'typeText':
   case 'fill': {
     const textPreview = typeof params.text === 'string' ? params.text.slice(0, 100) : '';
     payload = {
       tool,
       data: {
         selector: params.selector || null,
         elementIndex: Number.isFinite(params.elementIndex) ? params.elementIndex : null,
         textPreview
       }
     };
     break;
   }
 }

  if (payload) {
    safeRuntimeSendMessage({
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
  try { await chrome.storage.local.set({ LAST_PLANNER_USED: "legacy" }); } catch (_) {}
  // Auto-enable debug overlay visualization for this tab (best-effort)
  try { await showOverlayForDebug(tabId, { limit: 50, colorScheme: "type", clickableBadges: false }); } catch (_) {}
  try {
    const { PLANNER_STATS } = await chrome.storage.local.get("PLANNER_STATS");
    const s = PLANNER_STATS || {};
    const next = {
      react: Number(s?.react || 0),
      linear: Number(s?.linear || 0),
      legacy: Number(s?.legacy || 0) + 1
    };
    await chrome.storage.local.set({ PLANNER_STATS: next });
  } catch (_) {}

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

// Send agent status updates to the sidepanel
function emitAgentStatus(tabId, message) {
  try {
    const sess = agentSessions.get(tabId);
    if (!sess) return;

    safeRuntimeSendMessage({
      type: MSG.AGENT_STATUS_UPDATE,
      tabId,
      message,
      step: sess.step ?? 0,
      timestamp: Date.now()
    });
  } catch (e) {
    // Ignore errors if the sidepanel is not open
  }
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
  // Determine verbosity based on task complexity and progress
  const isSimpleTask = sess.subTaskStep > 2 && sess.consecutiveFailures === 0;
  const verbosity = isSimpleTask ? 'low' : 'high';

  switch (taskType) {
    case 'RESEARCH':
      reasoningPrompt = buildResearchAgentPrompt(goal, currentSubTask, contextData, verbosity);
      break;
    case 'YOUTUBE':
      reasoningPrompt = buildYouTubeActionPrompt(goal, contextData, verbosity);
      break;
    case 'NAVIGATION':
      reasoningPrompt = buildNavigationActionPrompt(goal, contextData, verbosity);
      break;
    default:
      reasoningPrompt = buildAgentPlanPrompt(goal, currentSubTask, contextData, verbosity);
  }
  
  emitAgentStatus(tabId, "🤔 Thinking...");
  const modelResponse = await callModelWithRotation(reasoningPrompt, { model: sess.selectedModel, tabId, verbosity });

  // 3. Parse and Validate Action
  emitAgentStatus(tabId, "📝 Parsing action...");
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
    if (!sess.doneGuardUsed) {
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
      sess.doneGuardUsed = true;
    } else {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.WARN,
        msg: "Accepting 'done' despite empty findings (second attempt)."
      });
    }
  }

  // Optimization: If the agent wants to read the page but we already have interactive elements,
  // skip the read and use the elements, as this is faster and provides enough context.
  try {
    const isReadAction = action.tool === 'read_page_content' || action.tool === 'readPageContent';
    // Element caching removed - always refresh elements for reliability
    const hasInteractiveElements = false; // Force fresh element queries

    if (isReadAction && hasInteractiveElements) {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.INFO,
        msg: "Skipping redundant read_page_content; using existing interactive elements for planning.",
        originalTool: action.tool
      });
      // By returning early from this execution, we effectively skip the action
      // and allow the loop to continue to the next planning stage with existing context.
      // This is a temporary solution. A better approach would be to replace the action
      // with a no-op or 'think' action.
      // For now, we will just proceed to the next loop iteration.
      agenticLoop(tabId, goal, settings);
      return;
    } else if (isReadAction) {
      emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "Proceeding with read_page_content as no interactive elements are cached." });
    }
  } catch (_) {}

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
    const { success, errors } = checkSuccessCriteria(sess, tabId);
    if (success) {
      emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: `Sub-task "${currentSubTask}" completed.` });
      sess.currentTaskIndex++;
      sess.subTaskStep = 0; // Reset sub-task step counter
      sess.noProgressCounter = 0; // Reset no-progress counter
      // Send a step update to the sidepanel
      safeRuntimeSendMessage({
        type: MSG.AGENT_STEP_UPDATE,
        tabId: tabId,
        currentTaskIndex: sess.currentTaskIndex
      });
    } else {
      emitAgentLog(tabId, { level: LOG_LEVELS.WARN, msg: "Done requested but success criteria not met. Not advancing.", errors });
    }
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
    const jsonResult = Utils.extractJSONWithRetry(responseText, 'model response');
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

        const elementsExtract = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
        if (elementsExtract?.ok) {
          interactiveElements = elementsExtract.elements || (elementsExtract.map && elementsExtract.map.elements) || [];
        }
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
    safeRuntimeSendMessage({
      type: MSG.SHOW_REPORT,
      tabId: tabId,
      report: reportRes.text,
      format: 'markdown'
    });
  } else {
    // Fallback message if report generation fails
    safeRuntimeSendMessage({
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
  await SessionManager.cleanupOldSessions();
  // Initialize enhanced features
  initializeEnhancedFeatures();
  
  // Attempt to restore any active sessions
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        await SessionManager.restoreSessionFromStorage(tab.id);
      }
    }
  } catch (e) {
    console.warn("[BG] Failed to restore sessions on startup:", e);
  }
});

// Service worker registration is handled by the manifest.json in MV3
// No need to manually register service workers in background scripts

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[BG] Installed");
  // Initialize API key manager
  await apiKeyManager.initialize();
  // Clean up old sessions on install
  await SessionManager.cleanupOldSessions();
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
          const restoredSession = await SessionManager.restoreSessionFromStorage(tab.id);
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
          const newSession = SessionManager.initializeNewSession(tab.id, goal, subTasks, settings, GEMINI_MODEL || "gemini-2.5-flash", taskContext);
          SessionManager.setSession(tab.id, newSession);
          
          // Persist new session
          await SessionManager.saveSessionToStorage(tab.id, newSession);
          
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
  const { EXPERIMENTAL_GRAPH_MODE, REACT_PLANNER_MODE } = await chrome.storage.local.get(["EXPERIMENTAL_GRAPH_MODE", "REACT_PLANNER_MODE"]);
  if (globalThis.TaskGraphEngine && EXPERIMENTAL_GRAPH_MODE) {
    // Default REACT_PLANNER_MODE to true when Graph Mode is enabled (unless explicitly set to false)
    const reactPlannerEnabled = (typeof REACT_PLANNER_MODE === "boolean") ? REACT_PLANNER_MODE : true;
    const hasReactPlanner = !!(globalThis.ReActPlanner && typeof globalThis.ReActPlanner.plan === "function");

    let graph = null;
    let plannerKind = "linear";

    // Try ReAct planner first if enabled and available
    try {
      if (reactPlannerEnabled && hasReactPlanner) {
        plannerKind = "react";
        const planningContext = await gatherContextForReasoning(tab.id, newSession).catch(() => ({}));
        const planRes = await globalThis.ReActPlanner.plan(
          newSession.goal,
          planningContext,
          { model: newSession.selectedModel, tabId: tab.id, requestId: newSession.requestId, maxChars: 15000 }
        );
        if (planRes?.ok && planRes.graph) {
          graph = planRes.graph;
          // Minimal end-to-end validation telemetry for the ReAct planner
          try {
            emitAgentLog(tab.id, {
              level: LOG_LEVELS.INFO,
              msg: "ReAct plan generated",
              planner: plannerKind,
              nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : undefined,
              rawBytes: typeof planRes.raw === "string" ? planRes.raw.length : undefined
            });
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn("[BG] ReAct planner failed, falling back to linear graph:", e);
      plannerKind = "linear";
      graph = null;
    }

    // Fallback to linear graph if ReAct graph not built
    if (!graph) {
      graph = globalThis.TaskGraphEngine.createLinearGraphFromSubTasks(
        newSession.subTasks,
        { requestId: newSession.requestId, goal: newSession.goal },
        { maxChars: 15000 }
      );
    }

    // Telemetry: which planner path we are using
    try {
      emitAgentLog(tab.id, {
        level: LOG_LEVELS.INFO,
        msg: "Graph mode starting",
        planner: plannerKind,
        reactPlannerEnabled,
        hasReactPlanner,
        nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : undefined
      });
    } catch (_) {}
    try { await chrome.storage.local.set({ LAST_PLANNER_USED: plannerKind }); } catch (_) {}
    try {
      const { PLANNER_STATS } = await chrome.storage.local.get("PLANNER_STATS");
      const s = PLANNER_STATS || {};
      const next = {
        react: Number(s?.react || 0) + (plannerKind === "react" ? 1 : 0),
        linear: Number(s?.linear || 0) + (plannerKind === "linear" ? 1 : 0),
        legacy: Number(s?.legacy || 0)
      };
      await chrome.storage.local.set({ PLANNER_STATS: next });
    } catch (_) {}

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
          safeRuntimeSendMessage({
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
            sess = await SessionManager.restoreSessionFromStorage(tab.id);
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
                files: ["common/messages.js", "content/dom-agent.js", "content/content.js"]
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
              safeRuntimeSendMessage({
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
                files: ["common/messages.js", "content/dom-agent.js", "content/content.js"]
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

          const extracted = Utils.extractJSONWithRetry(modelRes.text, 'coordinator response');
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
              const newSession = SessionManager.initializeNewSession(tab.id, agentGoal, [agentGoal], agentSettings, selectedModel, { taskType: 'AUTOMATION' });
              SessionManager.setSession(tab.id, newSession);
              await SessionManager.saveSessionToStorage(tab.id, newSession);
              runAgentLoop(tab.id, agentGoal, agentSettings).catch(e => console.error("[BG] Agent loop error:", e));
              
              sendResponse({ ok: true, agentStarted: true, goal: agentGoal });
              break;
            default:
              sendResponse({ ok: false, error: `Unknown tool from coordinator: ${tool}` });
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
      const jsonResult = Utils.extractJSONWithRetry(classificationRes.text, 'task classification');
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
      const jsonResult = Utils.extractJSONWithRetry(decompRes.text, 'task decomposition');
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
  const jsonResult = Utils.extractJSONWithRetry(responseText, 'planning response');

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
  if (!valid && (action.tool === 'record_finding' || action.tool === 'recordFinding')) {
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
      interactiveElements: [], // Elements removed from cache - will be fetched fresh when needed
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

/**
* Smart wait after navigation to reduce "perception timing" issues.
* Strategy:
* 1) Poll chrome.tabs.get(tabId).status until 'complete' or timeout (FAST_MODE aware)
* 2) Ensure content script and yield two rAF frames via SETTLE (best-effort)
* Never throws; logs are minimal and best-effort.
*/
async function waitForPageInteractive(tabId, options = {}) {
  const start = Date.now();
  const isClickTriggered = options.trigger === 'clickElement' || options.trigger === 'click';
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : (FAST_MODE_BG ? (isClickTriggered ? 3000 : 1500) : (isClickTriggered ? 7000 : 4000));
  const pollInterval = FAST_MODE_BG ? 150 : 250;

  try {
    // 1. Wait for the tab status to be 'complete'
    while (Date.now() - start < maxMs) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t?.status === 'complete') break;
      } catch (e) {
        // Tab may not exist yet, continue polling
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // 2. Ensure content script is available
    if (!(await ensureContentScript(tabId))) {
      emitAgentLog(tabId, { level: LOG_LEVELS.WARN, msg: "waitForPageInteractive: Content script not available after load." });
      return;
    }
    
    // 3. Actively poll for interactive elements to appear, confirming SPA render
    let elementsFound = 0;
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;
    
    while (Date.now() - start < maxMs) {
      try {
        const res = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
        const elements = (res?.ok && (res.elements || (res.map && res.map.elements))) ? (res.elements || res.map.elements) : [];
        
        if (Array.isArray(elements) && elements.length > 0) {
          elementsFound = elements.length;
          consecutiveFailures = 0; // Reset failure count
          
          // Cache the elements to avoid redundant fetches in refreshElementsAndExecute
          elementFetchCache.set(tabId, {
            timestamp: Date.now(),
            elements: elements
          });
          
          console.log(`[BG] waitForPageInteractive found ${elementsFound} elements after ${Date.now() - start}ms`);
          break; // Elements found, page is interactive
        } else {
          consecutiveFailures++;
          // If we've had multiple consecutive failures but still have time, try waiting a bit longer
          if (consecutiveFailures >= maxConsecutiveFailures && (Date.now() - start) < (maxMs * 0.7)) {
            console.log(`[BG] waitForPageInteractive: ${consecutiveFailures} consecutive failures, waiting longer...`);
            await new Promise(r => setTimeout(r, pollInterval * 3));
            consecutiveFailures = 0; // Reset after longer wait
          }
        }
      } catch (e) {
        consecutiveFailures++;
        console.warn(`[BG] waitForPageInteractive error (attempt ${consecutiveFailures}):`, e.message);
      }
      
      await new Promise(r => setTimeout(r, pollInterval * 2)); // Use a slightly longer poll for this part
    }
    
    // Final attempt if no elements were found
    if (elementsFound === 0 && (Date.now() - start) < maxMs) {
      console.log(`[BG] waitForPageInteractive: Making final attempt...`);
      try {
        const res = await sendContentRPC(tabId, { type: "GET_ELEMENT_MAP" }, getFastTimeout('getInteractiveElements'));
        const elements = (res?.ok && (res.elements || (res.map && res.map.elements))) ? (res.elements || res.map.elements) : [];
        if (Array.isArray(elements)) {
          elementsFound = elements.length;
          if (elementsFound > 0) {
            elementFetchCache.set(tabId, {
              timestamp: Date.now(),
              elements: elements
            });
          }
        }
      } catch (e) {
        console.warn(`[BG] waitForPageInteractive final attempt failed:`, e.message);
      }
    }

    emitAgentLog(tabId, {
      level: LOG_LEVELS.DEBUG,
      msg: `waitForPageInteractive finished after ${Date.now() - start}ms. Found ${elementsFound} elements.`,
      trigger: options.trigger
    });

  } catch (e) {
    emitAgentLog(tabId, { level: LOG_LEVELS.WARN, msg: "waitForPageInteractive encountered an error", error: e.message });
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
      tool: action.tool,
      action: redactedAction,
      rationale: action.rationale, // Add rationale to the log
      requestId: sess.requestId
    });
  
  emitAgentStatus(tabId, `Executing: ${getToolDescription(action.tool)}...`);

  // Capture URL before action for implicit navigation detection
  // Capture URL before action for implicit navigation detection, but skip for internal-only actions.
  let urlBeforeAction = '';
  if (action.tool !== 'think') {
    try {
      const tab = await chrome.tabs.get(tabId);
      urlBeforeAction = tab?.url || '';
    } catch (e) {
      emitAgentLog(tabId, { level: LOG_LEVELS.WARN, msg: "Could not get URL before action", error: e.message });
    }
  }

  const execRes = await dispatchActionWithTimeout(tabId, action, settings);

  // Capture URL after action
  // Similarly, skip URL check for internal-only actions.
  let urlAfterAction = '';
  if (action.tool !== 'think') {
    try {
      const tab = await chrome.tabs.get(tabId);
      urlAfterAction = tab?.url || '';
    } catch (e) {
      emitAgentLog(tabId, { level: LOG_LEVELS.WARN, msg: "Could not get URL after action", error: e.message });
    }
  }

  emitAgentLog(tabId, {
    level: execRes?.ok === false ? LOG_LEVELS.ERROR : LOG_LEVELS.SUCCESS,
    msg: "Action completed",
    tool: action.tool,
    success: execRes?.ok !== false,
    observation: execRes?.observation?.substring(0, 300) + (execRes?.observation?.length > 300 ? '...' : ''),
    errorType: execRes?.errorType,
    errorCode: execRes?.errorCode, // Propagate structured error code
    requestId: sess.requestId
  });

  sendActionResultToChat(tabId, sess, action, execRes);

  // Debug visualization: highlight executed action and update overlay indices
  try {
    if (execRes?.ok) {
      const tool = String(action.tool || '').trim();
      const p = action.params || {};
      const selector = typeof p.selector === 'string' ? p.selector : '';

      if (tool === 'click' || tool === 'click_element' || tool === 'clickElement') {
        // Keep the visual highlight for up to 1 minute so users can clearly see where the AI clicked
        await highlightSelectorForDebug(tabId, selector, 'AI Click', '#ff9800', 60000);
        await updateOverlayForDebug(tabId);
      } else if (tool === 'type_text' || tool === 'fill' || tool === 'typeText') {
        await highlightSelectorForDebug(tabId, selector, 'Type', '#4caf50', 1200);
        await updateOverlayForDebug(tabId);
      } else if (tool === 'wait_for_selector' || tool === 'waitForSelector') {
        if (selector) await highlightSelectorForDebug(tabId, selector, 'Wait OK', '#2196f3', 800);
      } else if (tool === 'scroll_to' || tool === 'scrollTo') {
        if (selector) await highlightSelectorForDebug(tabId, selector, 'Scroll', '#9c27b0', 800);
      } else if (tool === 'scrape' || tool === 'scrapeSelector') {
        if (selector) await highlightSelectorForDebug(tabId, selector, 'Scrape', '#607d8b', 1000);
      } else if (tool === 'get_interactive_elements' || tool === 'getInteractiveElements') {
        await updateOverlayForDebug(tabId);
      }
    }
  } catch (_) {}

  // Auto-sense: if navigation was successful or a click caused a URL change, wait for page to become interactive.
  const clickCausedNavigation = execRes.ok &&
                                ['click', 'click_element', 'clickElement'].includes(action.tool) &&
                                urlBeforeAction &&
                                urlAfterAction &&
                                urlBeforeAction !== urlAfterAction;

  if (clickCausedNavigation) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.INFO,
      msg: "Implicit navigation detected after click action.",
      from: urlBeforeAction,
      to: urlAfterAction
    });
  }

  // This function centralizes the logic for re-scanning elements after an action.
  const senseAndStoreElements = async (trigger) => {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.INFO,
      msg: "Auto-sensing interactive elements",
      triggeringTool: trigger
    });

    try { AgentPortManager.invalidate(tabId); } catch (_) {}
    await waitForPageInteractive(tabId, { trigger });

    try {
      let getElementsAction = { tool: 'get_interactive_elements', params: {} };
      let elementsRes = await dispatchActionWithTimeout(tabId, getElementsAction, settings);

      if (elementsRes?.ok && Array.isArray(elementsRes.data) && elementsRes.data.length === 0) {
        await waitForPageInteractive(tabId, { maxMs: FAST_MODE_BG ? 800 : 1500, trigger: `${trigger}_retry` });
        elementsRes = await dispatchActionWithTimeout(tabId, getElementsAction, settings);
      }

      if (elementsRes?.ok && elementsRes.data) {
        // Element caching removed for bfcache compatibility
        // sess.currentInteractiveElements = elementsRes.data;
        sess.currentPageContent = ""; // Clear stale content
        emitAgentLog(tabId, {
          level: LOG_LEVELS.DEBUG,
          msg: `Auto-get_interactive_elements successful, found ${elementsRes.data.length} elements (no longer cached).`
        });
        try { await showOverlayForDebug(tabId, { limit: 50, colorScheme: "type" }); } catch (_) {}
      } else {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.WARN,
          msg: "Auto-sensing interactive elements returned no data after navigation retry"
        });
      }
    } catch (e) {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.DEBUG,
        msg: "Gracefully handled comms error during post-action sensing.",
        error: e.message
      });
    }
  };

  // Logic Branch 1: Explicit navigation tool was used.
  if (execRes.ok && ['navigate', 'goto_url', 'navigateToUrl', 'smart_navigate', 'research_url'].includes(action.tool)) {
    await senseAndStoreElements(action.tool);
  }
  // Logic Branch 2: A click implicitly caused a navigation.
  else if (clickCausedNavigation) {
    await senseAndStoreElements('implicit_nav_click');
  }
  // Logic Branch 3: A non-navigating action that might change the DOM was used.
  else if (execRes.ok && ['click_element', 'type_text', 'wait_for_selector', 'select_option'].includes(action.tool)) {
    await senseAndStoreElements(`post_${action.tool}`);
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

  // Store page content in the session whenever provided by a tool result
  if (execRes.ok && typeof execRes.pageContent === 'string' && execRes.pageContent) {
    sess.currentPageContent = execRes.pageContent;
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: `Stored page content in session (length: ${execRes.pageContent.length})` });
  }
  
  // Element caching removed for bfcache compatibility - no longer storing elements in session
  if (action.tool === 'getInteractiveElements' && execRes.ok && execRes.data) {
      emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: `Found ${execRes.data.length} interactive elements (not cached for bfcache compatibility)` });
  }

  // If we navigate away, the content is now stale and must be cleared
  if (action.tool === 'navigate' || action.tool === 'goto_url' || action.tool === 'navigateToUrl' || action.tool === 'smart_navigate') {
    sess.currentPageContent = "";
    // Element caching removed for bfcache compatibility
    // sess.currentInteractiveElements = [];
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Cleared stale page content from session after navigation." });
  }

  // Persist session state after each action
  SessionManager.saveSessionToStorage(tabId, sess);

  // Update domain visit count for the watchdog
  if (!sess.domainVisitCount || typeof sess.domainVisitCount !== 'object') { sess.domainVisitCount = {}; }
  if (execRes.ok && ['navigate', 'goto_url', 'navigateToUrl', 'smart_navigate', 'research_url'].includes(action.tool)) {
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
  const progressTools = new Set([
    'navigate','goto_url','navigateToUrl','smart_navigate',
    'click','click_element','clickElement',
    'type_text','typeText','fill',
    'wait_for_selector','waitForSelector',
    'read_page_content','readPageContent',
    'get_interactive_elements','getInteractiveElements',
    'analyze_urls','analyzeUrls'
  ]);
  const isProgressTool = progressTools.has(action.tool);

  if ((execRes.ok && isProgressTool) ||
      (observation.length > 50 && observation !== sess.lastProgressObservation)) {
    sess.noProgressCounter = 0;
    sess.lastProgressObservation = observation;
  } else {
    sess.noProgressCounter = (sess.noProgressCounter || 0) + 1;
  }
}

// Fast-path deterministic correction builder (avoids model call for common failures)
function buildDeterministicCorrection(failedAction, execRes, contextData) {
  try {
    const tool = String(failedAction?.tool || '').trim();
    const observation = String(execRes?.observation || '').toLowerCase();
    const code = String(execRes?.errorCode || '').toUpperCase();
    const params = failedAction?.params || {};
    const elements = Array.isArray(contextData?.interactiveElements) ? contextData.interactiveElements : [];

    // Helper to read overlay index consistently
    const getIndex = (el) => {
      const v = el?.index ?? el?.elementIndex ?? el?.idx;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    // 1) Missing selector or element not found → prefer index typing/click, else fetch elements
    const isSelectorIssue =
      code === 'MISSING_SELECTOR' ||
      observation.includes('no selector provided') ||
      observation.includes('selector not found') ||
      observation.includes('not found or not visible');

    if (isSelectorIssue && (tool === 'type_text' || tool === 'typeText' || tool === 'click_element' || tool === 'clickElement')) {
      // Try index-based correction using existing interactive elements
      if (elements.length > 0) {
        if (tool === 'type_text' || tool === 'typeText') {
          const cand = elements.find(el => {
            const tag = String(el.tag || el.tagName || '').toLowerCase();
            const role = String(el.role || '').toLowerCase();
            const inputType = String(el.inputType || '').toLowerCase();
            return (tag === 'input' || tag === 'textarea' || role === 'textbox') && inputType !== 'hidden';
          }) || elements.find(el => String(el.tag || '').toLowerCase() === 'input');
          const idx = cand ? getIndex(cand) : null;
          if (idx) {
            return {
              tool: 'type_text',
              params: {
                elementIndex: idx,
                text: String(params.text ?? params.value ?? '')
              },
              rationale: 'Use overlay index to type into a visible input after selector failure',
              confidence: 0.9,
              done: false
            };
          }
        } else {
          const cand = elements.find(el => {
            const tag = String(el.tag || '').toLowerCase();
            const role = String(el.role || '').toLowerCase();
            return tag === 'button' || tag === 'a' || role === 'button' || role === 'link';
          }) || elements[0];
          const idx = cand ? getIndex(cand) : null;
          if (idx) {
            return {
              tool: 'click_element',
              params: { elementIndex: idx },
              rationale: 'Use overlay index to click after selector failure',
              confidence: 0.85,
              done: false
            };
          }
        }
      }
      // If we don't have elements cached, fetch them to enable index-based actions next
      return {
        tool: 'get_interactive_elements',
        params: {},
        rationale: 'Fetch interactive elements to enable elementIndex-based targeting',
        confidence: 0.85,
        done: false
      };
    }

    // 2) Timeout on wait_for_selector → increase timeout and retry
    if ((tool === 'wait_for_selector' || tool === 'waitForSelector') &&
        (code === 'TIMEOUT' || observation.includes('timeout'))) {
      const selector = String(params.selector || '');
      // If waiting for a selector fails, don't just wait longer.
      // Force a re-think to determine if another action is needed first.
      return {
          tool: 'think',
          params: {
              thought: `I waited for the element "${selector}" but it did not appear. I need to re-evaluate the page and my plan. Perhaps I need to navigate to a different page or click another element first to make it visible.`
          },
          rationale: 'Selector did not appear after waiting. Re-evaluating plan is safer than waiting longer.',
          confidence: 0.95,
          done: false
      };
    }

    // 3) Element not visible → scroll into view before retry
    if (params.selector && (observation.includes('not visible') || observation.includes('not in viewport') || observation.includes('obscured'))) {
      return {
        tool: 'scroll_to',
        params: { selector: params.selector },
        rationale: 'Scroll element into view before interacting',
        confidence: 0.85,
        done: false
      };
    }
  } catch (_) {}
  return null;
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
    observation: execRes.observation,
    errorCode: execRes.errorCode // Log the structured error code
  });

  // Fast-path: try deterministic correction before invoking the LLM
  try {
    const fastCorrection = buildDeterministicCorrection(failedAction, execRes, contextData);
    if (fastCorrection) {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.INFO,
        msg: "Using deterministic self-correction (no LLM).",
        proposed: fastCorrection
      });
      return fastCorrection;
    }
  } catch (_) {}

  // Generate a more targeted correction plan based on the error code
  const attemptCount = (sess.consecutiveFailures || 0) + 1;
  const correctionPrompt = buildSelfCorrectPrompt(goal, currentSubTask, {
    ...contextData,
    failedAction,
    observation: execRes.observation,
    // Pass the structured error code to the prompt for better context
    errorInfo: {
      type: execRes.errorType,
      code: execRes.errorCode,
      message: execRes.observation
    },
    attemptCount
  });

  const correctionRes = await callModelWithRotation(correctionPrompt, { model: sess.selectedModel, tabId });

  if (correctionRes?.ok) {
    const validationResult = parseAndValidateAction(tabId, sess, correctionRes.text);
    if (validationResult.success) {
      const correctedAction = validationResult.action;
      // Guard against repeating the exact same failed action
      if (Utils.deepEqual(correctedAction, failedAction)) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.WARN,
          msg: "Self-correction proposed the same failing action. Overriding with a 'think' action to force re-evaluation."
        });
        return {
          tool: 'think',
          params: { thought: `My previous action (${failedAction.tool}) failed. I need to try a different approach instead of repeating the same mistake. I will re-evaluate the page and my plan.` },
          rationale: "Avoiding a failure loop by not repeating the same action.",
          confidence: 0.99
        };
      }
      emitAgentLog(tabId, { level: LOG_LEVELS.INFO, msg: "Self-correction plan generated successfully." });
      return correctedAction;
    } else {
      emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Failed to parse self-correction plan.", error: validationResult.error });
    }
  } else {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.ERROR,
      msg: "Self-correction planning failed.",
      error: correctionRes?.error,
      provider: "model"
    });
  }

  // Fallback to a deterministic 'think' action if LLM-based correction fails
  emitAgentLog(tabId, {
    level: LOG_LEVELS.WARN,
    msg: "LLM-based self-correction failed. Falling back to a deterministic 'think' action."
  });
  return {
    tool: 'think',
    params: { thought: `My previous action (${failedAction.tool}) failed with the error: '${execRes.observation}'. I will re-read the page content and elements to re-evaluate my next step.` },
    rationale: "Fallback after failed self-correction attempt.",
    confidence: 0.95
  };
}

// [CONTEXT ENGINEERING] Dynamic delay between steps
function calculateAdaptiveDelay(action, success) {
  if (action.tool === 'navigate' || action.tool === 'goto_url' || action.tool === 'navigateToUrl') {
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
  if (['navigate', 'goto_url', 'navigateToUrl', 'smart_navigate', 'research_url'].includes(lastAction.tool) && lastExecRes.ok) {
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
                findingToRecord.forEach(item => { sess.findings = Utils.deepMerge(sess.findings || {}, item); });
              } else {
                sess.findings = Utils.deepMerge(sess.findings || {}, findingToRecord);
              }
              emitAgentLog(tabId, { level: MessageTypes.LOG_LEVELS.SUCCESS, msg: 'Graph: recorded structured finding', source: content.source || 'unknown' });
            }
            // Persist after each successful node
            SessionManager.saveSessionToStorage(tabId, sess);
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

// ============================================================================
// SYNC MANAGER INTEGRATION
// ============================================================================

// Initialize sync functionality
(function initSyncIntegration() {
  try {
    // Initialize database and sync manager
    const db = new globalThis.IndexedDB('ai-chrome-extension', 1, 'ai-state');
    const syncManager = new globalThis.SyncManager(db);
    
    // Setup background sync event listener
    if (typeof self !== 'undefined' && self.addEventListener) {
      self.addEventListener('sync', (event) => {
        if (event.tag === 'sync-ai-actions') {
          event.waitUntil(
            syncManager.sync().catch(error => {
              console.error('[BG] Background sync failed:', error);
            })
          );
        }
      });
      
      // Handle WebRTC offers (if needed for AI communication)
      self.addEventListener('message', async (event) => {
        if (event.data && event.data.type === 'webrtc-offer') {
          try {
            // For now, WebRTC is not fully implemented
            // Send back an error response instead of invalid SDP
            console.warn('[BG] WebRTC offer received but not implemented yet');
            
            if (event.source && event.source.postMessage) {
              event.source.postMessage({
                type: 'webrtc-error',
                error: 'WebRTC functionality not implemented yet'
              });
            }
          } catch (error) {
            console.error('[BG] Error handling WebRTC offer:', error);
          }
        }
      });
      
      // Initialize database on activation
      self.addEventListener('activate', (event) => {
        event.waitUntil(
          db.open().catch(error => {
            console.error('[BG] Failed to open database:', error);
          })
        );
      });
    }
    
    console.log('[BG] Sync integration initialized');
    
  } catch (error) {
    console.error('[BG] Failed to initialize sync integration:', error);
  }
})();

// ===== End Graph helpers =====