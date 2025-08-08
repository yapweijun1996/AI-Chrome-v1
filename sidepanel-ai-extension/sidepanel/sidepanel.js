import { initActivityTimeline, handleTraceMessage, loadRecentTimeline } from "./components/activity-timeline.js";
// sidepanel/sidepanel.js
// Chat-based UI for AI Assistant with Agent Mode capabilities

// Import centralized message types (in browser context)
const MSG = window.MessageTypes?.MSG || {
  PING: "PING",
  GET_ACTIVE_TAB: "GET_ACTIVE_TAB",
  EXTRACT_PAGE_TEXT: "EXTRACT_PAGE_TEXT",
  SUMMARIZE_PAGE: "SUMMARIZE_PAGE",
  CLASSIFY_INTENT: "CLASSIFY_INTENT",
  OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
  READ_API_KEY: "READ_API_KEY",
  // Agent
  AGENT_RUN: "AGENT_RUN",
  AGENT_STOP: "AGENT_STOP",
  AGENT_STATUS: "AGENT_STATUS",
  AGENT_LOG: "AGENT_LOG",
  AGENT_PROGRESS: "AGENT_PROGRESS",
  AGENT_FINDING: "AGENT_FINDING",
  SHOW_REPORT: "SHOW_REPORT",
  AGENT_ACTION_RESULT: "AGENT_ACTION_RESULT",
  // Permission flow (fallback constants; primary source is common/messages.js)
  AGENT_PERMISSION_REQUEST: "AGENT_PERMISSION_REQUEST",
  AGENT_PERMISSION_DECISION: "AGENT_PERMISSION_DECISION"
};

const ERROR_TYPES = window.MessageTypes?.ERROR_TYPES || {
  AGENT_ALREADY_RUNNING: "AGENT_ALREADY_RUNNING",
  TIMEOUT: "TIMEOUT",
  CONTENT_SCRIPT_UNAVAILABLE: "CONTENT_SCRIPT_UNAVAILABLE",
  RESTRICTED_URL: "RESTRICTED_URL"
};

const LOG_LEVELS = window.MessageTypes?.LOG_LEVELS || {
  ERROR: "error",
  WARN: "warn",
  INFO: "info", 
  DEBUG: "debug"
};

// DOM refs
const els = {
  // Header
  openOptionsBtn: document.getElementById("openOptionsBtn"),
  agentStopBtn: document.getElementById("agentStopBtn"),
  clearChatBtn: document.getElementById("clearChatBtn"),
  toggleActivityBtn: document.getElementById("toggleActivityBtn"),
  
  // Layout
  spLayout: document.getElementById("spLayout"),
  activityPanel: document.getElementById("activityPanel"),
  activityBody: document.getElementById("activityBody"),
  activityGroups: document.getElementById("activityGroups"),
  collapseActivityBtn: document.getElementById("collapseActivityBtn"),
  activityFilter: document.getElementById("activityFilter"),
  activitySearch: document.getElementById("activitySearch"),
  successCriteria: document.getElementById("successCriteria"),
  findingsTable: document.getElementById("findingsTable"),

   // Chat
    stepperBar: document.getElementById("stepperBar"),
    chatMessages: document.getElementById("chatMessages"),
    chatInput: document.getElementById("chatInput"),
    sendBtn: document.getElementById("sendBtn"),
    // Toasts
    toastContainer: document.getElementById("toastContainer"),
    
    // Quick actions (new toolbar)
  qaSummarize: document.getElementById("qaSummarize"),
  qaExtractLinks: document.getElementById("qaExtractLinks"),
  qaOutline: document.getElementById("qaOutline"),
  qaNavigate: document.getElementById("qaNavigate"),
  contextChips: document.getElementById("contextChips"),
  
  // Legacy quick actions (compat)
  btnSummarize: document.getElementById("btnSummarize"),
  btnAgentMode: document.getElementById("btnAgentMode"),
  btnTasks: document.getElementById("btnTasks"),
  
  // Agent Modal
  agentModal: document.getElementById("agentModal"),
  closeAgentModal: document.getElementById("closeAgentModal"),
  agentStartBtn: document.getElementById("agentStartBtn"),
  cancelAgentBtn: document.getElementById("cancelAgentBtn"),
  agentGoal: document.getElementById("agentGoal"),
  allowCrossDomain: document.getElementById("allowCrossDomain"),
  allowTabMgmt: document.getElementById("allowTabMgmt"),
  autoScreenshots: document.getElementById("autoScreenshots"),
  maxSteps: document.getElementById("maxSteps"),
  
  // Tasks Modal
  tasksModal: document.getElementById("tasksModal"),
  closeTasksModal: document.getElementById("closeTasksModal"),
  taskTitle: document.getElementById("taskTitle"),
  addTaskBtn: document.getElementById("addTaskBtn"),
  taskList: document.getElementById("taskList"),
};

const storageKeys = {
  TASKS: "SP_TASKS_V1",
  AGENT_SETTINGS: "SP_AGENT_SETTINGS_V1",
  CHAT_HISTORY: "SP_CHAT_HISTORY_V1",
  UI_ACTIVITY_OPEN: "SP_UI_ACTIVITY_OPEN_V1"
};

 // Chat state
let isTyping = false;
let currentAgentSession = null;
let statusCheckInterval = null;
let isAgentRunning = false;
let currentPlanMessage = null;
let currentStatusBubble = null; // Phase 3: Single status bubble for progress updates
let clarificationContext = null; // For handling ambiguous query clarification

// Slash commands state (UI-only; no CSS dependency)
const SLASH_COMMANDS = [
  { key: 'summarize', label: '/summarize', desc: 'Summarize current page', template: 'Summarize this page in 5 concise bullet points.', autoSend: true },
  { key: 'extract', label: '/extract-links', desc: 'Extract all links on the page', template: 'Extract all links on this page as a Markdown table with columns: Title, URL.', autoSend: true },
  { key: 'outline', label: '/outline', desc: 'Create outline of this page', template: 'Create a hierarchical outline of this page with headings and key points.', autoSend: true },
  { key: 'navigate', label: '/navigate', desc: 'Navigate to a URL', template: 'Navigate to https://', autoSend: false },
  { key: 'screenshot', label: '/screenshot', desc: 'Take a screenshot and include it in results', template: 'Take a screenshot of the current page and include it in the results.', autoSend: true },
  { key: 'help', label: '/help', desc: 'List available commands', template: 'List available commands and how to use them.', autoSend: true },
];
let slashMenuEl = null;
let slashFiltered = [];
let slashActiveIndex = -1;
let slashOpen = false;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

async function loadTasks() {
  const result = await chrome.storage.local.get(storageKeys.TASKS);
  const tasks = result[storageKeys.TASKS] || [];
  return tasks;
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({ [storageKeys.TASKS]: tasks });
}

function renderTasks(tasks) {
  els.taskList.innerHTML = "";
  for (const t of tasks) {
    const li = document.createElement("li");
    li.className = "task";
    li.dataset.id = t.id;
    li.innerHTML = `
      <input type="checkbox" ${t.done ? "checked" : ""} class="chk" title="Mark done">
      <span class="title">${escapeHtml(t.title)}</span>
      <span class="status">${t.done ? "done" : "todo"}</span>
      <button class="icon del" title="Delete">&#128465;</button>
    `;
    // events
    li.querySelector(".chk").addEventListener("change", async (e) => {
      t.done = !!e.target.checked;
      await saveTasks(tasks);
      renderTasks(tasks);
    });
    li.querySelector(".del").addEventListener("click", async () => {
      const idx = tasks.findIndex(x => x.id === t.id);
      if (idx >= 0) tasks.splice(idx, 1);
      await saveTasks(tasks);
      renderTasks(tasks);
    });
    els.taskList.appendChild(li);
  }
}

function escapeHtml(str = "") {
  // Robust HTML escape without using literal quotes in source (avoids tooling corruption).
  // We build entity strings from character codes, so the source never contains a raw " or ' in the mapping values.
  const AMP = String.fromCharCode(38) + "amp;";       // &
  const LT  = String.fromCharCode(38) + "lt;";        // <
  const GT  = String.fromCharCode(38) + "gt;";        // >
  const QUOT = String.fromCharCode(38) + "quot;";     // "
  const APOS = "&#" + "39;";                           // '

  return String(str).replace(/[&<>\u0022\u0027]/g, function (ch) {
    switch (ch) {
      case "&": return AMP;
      case "<": return LT;
      case ">": return GT;
      case "\u0022": return QUOT; // double quote
      case "\u0027": return APOS; // single quote
      default: return ch;
    }
  });
}

async function addTaskFromInput() {
  const title = (els.taskTitle.value || "").trim();
  if (!title) return;
  const tasks = await loadTasks();
  tasks.unshift({ id: uid(), title, done: false, createdAt: Date.now() });
  await saveTasks(tasks);
  els.taskTitle.value = "";
  renderTasks(tasks);
}

async function initTasksUI() {
  const tasks = await loadTasks();
  renderTasks(tasks);
  els.addTaskBtn.addEventListener("click", addTaskFromInput);
  els.taskTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTaskFromInput();
  });
}


