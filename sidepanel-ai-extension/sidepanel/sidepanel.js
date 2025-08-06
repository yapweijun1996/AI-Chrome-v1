// sidepanel/sidepanel.js
// Chat-based UI for AI Assistant with Agent Mode capabilities

// Import centralized message types (in browser context)
const MSG = window.MessageTypes?.MSG || {
  PING: "PING",
  GET_ACTIVE_TAB: "GET_ACTIVE_TAB", 
  EXTRACT_PAGE_TEXT: "EXTRACT_PAGE_TEXT",
  SUMMARIZE_PAGE: "SUMMARIZE_PAGE",
  OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
  READ_API_KEY: "READ_API_KEY",
  // Agent
  AGENT_RUN: "AGENT_RUN",
  AGENT_STOP: "AGENT_STOP",
  AGENT_STATUS: "AGENT_STATUS", 
  AGENT_LOG: "AGENT_LOG"
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

  // Chat
  chatMessages: document.getElementById("chatMessages"),
  chatInput: document.getElementById("chatInput"),
  sendBtn: document.getElementById("sendBtn"),
  
  // Quick actions
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
      currentAgentSession = res.session;
      const wasRunning = isAgentRunning;
      isAgentRunning = res.session.running;
      
      // Update UI based on status changes
      updateAgentStatusUI(res.session, wasRunning);
      return res.session;
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
    stopBtn.title = `Agent running (step ${session.step || 0}/${session.settings?.maxSteps || 12}) - Click to stop`;
    
    // Start status monitoring if not already running
    if (!statusCheckInterval) {
      statusCheckInterval = setInterval(checkAgentStatus, 2000);
    }
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
    setOutput("Gemini API key not set. Open settings (gear icon) to configure.");
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
    messageContent.innerHTML = marked.parse(content);
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
      addMessage('assistant', 'Please set your Gemini API key in settings (gear icon) to continue.');
      return;
    }
    
    // Process the message
    const response = await processUserMessage(input);
    hideTypingIndicator();
    addMessage('assistant', response);
    
    // Save to history
    const history = await loadChatHistory();
    history.push(
      { role: 'user', content: input, timestamp: Date.now() },
      { role: 'assistant', content: response, timestamp: Date.now() }
    );
    // Keep only last 50 messages
    if (history.length > 50) {
      history.splice(0, history.length - 50);
    }
    await saveChatHistory(history);
    
  } catch (error) {
    hideTypingIndicator();
    addMessage('assistant', `Error: ${error.message || 'Something went wrong'}`);
  }
}

async function processUserMessage(message) {
  // Use AI-powered intent classification instead of hardcoded rules
  try {
    const intent = await classifyUserIntent(message);
    
    if (!intent) {
      // Fallback to general chat if classification fails
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
      case 'AUTOMATION':
      case 'NAVIGATION':
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
  } catch (error) {
    console.error('Intent classification error:', error);
    // Fallback to general chat on error
    return await handleGeneralChat(message);
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
    switch (errorType) {
      case ERROR_TYPES.AGENT_ALREADY_RUNNING:
        return "An agent is already running on this tab. Please wait for it to finish or use the STOP button to halt it first.";
      case ERROR_TYPES.RESTRICTED_URL:
        return "Cannot run automation on this page due to browser security restrictions. Try navigating to a regular website first.";
      case ERROR_TYPES.CONTENT_SCRIPT_UNAVAILABLE:
        return "Unable to access this page for automation. Please refresh the page or navigate to a different site.";
      default:
        return `I couldn't start the automation: ${error || "unknown error"}`;
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
  // Use the existing prompt system with page context
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
  const logItem = document.createElement('div');
  logItem.className = `log-item log-${entry.level || 'info'}`;
  logItem.dataset.level = (entry.level || 'info').toLowerCase();
  logItem.dataset.msg = (entry.msg || '').toLowerCase();

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
    const b = document.createElement('span'); b.className = 'badge'; b.textContent = entry.tool;
    badges.appendChild(b);
  }
  if (typeof entry.success === 'boolean') {
    const b = document.createElement('span'); b.className = 'badge'; b.textContent = entry.success ? 'ok' : 'fail';
    badges.appendChild(b);
  }

  logItem.appendChild(meta);
  logItem.appendChild(msg);
  logItem.appendChild(badges);

  if (entry.report) {
    const reportDiv = document.createElement('div');
    reportDiv.className = 'report';
    reportDiv.innerHTML = marked.parse(entry.report);
    logItem.appendChild(reportDiv);
  } else if (entry.data || entry.result || entry.action || entry.observation || entry.error) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify({
      data: entry.data,
      result: entry.result,
      action: entry.action,
      observation: entry.observation,
      error: entry.error
    }, null, 2);
    details.appendChild(summary);
    details.appendChild(pre);
    logItem.appendChild(details);
  }
  if (entry.error) {
    const err = document.createElement('span');
    err.className = 'error-msg';
    err.textContent = String(entry.error);
    logItem.appendChild(err);
  }
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

  // Chat input
  els.chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.sendBtn?.addEventListener("click", sendMessage);
  
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
}

// Listen for background logs
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.AGENT_LOG && message.entry) {
    addAgentLogToChat(message.entry);
  }
  if (message?.type === MSG.AGENT_STATUS && message.session?.running) {
    // Ensure drawer visible while running
    ensureActivityOpen();
  }
});

async function loadChatHistoryOnStart() {
  const history = await loadChatHistory();
  history.forEach(msg => {
    addMessage(msg.role, msg.content, msg.timestamp);
  });
}

async function main() {
  wireBasics();
  await loadAgentSettings();
  await initTasksUI();
  await loadChatHistoryOnStart();

  // Restore activity drawer state
  const { [storageKeys.UI_ACTIVITY_OPEN]: open } = await chrome.storage.local.get(storageKeys.UI_ACTIVITY_OPEN);
  setActivityOpen(!!open);

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