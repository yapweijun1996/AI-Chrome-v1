/**
 * common/logger.js
 * Lightweight namespaced logger with levels, colors, and runtime-configurable settings.
 * Works in MV3 service worker (classic), sidepanel, and content scripts.
 *
 * Global API (attached to globalThis):
 *  - Log.init()
 *  - Log.getConfig()
 *  - Log.setConfig({ level, namespaces })
 *  - Log.setLevel(level)
 *  - Log.enable(namespaces)
 *  - Log.createLogger(ns) / Log.getLogger(ns)
 *
 * Usage (any console):
 *  - Log.setLevel('debug'); Log.enable('agent,tools,observer');
 *  - const log = Log.createLogger('agent'); log.info('started', { tabId, runId });
 *
 * Namespaces:
 *  - Comma-separated list with optional wildcard suffix ":*"
 *    e.g. "agent,tools:*" enables 'agent' and any 'tools:*' subspaces
 *
 * Runtime control:
 *  - Persisted to chrome.storage.local under LOG.CONFIG
 *  - Live updates via chrome.storage.onChanged and runtime messages:
 *    { type: MessageTypes?.MSG?.LOG_SET_CONFIG || "MSG.LOG_SET_CONFIG", config: { level, namespaces } }
 */
(function initLogger(global) {
  if (global.Log && global.Log.__LOCKED__) return;

  const CONFIG_KEY = "LOG.CONFIG";
  const DEFAULT_CONFIG = {
    level: "warn",   // error, warn, info, debug, trace
    namespaces: ""   // "", "agent,tools,observer", supports ":*" wildcard suffix
  };

  const LEVELS = ["error", "warn", "info", "debug", "trace"];
  const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

  // Palette for namespace roots
  const NS_COLORS = [
    "#1565C0", "#2E7D32", "#AD1457", "#6A1B9A", "#EF6C00",
    "#00838F", "#C62828", "#283593", "#00796B", "#5D4037"
  ];

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }
  function colorFor(ns) {
    const idx = hashCode(ns.split(":")[0]) % NS_COLORS.length;
    return NS_COLORS[idx];
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function ts() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  let activeConfig = { ...DEFAULT_CONFIG };
  let initialized = false;

  async function readConfig() {
    try {
      const st = await (global.chrome && chrome.storage && chrome.storage.local && chrome.storage.local.get
        ? chrome.storage.local.get(CONFIG_KEY)
        : Promise.resolve({}));
      return { ...DEFAULT_CONFIG, ...(st?.[CONFIG_KEY] || {}) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  async function writeConfig(cfg) {
    const merged = { ...DEFAULT_CONFIG, ...cfg };
    try {
      if (global.chrome && chrome.storage && chrome.storage.local && chrome.storage.local.set) {
        await chrome.storage.local.set({ [CONFIG_KEY]: merged });
      }
    } catch { /* ignore */ }
    activeConfig = merged;
    return merged;
  }

  function matchNamespace(ns, patterns) {
    if (!patterns) return false;
    const parts = String(patterns)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return true; // empty means allow all
    for (const p of parts) {
      if (p.endsWith(":*")) {
        const root = p.slice(0, -2);
        if (ns === root || ns.startsWith(root + ":")) return true;
      } else {
        if (ns === p) return true;
      }
    }
    return false;
  }

  function shouldLog(ns, level) {
    const needIdx = LEVEL_INDEX[activeConfig.level] ?? LEVEL_INDEX.warn;
    const lvlIdx = LEVEL_INDEX[level];
    if (lvlIdx === undefined) return false;
    if (lvlIdx > needIdx) return false;
    const patterns = activeConfig.namespaces;
    if (!patterns) return true;
    return matchNamespace(ns, patterns);
  }

  function fmt(ns, level, meta) {
    const c = colorFor(ns);
    const left = `%c${ts()}%c ${level.toUpperCase()} %c${ns}`;
    const style1 = "color:#999;font-weight:400";
    const style2 =
      level === "error" ? "color:#C62828" :
      level === "warn"  ? "color:#EF6C00" :
      level === "info"  ? "color:#2E7D32" :
      level === "debug" ? "color:#1565C0" : "color:#6A1B9A";
    const style3 = `color:${c};font-weight:700`;
    const suffix = meta ? " %o" : "";
    return { msg: left + suffix, styles: [style1, style2, style3] };
  }

  function rawConsole(level) {
    if (typeof global.console === "undefined") return () => {};
    switch (level) {
      case "error": return console.error.bind(console);
      case "warn": return console.warn.bind(console);
      case "info": return console.info?.bind(console) || console.log.bind(console);
      case "debug": return console.debug?.bind(console) || console.log.bind(console);
      case "trace": return console.trace?.bind(console) || console.log.bind(console);
      default: return console.log.bind(console);
    }
  }

  class NamespacedLogger {
    constructor(ns, context = null) {
      this.ns = ns;
      this.context = context;
      this.timers = new Map();
    }
    withContext(meta) {
      const ctx = { ...(this.context || {}), ...(meta || {}) };
      return new NamespacedLogger(this.ns, ctx);
    }
    logAt(level, message, meta) {
      if (!shouldLog(this.ns, level)) return;
      const { msg, styles } = fmt(this.ns, level, meta || this.context);
      const fn = rawConsole(level);
      if (meta) {
        fn(msg, ...styles, meta, message);
      } else if (this.context) {
        fn(msg, ...styles, this.context, message);
      } else {
        fn(msg, ...styles, message);
      }
    }
    error(message, meta) { this.logAt("error", message, meta); }
    warn(message, meta)  { this.logAt("warn",  message, meta); }
    info(message, meta)  { this.logAt("info",  message, meta); }
    debug(message, meta) { this.logAt("debug", message, meta); }
    trace(message, meta) { this.logAt("trace", message, meta); }

    group(label, meta) {
      if (!shouldLog(this.ns, "info")) return () => {};
      const { msg, styles } = fmt(this.ns, "info", meta || this.context);
      console.group?.(msg, ...styles, meta || this.context, label);
      return () => console.groupEnd?.();
    }
    groupCollapsed(label, meta) {
      if (!shouldLog(this.ns, "info")) return () => {};
      const { msg, styles } = fmt(this.ns, "info", meta || this.context);
      console.groupCollapsed?.(msg, ...styles, meta || this.context, label);
      return () => console.groupEnd?.();
    }
    time(name) {
      if (!shouldLog(this.ns, "debug")) return () => {};
      const key = `${this.ns}:${name}:${Math.random().toString(36).slice(2)}`;
      const start = (global.performance && performance.now) ? performance.now() : Date.now();
      this.timers.set(name, { key, start });
      return () => this.timeEnd(name);
    }
    timeEnd(name) {
      const t = this.timers.get(name);
      if (!t) return;
      const end = (global.performance && performance.now) ? performance.now() : Date.now();
      const ms = Math.max(0, end - t.start);
      this.debug(`timer ${name} ${ms.toFixed(1)}ms`);
      this.timers.delete(name);
    }
  }

  function createLogger(ns) {
    return new NamespacedLogger(ns);
  }

  const Log = {
    async init() {
      if (initialized) return activeConfig;
      activeConfig = await readConfig();

      // Live update via storage
      try {
        chrome?.storage?.onChanged?.addListener((changes, area) => {
          if (area === "local" && changes[CONFIG_KEY]) {
            activeConfig = { ...DEFAULT_CONFIG, ...(changes[CONFIG_KEY].newValue || {}) };
          }
        });
      } catch { /* ignore */ }

      // Live update via runtime message
      try {
        chrome?.runtime?.onMessage?.addListener((message) => {
          const mt = (global.MessageTypes && global.MessageTypes.MSG) || {};
          if (message?.type === mt.LOG_SET_CONFIG || message?.type === "MSG.LOG_SET_CONFIG") {
            if (message?.config && typeof message.config === "object") {
              Log.setConfig(message.config);
            }
          }
        });
      } catch { /* ignore */ }

      initialized = true;
      return activeConfig;
    },
    getConfig() { return { ...activeConfig }; },
    async setConfig(cfg) { return await writeConfig(cfg); },
    async setLevel(level) { return await writeConfig({ ...activeConfig, level }); },
    async enable(namespaces) { return await writeConfig({ ...activeConfig, namespaces }); },
    createLogger,
    getLogger: createLogger,
    __LOCKED__: true
  };

  // Expose on global for easy console access
  try { global.Log = Log; } catch {}
  try { if (!global.createLogger) global.createLogger = createLogger; } catch {}

  // Auto-init
  try { Log.init(); } catch {}

})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));