async function bgSend(msg) {
  return await chrome.runtime.sendMessage(msg);
}

// Enhanced agent state management
async function checkAgentStatus() {
  try {
    const res = await bgSend({ type: MSG.AGENT_STATUS });
    if (res?.ok && res.session) {
      const session = res.session;
      currentAgentSession = session;
      const wasRunning = isAgentRunning;
      isAgentRunning = session.running;
      
      // Update UI based on status changes
      updateAgentStatusUI(session, wasRunning);

      // If the session has a plan, render or update it
      if (session.subTasks && session.subTasks.length > 0) {
        if (!currentPlanMessage) {
          // If no plan is currently displayed, render it.
          const planContainer = addMessage('assistant', '');
          renderPlan(planContainer.querySelector('.content'), session.subTasks);
          currentPlanMessage = planContainer;
        }
        updatePlan(session.currentTaskIndex || 0);
      }

      // Render success criteria
      if (session.successCriteria) {
        renderSuccessCriteria(session.successCriteria, session.findings);
      }

      // Render findings table
      if (session.findings) {
        renderFindings(session.findings);
      }
      
      return session;
    } else {
      if (isAgentRunning) {
        isAgentRunning = false;
        updateAgentStatusUI(null, true);
      }
      currentAgentSession = null;
    }
  } catch (e) {
    console.warn('Failed to check agent status:', e);
  }
  return null;
}

function updateAgentStatusUI(session, wasRunning) {
  const stopBtn = els.agentStopBtn;
  
  if (!stopBtn) return;
  
  if (session?.running) {
    // Agent is running
    stopBtn.style.display = 'block';
    stopBtn.classList.add('active');
    stopBtn.title = `Agent running (step ${session.step || 0}/${session.settings?.maxSteps || 'N/A'}) - Click to stop`;
    
    // Status monitoring is managed centrally via startStatusMonitoring()
  } else {
    // Agent is not running
    stopBtn.style.display = 'none';
    stopBtn.classList.remove('active');
    stopBtn.title = 'Emergency STOP';
    
    // Stop status monitoring
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval);
      statusCheckInterval = null;
    }
    
    // Show completion message if agent just finished
    if (wasRunning && session?.stopped) {
      const reason = session.stopped === true ? 'completed' : 'stopped';
      addMessage('assistant', `Agent ${reason}. Total steps: ${session.step || 0}`);
    }
  }
}

function startStatusMonitoring() {
  // Check status immediately
  checkAgentStatus();
  
  // Set up periodic checking
  if (!statusCheckInterval) {
    statusCheckInterval = setInterval(checkAgentStatus, 3000);
  }
}

function stopStatusMonitoring() {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
}

async function checkApiKeyWarn() {
  const { ok, apiKey } = await bgSend({ type: MSG.READ_API_KEY });
  if (!ok || !apiKey) {
    // Phase 4: Better API key error message with visual cue
    addMessage('assistant', '🔑 **API Key Required**\n\nTo use AI features, you need to set up your Gemini API key.\n\n**How to get started:**\n1. Click the ⚙️ gear icon in the header\n2. Enter your Gemini API key\n3. Save and try again\n\n[Get a free API key at makersuite.google.com](https://makersuite.google.com/app/apikey)');
    
    // Add visual highlight to settings button
    if (els.openOptionsBtn) {
      els.openOptionsBtn.classList.add('highlight-attention');
      setTimeout(() => {
        els.openOptionsBtn.classList.remove('highlight-attention');
      }, 3000);
    }
    return false;
  }
  return true;
}

function openOptionsPage() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("../options/options.html"));
  }
}

/* -------- Context Chips and Quick Actions -------- */
function buildChip(label, value, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'context-chip';
  chip.title = value || label;
  chip.innerHTML = `<span class="prefix">${escapeHtml(label)}</span><span class="value">${escapeHtml(value || '')}</span>`;
  if (typeof onClick === 'function') {
    chip.addEventListener('click', onClick);
  }
  return chip;
}

function insertTextAtCursor(textarea, text) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
}

async function updateContextChips() {
  try {
    if (!els.contextChips) return;
    els.contextChips.innerHTML = '';

    const res = await bgSend({ type: MSG.GET_ACTIVE_TAB });
    const url = res?.tab?.url || '';
    const title = res?.tab?.title || '';

    if (url) {
      try {
        const u = new URL(url);
        const host = u.host;
        els.contextChips.appendChild(
          buildChip('URL', host, () => {
            insertTextAtCursor(els.chatInput, ` ${url} `);
            els.chatInput.focus();
          })
        );
      } catch {
        els.contextChips.appendChild(
          buildChip('URL', url, () => {
            insertTextAtCursor(els.chatInput, ` ${url} `);
            els.chatInput.focus();
          })
        );
      }
    }

    if (title) {
      els.contextChips.appendChild(
        buildChip('TITLE', title, () => {
          insertTextAtCursor(els.chatInput, ` "${title}" `);
          els.chatInput.focus();
        })
      );
    }

    // Screenshot stub chip to streamline common action
    els.contextChips.appendChild(
      buildChip('SHOT', 'Screenshot', async () => {
        const hasKey = await checkApiKeyWarn();
        if (!hasKey) return;
        await prefillAndSend('Take a screenshot of the current page and include it in the results.');
      })
    );
  } catch (e) {
    console.warn('updateContextChips failed:', e);
  }
}

async function prefillAndSend(text) {
  if (!els.chatInput) return;
  els.chatInput.value = text;
  await sendMessage();
  // Ensure the activity drawer opens so users can see live logs
  ensureActivityOpen();
}

/* -------- Slash Commands (inline autocomplete) -------- */
function ensureSlashMenuEl() {
  if (slashMenuEl) return slashMenuEl;
  const el = document.createElement('div');
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Slash commands');
  el.style.position = 'fixed';
  el.style.zIndex = '50';
  el.style.background = 'var(--panel)';
  el.style.border = '1px solid var(--border)';
  el.style.borderRadius = '8px';
  el.style.padding = '6px 0';
  el.style.boxShadow = '0 8px 24px rgba(0,0,0,0.3)';
  el.style.maxHeight = '240px';
  el.style.overflowY = 'auto';
  el.style.minWidth = '220px';
  el.style.display = 'none';
  document.body.appendChild(el);
  slashMenuEl = el;
  return el;
}

function positionSlashMenu() {
  if (!slashMenuEl || !els.chatInput) return;
  const rect = els.chatInput.getBoundingClientRect();
  const width = Math.min(rect.width, 360);
  slashMenuEl.style.width = width + 'px';
  let top = rect.bottom + 6;
  let left = rect.left;
  slashMenuEl.style.left = left + 'px';
  slashMenuEl.style.top = top + 'px';
  // If off-screen bottom, place above the input
  const menuRect = slashMenuEl.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 6;
    slashMenuEl.style.top = Math.max(8, top) + 'px';
  }
}

function renderSlashMenu() {
  if (!slashMenuEl) return;
  slashMenuEl.innerHTML = '';
  slashFiltered.forEach((cmd, idx) => {
    const item = document.createElement('div');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', idx === slashActiveIndex ? 'true' : 'false');
    item.style.padding = '8px 12px';
    item.style.display = 'grid';
    item.style.gridTemplateColumns = 'auto 1fr';
    item.style.gap = '6px 10px';
    item.style.cursor = 'pointer';
    item.style.background = idx === slashActiveIndex ? 'rgba(255,255,255,0.05)' : 'transparent';

    const name = document.createElement('div');
    name.textContent = cmd.label;
    name.style.fontWeight = '600';
    name.style.color = 'var(--text)';

    const desc = document.createElement('div');
    desc.textContent = cmd.desc;
    desc.style.color = 'var(--muted)';
    desc.style.fontSize = '12px';

    item.appendChild(name);
    item.appendChild(desc);

    item.addEventListener('mouseenter', () => {
      slashActiveIndex = idx;
      renderSlashMenu();
    });
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent textarea blur
      selectSlashItem(idx);
    });

    slashMenuEl.appendChild(item);
  });
}

function openSlashMenu(query = '') {
  ensureSlashMenuEl();
  const q = (query || '').toLowerCase();
  slashFiltered = SLASH_COMMANDS.filter(c =>
    !q ||
    c.key.includes(q) ||
    c.label.toLowerCase().includes(q) ||
    c.desc.toLowerCase().includes(q)
  );
  if (slashFiltered.length === 0) {
    closeSlashMenu();
    return;
  }
  slashActiveIndex = 0;
  renderSlashMenu();
  slashMenuEl.style.display = 'block';
  slashOpen = true;
  positionSlashMenu();
}

function closeSlashMenu() {
  if (!slashMenuEl) return;
  slashMenuEl.style.display = 'none';
  slashOpen = false;
  slashActiveIndex = -1;
  slashFiltered = [];
}

function selectSlashItem(idx) {
  const cmd = slashFiltered[idx];
  if (!cmd) return;
  closeSlashMenu();
  if (!els.chatInput) return;
  els.chatInput.value = cmd.template;
  if (cmd.autoSend) {
    prefillAndSend(cmd.template);
  } else {
    els.chatInput.focus();
    // Move caret to end
    const end = els.chatInput.value.length;
    els.chatInput.setSelectionRange(end, end);
  }
}

