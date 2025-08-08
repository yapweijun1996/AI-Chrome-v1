/**
 * sidepanel/components/activity-timeline.js
 * Minimal activity timeline renderer for AgentObserver events.
 * ES module loaded by sidepanel.js
 */

const TIMELINE_KEY = "SP_TIMELINE_V1";
const MAX_RENDERED = 300;

let timelineRoot = null;
let listEl = null;

export function initActivityTimeline(rootEl) {
  timelineRoot = rootEl || document.body;

  // Create a dedicated container at the top of activity body
  const container = document.createElement("section");
  container.className = "timeline-container";
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "Agent Timeline");

  const header = document.createElement("div");
  header.className = "timeline-header";
  header.innerHTML = `<strong>Timeline</strong> <small style="color:var(--muted)">Live agent events</small>`;

  listEl = document.createElement("ul");
  listEl.id = "timelineList";
  listEl.className = "timeline-list";
  listEl.style.listStyle = "none";
  listEl.style.margin = "8px 0 12px 0";
  listEl.style.padding = "0";
  listEl.style.display = "flex";
  listEl.style.flexDirection = "column";
  listEl.style.gap = "6px";

  container.appendChild(header);
  container.appendChild(listEl);

  // Insert as the first child so it sits above success/findings/groups
  timelineRoot.insertBefore(container, timelineRoot.firstChild || null);
}

export async function loadRecentTimeline(limit = 100) {
  try {
    const got = await chrome.storage.local.get(TIMELINE_KEY);
    const arr = Array.isArray(got[TIMELINE_KEY]) ? got[TIMELINE_KEY] : [];
    const slice = arr.slice(Math.max(0, arr.length - (Number(limit) || 100)));
    // Render oldest to newest so times read naturally
    slice.forEach(evt => handleTraceMessage(evt));
  } catch (e) {
    console.warn("[Timeline] loadRecentTimeline failed:", e);
  }
}

/**
 * Handle a single trace event and render a row.
 * Can be called directly from onMessage or during backfill.
 */
export function handleTraceMessage(evt, opts = {}) {
  const root = opts.root || timelineRoot || document.body;
  if (!listEl) {
    // If not initialized, do a lazy init into root
    initActivityTimeline(root);
  }

  const li = document.createElement("li");
  li.className = "timeline-item";
  li.style.display = "grid";
  li.style.gridTemplateColumns = "24px 1fr auto";
  li.style.alignItems = "center";
  li.style.gap = "8px";
  li.style.padding = "6px 8px";
  li.style.border = "1px solid var(--border)";
  li.style.borderRadius = "8px";
  li.style.background = "var(--panel)";

  const icon = document.createElement("span");
  icon.className = "timeline-icon";
  icon.style.width = "24px";
  icon.style.height = "24px";
  icon.style.display = "inline-flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";

  icon.textContent = kindEmoji(evt.kind, evt);

  const main = document.createElement("div");
  main.className = "timeline-main";
  main.style.minWidth = "0";

  const title = document.createElement("div");
  title.className = "timeline-title";
  title.style.fontWeight = "600";
  title.style.color = "var(--text)";
  title.textContent = buildTitle(evt);

  const meta = document.createElement("div");
  meta.className = "timeline-meta";
  meta.style.color = "var(--muted)";
  meta.style.fontSize = "12px";
  meta.textContent = buildMeta(evt);

  main.appendChild(title);
  main.appendChild(meta);

  const when = document.createElement("div");
  when.className = "timeline-ts";
  when.style.fontSize = "12px";
  when.style.color = "var(--muted)";
  when.textContent = formatClock(evt.ts);

  li.appendChild(icon);
  li.appendChild(main);
  li.appendChild(when);

  // Append to end (newest last)
  listEl.appendChild(li);

  // Trim
  while (listEl.children.length > MAX_RENDERED) {
    listEl.removeChild(listEl.firstChild);
  }
}

function kindEmoji(kind, evt) {
  switch (kind) {
    case "run_state":
      return stateEmoji(evt?.state);
    case "tool_started":
      return "🟡";
    case "tool_result":
      return evt?.status === "error" || evt?.output?.status === "error" ? "🔴" : "🟢";
    default:
      return "🔷";
  }
}

function stateEmoji(state) {
  switch ((state || "").toLowerCase()) {
    case "started": return "🚀";
    case "resumed": return "🔄";
    case "stopped": return "⏹️";
    case "finished": return "✅";
    default: return "🧭";
    }
}

function buildTitle(evt) {
  const kind = evt?.kind || "event";
  if (kind === "run_state") {
    return `Run ${evt.state || "updated"}`;
  }
  if (kind === "tool_started") {
    return `Tool: ${evt.toolId || "unknown"} (started)`;
  }
  if (kind === "tool_result") {
    const status = evt.status || evt?.output?.status || (evt?.output?.ok === false ? "error" : "success");
    return `Tool: ${evt.toolId || "unknown"} (${status})`;
  }
  return kind;
}

function buildMeta(evt) {
  const parts = [];
  if (evt.kind === "run_state") {
    if (evt.meta?.goal) parts.push(`goal="${evt.meta.goal}"`);
    if (evt.meta?.model) parts.push(`model=${evt.meta.model}`);
    if (evt.meta?.reason) parts.push(`reason=${evt.meta.reason}`);
  } else if (evt.kind === "tool_started") {
    const keys = evt.input ? Object.keys(evt.input).slice(0, 3).join(", ") : "";
    parts.push(`input: { ${keys}${keys ? "" : ""} }`);
  } else if (evt.kind === "tool_result") {
    const ok = evt.output?.ok !== false;
    const ms = evt.output?.durationMs;
    parts.push(ok ? "ok" : "error");
    if (Number.isFinite(ms)) parts.push(`${formatDuration(ms)}`);
    if (evt.output?.observation) {
      parts.push(`obs: ${truncate(evt.output.observation, 80)}`);
    }
  }
  return parts.join(" · ");
}

function truncate(str, max = 80) {
  if (!str) return "";
  const s = String(str);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatClock(ts) {
  try {
    return new Date(ts || Date.now()).toLocaleTimeString();
  } catch {
    return "";
  }
}

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(0);
  return `${m}m ${rem}s`;
}