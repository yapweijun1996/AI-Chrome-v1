/**
 * common/task-graph.js
 * Task Graph Engine for MV3 classic scripts.
 * Exposes globalThis.TaskGraphEngine with:
 *  - createGraph(nodes, meta?)
 *  - run(tabId, graph, options?)
 *
 * Node spec (minimal Phase A.1):
 * {
 *   id: string,
 *   kind: 'tool' | 'delay' | 'noop',
 *   dependsOn?: string[],
 *   // kind === 'tool'
 *   toolId?: string,
 *   input?: any,
 *   // kind === 'delay'
 *   delayMs?: number,
 *   // execution
 *   timeoutMs?: number,
 *   retryPolicy?: { maxAttempts?: number, backoffMs?: number }
 * }
 *
 * Options:
 *  - concurrency?: number (default 2)
 *  - ctx?: object passed to ToolsRegistry for tool runs (should include { tabId, ensureContentScript, chrome })
 *  - onNodeStart?: (node) => void
 *  - onNodeFinish?: (node, result) => void
 *  - signal?: AbortSignal to cancel remaining nodes
 *  - defaultToolTimeoutMs?: number
 *  - failFast?: boolean (default false) — if true, cancel remaining on first failure
 *
 * Emits Observer events (if available):
 *  - graph_started, graph_finished
 *  - graph_node_started, graph_node_finished
 * Mirrors tool_started/tool_result around tool nodes (scoped inside the engine).
 */