function onChatInputInput(e) {
  const val = e.target.value || '';
  if (val.startsWith('/')) {
    const q = val.slice(1);
    openSlashMenu(q);
  } else {
    if (slashOpen) closeSlashMenu();
  }
}

function onChatInputKeydown(e) {
  if (!slashOpen) return;
  if (e.key === 'ArrowDown' || e.key === 'Down') {
    e.preventDefault();
    if (slashFiltered.length > 0) {
      slashActiveIndex = (slashActiveIndex + 1) % slashFiltered.length;
      renderSlashMenu();
    }
  } else if (e.key === 'ArrowUp' || e.key === 'Up') {
    e.preventDefault();
    if (slashFiltered.length > 0) {
      slashActiveIndex = (slashActiveIndex - 1 + slashFiltered.length) % slashFiltered.length;
      renderSlashMenu();
    }
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    e.preventDefault();
    selectSlashItem(Math.max(0, slashActiveIndex));
  } else if (e.key === 'Escape' || e.key === 'Esc') {
    e.preventDefault();
    closeSlashMenu();
  }
}

 // -------- Chat System --------

async function loadChatHistory() {
  const result = await chrome.storage.local.get(storageKeys.CHAT_HISTORY);
  const history = result[storageKeys.CHAT_HISTORY] || [];
  return history;
}

async function saveChatHistory(history) {
  await chrome.storage.local.set({ [storageKeys.CHAT_HISTORY]: history });
}

async function clearChatHistory() {
  // Clear storage
  await chrome.storage.local.set({ [storageKeys.CHAT_HISTORY]: [] });
  // Clear UI
  els.chatMessages.innerHTML = "";
  // Add optional empty-state helper
  addMessage('assistant', 'Chat cleared.');
  // Non-blocking UX feedback
  if (typeof showToast === 'function') {
    showToast('Chat cleared', 'info');
  }
}

function addMessage(role, content, timestamp = Date.now(), isMarkdown = false) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;
  
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'U' : 'AI';
  
  const messageContent = document.createElement('div');
  messageContent.className = 'content';
  
  if (isMarkdown) {
    if (window.marked && typeof window.marked.parse === 'function') {
      messageContent.innerHTML = window.marked.parse(content);
    } else {
      messageContent.textContent = content;
    }
  } else {
    messageContent.textContent = content;
  }
  
  const timestampDiv = document.createElement('div');
  timestampDiv.className = 'timestamp';
  timestampDiv.textContent = new Date(timestamp).toLocaleTimeString();
  
  messageDiv.appendChild(avatar);
  const contentWrapper = document.createElement('div');
  contentWrapper.appendChild(messageContent);
  contentWrapper.appendChild(timestampDiv);
  messageDiv.appendChild(contentWrapper);
  
  els.chatMessages.appendChild(messageDiv);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  
  return messageDiv;
}

function showTypingIndicator() {
  if (isTyping) return;
  isTyping = true;
  
  const typingDiv = document.createElement('div');
  typingDiv.className = 'typing-indicator';
  typingDiv.id = 'typing-indicator';
  
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'AI';
  
  const dotsDiv = document.createElement('div');
  dotsDiv.className = 'typing-dots';
  dotsDiv.innerHTML = '<span></span><span></span><span></span>';
  
  typingDiv.appendChild(avatar);
  typingDiv.appendChild(dotsDiv);
  
  els.chatMessages.appendChild(typingDiv);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function hideTypingIndicator() {
  isTyping = false;
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.remove();
  }
}

async function sendMessage() {
  // Ensure any open slash menu is closed before sending
  closeSlashMenu();

  const input = els.chatInput.value.trim();
  if (!input) return;
  
  // Add user message
  addMessage('user', input);
  els.chatInput.value = '';
  
  // Show typing indicator
  showTypingIndicator();
  
  try {
    // Check API key
    const hasKey = await checkApiKeyWarn();
    if (!hasKey) {
      hideTypingIndicator();
      addMessage('assistant', 'Please set your Gemini API key(s) in settings (gear icon) to continue.');
      return;
    }
    
    // Process the message
    const response = await processUserMessage(input);
    hideTypingIndicator();
    // The new coordinator returns a summary for quick answers, or an agentStarted flag.
    if (typeof response === 'string') {
      // Treat as a formatted error message (Markdown)
      addMessage('assistant', response, Date.now(), true);
    } else if (response && response.summary) {
      addMessage('assistant', response.summary);
    } else if (response && response.agentStarted) {
      addMessage('assistant', `I'm starting the web automation to handle your request: "${response.goal}". I'll keep you updated!`);
      startStatusMonitoring();
    } else if (response && response.errorMsg) {
      addMessage('assistant', response.errorMsg, Date.now(), true);
    } else {
      addMessage('assistant', "I'm not sure how to handle that request. Please try rephrasing.");
    }
    
    // Save to history
    const history = await loadChatHistory();
    const assistantResponse = response.summary || `Agent started for: ${response.goal}`;
    history.push(
      { role: 'user', content: input, timestamp: Date.now() },
      { role: 'assistant', content: assistantResponse, timestamp: Date.now() }
    );
    // Keep only last 50 messages
    if (history.length > 50) {
      history.splice(0, history.length - 50);
    }
    await saveChatHistory(history);
    
  } catch (error) {
    hideTypingIndicator();
    // Phase 4: Better error formatting in chat
    const errorMsg = formatChatError(error);
    addMessage('assistant', errorMsg);
  }
}

async function processUserMessage(message) {
  // All user messages now go through the coordinator in the background script.
  const response = await bgSend({
    type: MSG.COORDINATE_AND_EXECUTE,
    userMessage: message,
  });

  if (!response?.ok) {
    return formatChatError(response?.error || 'Coordinator failed to respond.');
  }

  return response;
}

// New function to handle ambiguous messages with clarification
async function handleAmbiguousClarification(message) {
  // Set the context that we are waiting for a choice
  clarificationContext = {
    originalMessage: message,
  };

  // Phase 4: Enhanced clarification with better UX
  const clarificationMsg = `🤔 **I need a bit more clarity**\n\nYour request: "${message}"\n\n**Choose an option by typing the number:**\n\n1. **Quick Answer** - I'll provide information without browsing\n   *Example: "What is JavaScript?"*\n\n2. **Web Automation** - I'll navigate and interact with websites\n   *Example: "Navigate to GitHub and search for React"*\n\n**Tip:** Start with action words like:\n• "Explain..." or "What is..." for information\n• "Navigate to..." or "Click on..." for automation`;
  
  return clarificationMsg;
}

async function handleClarificationResponse(choice) {
  const originalMessage = clarificationContext.originalMessage;
  clarificationContext = null; // Reset context immediately
  
  const choiceLower = choice.toLowerCase().trim();
  
  if (choiceLower === '1' || choiceLower.includes('quick answer')) {
    addMessage('user', `(Clarification for "${originalMessage}") -> Quick Answer`);
    return await handleGeneralChat(originalMessage);
  } else if (choiceLower === '2' || choiceLower.includes('web automation')) {
    addMessage('user', `(Clarification for "${originalMessage}") -> Web Automation`);
    return await handleAgentIntent(originalMessage);
  } else {
    // Invalid choice, ask again.
    addMessage('assistant', "That wasn't a valid choice. Please try again.");
    return await handleAmbiguousClarification(originalMessage); // This will re-set the context and return the prompt.
  }
}

/**
 * Enhanced AI-powered intent classification with ambiguity detection
 */
async function classifyUserIntentEnhanced(message) {
  try {
    // Get current page context
    const tabRes = await bgSend({ type: MSG.GET_ACTIVE_TAB });
    const currentContext = {
      url: tabRes?.tab?.url || 'Unknown',
      title: tabRes?.tab?.title || 'Unknown',
      previousActions: [] // Could be populated from chat history
    };

    // Use the enhanced classification message type
    const result = await bgSend({
      type: MSG.CLASSIFY_INTENT_ENHANCED,
      userMessage: message,
      currentContext: currentContext
    });

    if (!result?.ok) {
      console.warn('Enhanced intent classification failed:', result?.error);
      return null;
    }

    if (result.result && result.result.success) {
      console.log('Enhanced AI Intent Classification:', result.result);
      return result.result;
    }

    return null;
  } catch (error) {
    console.error('Enhanced intent classification error:', error);
    return null;
  }
}

/**
 * Handle clarification requests for ambiguous queries
 */
async function handleClarificationRequest(originalMessage, enhancedResult) {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Create clarification request
    const clarificationRes = await bgSend({
      type: MSG.REQUEST_CLARIFICATION,
      sessionId: sessionId,
      userMessage: originalMessage,
      classificationResult: enhancedResult,
      context: {
        timestamp: Date.now(),
        chatHistory: await loadChatHistory()
      }
    });

    if (!clarificationRes?.ok) {
      return "I need more information to help you, but I'm having trouble processing your request. Could you please be more specific about what you'd like me to do?";
    }

    const clarificationRequest = clarificationRes.result.request;
    
    // Generate clarification message for the user
    return await generateClarificationMessage(clarificationRequest, sessionId);
    
  } catch (error) {
    console.error('Clarification request failed:', error);
    return "I need more information to help you effectively. Could you please provide more details about what you'd like me to do?";
  }
}

