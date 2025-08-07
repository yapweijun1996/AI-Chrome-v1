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
  // api-key-manager.js is optional; guard its absence
  try {
    safeImport("../common/api-key-manager.js");  // API key rotation/manager (if present)
  } catch (e) {
    console.warn("[BG] api-key-manager optional import failed; continuing without rotation:", e && e.message);
  }

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

// Extract centralized message types and constants
const { MSG, PARAM_LIMITS, TIMEOUTS, ERROR_TYPES, LOG_LEVELS, API_KEY_ROTATION } = MessageTypes;

// Simple in-memory agent sessions keyed by tabId
const agentSessions = new Map(); // tabId -> { running, stopped, step, goal, subTasks: [], currentTaskIndex: 0, settings, logs: [], history: [], lastAction, lastObservation }

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
      model: "gemini-1.5-flash",
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
            await new Promise(resolve => setTimeout(resolve, API_KEY_ROTATION.RETRY_DELAY_MS));
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
        await new Promise(resolve => setTimeout(resolve, API_KEY_ROTATION.RETRY_DELAY_MS));
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
  try {
    return await withTimeout(
      dispatchAgentAction(tabId, action, settings),
      timeoutMs,
      'DOM action'
    );
  } catch (error) {
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
      return { success: true, data: JSON.parse(fencedMatch[1]) };
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
      return { success: true, data: JSON.parse(jsonStr) };
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

// Template variable resolution system
function resolveTemplateVariables(params, sess, tabId) {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const resolvedParams = { ...params };
  const context = buildTemplateContext(sess, tabId);

  // DEBUG: Log template resolution process
  console.log("[TEMPLATE DEBUG] Original params:", params);
  console.log("[TEMPLATE DEBUG] Substitution context:", context);

  // Recursively resolve template variables in all string parameters
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (typeof value === 'string') {
      const originalValue = value;
      resolvedParams[key] = substituteTemplateVariables(value, context);
      
      // DEBUG: Log each substitution
      if (originalValue !== resolvedParams[key]) {
        console.log(`[TEMPLATE DEBUG] Substituted ${key}: "${originalValue}" -> "${resolvedParams[key]}"`);
      } else if (originalValue.includes('{{')) {
        console.log(`[TEMPLATE DEBUG] No substitution for ${key}: "${originalValue}" (contains template variables)`);
      }
    }
  }

  console.log("[TEMPLATE DEBUG] Resolved params:", resolvedParams);
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
  console.log("[CONTEXT DEBUG] Building context for tabId:", tabId);
  console.log("[CONTEXT DEBUG] Session state:", {
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
    console.log("[CONTEXT DEBUG] Recent actions:", recentActions.map(h => ({
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
    console.log("[CONTEXT DEBUG] Research actions found:", researchActions.map(h => ({
      tool: h.action?.tool,
      url: h.action?.params?.url
    })));
    
    // Populate numbered URL variables
    if (researchActions.length > 0) {
      context.PREVIOUS_RESEARCHED_URL = researchActions[0].action?.params?.url || '';
      context.PREVIOUS_STEP_RESULT_URL_1 = researchActions[0].action?.params?.url || '';
      console.log("[CONTEXT DEBUG] Set PREVIOUS_STEP_RESULT_URL_1:", context.PREVIOUS_STEP_RESULT_URL_1);
    }
    if (researchActions.length > 1) {
      context.PREVIOUS_STEP_RESULT_URL_2 = researchActions[1].action?.params?.url || '';
      console.log("[CONTEXT DEBUG] Set PREVIOUS_STEP_RESULT_URL_2:", context.PREVIOUS_STEP_RESULT_URL_2);
    }
    if (researchActions.length > 2) {
      context.PREVIOUS_STEP_RESULT_URL_3 = researchActions[2].action?.params?.url || '';
      console.log("[CONTEXT DEBUG] Set PREVIOUS_STEP_RESULT_URL_3:", context.PREVIOUS_STEP_RESULT_URL_3);
    }
    
    // Find URLs from analyze_urls results stored in session
    if (sess.analyzedUrls && Array.isArray(sess.analyzedUrls)) {
      console.log("[CONTEXT DEBUG] Found analyzedUrls:", sess.analyzedUrls);
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
  console.log("[CONTEXT DEBUG] Final context (non-empty values):", nonEmptyContext);

  return context;
}

// Substitute template variables in a string
function substituteTemplateVariables(text, context) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let result = text;
  
  // DEBUG: Log substitution attempt
  const templateMatches = text.match(/\{\{([A-Za-z_]+)\}\}/g);
  if (templateMatches) {
    console.log("[SUBSTITUTION DEBUG] Found template variables in text:", templateMatches);
  }
  
  // Replace template variables like {{VARIABLE_NAME}} or {{variable_name}}
  const templateRegex = /\{\{([A-Za-z_]+)\}\}/g;
  result = result.replace(templateRegex, (match, variableName) => {
    console.log(`[SUBSTITUTION DEBUG] Processing variable: ${variableName}`);
    
    const value = context[variableName];
    console.log(`[SUBSTITUTION DEBUG] Context value for ${variableName}:`, value);
    
    if (value !== undefined && value !== '') {
      console.log(`[SUBSTITUTION DEBUG] Using context value for ${variableName}: "${value}"`);
      return value;
    }
    
    // If template variable can't be resolved, try to provide a sensible fallback
    const fallbackValue = getFallbackValue(variableName, context);
    console.log(`[SUBSTITUTION DEBUG] Using fallback value for ${variableName}: "${fallbackValue}"`);
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

// Input validation
function validateToolParams(action) {
  const errors = [];
  
  if (!action || typeof action !== 'object') {
    return ['Invalid action object'];
  }
  
  if (!action.tool || typeof action.tool !== 'string') {
    errors.push('Missing or invalid tool name');
  }
  
  if (action.params && typeof action.params === 'object') {
    const params = action.params;
    
    // Check selector length
    if (params.selector && typeof params.selector === 'string') {
      if (params.selector.length > PARAM_LIMITS.MAX_SELECTOR_LENGTH) {
        errors.push(`Selector too long (${params.selector.length} > ${PARAM_LIMITS.MAX_SELECTOR_LENGTH})`);
      }
      if (params.selector.includes('\0')) {
        errors.push('Selector contains null bytes');
      }
    }
    
    // Check value length
    if (params.value && typeof params.value === 'string') {
      if (params.value.length > PARAM_LIMITS.MAX_VALUE_LENGTH) {
        errors.push(`Value too long (${params.value.length} > ${PARAM_LIMITS.MAX_VALUE_LENGTH})`);
      }
      if (params.value.includes('\0')) {
        errors.push('Value contains null bytes');
      }
    }
    
    // Check URL length
    if (params.url && typeof params.url === 'string') {
      if (params.url.length > PARAM_LIMITS.MAX_URL_LENGTH) {
        errors.push(`URL too long (${params.url.length} > ${PARAM_LIMITS.MAX_URL_LENGTH})`);
      }
    }
    
    // Check reason length
    if (params.reason && typeof params.reason === 'string') {
      if (params.reason.length > PARAM_LIMITS.MAX_REASON_LENGTH) {
        errors.push(`Reason too long (${params.reason.length} > ${PARAM_LIMITS.MAX_REASON_LENGTH})`);
      }
    }
  }
  
  return errors;
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

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[BG] Installed");
  // Initialize API key manager
  await apiKeyManager.initialize();
  // Clean up old sessions on install
  await cleanupOldSessions();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[BG] Startup");
  // Initialize API key manager
  await apiKeyManager.initialize();
  // Clean up old sessions on startup
  await cleanupOldSessions();
  
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

async function dispatchAgentAction(tabId, action, settings) {
  const { tool, params = {} } = action || {};
  const sess = agentSessions.get(tabId);
  if (!sess) throw new Error("No agent session");

  // Apply template variable substitution to params
  const resolvedParams = resolveTemplateVariables(params, sess, tabId);

  // URL restriction logic has been disabled by user request.

  switch (tool) {
    case "navigate": {
      const url = String(resolvedParams.url || "");
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, observation: "Invalid URL for navigate" };
      }
      await chrome.tabs.update(tabId, { url });
      return { ok: true, observation: `Navigated to ${url}` };
    }
    case "click": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, { 
          level: LOG_LEVELS.ERROR, 
          msg: "Content script unavailable: cannot execute DOM tool", 
          tool: "click",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "CLICK_SELECTOR", selector: resolvedParams.selector || "" });
      return res?.ok ? { ok: true, observation: res.msg || "Clicked" } : { ok: false, observation: res?.error || "Click failed" };
    }
    case "fill": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, { 
          level: LOG_LEVELS.ERROR, 
          msg: "Content script unavailable: cannot execute DOM tool", 
          tool: "fill",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "FILL_SELECTOR", selector: resolvedParams.selector || "", value: resolvedParams.value ?? "" });
      return res?.ok ? { ok: true, observation: res.msg || "Filled" } : { ok: false, observation: res?.error || "Fill failed" };
    }
    case "scroll": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, { 
          level: LOG_LEVELS.ERROR, 
          msg: "Content script unavailable: cannot execute DOM tool", 
          tool: "scroll",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "SCROLL_TO_SELECTOR", selector: resolvedParams.selector || "", direction: resolvedParams.direction || "" });
      return res?.ok ? { ok: true, observation: res.msg || "Scrolled" } : { ok: false, observation: res?.error || "Scroll failed" };
    }
    case "waitForSelector": {
      if (!(await ensureContentScript(tabId))) {
        emitAgentLog(tabId, { 
          level: LOG_LEVELS.ERROR, 
          msg: "Content script unavailable: cannot execute DOM tool", 
          tool: "waitForSelector",
          errorType: ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE
        });
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "WAIT_FOR_SELECTOR", selector: resolvedParams.selector || "", timeoutMs: resolvedParams.timeoutMs || 5000 });
      return res?.ok ? { ok: true, observation: res.msg || "Selector found" } : { ok: false, observation: res?.error || "Wait failed" };
    }
    case "scrape": {
        if (!(await ensureContentScript(tabId))) {
            return { ok: false, observation: "Content script unavailable" };
        }
        const res = await chrome.tabs.sendMessage(tabId, { type: MSG.SCRAPE_SELECTOR, selector: resolvedParams.selector || "" });
        
        if (res?.ok) {
            // Truncate potentially large scraped data for the observation log
            const observationText = `Scraped ${res.data?.length} items. Content: ${JSON.stringify(res.data).substring(0, 500)}...`;
            return { ok: true, observation: observationText, data: res.data };
        } else {
            return { ok: false, observation: res?.error || "Scrape failed" };
        }
    }
    case "think": {
        const thought = String(resolvedParams.thought || "...");
        return { ok: true, observation: `Thought recorded: ${thought}` };
    }
    case "screenshot": {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
        return { ok: true, observation: "Screenshot captured", dataUrl };
      } catch (e) {
        return { ok: false, observation: "Screenshot failed: " + String(e?.message || e) };
      }
    }
    case "tabs.query": {
      const titleContains = resolvedParams.titleContains || "";
      const urlContains = resolvedParams.urlContains || "";
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter(t => (titleContains ? (t.title || "").toLowerCase().includes(titleContains.toLowerCase()) : true) &&
                                       (urlContains ? (t.url || "").toLowerCase().includes(urlContains.toLowerCase()) : true))
                          .map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
      return { ok: true, observation: `Found ${matches.length} tabs`, tabs: matches };
    }
    case "tabs.activate": {
      const tgt = Number(resolvedParams.tabId);
      if (!Number.isFinite(tgt)) return { ok: false, observation: "Invalid tabId" };
      await chrome.tabs.update(tgt, { active: true });
      return { ok: true, observation: `Activated tab ${tgt}` };
    }
    case "tabs.close": {
      const tgt = Number(resolvedParams.tabId);
      if (!Number.isFinite(tgt)) return { ok: false, observation: "Invalid tabId" };
      await chrome.tabs.remove(tgt);
      return { ok: true, observation: `Closed tab ${tgt}` };
    }
    case "done": {
      return { ok: true, observation: "Goal marked done" };
    }
    case "generate_report": {
      const { format = 'markdown', content = '' } = resolvedParams;
      const reportPrompt = buildReportGenerationPrompt(sess.goal, content, format);
      
      const reportRes = await callModelWithRotation(reportPrompt, { model: sess.selectedModel, tabId: tabId });
      
      if (reportRes.ok) {
        emitAgentLog(tabId, {
          level: LOG_LEVELS.SUCCESS,
          msg: "User-facing report generated",
          report: reportRes.text
        });
        // Send the report to the sidepanel for display
        chrome.runtime.sendMessage({
          type: MSG.SHOW_REPORT,
          tabId: tabId,
          report: reportRes.text,
          format: format
        });
        return { ok: true, observation: "Report generated successfully", report: reportRes.text };
      } else {
        return { ok: false, observation: "Failed to generate report" };
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
    case "extract_structured_content": {
      if (!(await ensureContentScript(tabId))) {
        return { ok: false, observation: "Content script unavailable" };
      }
      const res = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_STRUCTURED_CONTENT" });
      return res?.ok ? { ok: true, observation: "Structured content extracted", content: res.content } : { ok: false, observation: res?.error || "Content extraction failed" };
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
    default:
      return { ok: false, observation: "Unknown tool: " + String(tool) };
  }
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

  // Start the agentic loop
  agenticLoop(tabId, goal, settings);
}

async function agenticLoop(tabId, goal, settings) {
  const sess = agentSessions.get(tabId);
  if (!sess || sess.stopped) {
    return;
  }

  // Perceive
  const context = await gatherContextForReasoning(tabId, sess);

  // Reason
  const reasoningPrompt = buildReasoningPrompt(goal, context, sess.history);
  const modelResponse = await callModelWithRotation(reasoningPrompt, { model: sess.selectedModel, tabId });

  if (!modelResponse.ok) {
    emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Reasoning failed", error: modelResponse.error });
    stopAgent(tabId, "Reasoning failed");
    return;
  }

  const { action, rationale } = parseModelResponse(modelResponse.text);

  if (!action || !action.tool) {
    emitAgentLog(tabId, { level: LOG_LEVELS.ERROR, msg: "Failed to parse action from model response", response: modelResponse.text });
    stopAgent(tabId, "Failed to parse action");
    return;
  }

  // Act
  const execRes = await executeActionWithContext(tabId, sess, action, settings);

  // Observe
  updateSessionContext(tabId, sess, action, execRes);

  if (action.tool === 'done' || sess.step >= settings.maxSteps) {
    stopAgent(tabId, "Goal achieved or max steps reached.");
    return;
  }

  // Continue the loop
  sess.step++;
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
          const { goal = "", settings = {} } = message || {};
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });

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
          const newSession = {
            running: false,
            stopped: false,
            step: 0,
            goal,
            subTasks,
            currentTaskIndex: 0,
            settings,
            selectedModel: GEMINI_MODEL || "gemini-1.5-flash",
            logs: [],
            lastAction: "",
            lastObservation: "",
            history: [],
            requestId: `agent_${tab.id}_${Date.now()}`, // For correlation
            taskContext: taskContext, // Enhanced task context
            contextCache: {}, // Context caching
            failureCount: 0,
            consecutiveFailures: 0
          };
          agentSessions.set(tab.id, newSession);
          
          // Persist new session
          await saveSessionToStorage(tab.id, newSession);
          
          emitAgentLog(tab.id, {
            level: LOG_LEVELS.INFO,
            msg: "Enhanced goal decomposition completed",
            subTasks,
            taskContext: taskContext,
            enhancedFeatures: ["context_caching", "failure_tracking", "adaptive_planning"]
          });

          // 3. Start loop but don't block sendResponse
          runAgentLoop(tab.id, goal, settings).catch(e => {
            console.error("[BG] Agent loop error:", e);
            emitAgentLog(tab.id, { level: "error", msg: "Agent loop error", error: String(e?.message || e) });
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
          const { GEMINI_API_KEY } = await chrome.storage.sync.get("GEMINI_API_KEY");
          sendResponse({ ok: true, apiKey: GEMINI_API_KEY || "" });
          break;
        }

        case MSG.SUMMARIZE_PAGE: {
          const { maxChars = 20000, userPrompt = "" } = message;
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
          const selectedModel = (GEMINI_MODEL || "gemini-1.5-flash");
 
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
            const result = await callModelWithRotation(classificationPrompt, { model: "gemini-1.5-flash" });
            
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
      model: "gemini-1.5-flash",
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
      model: "gemini-1.5-flash",
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

// Enhanced JSON parsing with better error handling
function parseAndValidateAction(tabId, sess, responseText) {
  // Try multiple parsing strategies
  const strategies = [
    () => extractJSONWithRetry(responseText, 'planning response'),
    () => {
      // Try to find JSON in code blocks
      const codeBlockMatch = responseText.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i);
      if (codeBlockMatch) {
        return { success: true, data: JSON.parse(codeBlockMatch[1]) };
      }
      return { success: false, error: 'No code block found' };
    },
    () => {
      // Try to extract from the last complete JSON object
      const matches = responseText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
      if (matches && matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        return { success: true, data: JSON.parse(lastMatch) };
      }
      return { success: false, error: 'No JSON objects found' };
    }
  ];
  
  for (let i = 0; i < strategies.length; i++) {
    try {
      const result = strategies[i]();
      if (result.success && result.data) {
        // Validate the action structure
        const action = result.data;
        if (action.tool && typeof action.tool === 'string') {
          // Set default confidence if not provided
          if (typeof action.confidence !== 'number') {
            action.confidence = 0.8;
          }
          
          emitAgentLog(tabId, {
            level: LOG_LEVELS.INFO,
            msg: `Action parsed successfully (strategy ${i + 1})`,
            tool: action.tool,
            confidence: action.confidence
          });
          
          return { success: true, action: action };
        }
      }
    } catch (error) {
      // Continue to next strategy
      continue;
    }
  }
  
  return {
    success: false,
    error: 'Failed to parse valid action from response',
    rawText: responseText.substring(0, 500)
  };
}

// Recovery planning for when main planning fails
async function attemptRecoveryPlanning(tabId, sess, goal, currentSubTask, contextData) {
  emitAgentLog(tabId, {
    level: LOG_LEVELS.WARN,
    msg: "Attempting recovery planning with simplified prompt"
  });
  
  const simplePrompt = `You are a web automation agent. Your goal: ${goal}
Current sub-task: ${currentSubTask}
Current page: ${contextData.pageInfo.title} (${contextData.pageInfo.url})

Choose the next action to progress toward your goal. Return ONLY valid JSON:
{
  "tool": "navigate|click|fill|scroll|waitForSelector|screenshot|done",
  "params": {},
  "rationale": "Why this action helps",
  "done": false
}`;

  try {
    const recoveryRes = await callModelWithRotation(simplePrompt, {
      model: "gemini-1.5-flash",
      tabId: tabId
    });
    
    if (recoveryRes?.ok) {
      emitAgentLog(tabId, {
        level: LOG_LEVELS.INFO,
        msg: "Recovery planning succeeded"
      });
      return recoveryRes;
    }
  } catch (error) {
    emitAgentLog(tabId, {
      level: LOG_LEVELS.ERROR,
      msg: "Recovery planning also failed",
      error: error.message
    });
  }
  
  return null;
}
// [CONTEXT ENGINEERING] Enhanced context gathering with caching
async function gatherEnhancedContext(tabId, sess, currentSubTask) {
  const now = Date.now();
  const cache = sess.contextCache || {};
  const CACHE_TTL = 30000; // 30 seconds

  // Use cached data if not stale
  if (cache.timestamp && (now - cache.timestamp < CACHE_TTL)) {
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Using cached context" });
    return cache.data;
  }

  emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Gathering fresh context" });

  try {
    const pageInfo = await getPageInfoForPlanning(tabId);
    let pageContent = "";
    let interactiveElements = [];

    if (!isRestrictedUrl(pageInfo.url)) {
      if (await ensureContentScript(tabId)) {
        const textExtract = await chrome.tabs.sendMessage(tabId, { type: MSG.EXTRACT_PAGE_TEXT, maxChars: 8000 });
        if (textExtract?.ok) pageContent = textExtract.text;

        const elementsExtract = await chrome.tabs.sendMessage(tabId, { type: MSG.GET_INTERACTIVE_ELEMENTS });
        if (elementsExtract?.ok) interactiveElements = elementsExtract.elements;
      }
    }

    const contextData = {
      pageInfo,
      pageContent,
      interactiveElements,
      history: sess.history || [],
      lastAction: sess.lastAction,
      lastObservation: sess.lastObservation,
      taskContext: sess.taskContext,
      progress: {
        step: sess.step,
        currentSubTask,
        subTaskIndex: sess.currentTaskIndex,
        totalSubTasks: sess.subTasks.length,
        failureCount: sess.failureCount,
        consecutiveFailures: sess.consecutiveFailures
      }
    };

    // Update cache
    sess.contextCache = {
      timestamp: now,
      data: contextData
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

  return execRes;
}

// [CONTEXT ENGINEERING] Session state update logic
function updateSessionContext(tabId, sess, action, execRes) {
  sess.lastAction = action;
  sess.lastObservation = execRes?.observation || "";

  // Add to history and keep it trimmed
  sess.history.push({ action, observation: execRes?.observation || "" });
  if (sess.history.length > 20) { // Increased history size for better context
    sess.history.shift();
  }

  // Invalidate cache after successful navigation
  if (action.tool === 'navigate' && execRes.ok) {
    sess.contextCache = {};
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Context cache invalidated after navigation." });
  }

  // Persist session state after each action
  saveSessionToStorage(tabId, sess);
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