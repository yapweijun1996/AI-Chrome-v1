// common/planner.js
// This file is deprecated and will be removed in a future version.
// The planning and reasoning logic has been moved to the more advanced
// prompt builders in common/prompts.js and the agentic loop in background/background.js.

(function (global) {
  if (global.buildReasoningPrompt) {
    // Overwrite with a no-op function to ensure old calls don't break anything
    global.buildReasoningPrompt = function() {
      console.warn("buildReasoningPrompt is deprecated and should not be used.");
      return "";
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));