/**
 * Generate user-friendly clarification message
 */
async function generateClarificationMessage(clarificationRequest, sessionId) {
  const prompts = clarificationRequest.prompts;
  
  if (!prompts || prompts.length === 0) {
    return "Could you please provide more details about what you'd like me to help you with?";
  }

  const mainPrompt = prompts[0];
  let clarificationMessage = mainPrompt.message;

  // Add interactive elements based on prompt type
  switch (mainPrompt.type) {
    case 'multiple_choice':
      clarificationMessage += "\n\nPlease choose one of the following options:";
      mainPrompt.options.forEach((option, index) => {
        clarificationMessage += `\n${index + 1}. ${option.description}`;
      });
      if (mainPrompt.allowCustom) {
        clarificationMessage += `\n${mainPrompt.options.length + 1}. ${mainPrompt.customPrompt}`;
      }
      break;

    case 'context_gathering':
      clarificationMessage += "\n\nPlease provide the following information:";
      mainPrompt.questions.forEach((question, index) => {
        clarificationMessage += `\n${index + 1}. ${question.question}`;
      });
      break;

    case 'confidence_check':
      clarificationMessage += "\n\nPlease respond with:";
      mainPrompt.options.forEach((option, index) => {
        clarificationMessage += `\n${index + 1}. ${option.text}`;
      });
      break;

    case 'open_clarification':
      if (mainPrompt.suggestions && mainPrompt.suggestions.length > 0) {
        clarificationMessage += "\n\nFor example, you might want to:";
        mainPrompt.suggestions.forEach((suggestion, index) => {
          clarificationMessage += `\n• ${suggestion}`;
        });
      }
      if (mainPrompt.followUp) {
        clarificationMessage += `\n\n${mainPrompt.followUp}`;
      }
      break;

    case 'page_context':
      if (mainPrompt.suggestions && mainPrompt.suggestions.length > 0) {
        mainPrompt.suggestions.forEach((suggestion, index) => {
          clarificationMessage += `\n${index + 1}. ${suggestion}`;
        });
      }
      break;
  }

  // Store the clarification context for follow-up processing
  // This would be handled by the clarification manager in a real implementation
  
  return clarificationMessage;
}

/**
 * Route message based on intent classification
 */
async function routeBasedOnIntent(message, intent) {
  if (!intent) {
    return await handleGeneralChat(message);
  }

  // Route to appropriate handler based on AI classification
  switch (intent.intent) {
    case 'YOUTUBE':
      return await handleYouTubeIntent(message, intent);
    case 'NAVIGATION':
      return await handleNavigationIntent(message, intent);
    case 'RESEARCH':
      return await handleResearchIntent(message, intent);
    case 'SHOPPING':
      return await handleShoppingIntent(message, intent);
    case 'AUTOMATION':
      return await handleAgentIntent(message, intent);
    case 'CONVERSATION':
      // Check for specific conversation types
      if (message.toLowerCase().includes('summarize') || message.toLowerCase().includes('summary')) {
        return await handleSummarizeChat();
      }
      if (message.toLowerCase().includes('task') || message.toLowerCase().includes('todo')) {
        return "I can help you manage tasks. Would you like me to create a new task or show your existing ones?";
      }
      return await handleGeneralChat(message);
    default:
      return await handleAgentIntent(message);
  }
}

/**
 * Handle shopping-related intents with enhanced pricing research
 */
async function handleShoppingIntent(message, intent = null) {
  // Check if API key is available
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) {
    return 'Please set your Gemini API key in settings (gear icon) before I can help with shopping research.';
  }
  
  // Use enhanced research approach for shopping queries
  const shoppingGoal = `Find comprehensive pricing and product information: ${message}`;
  
  const intentMessage = intent ?
    `I understand you want to ${intent.suggestedAction}. Let me research pricing and product information for you.` :
    `I'll help you find pricing and product information. Let me search multiple sources for you.`;
  
  addMessage('assistant', intentMessage);
  
  // Use enhanced research settings with pricing focus
  const settings = {
    allowCrossDomain: true,
    allowTabMgmt: true,
    autoScreenshots: true,
    maxSteps: 25 // More steps for comprehensive shopping research
  };
  
  try {
    const res = await bgSend({ type: MSG.AGENT_RUN, goal: shoppingGoal, settings });
    if (!res?.ok) {
      return getErrorMessage(res?.error, res?.errorType);
    }
    
    // Start monitoring agent status
    startStatusMonitoring();
    
    return "I'm now researching pricing and product information for you. I'll search multiple sources, compare prices, and provide you with comprehensive shopping insights. You can use the STOP button if needed.";
  } catch (error) {
    return `Error starting shopping research: ${error.message || 'Something went wrong'}`;
  }
  
  function getErrorMessage(error, errorType) {
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "I'm already working on another task. Please wait for it to finish or use the STOP button first.";
      case ERROR_TYPES.RESTRICTED_URL:
        return "I can't research from this page due to browser restrictions. Try navigating to a regular website first.";
      default:
        return `I couldn't start the shopping research: ${error || "unknown error"}`;
    }
  }
}

/**
 * AI-powered intent classification function
 */
async function classifyUserIntent(message) {
  try {
    // Get current page context
    const tabRes = await bgSend({ type: MSG.GET_ACTIVE_TAB });
    const currentContext = {
      url: tabRes?.tab?.url || 'Unknown',
      title: tabRes?.tab?.title || 'Unknown'
    };

    // Use the dedicated CLASSIFY_INTENT message type that doesn't require page access
    const result = await bgSend({
      type: MSG.CLASSIFY_INTENT,
      userMessage: message,
      currentContext: currentContext
    });

    if (!result?.ok) {
      console.warn('Intent classification failed:', result?.error);
      return null;
    }

    // The classification is already parsed by the background script
    if (result.classification && result.classification.intent) {
      console.log('AI Intent Classification:', result.classification);
      return result.classification;
    }

    return null;
  } catch (error) {
    console.error('Intent classification error:', error);
    return null;
  }
}

// Removed hardcoded shouldTrigger functions - now using AI-powered intent classification

async function handleResearchIntent(message, intent = null) {
  // Check if API key is available
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) {
    return 'Please set your Gemini API key in settings (gear icon) before I can help with research.';
  }
  
  // For research queries, we'll use a specialized research agent approach
  const researchGoal = `Research and provide comprehensive information about: ${message}`;
  
  const intentMessage = intent ?
    `I understand you want to ${intent.suggestedAction}. Let me gather comprehensive information for you.` :
    `I'll help you research that topic. Let me gather comprehensive information for you.`;
  
  addMessage('assistant', intentMessage);
  
  // Use enhanced research settings
  const settings = {
    allowCrossDomain: true,
    allowTabMgmt: true,
    autoScreenshots: true, // Enable screenshots for research
    maxSteps: 20 // More steps for thorough research
  };
  
  try {
    const res = await bgSend({ type: MSG.AGENT_RUN, goal: researchGoal, settings });
    if (!res?.ok) {
      return getErrorMessage(res?.error, res?.errorType);
    }
    
    // Start monitoring agent status
    startStatusMonitoring();
    
    return "I'm now researching this topic for you. I'll search multiple sources, gather information, and provide you with a comprehensive summary. You can use the STOP button if needed.";
  } catch (error) {
    return `Error starting research: ${error.message || 'Something went wrong'}`;
  }
  
  function getErrorMessage(error, errorType) {
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "I'm already working on another task. Please wait for it to finish or use the STOP button first.";
      case ERROR_TYPES.RESTRICTED_URL:
        return "I can't research from this page due to browser restrictions. Try navigating to a regular website first.";
      default:
        return `I couldn't start the research: ${error || "unknown error"}`;
    }
  }
}

async function handleYouTubeIntent(message, intent = null) {
  // Check if API key is available
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) {
    return 'Please set your Gemini API key in settings (gear icon) before I can help with YouTube actions.';
  }
  
  // Use YouTube-specific agent approach
  const youtubeGoal = `YouTube task: ${message}`;
  
  const intentMessage = intent ?
    `I understand you want to ${intent.suggestedAction}. Let me handle that for you.` :
    `I'll help you with that YouTube task. Let me navigate and interact with YouTube for you.`;
  
  addMessage('assistant', intentMessage);
  
  // Use settings optimized for YouTube interaction
  const settings = {
    allowCrossDomain: true,
    allowTabMgmt: true,
    autoScreenshots: false,
    maxSteps: 15 // More steps for YouTube navigation
  };
  
  try {
    const res = await bgSend({ type: MSG.AGENT_RUN, goal: youtubeGoal, settings });
    if (!res?.ok) {
      return getErrorMessage(res?.error, res?.errorType);
    }
    
    // Start monitoring agent status
    startStatusMonitoring();
    
    return "I'm now working on your YouTube request. I'll navigate to YouTube, search for the content, and interact with it as needed. You can use the STOP button if needed.";
  } catch (error) {
    return `Error starting YouTube task: ${error.message || 'Something went wrong'}`;
  }
  
  function getErrorMessage(error, errorType) {
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "I'm already working on another task. Please wait for it to finish or use the STOP button first.";
      case ERROR_TYPES.RESTRICTED_URL:
        return "I can't perform YouTube actions from this page due to browser restrictions. Try navigating to a regular website first.";
      default:
        return `I couldn't start the YouTube task: ${error || "unknown error"}`;
    }
  }
}