(function initTaskGraphEngine(global) {
  if (global.TaskGraphEngine && global.TaskGraphEngine.__LOCKED__) return;

  const LOGGER = (global.Log && global.Log.createLogger) ? global.Log.createLogger('graph') : null;
  const AgentObserver = global.AgentObserver;
  const ToolsRegistry = global.ToolsRegistry;

  function nowMs() { return Date.now(); }

  async function emitGeneric(tabId, kind, data) {
    try {
      if (AgentObserver && typeof AgentObserver.emitGeneric === 'function') {
        return await AgentObserver.emitGeneric(tabId, kind, data);
      }
    } catch (_) {}
    return null;
  }

  async function emitRunState(tabId, state, meta) {
    try {
      if (AgentObserver && typeof AgentObserver.emitRunState === 'function') {
        return await AgentObserver.emitRunState(tabId, state, meta || {});
      }
    } catch (_) {}
    return null;
  }

  async function emitToolStarted(tabId, toolId, input) {
    try {
      if (AgentObserver && typeof AgentObserver.emitToolStarted === 'function') {
        return await AgentObserver.emitToolStarted(tabId, toolId, input || {});
      }
    } catch (_) {}
    return null;
  }

  async function emitToolResult(tabId, toolId, output) {
    try {
      if (AgentObserver && typeof AgentObserver.emitToolResult === 'function') {
        return await AgentObserver.emitToolResult(tabId, toolId, output || {});
      }
    } catch (_) {}
    return null;
  }

  function withTimeout(promise, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${timeoutMs}ms`)), timeoutMs))
    ]);
  }

  function createGraph(nodes, meta) {
    if (!Array.isArray(nodes)) throw new Error('nodes array required');
    const id = `tg_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`;

    const nodeMap = new Map();
    for (const n of nodes) {
      if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id) {
        throw new Error('Each node must be an object with a non-empty string id');
      }
      if (nodeMap.has(n.id)) {
        throw new Error(`Duplicate node id: ${n.id}`);
      }
      const def = {
        id: n.id,
        kind: n.kind || 'noop',
        dependsOn: Array.isArray(n.dependsOn) ? [...n.dependsOn] : [],
        toolId: n.toolId,
        input: n.input,
        delayMs: Number(n.delayMs || 0),
        timeoutMs: Number(n.timeoutMs || 0),
        retryPolicy: {
          maxAttempts: Math.max(1, Number(n.retryPolicy?.maxAttempts || 1)),
          backoffMs: Math.max(0, Number(n.retryPolicy?.backoffMs || 0))
        }
      };
      nodeMap.set(def.id, def);
    }

    // Validate dependencies exist
    for (const def of nodeMap.values()) {
      for (const dep of def.dependsOn) {
        if (!nodeMap.has(dep)) throw new Error(`Node '${def.id}' depends on missing node '${dep}'`);
      }
    }

    // Build in-degrees for scheduling
    const inDegree = {};
    for (const def of nodeMap.values()) inDegree[def.id] = 0;
    for (const def of nodeMap.values()) {
      for (const dep of def.dependsOn) inDegree[def.id]++;
    }

    return Object.freeze({
      id,
      nodes: Array.from(nodeMap.values()),
      meta: meta || {},
      __map: nodeMap,
      __inDegree: inDegree
    });
  }

  function makeBackoffDelay(base, attemptIndex) {
    // attemptIndex starts at 1
    const factor = attemptIndex;
    const jitter = 0.5 + Math.random(); // 0.5x..1.5x
    return Math.max(0, Math.floor(base * factor * jitter));
  }

  async function runNode(tabId, node, options, runCtx) {
    const startedAt = nowMs();
    const resultEnvelope = (rawOk, observation, extra) => {
      const durationMs = Math.max(0, nowMs() - startedAt);
      return { ok: !!rawOk, observation: observation || (rawOk ? 'OK' : 'ERROR'), durationMs, ...(extra || {}) };
    };

    const graphMeta = options?.__graph || {};
    const correlationId = graphMeta.correlationId || '';

    try { LOGGER?.debug?.('graph_node_dispatch', { id: node.id, kind: node.kind, graphId: graphMeta.graphId, correlationId }); } catch (_) {}
    await emitGeneric(tabId, 'graph_node_started', { nodeId: node.id, kind: node.kind, graphId: graphMeta.graphId, correlationId });

    if (node.kind === 'noop') {
      await emitGeneric(tabId, 'graph_node_finished', { nodeId: node.id, status: 'success', graphId: graphMeta.graphId, correlationId });
      return resultEnvelope(true, 'noop');
    }

    if (node.kind === 'delay') {
      const ms = Math.max(0, Number(node.delayMs || 0));
      await new Promise(r => setTimeout(r, ms));
      await emitGeneric(tabId, 'graph_node_finished', { nodeId: node.id, status: 'success', delayMs: ms, graphId: graphMeta.graphId, correlationId });
      return resultEnvelope(true, `delay ${ms}ms`);
    }

    if (node.kind === 'tool') {
      if (!ToolsRegistry || typeof ToolsRegistry.runTool !== 'function') {
        await emitGeneric(tabId, 'graph_node_finished', { nodeId: node.id, status: 'error', error: 'ToolsRegistry unavailable' });
        return resultEnvelope(false, 'ToolsRegistry unavailable', { error: 'ToolsRegistry unavailable' });
      }
      const toolId = String(node.toolId || '');
      const input = node.input || {};
      const capabilities = (ToolsRegistry && typeof ToolsRegistry.getCapabilities === 'function')
        ? ToolsRegistry.getCapabilities(toolId)
        : null;
      // Mirror standard tool events
      try { LOGGER?.info?.('tool_started', { nodeId: node.id, toolId, graphId: graphMeta.graphId, correlationId, capabilities }); } catch (_) {}
      await emitToolStarted(tabId, toolId, { ...(input || {}), __meta: { graphId: graphMeta.graphId, nodeId: node.id, correlationId, capabilities } });
      let out;
      try {
        const defTimeout = Number(options.defaultToolTimeoutMs || 0);
        const timeoutMs = node.timeoutMs || defTimeout || 0;
        out = await withTimeout(
          ToolsRegistry.runTool(toolId, runCtx || {}, input),
          timeoutMs,
          `tool:${toolId}`
        );
      } catch (e) {
        out = { ok: false, observation: String(e?.message || e), error: e };
      }
      const summary = {
        ...out,
        durationMs: out?.durationMs ?? Math.max(0, nowMs() - startedAt)
      };
      const enriched = { ...summary, graphId: graphMeta.graphId, nodeId: node.id, correlationId, capabilities };
      try {
        const s = { ok: out?.ok !== false, observation: String(out?.observation || '').slice(0, 200), durationMs: enriched.durationMs, graphId: graphMeta.graphId, correlationId };
        LOGGER?.info?.('tool_result', { nodeId: node.id, toolId, ...s, capabilities });
      } catch (_) {}
      await emitToolResult(tabId, toolId, enriched);
      await emitGeneric(tabId, 'graph_node_finished', { nodeId: node.id, status: enriched.ok === false ? 'error' : 'success', graphId: graphMeta.graphId, correlationId, capabilities });
      return enriched;
    }

    await emitGeneric(tabId, 'graph_node_finished', { nodeId: node.id, status: 'error', error: 'Unknown node kind', graphId: graphMeta.graphId, correlationId });
    return resultEnvelope(false, `Unknown node kind: ${node.kind}`, { error: 'unknown_kind' });
  }

  async function run(tabId, graph, options) {
    const startTs = nowMs();
    const graphId = graph?.id || `tg_${startTs}`;
    const concurrency = Math.max(1, Number(options?.concurrency || 2));
    const failFast = !!options?.failFast;
    const abortSignal = options?.signal;
    const ctx = options?.ctx || { tabId };

    const requestId = graph?.meta?.requestId;
    const goal = graph?.meta?.goal;
    const correlationId = requestId || graphId;
    try { LOGGER?.info?.('graph_started', { graphId, nodes: graph?.nodes?.length || 0, correlationId, requestId }); } catch (_) {}
    await emitRunState(tabId, 'started', { graphId, nodes: graph?.nodes?.length || 0, correlationId, requestId, goal });

    const nodeMap = graph.__map || new Map((graph.nodes || []).map(n => [n.id, n]));
    const inDegree = { ...(graph.__inDegree || {}) };
    const dependents = {};
    for (const n of nodeMap.values()) dependents[n.id] = [];
    for (const n of nodeMap.values()) for (const d of n.dependsOn) dependents[d].push(n.id);

    const state = {}; // id -> { status: 'pending'|'running'|'success'|'error'|'skipped', result?, attempts }
    const ready = [];
    for (const n of nodeMap.values()) {
      state[n.id] = { status: 'pending', attempts: 0 };
      if ((inDegree[n.id] || 0) === 0) ready.push(n.id);
    }

    const results = {}; // id -> result
    let running = 0;
    let cancelled = false;
    const pendingSet = new Set(nodeMap.keys());

    function canStart(id) {
      if (state[id].status !== 'pending') return false;
      // Ensure no failed dependency
      const deps = nodeMap.get(id).dependsOn;
      for (const d of deps) {
        if (state[d].status === 'error' || state[d].status === 'skipped') return false;
      }
      return true;
    }

    function scheduleNext(resolveOuter) {
      if (cancelled) return;
      if (pendingSet.size === 0 && running === 0) {
        resolveOuter();
        return;
      }
      while (running < concurrency && ready.length > 0) {
        const id = ready.shift();
        if (!canStart(id)) continue;
        runOne(id, resolveOuter);
      }
    }

    async function runOne(id, resolveOuter) {
      if (cancelled) return;
      const node = nodeMap.get(id);
      state[id].status = 'running';
      state[id].attempts += 1;
      options?.onNodeStart?.(node);
      try { LOGGER?.debug?.('graph_node_start', { id }); } catch (_) {}

      running++;
      const attempts = Math.max(1, Number(node.retryPolicy?.maxAttempts || 1));
      const backoff = Math.max(0, Number(node.retryPolicy?.backoffMs || 0));
      let last;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          if (abortSignal?.aborted) throw new Error('Aborted');
          last = await runNode(tabId, node, { ...(options || {}), __graph: { graphId, correlationId } }, ctx);
          if (last && last.ok !== false) break;
        } catch (e) {
          last = { ok: false, observation: String(e?.message || e), error: e, durationMs: last?.durationMs || 0 };
        }
        if (attempt < attempts && backoff > 0) {
          await new Promise(r => setTimeout(r, makeBackoffDelay(backoff, attempt)));
        }
      }

      results[id] = last;
      state[id].status = (last && last.ok !== false) ? 'success' : 'error';
      try { LOGGER?.debug?.('graph_node_end', { id, ok: last?.ok !== false }); } catch (_) {}
      options?.onNodeFinish?.(node, last);

      running--;
      pendingSet.delete(id);

      // If failFast and an error occurred, cancel remaining
      if (failFast && state[id].status === 'error') {
        cancelled = true;
      }

      // Unblock dependents
      for (const depId of dependents[id]) {
        inDegree[depId] = Math.max(0, (inDegree[depId] || 0) - 1);
        if (inDegree[depId] === 0) {
          // If any dependency failed/skipped, mark as skipped; else enqueue
          const deps = nodeMap.get(depId).dependsOn;
          const anyFailed = deps.some(d => state[d].status === 'error' || state[d].status === 'skipped');
          if (cancelled || anyFailed) {
            state[depId].status = 'skipped';
            results[depId] = { ok: false, observation: anyFailed ? 'Skipped due to failed dependency' : 'Skipped due to cancellation', skipped: true, durationMs: 0 };
            pendingSet.delete(depId);
            // Continue to next without enqueue
          } else {
            ready.push(depId);
          }
        }
      }

      scheduleNext(resolveOuter);
    }

    // Abort handling
    if (abortSignal) {
      const onAbort = () => { cancelled = true; };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    await new Promise(resolveOuter => {
      // Kick off initial
      scheduleNext(resolveOuter);
    });

    const durationMs = Math.max(0, nowMs() - startTs);
    const allOk = Object.values(state).every(s => s.status === 'success' || s.status === 'skipped');
    try { LOGGER?.info?.('graph_finished', { graphId, durationMs, ok: allOk, correlationId, requestId }); } catch (_) {}
    await emitGeneric(tabId, 'graph_finished', { graphId, durationMs, ok: allOk, correlationId, requestId });
    await emitRunState(tabId, 'finished', { graphId, durationMs, ok: allOk, correlationId, requestId });

    return {
      ok: allOk,
      durationMs,
      results,
      state
    };
  }

  // Phase A.2: Minimal linear planner that converts subTasks to a simple DAG
  // Heuristic mapping:
  // - If a sub-task contains a URL, plan: navigateToUrl -> readPageContent -> extractStructuredContent
  // - If it mentions "analyze", add analyzeUrls (after a read if not already planned)
  // - If it mentions "read"/"content", add readPageContent
  // - Otherwise default to readPageContent
  function planLinearFromSubTasks(subTasks, opts) {
    const nodes = [];
    const tasks = Array.isArray(subTasks) ? subTasks : [];
    let lastId = null;
    const maxChars = Number(opts?.maxChars || 15000);

    function enqueue(node) {
      const n = { retryPolicy: { maxAttempts: 1 }, ...node };
      if (lastId && (!n.dependsOn || n.dependsOn.length === 0)) {
        n.dependsOn = [lastId];
      }
      nodes.push(n);
      lastId = n.id;
    }

    function isUrl(s) {
      return /^https?:\/\//i.test(String(s || '').trim());
    }
    function extractFirstUrl(text) {
      const m = String(text || '').match(/https?:\/\/[^\s"'()<>]+/i);
      return m ? m[0] : null;
    }

    tasks.forEach((st, idx) => {
      const text = String(st || '').trim();
      const i = idx + 1;
      const lower = text.toLowerCase();

      const url = extractFirstUrl(text);
      if (url && isUrl(url)) {
        enqueue({ id: `s${i}_nav`, kind: 'tool', toolId: 'navigateToUrl', input: { url } });
        enqueue({ id: `s${i}_read`, kind: 'tool', toolId: 'readPageContent', input: { maxChars } });
        enqueue({ id: `s${i}_extract`, kind: 'tool', toolId: 'extractStructuredContent' });
        return;
      }

      // Non-URL tasks: choose a sensible default sequence
      const mentionsAnalyze = lower.includes('analyze') || lower.includes('analysis') || lower.includes('links');
      const mentionsRead = lower.includes('read') || lower.includes('content') || lower.includes('extract');

      // Always start with a read to prime context (safe, read-only)
      enqueue({ id: `s${i}_read`, kind: 'tool', toolId: 'readPageContent', input: { maxChars } });

      if (mentionsAnalyze) {
        enqueue({ id: `s${i}_analyze`, kind: 'tool', toolId: 'analyzeUrls' });
      } else if (mentionsRead) {
        enqueue({ id: `s${i}_extract`, kind: 'tool', toolId: 'extractStructuredContent' });
      } else {
        // Default: try structured extraction after read to capture metadata
        enqueue({ id: `s${i}_extract`, kind: 'tool', toolId: 'extractStructuredContent' });
      }
    });

    return nodes;
  }

  // Convenience: create a graph from subTasks directly
  function createLinearGraphFromSubTasks(subTasks, meta, opts) {
    const nodes = planLinearFromSubTasks(subTasks, opts);
    return createGraph(nodes, meta || {});
  }

  const TaskGraphEngine = {
    createGraph,
    run,
    planLinearFromSubTasks,
    createLinearGraphFromSubTasks,
    __LOCKED__: true
  };

  global.TaskGraphEngine = TaskGraphEngine;

  // Optional CommonJS export for tests
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TaskGraphEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));