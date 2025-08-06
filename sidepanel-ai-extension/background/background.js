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

// Session persistence functions for service worker restarts
async function saveSessionToStorage(tabId, session) {
  try {
    const storageKey = `agent_session_${tabId}`;
    const sessionData = {
      ...session,
      // Convert logs array to a limited size to avoid storage quota issues
      logs: session.logs ? session.logs.slice(-50) : [],
      // Store timestamp for cleanup
      lastSaved: Date.now()
    };
    await chrome.storage.local.set({ [storageKey]: sessionData });
  } catch (e) {
    console.warn('[BG] Failed to save session to storage:', e);
  }
}

async function restoreSessionFromStorage(tabId) {
  try {
    const storageKey = `agent_session_${tabId}`;
    const result = await chrome.storage.local.get(storageKey);
    const sessionData = result[storageKey];
    
    if (sessionData) {
      // Restore session but mark as not running (service worker restart)
      const restoredSession = {
        ...sessionData,
        running: false, // Always reset running state after restart
        stopped: true   // Mark as stopped to prevent auto-continuation
      };
      agentSessions.set(tabId, restoredSession);
      return restoredSession;
    }
  } catch (e) {
    console.warn('[BG] Failed to restore session from storage:', e);
  }
  return null;
}

async function cleanupOldSessions() {
  try {
    const result = await chrome.storage.local.get();
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    const keysToRemove = [];
    
    for (const [key, value] of Object.entries(result)) {
      if (key.startsWith('agent_session_') && value.lastSaved && value.lastSaved < cutoffTime) {
        keysToRemove.push(key);
      }
    }
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log(`[BG] Cleaned up ${keysToRemove.length} old agent sessions`);
    }
  } catch (e) {
    console.warn('[BG] Failed to cleanup old sessions:', e);
  }
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
  
  // Persist session after significant changes
  if (entry.level === LOG_LEVELS.ERROR || entry.level === LOG_LEVELS.INFO || sess.logs.length % 5 === 0) {
    saveSessionToStorage(tabId, sess);
  }
  
  try {
    chrome.runtime.sendMessage({ type: MSG.AGENT_LOG, tabId, entry: logEntry });
  } catch (_) {}
}

function stopAgent(tabId, reason = "STOP requested") {
  const sess = agentSessions.get(tabId);
  if (!sess) return;
  sess.stopped = true;
  sess.running = false;
  emitAgentLog(tabId, { level: "warn", msg: "Agent stopped", reason });
  
  // Persist session when stopped
  saveSessionToStorage(tabId, sess);
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

  // URL restriction logic has been disabled by user request.

  switch (tool) {
    case "navigate": {
      const url = String(params.url || "");
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
      const res = await chrome.tabs.sendMessage(tabId, { type: "CLICK_SELECTOR", selector: params.selector || "" });
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
      const res = await chrome.tabs.sendMessage(tabId, { type: "FILL_SELECTOR", selector: params.selector || "", value: params.value ?? "" });
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
      const res = await chrome.tabs.sendMessage(tabId, { type: "SCROLL_TO_SELECTOR", selector: params.selector || "", direction: params.direction || "" });
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
      const res = await chrome.tabs.sendMessage(tabId, { type: "WAIT_FOR_SELECTOR", selector: params.selector || "", timeoutMs: params.timeoutMs || 5000 });
      return res?.ok ? { ok: true, observation: res.msg || "Selector found" } : { ok: false, observation: res?.error || "Wait failed" };
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
      const titleContains = params.titleContains || "";
      const urlContains = params.urlContains || "";
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter(t => (titleContains ? (t.title || "").toLowerCase().includes(titleContains.toLowerCase()) : true) &&
                                       (urlContains ? (t.url || "").toLowerCase().includes(urlContains.toLowerCase()) : true))
                          .map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
      return { ok: true, observation: `Found ${matches.length} tabs`, tabs: matches };
    }
    case "tabs.activate": {
      const tgt = Number(params.tabId);
      if (!Number.isFinite(tgt)) return { ok: false, observation: "Invalid tabId" };
      await chrome.tabs.update(tgt, { active: true });
      return { ok: true, observation: `Activated tab ${tgt}` };
    }
    case "tabs.close": {
      const tgt = Number(params.tabId);
      if (!Number.isFinite(tgt)) return { ok: false, observation: "Invalid tabId" };
      await chrome.tabs.remove(tgt);
      return { ok: true, observation: `Closed tab ${tgt}` };
    }
    case "done": {
      return { ok: true, observation: "Goal marked done" };
    }
    case "generate_report": {
      const { format = 'markdown', content = '' } = params;
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
  sess.currentPlan = [];
  sess.currentStepIndex = 0;

  emitAgentLog(tabId, {
    level: LOG_LEVELS.INFO,
    msg: "Agent started with multi-step planning",
    goal,
    model: sess.selectedModel,
    requestId: sess.requestId,
    maxSteps: Math.min(Number(settings?.maxSteps || 12), 50),
    initialTaskContext: sess.taskContext
  });

  const planner = new AIPlanner({ model: sess.selectedModel });
  const contextData = await gatherEnhancedContext(tabId, sess, goal);
  const planResult = await planner.generatePlan(goal, contextData);

  if (!planResult.ok) {
    stopAgent(tabId, "Failed to generate a plan.");
    return;
  }

  sess.currentPlan = planResult.plan.steps;
  emitAgentLog(tabId, {
    level: LOG_LEVELS.INFO,
    msg: "Multi-step plan generated",
    thought: planResult.plan.thought,
    plan: sess.currentPlan
  });

  while (!sess.stopped && sess.currentStepIndex < sess.currentPlan.length) {
    const action = sess.currentPlan[sess.currentStepIndex];
    const execRes = await executeActionWithContext(tabId, sess, action, settings);
    updateSessionContext(tabId, sess, action, execRes);

    if (!execRes.ok) {
      // Handle failure (simplified for now)
      stopAgent(tabId, `Action failed: ${execRes.observation}`);
      break;
    }


    sess.step++;
    sess.currentStepIndex++;
    const delay = calculateAdaptiveDelay(action, execRes.ok);
    await new Promise(r => setTimeout(r, delay));
  }

  if (!sess.stopped) {
    stopAgent(tabId, "Plan completed.");
  }

  await saveSessionToStorage(tabId, sess);
}

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
  if (sess.history.length > 10) {
    sess.history.shift();
  }

  // Invalidate cache after successful navigation
  if (action.tool === 'navigate' && execRes.ok) {
    sess.contextCache = {};
    emitAgentLog(tabId, { level: LOG_LEVELS.DEBUG, msg: "Context cache invalidated after navigation." });
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