async function handleNavigationIntent(message, intent = null) {
  // Check if API key is available
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) {
    return 'Please set your Gemini API key in settings (gear icon) before I can help with navigation.';
  }
  
  // Use navigation-specific agent approach
  const navigationGoal = `Navigation task: ${message}`;
  
  const intentMessage = intent ?
    `I understand you want to ${intent.suggestedAction}. Starting navigation now.` :
    `I'll help you navigate and interact with websites. Starting automation now.`;
  
  addMessage('assistant', intentMessage);
  
  // Use settings optimized for navigation
  const settings = {
    allowCrossDomain: true,
    allowTabMgmt: true,
    autoScreenshots: false,
    maxSteps: 12
  };
  
  try {
    const res = await bgSend({ type: MSG.AGENT_RUN, goal: navigationGoal, settings });
    if (!res?.ok) {
      return getErrorMessage(res?.error, res?.errorType);
    }
    
    // Start monitoring agent status
    startStatusMonitoring();
    
    return "I'm now working on your navigation request. I'll navigate to the appropriate websites and perform the actions you requested. You can use the STOP button if needed.";
  } catch (error) {
    return `Error starting navigation task: ${error.message || 'Something went wrong'}`;
  }
  
  function getErrorMessage(error, errorType) {
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "I'm already working on another task. Please wait for it to finish or use the STOP button first.";
      case ERROR_TYPES.RESTRICTED_URL:
        return "I can't perform navigation actions from this page due to browser restrictions. Try navigating to a regular website first.";
      default:
        return `I couldn't start the navigation task: ${error || "unknown error"}`;
    }
  }
}

// Removed shouldTriggerAgent function - now using AI-powered intent classification

async function handleAgentIntent(message, intent = null) {
  // Check if API key is available
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) {
    return 'Please set your Gemini API key in settings (gear icon) before I can automate tasks.';
  }
  
  // Start agent automatically with the user's message as the goal
  addMessage('assistant', `I'll help you automate that task. Starting agent with goal: "${message}"`);
  
  // Use default agent settings
  const settings = {
    allowCrossDomain: true,
    allowTabMgmt: true,
    autoScreenshots: false,
    maxSteps: 12
  };
  
  try {
    const res = await bgSend({ type: MSG.AGENT_RUN, goal: message, settings });
    if (!res?.ok) {
      return getErrorMessage(res?.error, res?.errorType);
    }
    
    // Start monitoring agent status  
    startStatusMonitoring();
    
    return "Agent started! I'll keep you updated on my progress. You can use the STOP button anytime to halt the automation.";
  } catch (error) {
    return `Error starting agent: ${error.message || 'Something went wrong'}`;
  }
  
  function getErrorMessage(error, errorType) {
    // Phase 4: User-friendly error messages with actionable guidance
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "🔄 **Agent already active**\n\nI'm currently working on another task. You can:\n• Wait for the current task to complete\n• Click the STOP button (red button in header) to halt the current task\n• Check the activity panel for progress details";
      case ERROR_TYPES.RESTRICTED_URL:
        return "🚫 **Browser restrictions**\n\nI can't automate browser system pages (chrome://, about:, etc).\n\n**What to do:**\n• Navigate to any regular website (e.g., google.com)\n• Then try your automation request again";
      case ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE:
        return "⚠️ **Page access issue**\n\nI can't interact with this page right now.\n\n**Quick fixes:**\n• Refresh the page (Ctrl/Cmd + R)\n• Wait a moment for the page to fully load\n• Try navigating to a different website";
      default:
        return `❌ **Something went wrong**\n\nI couldn't start the automation.\n\n**Error details:** ${error || "Unknown error"}\n\n**Try:**\n• Refreshing the page\n• Checking your internet connection\n• Restarting the extension`;
    }
  }
}

async function handleSummarizeChat() {
  const res = await bgSend({ type: MSG.SUMMARIZE_PAGE, maxChars: 20000 });
  if (!res?.ok) {
    return `I couldn't summarize the page: ${res?.error || "unknown error"}`;
  }
  return res.summary || "(no content found)";
}

async function handleGeneralChat(message) {
  // Phase 2: Check if page context is actually needed for this query
  const messageLower = message.toLowerCase();
  
  // Keywords that indicate page context is needed
  const pageContextKeywords = [
    'this page', 'current page', 'this site', 'this website',
    'above', 'below', 'here', 'this article', 'this content',
    'what does it say', 'on this page', 'in this document'
  ];
  
  const needsPageContext = pageContextKeywords.some(keyword =>
    messageLower.includes(keyword)
  );
  
  if (!needsPageContext) {
    // Use fast chat without page extraction
    return await handleFastChat(message);
  }
  
  // Original behavior: Use the existing prompt system with page context
  const res = await bgSend({
    type: MSG.SUMMARIZE_PAGE,
    maxChars: 20000,
    userPrompt: `Please respond to this message in a helpful and conversational way: "${message}"`
  });
  
  if (!res?.ok) {
    return `I'm having trouble processing your request: ${res?.error || "unknown error"}`;
  }
  return res.summary || "I'm not sure how to respond to that.";
}

/**
 * Fast chat handler that bypasses page content extraction
 * Responds in <3 seconds for simple Q&A
 */
async function handleFastChat(message) {
  // Use the new MSG.CHAT_DIRECT for fast responses without page context
  const res = await bgSend({
    type: MSG.CHAT_DIRECT,
    userPrompt: `Please provide a direct, helpful response to this question: "${message}"`
  });
  
  if (!res?.ok) {
    return `I'm having trouble processing your request: ${res?.error || "unknown error"}`;
  }
  return res.summary || "I'm not sure how to respond to that.";
}

// -------- Agent Mode --------

function getAgentSettingsFromUI() {
  return {
    allowCrossDomain: !!els.allowCrossDomain?.checked,
    allowTabMgmt: !!els.allowTabMgmt?.checked,
    autoScreenshots: !!els.autoScreenshots?.checked,
    maxSteps: Math.max(1, Math.min(50, Number(els.maxSteps?.value || 12)))
  };
}

async function loadAgentSettings() {
  const res = await chrome.storage.local.get(storageKeys.AGENT_SETTINGS);
  const s = res[storageKeys.AGENT_SETTINGS] || { allowCrossDomain: true, allowTabMgmt: true, autoScreenshots: false, maxSteps: 12 };
  if (els.allowCrossDomain) els.allowCrossDomain.checked = !!s.allowCrossDomain;
  if (els.allowTabMgmt) els.allowTabMgmt.checked = !!s.allowTabMgmt;
  if (els.autoScreenshots) els.autoScreenshots.checked = !!s.autoScreenshots;
  if (els.maxSteps) els.maxSteps.value = s.maxSteps ?? 12;
}

async function saveAgentSettings() {
  const s = getAgentSettingsFromUI();
  await chrome.storage.local.set({ [storageKeys.AGENT_SETTINGS]: s });
}

// Activity drawer rendering with grouping, filtering, and search
function formatDateKey(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleDateString();
}

function ensureGroupContainer(dateKey) {
  if (!els.activityGroups) return els.activityBody || els.chatMessages;
  let group = els.activityGroups.querySelector(`[data-group="${CSS.escape(dateKey)}"]`);
  if (!group) {
    group = document.createElement('div');
    group.className = 'activity-group';
    group.dataset.group = dateKey;
    const header = document.createElement('div');
    header.className = 'group-header';
    header.textContent = dateKey;
    const body = document.createElement('div');
    body.className = 'group-body';
    group.appendChild(header);
    group.appendChild(body);
    els.activityGroups.appendChild(group);
  }
  return group.querySelector('.group-body');
}

function passesFilter(entry) {
  const level = (entry.level || '').toLowerCase();
  const q = (els.activitySearch?.value || '').trim().toLowerCase();
  const filter = (els.activityFilter?.value || 'all').toLowerCase();
  const matchesLevel = filter === 'all' || level.includes(filter);
  const textBlob = JSON.stringify(entry || {});
  const matchesQuery = !q || textBlob.toLowerCase().includes(q);
  return matchesLevel && matchesQuery;
}

