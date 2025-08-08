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
      registry.set(def.id, Object.freeze({ ...def }));
      try { LOGGER?.info?.("register", { id: def.id, hasSchema: !!def.inputSchema, retry: def.retryPolicy?.maxAttempts || 1 }); } catch (_) {}
      return true;
    },
    getTool(id) {
      return registry.get(id) || null;
    },
    listTools() {
      return Array.from(registry.values());
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