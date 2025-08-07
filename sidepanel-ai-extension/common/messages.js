// common/messages.js
// Centralized message types to prevent drift between background and sidepanel
// This file is safe to import multiple times via importScripts; it uses guards
// and attaches a single global namespace: globalThis.MessageTypes

(function initMessageTypes(global) {
  if (global.MessageTypes && global.MessageTypes.__LOCKED__) {
    // Already initialized; do nothing to avoid "already been declared"
    return;
  }

  // Define constants only if not already present
  const MSG = (global.MessageTypes && global.MessageTypes.MSG) || {
    // Basic communication
    PING: "PING",
    PONG: "PONG",
    
    // API Key management
    READ_API_KEY: "READ_API_KEY",
    SAVE_API_KEY: "SAVE_API_KEY",
    
    // Page interaction
    EXTRACT_PAGE_TEXT: "EXTRACT_PAGE_TEXT",
    SUMMARIZE_PAGE: "SUMMARIZE_PAGE",
    CLASSIFY_INTENT: "CLASSIFY_INTENT",
    CLASSIFY_INTENT_ENHANCED: "CLASSIFY_INTENT_ENHANCED",
    REQUEST_CLARIFICATION: "REQUEST_CLARIFICATION",
    RESPOND_CLARIFICATION: "RESPOND_CLARIFICATION",
    GET_ACTIVE_TAB: "GET_ACTIVE_TAB",
    OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
    
    // Agent workflow
    AGENT_RUN: "AGENT_RUN",
    AGENT_STOP: "AGENT_STOP",
    AGENT_STATUS: "AGENT_STATUS",
    AGENT_LOG: "AGENT_LOG",
    AGENT_PROGRESS: "AGENT_PROGRESS", // New message type for chat progress updates
    AGENT_PLAN_GENERATED: "AGENT_PLAN_GENERATED",
    AGENT_STEP_UPDATE: "AGENT_STEP_UPDATE",
    AGENT_FINISHED: "AGENT_FINISHED",
    SHOW_REPORT: "SHOW_REPORT",
    CHAT_MESSAGE: "CHAT_MESSAGE",
    
    // Agentic Tool Execution
    AGENT_EXECUTE_TOOL: "AGENT_EXECUTE_TOOL",
    AGENT_TOOL_RESULT: "AGENT_TOOL_RESULT",

    // Content script actions
    CLICK_SELECTOR: "CLICK_SELECTOR",
    FILL_SELECTOR: "FILL_SELECTOR",
    SCROLL_TO_SELECTOR: "SCROLL_TO_SELECTOR",
    WAIT_FOR_SELECTOR: "WAIT_FOR_SELECTOR",
    GET_PAGE_INFO: "GET_PAGE_INFO",
    GET_INTERACTIVE_ELEMENTS: "GET_INTERACTIVE_ELEMENTS",
    
    // Enhanced content extraction for research
    EXTRACT_STRUCTURED_CONTENT: "EXTRACT_STRUCTURED_CONTENT",
    ANALYZE_PAGE_URLS: "ANALYZE_PAGE_URLS",
    FETCH_URL_CONTENT: "FETCH_URL_CONTENT",
    GET_PAGE_LINKS: "GET_PAGE_LINKS",
    
    // Enhanced research and pricing tools
    RESEARCH_PRICING: "RESEARCH_PRICING",
    COMPARE_SOURCES: "COMPARE_SOURCES",
    REFINE_QUERY: "REFINE_QUERY",
    MULTI_SOURCE_SEARCH: "MULTI_SOURCE_SEARCH"
  };

  const PARAM_LIMITS = (global.MessageTypes && global.MessageTypes.PARAM_LIMITS) || {
    MAX_SELECTOR_LENGTH: 2000,
    MAX_VALUE_LENGTH: 8000,
    MAX_URL_LENGTH: 2000,
    MAX_REASON_LENGTH: 500
  };

  const TIMEOUTS = (global.MessageTypes && global.MessageTypes.TIMEOUTS) || {
    MODEL_CALL_MS: 60000,       // 60 seconds for model calls
    DOM_ACTION_MS: 10000,       // 10 seconds for DOM actions
    CONTENT_SCRIPT_MS: 5000,    // 5 seconds for content script injection
    PAGE_LOAD_DELAY: 2000,      // 2 seconds to wait after navigation
    ACTION_DELAY: 800,          // 800ms between successful actions
    RETRY_DELAY: 1500           // 1.5s delay on failure before retry
  };

  const ERROR_TYPES = (global.MessageTypes && global.MessageTypes.ERROR_TYPES) || {
    AGENT_ALREADY_RUNNING: "AGENT_ALREADY_RUNNING",
    TIMEOUT: "TIMEOUT",
    CONTENT_SCRIPT_UNAVAILABLE: "CONTENT_SCRIPT_UNAVAILABLE",
    RESTRICTED_URL: "RESTRICTED_URL",
    INVALID_PARAMS: "INVALID_PARAMS",
    PARSE_ERROR: "PARSE_ERROR",
    MODEL_ERROR: "MODEL_ERROR",
    DOM_ERROR: "DOM_ERROR",
    API_KEY_ERROR: "API_KEY_ERROR",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
    CLARIFICATION_NEEDED: "CLARIFICATION_NEEDED",
    CLARIFICATION_TIMEOUT: "CLARIFICATION_TIMEOUT",
    QUERY_TOO_VAGUE: "QUERY_TOO_VAGUE"
  };

  const LOG_LEVELS = (global.MessageTypes && global.MessageTypes.LOG_LEVELS) || {
    ERROR: "error",
    WARN: "warn",
    INFO: "info",
    DEBUG: "debug",
    SUCCESS: "success"
  };

  const API_KEY_ROTATION = (global.MessageTypes && global.MessageTypes.API_KEY_ROTATION) || {
    MAX_KEYS: 10,                    // Maximum number of API keys
    RETRY_DELAY_MS: 1000,           // Delay before trying next key
    KEY_COOLDOWN_MS: 300000,        // 5 minutes cooldown for failed keys
    MAX_CONSECUTIVE_FAILURES: 3,    // Max failures before marking key as bad
    HEALTH_CHECK_INTERVAL_MS: 60000 // 1 minute between health checks
  };

  // Attach a single, locked namespace
  global.MessageTypes = {
    MSG,
    PARAM_LIMITS,
    TIMEOUTS,
    ERROR_TYPES,
    LOG_LEVELS,
    API_KEY_ROTATION,
    __LOCKED__: true
  };

  // Also support CommonJS environments without redeclaration
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.MessageTypes;
  }

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));