function renderLogItem(entry) {
  const logItem = document.createElement('details');
  logItem.className = `log-item log-${entry.level || 'info'}`;
  logItem.dataset.level = (entry.level || 'info').toLowerCase();
  logItem.dataset.msg = (entry.msg || '').toLowerCase();
  if (entry.level === 'error' || entry.level === 'warn') {
    logItem.open = true; // Auto-expand errors and warnings
  }

  const summary = document.createElement('summary');
  summary.className = 'log-summary';

  const ts = new Date(entry.ts || Date.now()).toLocaleTimeString();
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `[${ts}] #${entry.step ?? ''}`;

  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = entry.msg || '';

  const badges = document.createElement('span');
  badges.className = 'badges';
  if (entry.tool) {
    const b = document.createElement('span');
    b.className = 'badge tool';
    b.textContent = entry.tool;
    badges.appendChild(b);
  }
  if (entry.confidence) {
    const b = document.createElement('span');
    b.className = 'badge confidence';
    b.textContent = `${Math.round(entry.confidence * 100)}%`;
    badges.appendChild(b);
  }
  if (typeof entry.success === 'boolean') {
    const b = document.createElement('span');
    b.className = `badge ${entry.success ? 'success' : 'fail'}`;
    b.textContent = entry.success ? 'OK' : 'FAIL';
    badges.appendChild(b);
  }

  summary.appendChild(meta);
  summary.appendChild(msg);
  summary.appendChild(badges);
  logItem.appendChild(summary);

  const logBody = document.createElement('div');
  logBody.className = 'log-body';

  if (entry.rationale) {
    const rationaleDiv = document.createElement('div');
    rationaleDiv.className = 'rationale';
    rationaleDiv.textContent = entry.rationale;
    logBody.appendChild(rationaleDiv);
  }

  if (entry.report) {
    const reportDiv = document.createElement('div');
    reportDiv.className = 'report';
    if (window.marked && typeof window.marked.parse === 'function') {
      reportDiv.innerHTML = window.marked.parse(entry.report);
    } else {
      reportDiv.textContent = entry.report;
    }
    logBody.appendChild(reportDiv);
  } else if (entry.data || entry.result || entry.action || entry.observation || entry.error) {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify({
      data: entry.data,
      result: entry.result,
      action: entry.action,
      observation: entry.observation,
      error: entry.error
    }, null, 2);
    logBody.appendChild(pre);
  }

  if (entry.error) {
    const err = document.createElement('span');
    err.className = 'error-msg';
    err.textContent = String(entry.error);
    logBody.appendChild(err);
  }

  logItem.appendChild(logBody);
  return logItem;
}

function applyActivityFilters() {
  const groupsRoot = els.activityGroups || els.activityBody || els.chatMessages;
  const q = (els.activitySearch?.value || '').trim().toLowerCase();
  const filter = (els.activityFilter?.value || 'all').toLowerCase();
  const allItems = groupsRoot.querySelectorAll('.log-item');
  allItems.forEach(item => {
    const level = (item.dataset.level || '').toLowerCase();
    const content = (item.dataset.msg || '') + ' ' + (item.textContent || '');
    const matchesLevel = filter === 'all' || level.includes(filter);
    const matchesQuery = !q || content.toLowerCase().includes(q);
    item.style.display = (matchesLevel && matchesQuery) ? '' : 'none';
  });
}

function addAgentLogToChat(entry) {
  // Ensure container and group
  const dateKey = formatDateKey(entry.ts);
  const container = ensureGroupContainer(dateKey);
  const logItem = renderLogItem(entry);
  container.appendChild(logItem);

  // Auto-open the drawer when logs arrive
  if (els.spLayout && els.activityPanel) {
    ensureActivityOpen();
    (els.activityBody || els.activityPanel).scrollTop = (els.activityBody || els.activityPanel).scrollHeight;
  } else {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  // Apply current filter/search to the new item
  applyActivityFilters();
}

async function startAgent() {
  const goal = (els.agentGoal?.value || "").trim();
  if (!goal) {
    addMessage('assistant', 'Please enter a goal for Agent Mode.');
    return;
  }
  
  await saveAgentSettings();
  const settings = getAgentSettingsFromUI();
  
  // Close modal
  els.agentModal.classList.remove('show');
  
  // Add initial message
  addMessage('user', `Start agent: ${goal}`);
  addMessage('assistant', `Starting agent with goal: "${goal}". I'll keep you updated on my progress.`);
  
  const res = await bgSend({ type: MSG.AGENT_RUN, goal, settings });
  if (!res?.ok) {
    const errorMsg = getErrorMessage(res?.error, res?.errorType);
    addMessage('assistant', `Agent start failed: ${errorMsg}`);
  } else {
    // Start monitoring agent status
    startStatusMonitoring();
  }
  
  function getErrorMessage(error, errorType) {
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "An agent is already running on this tab. Please wait for it to finish or use the STOP button to halt it first.";
      case ERROR_TYPES.RESTRICTED_URL:
        return "Cannot run automation on this page due to browser security restrictions. Try navigating to a regular website first.";
      case ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE:
        return "Unable to access this page for automation. Please refresh the page or navigate to a different site.";
      default:
        return error || "unknown error";
    }
  }
}

async function stopAgent() {
  await bgSend({ type: MSG.AGENT_STOP });
  addMessage('assistant', 'Agent stopped by user request.');
  if (typeof showToast === 'function') {
    showToast('Agent stopped', 'warn');
  }
  if (typeof clearStepperBar === 'function') {
    clearStepperBar();
  }
}

// -------- Modal Management --------

function showModal(modal) {
  modal.classList.add('show');
}

function hideModal(modal) {
  modal.classList.remove('show');
}

// -------- Legacy Functions (for compatibility) --------

function setOutput(text) {
  // For compatibility with existing code - add as assistant message
  addMessage('assistant', text);
}

async function handleSummarize() {
  setOutput("Summarizing current page...");
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) return;
  const res = await bgSend({ type: MSG.SUMMARIZE_PAGE, maxChars: 20000 });
  if (!res?.ok) {
    setOutput(`Error: ${res?.error || "unknown"}`);
  } else {
    setOutput(res.summary || "(no content)");
  }
}

async function handleSendPrompt() {
  const prompt = (els.aiPrompt.value || "").trim();
  if (!prompt) {
    setOutput("Enter a prompt to send.");
    return;
  }
  // For MVP: reuse summarize flow by extracting page text and concatenating prompt.
  setOutput("Running prompt with current page context...");
  const hasKey = await checkApiKeyWarn();
  if (!hasKey) return;

  // Ask BG to extract text first so we keep logic unified there later if needed
  const active = await bgSend({ type: MSG.GET_ACTIVE_TAB });
  if (!active?.ok) {
    return setOutput("Could not get active tab.");
  }
  const extract = await bgSend({ type: MSG.EXTRACT_PAGE_TEXT, maxChars: 20000 });
  if (!extract?.ok) {
    return setOutput(`Extraction error: ${extract?.error || "unknown"}`);
  }

  // Compose a context-aware request by sending a special message (reuse SUMMARIZE_PAGE handler path via buildSummarizePrompt)
  // For now, directly call SUMMARIZE_PAGE but prepend user's prompt in the background prompt template.
  // A better design: create a new BG route MSG.GENERATE_WITH_CONTEXT and handle with prompts.js.
  const res = await bgSend({ type: MSG.SUMMARIZE_PAGE, maxChars: 20000, userPrompt: prompt });
  if (!res?.ok) {
    setOutput(`Error: ${res?.error || "unknown"}`);
  } else {
    setOutput(res.summary || "(no content)");
  }
}

