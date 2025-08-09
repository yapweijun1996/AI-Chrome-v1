/**
 * common/tools-registry.js
 * Global Tool Registry with normalized execution results.
 * Safe to import multiple times (classic script).
 */
(function initToolsRegistry(global) {
  if (global.ToolsRegistry && global.ToolsRegistry.__LOCKED__) {
    return;
  }

  const registry = new Map();
  const LOGGER = (global.Log && global.Log.createLogger) ? global.Log.createLogger('tools') : null;
 
  function typeOf(val) {
    if (Array.isArray(val)) return 'array';
    if (val === null) return 'null';
    return typeof val;
  }

  // Minimal JSON-like validation
  function validateAgainstSchema(obj, schema) {
    if (!schema || typeof schema !== 'object') return { ok: true, errors: [] };
    const errors = [];
    if (schema.type === 'object' && schema.properties) {
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of Object.keys(schema.properties)) {
        const propSchema = schema.properties[key] || {};
        const isRequired = required.includes(key);
        if (!(key in obj)) {
          if (isRequired) errors.push(`Missing required property '${key}'`);
          continue;
        }
        const val = obj[key];
        const expected = propSchema.type;
        if (expected) {
          const expectedTypes = Array.isArray(expected) ? expected : [expected];
          const actual = typeOf(val);
          const okType = expectedTypes.includes(actual) || (expectedTypes.includes('integer') && actual === 'number');
          if (!okType) {
            errors.push(`Invalid type for '${key}': expected ${expectedTypes.join('/')} got ${actual}`);
          }
        }
        if (propSchema.maxLength && typeof val === 'string' && val.length > propSchema.maxLength) {
          errors.push(`'${key}' exceeds maxLength=${propSchema.maxLength}`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  function normalizeResult(raw, startedAtMs) {
    const now = Date.now();
    const durationMs = Math.max(0, now - (startedAtMs || now));

    const ok = !!(raw && raw.ok !== false);
    const observation = typeof raw?.observation === 'string' ? raw.observation : (ok ? 'OK' : 'ERROR');

    const out = {
      ok,
      status: ok ? 'success' : 'error',
      durationMs,
      observation,
    };

    const artifacts = {};
    if (raw && typeof raw === 'object') {
      if (raw.dataUrl) artifacts.screenshot = true;
      if (raw.tabs) artifacts.tabs = raw.tabs;
      if (raw.links) artifacts.links = raw.links;
      if (raw.report) artifacts.report = raw.report;
      if (raw.data) artifacts.data = raw.data;
      if (raw.content) artifacts.content = raw.content;
    }
    if (Object.keys(artifacts).length > 0) out.artifacts = artifacts;
    if (raw?.error) out.errors = [String(raw.error)];
    if (raw?.warnings) out.warnings = [].concat(raw.warnings);

    // Back-compat: pass through common fields for legacy callers that expect top-level properties
    if (raw && typeof raw === 'object') {
      if (raw.pageContent !== undefined) out.pageContent = raw.pageContent;
      if (raw.links !== undefined) out.links = raw.links;
      if (raw.tabs !== undefined) out.tabs = raw.tabs;
      if (raw.report !== undefined) out.report = raw.report;
      if (raw.data !== undefined) out.data = raw.data;
      if (raw.content !== undefined) out.content = raw.content;
      if (raw.dataUrl !== undefined) out.dataUrl = raw.dataUrl;
    }

    return out;
  }

  // Capability metadata normalizer (lightweight)
  // Provides sensible defaults and normalizes enum-like fields while preserving extra keys.
  function validateCapabilities(caps) {
    const defaults = {
      readOnly: true,
      requiresVisibleElement: false,
      requiresContentScript: false,
      framesSupport: 'all',   // 'none' | 'same-origin' | 'all'
      shadowDom: 'partial',   // 'none' | 'partial' | 'full'
      navigation: {
        causesNavigation: false,
        waitsForLoad: false
      }
    };
    const out = { ...defaults, ...(caps || {}) };

    // Normalize enums safely
    const validFrames = new Set(['none', 'same-origin', 'all']);
    const validShadow = new Set(['none', 'partial', 'full']);
    if (!validFrames.has(out.framesSupport)) out.framesSupport = defaults.framesSupport;
    if (!validShadow.has(out.shadowDom)) out.shadowDom = defaults.shadowDom;

    // Normalize nested navigation block
    if (typeof out.navigation !== 'object' || out.navigation === null) {
      out.navigation = { ...defaults.navigation };
    } else {
      out.navigation = {
        causesNavigation: !!out.navigation.causesNavigation,
        waitsForLoad: !!out.navigation.waitsForLoad
      };
    }

    // Ensure booleans
    out.readOnly = !!out.readOnly;
    out.requiresVisibleElement = !!out.requiresVisibleElement;
    out.requiresContentScript = !!out.requiresContentScript;

    return out;
  }

  async function runToolInternal(def, ctx, input) {
    // Preconditions hook
    if (typeof def.preconditions === 'function') {
      const pre = await def.preconditions(ctx, input);
      if (pre && pre.ok === false) {
        try { LOGGER?.warn?.("preconditions_failed", { id: def.id, observation: pre.observation }); } catch (_) {}
        return {
          ok: false,
          observation: pre.observation || 'Preconditions failed',
          error: pre.error || 'preconditions_failed',
        };
      }
    }
    // Retry policy
    const attempts = Math.max(1, Number(def.retryPolicy?.maxAttempts || 1));
    const baseDelay = Number(def.retryPolicy?.backoffMs || 0);
    let last;
    const start = Date.now();
    for (let i = 0; i < attempts; i++) {
      try {
        try { LOGGER?.debug?.("attempt_start", { id: def.id, attempt: i + 1, attempts }); } catch (_) {}
        const raw = await def.run(ctx || {}, input || {});
        last = normalizeResult(raw || {}, start);
        if (last.ok) {
          try { LOGGER?.info?.("attempt_success", { id: def.id, attempt: i + 1, durationMs: last.durationMs }); } catch (_) {}
          return last;
        } else {
          try { LOGGER?.warn?.("attempt_result_error", { id: def.id, attempt: i + 1, observation: (last.observation || "").slice(0, 160) }); } catch (_) {}
        }
      } catch (e) {
        last = normalizeResult({ ok: false, observation: String(e?.message || e), error: e }, start);
        try { LOGGER?.warn?.("attempt_exception", { id: def.id, attempt: i + 1, error: String(e?.message || e) }); } catch (_) {}
      }
      if (i < attempts - 1 && baseDelay > 0) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
      }
    }
    return last || { ok: false, status: 'error', durationMs: Math.max(0, Date.now() - start), observation: 'Failed' };
  }

  const ToolsRegistry = {
    registerTool(def) {
      if (!def || typeof def !== 'object') throw new Error('Tool definition required');
      if (!def.id || typeof def.id !== 'string') throw new Error('Tool id is required');
      if (registry.has(def.id)) registry.delete(def.id);

      // Normalize/validate capabilities; warn if missing (back-compat safe)
      const hasCaps = !!def.capabilities;
      if (!hasCaps) {
        try { LOGGER?.warn?.("register_missing_capabilities", { id: def.id }); } catch (_) {}
      }
      const caps = validateCapabilities(def.capabilities);

      // Compose preconditions: capability guards first, then user-defined preconditions
      const userPreconditions = typeof def.preconditions === 'function' ? def.preconditions : null;
      const composedPreconditions = async (ctx, input) => {
        // Capability-aware guardrails
        try {
          // requiresContentScript: ensure content script is available or fail fast
          if (caps.requiresContentScript) {
            const hasEnsure = !!(ctx && typeof ctx.ensureContentScript === 'function');
            const hasTabId = Number.isFinite(ctx?.tabId);
            if (!hasEnsure || !hasTabId) {
              try { LOGGER?.warn?.("capability_guard_missing_ctx", { id: def.id, hasEnsure, hasTabId }); } catch (_) {}
              return { ok: false, observation: 'Content script requirement cannot be satisfied (missing ctx.ensureContentScript or tabId)' };
            }
            const ensured = await ctx.ensureContentScript(ctx.tabId);
            if (!ensured) {
              return { ok: false, observation: 'Content script unavailable' };
            }
          }
        } catch (e) {
          try { LOGGER?.warn?.("capability_guard_exception", { id: def.id, error: String(e?.message || e) }); } catch (_) {}
          return { ok: false, observation: 'Capability guard failed' };
        }

        // User-defined preconditions (preserved)
        if (userPreconditions) {
          const res = await userPreconditions(ctx, input);
          if (res && res.ok === false) return res;
        }
        return { ok: true };
      };

      const normalized = {
        ...def,
        capabilities: caps,
        preconditions: composedPreconditions
      };

      registry.set(def.id, Object.freeze(normalized));
      try { LOGGER?.info?.("register", { id: def.id, hasSchema: !!def.inputSchema, retry: def.retryPolicy?.maxAttempts || 1, hasCaps }); } catch (_) {}
      return true;
    },
    getTool(id) {
      return registry.get(id) || null;
    },
    listTools() {
      return Array.from(registry.values());
    },
    getCapabilities(id) {
      const def = registry.get(id);
      return def ? def.capabilities || null : null;
    },
    async runTool(id, ctx, input) {
      const def = registry.get(id);
      if (!def) throw new Error(`Unknown tool '${id}'`);
      // Input validation
      if (def.inputSchema) {
        const v = validateAgainstSchema(input || {}, def.inputSchema);
        if (!v.ok) {
          try { LOGGER?.warn?.("validation_failed", { id, errors: v.errors }); } catch (_) {}
          return {
            ok: false,
            status: 'error',
            durationMs: 0,
            observation: `Invalid input for '${id}': ${v.errors.join('; ')}`,
            errors: v.errors,
          };
        }
      }
      const startedAt = Date.now();
      try {
        const out = await runToolInternal(def, ctx, input);
        try {
          LOGGER?.info?.("run_result", {
            id,
            ok: out?.ok !== false,
            durationMs: out?.durationMs ?? Math.max(0, Date.now() - startedAt),
            observation: (out?.observation || "").slice(0, 160)
          });
        } catch (_) {}
        return out;
      } catch (e) {
        try { LOGGER?.error?.("run_error", { id, error: String(e?.message || e) }); } catch (_) {}
        throw e;
      }
    },
    __LOCKED__: true,
  };

  // Expose
  global.ToolsRegistry = ToolsRegistry;

  // Optional CommonJS export for tests
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ToolsRegistry;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));