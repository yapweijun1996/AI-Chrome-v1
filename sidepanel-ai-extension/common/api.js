// common/api.js
// Wrapper for calling the Google Generative Language (Gemini) API - updated to supported models/endpoints

(function initApiWrapper(global) {
  // Guard against multiple imports in service worker
  if (global.__API_WRAPPER_LOADED__) {
    return;
  }

  // Default model. Use name without "models/" prefix; URL will add it.
  const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

  // Use v1 for production stability.
  const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1";

  // Pull shared error types if available to standardize rotation signals
  const MT = (typeof global.MessageTypes !== "undefined") ? global.MessageTypes : {};
  const ERROR_TYPES = MT.ERROR_TYPES || {
    MODEL_ERROR: "MODEL_ERROR",
    API_KEY_ERROR: "API_KEY_ERROR",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  };

  /**
   * Derive a structured errorType from HTTP status and API error payload
   */
  function mapGeminiError(status, errorJsonOrText) {
    try {
      const payload = typeof errorJsonOrText === "string" ? JSON.parse(errorJsonOrText) : errorJsonOrText;
      const apiErr = payload?.error || {};
      const code = apiErr.code || status;
      const statusText = String(apiErr.status || "").toUpperCase();
      const message = String(apiErr.message || "");
      // Authentication errors
      if (status === 401 || statusText === "UNAUTHENTICATED" || /unauthenticated|authentication|invalid api key|api key/i.test(message)) {
        return ERROR_TYPES.AUTHENTICATION_ERROR;
      }
      if (status === 403 || statusText === "PERMISSION_DENIED" || /permission denied|forbidden|unauthorized/i.test(message)) {
        return ERROR_TYPES.AUTHENTICATION_ERROR;
      }
      // Quota/billing/rate limiting
      if (status === 429 || statusText === "RESOURCE_EXHAUSTED" || /rate limit|quota|too many requests/i.test(message)) {
        return ERROR_TYPES.QUOTA_EXCEEDED;
      }
      if (status === 402 || /billing|payment required|insufficient credit|account suspended/i.test(message)) {
        return ERROR_TYPES.QUOTA_EXCEEDED;
      }
    } catch (_) {
      // ignore JSON parse failures; fall through
    }
    // Fallback classification
    if (status === 401 || status === 403) return ERROR_TYPES.AUTHENTICATION_ERROR;
    if (status === 429 || status === 402) return ERROR_TYPES.QUOTA_EXCEEDED;
    return ERROR_TYPES.MODEL_ERROR;
  }

  /**
   * Call Gemini generateContent with a text prompt.
   * @param {string} apiKey - Google API key
   * @param {string} prompt - User/system prompt to send
   * @param {object} [options]
   * @param {string} [options.model] - Model name, e.g., "gemini-1.5-flash" or "gemini-1.5-pro"
   * @returns {{ok: boolean, text?: string, raw?: any, error?: string, errorType?: string}}
   */
  async function callGeminiGenerateText(apiKey, prompt, options = {}) {
    const modelName = (options.model || DEFAULT_GEMINI_MODEL).trim();
    // Build URL as .../v1/models/{name}:generateContent
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: String(prompt ?? "") }],
            },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        // Try to parse JSON error
        let errorType = mapGeminiError(response.status, text);
        // Friendly message for NOT_FOUND models
    if (response.status === 404 || /NOT_FOUND|models\/.*is not found|404/i.test(text)) {
          return {
            ok: false,
            error:
              "Gemini model not found or unsupported. Use a supported Gemini model (e.g., 'gemini-2.5-flash' default) or verify access in Google AI Studio. Ensure the URL format is /v1/models/{model}:generateContent.",
            raw: null,
            errorType
          };
        }
        // Return structured error for rotation logic
        return {
          ok: false,
          error: `HTTP ${response.status}: ${text}`,
          raw: null,
          errorType
        };
      }

      const data = await response.json();
      // Extract first text part from first candidate safely
      let text = "";
      const cand = data?.candidates?.[0];
      if (cand?.content?.parts?.length) {
        const firstPart = cand.content.parts.find(p => typeof p?.text === "string");
        if (firstPart) text = firstPart.text;
      }
      return { ok: true, text, raw: data };
    } catch (error) {
      console.error("Error calling Gemini API:", error);
      const msg = String(error?.message || error);
      // Keep NOT_FOUND friendly mapping
      if (/NOT_FOUND|models\/.*is not found|404/i.test(msg)) {
        return {
          ok: false,
          error:
            "Gemini model not found or unsupported. Use a supported Gemini model (e.g., 'gemini-2.5-flash' default) or verify access in Google AI Studio. Ensure the URL format is /v1/models/{model}:generateContent.",
          raw: null,
          errorType: ERROR_TYPES.MODEL_ERROR
        };
      }
      // Heuristic mapping when network/other exceptions
      let errorType = ERROR_TYPES.MODEL_ERROR;
      const low = msg.toLowerCase();
      if (/unauthenticated|authentication|invalid api key|api key|forbidden|permission/.test(low)) {
        errorType = ERROR_TYPES.AUTHENTICATION_ERROR;
      } else if (/rate limit|quota|too many requests|payment required|billing|insufficient credit|account suspended/.test(low)) {
        errorType = ERROR_TYPES.QUOTA_EXCEEDED;
      }
      return { ok: false, error: msg, raw: null, errorType };
    }
  }

  // Export to global scope for use by api-key-manager and other modules
  if (typeof global.globalThis !== 'undefined') {
    global.globalThis.callGeminiGenerateText = callGeminiGenerateText;
  }
  if (typeof global.window !== 'undefined') {
    global.window.callGeminiGenerateText = callGeminiGenerateText;
  }
  if (typeof global.self !== 'undefined') {
    global.self.callGeminiGenerateText = callGeminiGenerateText;
  }
  global.callGeminiGenerateText = callGeminiGenerateText;

  // Also support CommonJS/module exports
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { callGeminiGenerateText };
  }

  // Mark as loaded to prevent re-execution
  global.__API_WRAPPER_LOADED__ = true;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));