function wireBasics() {
  // Header actions
  els.openOptionsBtn?.addEventListener("click", openOptionsPage);
  els.agentStopBtn?.addEventListener("click", stopAgent);
  els.clearChatBtn?.addEventListener("click", async () => {
    const proceed = confirm("Clear chat history?");
    if (!proceed) return;
    await clearChatHistory();
  });

  // Activity drawer toggles
  els.toggleActivityBtn?.addEventListener("click", toggleActivityPanel);
  els.collapseActivityBtn?.addEventListener("click", closeActivityPanel);
  els.activityFilter?.addEventListener("change", applyActivityFilters);
  els.activitySearch?.addEventListener("input", applyActivityFilters);

   // Chat input with slash commands and Enter-to-send
  els.chatInput?.addEventListener("input", onChatInputInput);
  els.chatInput?.addEventListener("keydown", (e) => {
    if (slashOpen) {
      onChatInputKeydown(e);
      if (e.defaultPrevented) return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.sendBtn?.addEventListener("click", sendMessage);
  
  // Close slash menu on outside click or window resize
  document.addEventListener('click', (ev) => {
    if (!slashOpen) return;
    if (ev.target === els.chatInput) return;
    if (slashMenuEl && slashMenuEl.contains(ev.target)) return;
    closeSlashMenu();
  });
  window.addEventListener('resize', () => { if (slashOpen) positionSlashMenu(); });
    
  // Agent modal
  els.closeAgentModal?.addEventListener("click", () => hideModal(els.agentModal));
  els.cancelAgentBtn?.addEventListener("click", () => hideModal(els.agentModal));
  els.agentStartBtn?.addEventListener("click", startAgent);
  
  // Tasks modal
  els.closeTasksModal?.addEventListener("click", () => hideModal(els.tasksModal));
  
  // Close modals on backdrop click
  [els.agentModal, els.tasksModal].forEach(modal => {
    modal?.addEventListener("click", (e) => {
      if (e.target === modal) hideModal(modal);
    });
  });
  
  // Agent settings persistence
  [els.allowCrossDomain, els.allowTabMgmt, els.autoScreenshots, els.maxSteps]
    .filter(Boolean)
    .forEach(el => el.addEventListener("change", saveAgentSettings));

  // Quick actions toolbar
  els.qaSummarize?.addEventListener('click', async () => {
    const hasKey = await checkApiKeyWarn(); if (!hasKey) return;
    await prefillAndSend('Summarize this page in 5 concise bullet points.');
  });
  els.qaExtractLinks?.addEventListener('click', async () => {
    const hasKey = await checkApiKeyWarn(); if (!hasKey) return;
    await prefillAndSend('Extract all links on this page as a Markdown table with columns: Title, URL.');
  });
  els.qaOutline?.addEventListener('click', async () => {
    const hasKey = await checkApiKeyWarn(); if (!hasKey) return;
    await prefillAndSend('Create a hierarchical outline of this page with headings and key points.');
  });
  els.qaNavigate?.addEventListener('click', () => {
    if (!els.chatInput) return;
    els.chatInput.value = 'Navigate to ';
    els.chatInput.focus();
  });

  // Context chips refresh hooks
  if (els.contextChips) {
    updateContextChips();
    window.addEventListener('focus', updateContextChips);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') updateContextChips();
    });
  }
}

// Listen for background logs
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.AGENT_LOG && message.entry) {
    addAgentLogToChat(message.entry);
    if (message.entry.step !== undefined && currentPlanMessage) {
      updatePlan(message.entry.step);
    }
  } else if (message?.type === MSG.AGENT_PROGRESS && message.message) {
    updateStatusBubble(message.message, message.step, message.timestamp);
    if (typeof updateStepperProgress === 'function') {
      updateStepperProgress(message.step, message.totalSteps, message.message);
    }
  } else if (message?.type === MSG.AGENT_FINDING && message.finding) {
    addFindingMessage(message.finding, message.timestamp);
  } else if (message?.type === MSG.SHOW_REPORT && message.report) {
    clearStatusBubble();
    addMessage('assistant', message.report, Date.now(), message.format === 'markdown');
  } else if (message?.type === MSG.AGENT_STATUS) {
    if (message.session?.running) {
      ensureActivityOpen();
      if (typeof updateStepperFromSession === 'function') {
        updateStepperFromSession(message.session);
      }
    } else {
      clearStatusBubble();
      if (typeof clearStepperBar === 'function') {
        clearStepperBar();
      }
    }
    if (message.session?.subTasks?.length > 0) {
      if (!currentPlanMessage) {
        const planContainer = addMessage('assistant', '');
        renderPlan(planContainer.querySelector('.content'), message.session.subTasks);
        currentPlanMessage = planContainer;
      }
      updatePlan(message.session.currentTaskIndex || 0);
    }
  } else if (message?.type === MSG.AGENT_PLAN_GENERATED) {
      const planContainer = addMessage('assistant', '');
      renderPlan(planContainer.querySelector('.content'), message.plan);
      currentPlanMessage = planContainer;
  } else if (message?.type === MSG.AGENT_STEP_UPDATE) {
      if (currentPlanMessage) {
        updatePlan(message.currentTaskIndex);
      }
  } else if (message?.type === MSG.AGENT_ACTION_RESULT && message.payload) {
    addActionResultMessage(message.payload, message.timestamp);
    (async () => {
      const history = await loadChatHistory();
      history.push({ role: 'action_result', content: message.payload, timestamp: message.timestamp });
      await saveChatHistory(history);
    })();
  } else if (message?.type === MSG.AGENT_PERMISSION_REQUEST && message.payload) {
    try {
      const { correlationId, origin, tool, params, rationale } = message.payload;
      addAgentLogToChat({
        level: LOG_LEVELS.INFO,
        msg: "Auto-approved permission request",
        tool,
        origin,
        data: { params, rationale }
      });
      chrome.runtime.sendMessage({
        type: MSG.AGENT_PERMISSION_DECISION,
        payload: { correlationId, granted: true, remember: true, origin, tool }
      });
    } catch (e) {
      console.warn('Permission auto-approval failed:', e);
    }
  } else if (message?.type === MSG.AGENT_TRACE_UPDATE && message.event) {
    // Timeline events from AgentObserver
    ensureActivityOpen();
    try {
      handleTraceMessage(message.event, {
        root: els.activityBody || document.body
      });
    } catch (e) {
      console.warn('Failed to render trace event:', e);
    }
  }
});

async function loadChatHistoryOnStart() {
  const history = await loadChatHistory();
  history.forEach(msg => {
    if (msg.role === 'action_result') {
      addActionResultMessage(msg.content, msg.timestamp);
    } else {
      addMessage(msg.role, msg.content, msg.timestamp);
    }
  });
}

async function main() {
  wireBasics();
  await loadAgentSettings();
  await initTasksUI();
  await loadChatHistoryOnStart();

  // Mount minimal activity timeline and backfill recent events
  try {
    initActivityTimeline(els.activityBody || document.body);
    await loadRecentTimeline(100);
  } catch (e) {
    console.warn('Timeline init/backfill failed:', e);
  }

  // Restore activity drawer state
  const { [storageKeys.UI_ACTIVITY_OPEN]: open } = await chrome.storage.local.get(storageKeys.UI_ACTIVITY_OPEN);
  setActivityOpen(!!open);

  // Populate context chips with current tab info
  await updateContextChips();

  // Check for existing agent session on startup
  await checkAgentStatus();
  
  // Welcome message if no history
  const history = await loadChatHistory();
  if (history.length === 0) {
    addMessage('assistant', 'Hello! I\'m your AI assistant. I can help you summarize pages, manage tasks, or automate web actions. What would you like to do?');
  }
  
  // Start status monitoring if agent is running
  if (isAgentRunning) {
    startStatusMonitoring();
    ensureActivityOpen();
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  stopStatusMonitoring();
});

main().catch(err => {
  console.error("Sidepanel init error:", err);
  setOutput("Init error: " + String(err?.message || err));
});

/* ---------- Activity Drawer helpers ---------- */
function setActivityOpen(open) {
  if (!els.spLayout || !els.activityPanel || !els.toggleActivityBtn) return;
  if (open) {
    els.spLayout.classList.add('expanded');
    els.activityPanel.classList.remove('collapsed');
    els.toggleActivityBtn.setAttribute('aria-pressed', 'true');
    chrome.storage.local.set({ [storageKeys.UI_ACTIVITY_OPEN]: true });
  } else {
    els.spLayout.classList.remove('expanded');
    els.activityPanel.classList.add('collapsed');
    els.toggleActivityBtn.setAttribute('aria-pressed', 'false');
    chrome.storage.local.set({ [storageKeys.UI_ACTIVITY_OPEN]: false });
  }
}

function toggleActivityPanel() {
  const isOpen = els.spLayout?.classList.contains('expanded');
  setActivityOpen(!isOpen);
}

function closeActivityPanel() {
  setActivityOpen(false);
}

function ensureActivityOpen() {
  // Auto-open on activity if viewport wide enough
  if (window.matchMedia('(min-width: 721px)').matches) {
    setActivityOpen(true);
  }
}
/* ---------- Plan Visualization helpers ---------- */
function renderPlan(container, subTasks) {
  if (!container) return;

  container.innerHTML = ''; // Clear previous plan
  const planList = document.createElement('ul');
  planList.className = 'plan-list';
  
  const title = document.createElement('div');
  title.className = 'plan-title';
  title.textContent = 'Agent Plan';
  container.appendChild(title);

  subTasks.forEach((task, index) => {
    const item = document.createElement('li');
    item.className = 'plan-step';
    item.dataset.index = index;
    item.innerHTML = `<span class="plan-icon"></span><span class="plan-text">${escapeHtml(task)}</span>`;
    planList.appendChild(item);
  });

  container.appendChild(planList);
}

// Phase 3: Status Bubble functions
function updateStatusBubble(message, step, timestamp) {
  // Handle regular status updates
  if (!currentStatusBubble) {
    const bubbleContainer = addMessage('assistant', '');
    bubbleContainer.classList.add('status-bubble-container');
    const contentDiv = bubbleContainer.querySelector('.content');
    contentDiv.innerHTML = `
      <div class="status-bubble">
        <div class="spinner"></div>
        <div class="status-text"></div>
        <div class="status-timestamp"></div>
      </div>
    `;
    currentStatusBubble = bubbleContainer;
  }
  
  const textEl = currentStatusBubble.querySelector('.status-text');
  const tsEl = currentStatusBubble.querySelector('.status-timestamp');
  
  if (textEl) textEl.textContent = message;
  if (tsEl) tsEl.textContent = `Step ${step || ''} - ${new Date(timestamp).toLocaleTimeString()}`;
  
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

/* ---------- Inline Stepper / Toasts (moved out of template) ---------- */
function ensureStepperBuilt() {
  const bar = els.stepperBar;
  if (!bar) return null;
  if (!bar.firstChild) {
    bar.innerHTML = `
      <div class="stepper-inner">
        <div class="stepper-status">Preparing…</div>
        <button id="inlineStopBtn" class="stop-inline-btn" title="Stop automation">STOP</button>
      </div>
      <div class="stepper-track"><div class="stepper-fill" style="width:0%"></div></div>
      <div class="stepper-meta">Step 0</div>
    `;
    const stopBtn = bar.querySelector('#inlineStopBtn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        try { stopAgent(); } catch (_) {}
      });
    }
  }
  bar.hidden = false;
  return bar;
}

