/**
 * common/react-planner.js
 * ReAct-style dynamic planner that produces a TaskGraph from the current goal and context.
 * Designed for MV3 classic scripts. Exposes globalThis.ReActPlanner with:
 *  - plan(goal, context, options?): Promise<{ ok: boolean, graph?: any, error?: string, raw?: string }>
 *  - stepsToGraph(steps, meta?, opts?): any
 */
(function initReActPlanner(global) {
  if (global.ReActPlanner) return;

  const TaskGraphEngine = global.TaskGraphEngine;
  const ToolsRegistry = global.ToolsRegistry;

  function safeListTools() {
    try {
      const defs = ToolsRegistry?.listTools?.() || [];
      return defs.map(def => ({
        id: def.id,
        title: def.title || def.id,
        description: def.description || '',
        inputSchema: def.inputSchema || {},
        capabilities: def.capabilities || {}
      }));
    } catch {
      return [];
    }
  }

  function buildToolCatalogSnippet(tools) {
    // Keep compact but informative; include input properties for validation help
    return tools.map(t => {
      const props = t.inputSchema?.properties || {};
      const propKeys = Object.keys(props);
      const propsStr = propKeys.length
        ? propKeys.map(k => {
            const p = props[k];
            const type = Array.isArray(p?.type) ? p.type.join('|') : (p?.type || 'any');
            return `${k}:${type}`;
          }).join(', ')
        : 'none';
      return `- ${t.id}: ${t.description || 'no description'} (input: ${propsStr})`;
    }).join('\n');
  }

  function buildReActPrompt(goal, context, tools, options) {
    const toolIds = tools.map(t => t.id).join('","');
    const toolCatalog = buildToolCatalogSnippet(tools);

    const pageInfo = context?.pageInfo || {};
    const interactiveElements = Array.isArray(context?.interactiveElements) ? context.interactiveElements.slice(0, 12) : [];
    const pageContentPreview = (context?.pageContent || '').slice(0, 1500);

    const maxSteps = Math.max(1, Math.min(10, Number(options?.maxSteps || 6)));

    // Prompt requires a JSON plan with multi-step ReAct-like "thought + action" sequence.
    return `You are an advanced web agent using a ReAct-style planning loop. 
You will think step-by-step ("thought"), then choose the best "action" (tool with params) to progress toward the goal.

Goal:
"${goal}"

Current Context:
- URL: ${pageInfo.url || 'unknown'}
- Title: ${pageInfo.title || 'unknown'}
- Interactive Elements (sample):
${JSON.stringify(interactiveElements, null, 2)}
- Page Content Preview:
${pageContentPreview ? pageContentPreview + (pageContentPreview.length === 1500 ? '...' : '') : '(none)'}

Available Tools (IDs must be used exactly as listed; prefer camelCase IDs):
${toolCatalog}

Strict Output Requirements:
- Respond with ONE JSON object only, no markdown fences, no extra prose.
- The object must have:
{
  "thought": "overall plan and reasoning",
  "steps": [
    {
      "tool": "one of: "${toolIds}"",
      "params": { /* valid for that tool */ },
      "rationale": "why this action is next"
    }
  ]
}
- steps length: 1..${maxSteps}
- Use short, robust params (e.g., CSS selectors should be simple).
- Prefer safe read-first actions (like readPageContent, extractStructuredContent, analyzeUrls) before risky interactions.
- If navigation is required, use navigateToUrl with a full http(s) URL.
- Do not invent tools not listed above.
- Do not include screenshots unless genuinely needed.

Now produce the JSON plan.`;
  }

  function extractJson(text) {
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const body = text.slice(start, end + 1);
        return JSON.parse(body);
      }
    } catch {}
    return null;
  }

  function normalizeStep(step) {
    if (!step || typeof step !== 'object') return null;
    const tool = String(step.tool || '').trim();
    const params = (step.params && typeof step.params === 'object') ? step.params : {};
    const rationale = String(step.rationale || '').trim();
    if (!tool) return null;
    return { tool, params, rationale };
  }

  function stepsToGraph(steps, meta, opts) {
    const nodes = [];
    let lastId = null;

    const defRetry = { maxAttempts: 1 };
    const maxChars = Number(opts?.maxChars || 15000);

    function addNode(node) {
      const n = { retryPolicy: defRetry, ...node };
      if (lastId && (!n.dependsOn || n.dependsOn.length === 0)) {
        n.dependsOn = [lastId];
      }
      nodes.push(n);
      lastId = n.id;
    }

    steps.forEach((s, idx) => {
      const i = idx + 1;
      const toolId = s.tool;
      const input = s.params || {};

      // Light normalization for common read path defaults
      if (toolId === 'readPageContent' && typeof input.maxChars === 'undefined') {
        input.maxChars = maxChars;
      }

      addNode({
        id: `r${i}_${toolId}`,
        kind: 'tool',
        toolId,
        input
      });
    });

    return TaskGraphEngine.createGraph(nodes, meta || {});
  }

  async function plan(goal, context, options) {
    try {
      if (!TaskGraphEngine) {
        return { ok: false, error: 'TaskGraphEngine unavailable' };
      }
      const tools = safeListTools();
      if (tools.length === 0) {
        return { ok: false, error: 'No tools registered' };
      }

      const prompt = buildReActPrompt(goal, context || {}, tools, options || {});
      const model = String(options?.model || 'gemini-2.5-flash');
      const tabId = Number.isFinite(options?.tabId) ? options.tabId : undefined;

      // callModelWithRotation is defined in background/background.js; use it dynamically
      const call = global.callModelWithRotation || globalThis.callModelWithRotation;
      if (typeof call !== 'function') {
        return { ok: false, error: 'Model caller not available' };
      }

      const res = await call(prompt, { model, tabId });
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'Planner model call failed', raw: res?.raw || res?.text };
      }

      const parsed = extractJson(res.text || '');
      if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        return { ok: false, error: 'Failed to parse steps from planner response', raw: res.text };
      }

      const steps = parsed.steps.map(normalizeStep).filter(Boolean);
      if (steps.length === 0) {
        return { ok: false, error: 'No valid steps after normalization', raw: res.text };
      }

      const meta = {
        requestId: options?.requestId || '',
        goal: goal || ''
      };
      const graph = stepsToGraph(steps, meta, { maxChars: options?.maxChars || 15000 });
      return { ok: true, graph, raw: res.text };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  global.ReActPlanner = {
    plan,
    stepsToGraph
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));