function clearStepperBar() {
  const bar = els.stepperBar;
  if (!bar) return;
  const fill = bar.querySelector('.stepper-fill');
  const status = bar.querySelector('.stepper-status');
  const meta = bar.querySelector('.stepper-meta');
  if (fill) fill.style.width = '0%';
  if (status) status.textContent = 'Idle';
  if (meta) meta.textContent = '';
  bar.hidden = true;
}

function updateStepperFromSession(session) {
  if (!session) return;
  const bar = ensureStepperBuilt();
  if (!bar) return;
  const step = Number(session.step || session.currentTaskIndex || 0);
  const totalSteps = Number((session.settings && session.settings.maxSteps) || session.totalSteps || 0);
  const message = session.statusMessage || 'Working…';

  const fill = bar.querySelector('.stepper-fill');
  const status = bar.querySelector('.stepper-status');
  const meta = bar.querySelector('.stepper-meta');

  const pct = totalSteps > 0 ? Math.max(0, Math.min(100, (step / totalSteps) * 100)) : 0;
  if (fill) fill.style.width = pct + '%';
  if (status) status.textContent = message;
  if (meta) meta.textContent = totalSteps ? `Step ${step}/${totalSteps}` : `Step ${step}`;
}

function updateStepperProgress(step, totalSteps, message) {
  const bar = ensureStepperBuilt();
  if (!bar) return;
  const fill = bar.querySelector('.stepper-fill');
  const status = bar.querySelector('.stepper-status');
  const meta = bar.querySelector('.stepper-meta');

  const s = Number(step || 0);
  const t = Number(totalSteps || 0);
  const pct = t > 0 ? Math.max(0, Math.min(100, (s / t) * 100)) : 0;

  if (fill) fill.style.width = pct + '%';
  if (status) status.textContent = message || 'Working…';
  if (meta) meta.textContent = t ? `Step ${s}/${t}` : `Step ${s}`;
}

/* ---------- Toasts Utilities ---------- */
function ensureToastContainer() {
  if (els.toastContainer) return els.toastContainer;
  const container = document.getElementById('toastContainer') || document.createElement('div');
  container.id = 'toastContainer';
  container.className = 'toast-container';
  document.body.appendChild(container);
  els.toastContainer = container;
  return container;
}

function showToast(msg, level = 'info', duration = 3500) {
  const container = ensureToastContainer();
  if (!container) return;

  const variant = level === 'warn' ? 'warn' : level === 'error' ? 'error' : level === 'success' ? 'success' : 'info';
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;

  const text = document.createElement('div');
  text.className = 'toast-msg';
  text.textContent = msg || '';

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.addEventListener('click', () => dismissToast(toast));

  toast.appendChild(text);
  toast.appendChild(close);
  container.appendChild(toast);

  let timeoutId = null;
  if (duration > 0) {
    timeoutId = setTimeout(() => dismissToast(toast), duration);
  }

  toast.addEventListener('mouseenter', () => { if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; } });
  toast.addEventListener('mouseleave', () => {
    if (!timeoutId && duration > 0) {
      timeoutId = setTimeout(() => dismissToast(toast), 1200);
    }
  });
}

function dismissToast(toast) {
  if (!toast) return;
  toast.style.animation = 'toast-out 160ms ease-in forwards';
  setTimeout(() => { try { toast.remove(); } catch (_) {} }, 180);
}

/* ---------- Status bubble cleanup ---------- */
function clearStatusBubble() {
  if (currentStatusBubble) {
    currentStatusBubble.remove();
    currentStatusBubble = null;
  }
}

function updatePlan(currentTaskIndex) {
  if (!currentPlanMessage) return;

  const steps = currentPlanMessage.querySelectorAll('.plan-step');
  steps.forEach((step, index) => {
    step.classList.remove('completed', 'in-progress', 'pending');
    if (index < currentTaskIndex) {
      step.classList.add('completed');
    } else if (index === currentTaskIndex) {
      step.classList.add('in-progress');
    } else {
      step.classList.add('pending');
    }
  });
}

/* ---------- Success Criteria Visualization helpers ---------- */
function addFindingMessage(finding, timestamp) {
   const findingContainer = addMessage('assistant', '');
   findingContainer.classList.add('finding-bubble-container');
   const contentDiv = findingContainer.querySelector('.content');
   
   const formattedFinding = `<pre><code>${JSON.stringify(finding, null, 2)}</code></pre>`;
 
   contentDiv.innerHTML = `
     <div class="finding-bubble">
       <div class="finding-title">✅ Finding Recorded</div>
       <div class="finding-content">${formattedFinding}</div>
       <div class="finding-timestamp">${new Date(timestamp).toLocaleTimeString()}</div>
     </div>
   `;
   els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
 }

 function addActionResultMessage(payload, timestamp) {
  const { tool, data } = payload;
  const resultContainer = addMessage('assistant', '');
  resultContainer.classList.add('action-result-bubble-container');
  const contentDiv = resultContainer.querySelector('.content');

  let contentHtml = '';

  switch (tool) {
    case 'record_finding':
      contentHtml = `
        <div class="action-result-bubble">
          <div class="action-result-title">✅ Finding Recorded</div>
          <div class="action-result-content"><pre><code>${escapeHtml(JSON.stringify(data, null, 2))}</code></pre></div>
        </div>`;
      break;
    case 'read_page_content':
      contentHtml = `
        <div class="action-result-bubble">
          <div class="action-result-title">📄 Page Content Read</div>
          <div class="action-result-content">
            <p>${escapeHtml(data.summary)}</p>
            <a href="${escapeHtml(data.url)}" target="_blank" class="action-result-link">${escapeHtml(data.title)}</a>
          </div>
        </div>`;
      break;
    case 'navigate':
      contentHtml = `
        <div class="action-result-bubble">
          <div class="action-result-title">🌐 Navigation Complete</div>
          <div class="action-result-content">
            <p>Navigated to:</p>
            <a href="${escapeHtml(data.url)}" target="_blank" class="action-result-link">${escapeHtml(data.title)}</a>
          </div>
        </div>`;
      break;
  }

  contentDiv.innerHTML = contentHtml;
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

  // QA log
  console.log('Rendered action result:', { tool, data });
}

function renderSuccessCriteria(schema, findings) {
  const container = els.successCriteria;
  if (!container) return;

  container.innerHTML = ''; // Clear previous checklist
  const title = document.createElement('div');
  title.className = 'success-criteria-title';
  title.textContent = 'Success Criteria';
  container.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'success-criteria-list';

  const properties = schema.properties || {};
  for (const key in properties) {
    const item = document.createElement('li');
    item.className = 'success-criteria-item';
    const isMet = findings && findings[key];
    item.innerHTML = `<span class="criteria-icon">${isMet ? '✅' : '🔲'}</span><span class="criteria-text">${key}</span>`;
    list.appendChild(item);
  }

  container.appendChild(list);
}

/* ---------- Findings Table Visualization helpers ---------- */
function renderFindings(findings) {
  const container = els.findingsTable;
  if (!container) return;

  container.innerHTML = ''; // Clear previous table
  const title = document.createElement('div');
  title.className = 'findings-title';
  title.textContent = 'Findings';
  container.appendChild(title);

  const table = document.createElement('table');
  table.className = 'findings-table';

  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Key</th><th>Value</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const key in findings) {
    const value = findings[key];
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escapeHtml(key)}</td><td>${escapeHtml(JSON.stringify(value))}</td>`;
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  container.appendChild(table);
}

/* ---------- Error Formatting Helper (Phase 4) ---------- */
function formatChatError(error) {
  const errorMessage = error?.message || String(error) || 'Unknown error';
  
  // Check for specific error patterns and provide helpful guidance
  if (errorMessage.includes('API key') || errorMessage.includes('authentication')) {
    return '🔑 **Authentication Error**\n\nYour API key might be invalid or expired.\n\n**Fix:** Click the ⚙️ gear icon to update your API key.';
  }
  
  if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
    return '🌐 **Connection Issue**\n\nI couldn\'t connect to the AI service.\n\n**Check:**\n• Your internet connection\n• Any firewall or VPN settings\n• Try again in a moment';
  }
  
  if (errorMessage.includes('timeout')) {
    return '⏱️ **Request Timed Out**\n\nThe request took too long to complete.\n\n**Try:**\n• Simplifying your request\n• Checking if the website is responsive\n• Waiting a moment and trying again';
  }
  
  if (errorMessage.includes('quota') || errorMessage.includes('limit')) {
    return '📊 **Rate Limit Reached**\n\nYou\'ve hit the API usage limit.\n\n**Options:**\n• Wait a few minutes before trying again\n• Check your API usage in the Google Cloud Console\n• Consider upgrading your API plan';
  }
  
  // Default error message with the actual error for debugging
  return `❌ **Unexpected Error**\n\nSomething went wrong while processing your request.\n\n**Error details:** ${errorMessage}\n\n**You can try:**\n• Refreshing the page\n• Restarting the extension\n• Checking the browser console for more details`;
}