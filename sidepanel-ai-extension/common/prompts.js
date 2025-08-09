// common/prompts.js
// Stores and builds prompts for the Gemini API

function buildSummarizePrompt(pageText, userPrompt = "") {
  let prompt = `You are an intelligent assistant. Your task is to analyze the provided text from a webpage and respond to the user's request.
  
  First, provide a concise, neutral summary of the text.
  
  Second, analyze the user's follow-up request: "${userPrompt}"
  
  Follow these rules:
  1.  If the user's request can be answered using the provided text, answer it directly.
  2.  If the user's request is unrelated to the provided text, clearly state that the text does not contain the requested information and suggest how the user can find it (e.g., by searching online, visiting a specific website).
  3.  If no user request is provided, just return the summary.
  
  Here is the text to analyze:
  ---
  ${pageText}
  ---
  
  Present your response in two parts: a "Concise Summary of the Text" and then your "Response to User Request".`;

  return prompt;
}

/**
 * Build a planning prompt for autonomous Agent Mode.
 * The assistant must reply ONLY with a single JSON object using this schema:
 * {
 *   "tool": string, // allowed: "navigateToUrl","clickElement","typeText","scrollTo","waitForSelector","readPageContent","analyzeUrls","extractStructuredContent","extractLinks","take_screenshot","tabs.query","tabs.activate","tabs.close","recordFinding","done","getInteractiveElements","scrapeSelector"
 *   "params": object, // as required by the tool (see constraints)
 *   "rationale": string, // brief reason for the chosen action
 *   "done": boolean // true when the overall goal is met
 * }
 * Constraints per tool:
 * - navigateToUrl: { "url": "https://..." }
 * - clickElement: { "selector": "CSS selector" } OR { "elementIndex": number } // Prefer a robust "selector" using text/aria/role/title; use elementIndex only as a last resort
 * - typeText: { "selector": "CSS selector", "text": "text" } OR { "elementIndex": number, "text": "text" } // Prefer "selector" built from accessibleName/aria-label/placeholder/name
 * - scrollTo: { "selector": "CSS selector" } OR { "direction": "top"|"bottom" }
 * - waitForSelector: { "selector": "CSS selector", "timeoutMs": number (optional, default 5000) }
 * - readPageContent: { "maxChars": number (optional) }
 * - extractStructuredContent: { }
 * - extractLinks: { "includeExternal": boolean (optional), "maxLinks": number (optional) }
 * - take_screenshot: { "reason": "optional string" }
 * - tabs.query: { "titleContains": "optional", "urlContains": "optional" }
 * - tabs.activate: { "tabId": number }
 * - tabs.close: { "tabId": number }
 * - recordFinding: { "finding": object }
 * - done: use when you judge the goal is achieved; params can be {}
 *
 * Safety:
 * - Do not propose actions on restricted pages (chrome://, chrome-extension://, edge://, about:, moz-extension://).
 * - Prefer simple and robust selectors; only click visible, interactive elements.
 * - One step per JSON; do not return arrays.
 * - Respond with JSON only, no markdown or prose.
 * - Do NOT use "generateReport" in automation workflows; it is not an allowed tool in this mode.
 */
function buildAgentPlanPrompt(fullGoal, currentSubTask, context = {}) {
  const {
    url = "",
    title = "",
    pageContent = "",
    interactiveElements = [],
    lastAction = "",
    lastObservation = "",
    history = [],
    scratchpad = [],
    taskContext = {},
    progressMetrics = {},
    failurePatterns = [],
    successCriteria = {},
    chatSummary = ""
  } = context || {};

  const chatSummaryLog = chatSummary
    ? `CHAT SUMMARY (Recent conversation with user):
---
${chatSummary}
---`
    : "";

  const scratchpadLog = scratchpad.length > 0
    ? `AGENT'S SCRATCHPAD (Working Memory):
---
${scratchpad.join("\n\n")}
---`
    : "AGENT'S SCRATCHPAD (Working Memory):\n---No notes taken yet.---\n";

  const successCriteriaLog = successCriteria
    ? `SUCCESS CRITERIA (Your goal is to populate this structure):
---
${JSON.stringify(successCriteria, null, 2)}
---`
    : "";

  const elementsLog = interactiveElements.length > 0
    ? `Available Interactive Elements (prioritized by relevance and score):
  ---
  ${JSON.stringify(interactiveElements.slice(0, 15).map(el => ({ ...el, score: el.score || 'N/A', purpose: el.purpose || 'N/A' })), null, 2)}
  ---`
    : "No interactive elements found. Consider navigation or page loading issues.";

  const contextualInsights = generateContextualInsights(history, lastAction, lastObservation, failurePatterns);
  
  const progressAnalysis = analyzeProgress(history, currentSubTask, progressMetrics);

  // Get template suggestions based on the goal for enhanced autonomous decision-making
  const AutomationTemplatesRef = (typeof window !== 'undefined' && window.AutomationTemplates) || 
                                 (typeof globalThis !== 'undefined' && globalThis.AutomationTemplates);
  const templateSuggestions = AutomationTemplatesRef ? 
    AutomationTemplatesRef.suggestTemplates(fullGoal) : [];
  
  const templateGuidance = templateSuggestions.length > 0 ? 
    `\n\nAUTONOMOUS WORKFLOW GUIDANCE:
Based on your goal, these proven automation patterns may help:
${templateSuggestions.map(t => 
  `• ${t.name}: ${t.description}
    Recommended sites: ${t.sites?.join(', ') || t.platforms?.join(', ') || t.sources?.join(', ') || 'Multiple sources'}
    Key steps: ${t.workflow.slice(0, 4).join(' → ')}`
).join('\n')}

Use these patterns to guide your autonomous decision-making and site selection.` : '';

  return (
`You are an intelligent web automation agent with advanced contextual reasoning and autonomous decision-making capabilities.

MISSION CONTEXT:
Overall Goal: ${fullGoal}
Current Sub-Task: ${currentSubTask}
Task Type: ${taskContext.taskType || 'general'}
Expected Complexity: ${taskContext.complexity || 'unknown'}

CURRENT ENVIRONMENT:
Page: ${title} (${url})
Content Available: ${pageContent ? 'Yes' : 'No'}
Interactive Elements: ${interactiveElements.length} found

${elementsLog}
${templateGuidance}

EXECUTION CONTEXT:
${progressAnalysis}

${scratchpadLog}

${chatSummaryLog}

${successCriteriaLog}

LAST ACTION ANALYSIS:
Action: ${JSON.stringify(lastAction) || "None"}
Result: ${lastObservation || "No observation"}
${contextualInsights}

ENHANCED AUTONOMOUS REASONING:
Before deciding your next action, consider:
1. PROGRESS: Are you making meaningful progress toward the sub-task?
2. PATTERNS: Have you tried similar actions before? What were the results?
3. CONTEXT: Does the current page state align with your sub-task requirements?
4. EFFICIENCY: Is there a more direct path to accomplish the goal?
5. VALIDATION: Can you verify if previous actions actually succeeded?
6. TEMPLATES: Do the workflow guidance patterns above suggest better approaches or sites?
7. AUTONOMY: Can you independently navigate to relevant sites without explicit user direction?

ADVANCED DECISION FRAMEWORK:
- Autonomous Navigation: You can proactively navigate to relevant websites (Amazon, Google, Wikipedia, etc.) based on the goal type, without waiting for explicit navigation instructions
- Smart Site Selection: Use the template guidance above to choose the most appropriate websites for different task types
- Multi-Source Strategy: For research tasks, automatically plan to visit multiple authoritative sources
- Contextual Adaptation: Adapt your approach based on what type of content/functionality each website offers
- Plan before acting: internally enumerate the next 2–4 concrete steps required to reach the sub-task goal. Then output ONLY the next action as JSON.
- If stuck in a loop, proactively try different websites or approaches based on template guidance
- Enhanced Reliability Mode: Elements are now always fetched fresh for each interaction to prevent bfcache issues. The system automatically refreshes elements before clicks/typing.
- Redundant sensing optimization: If recent Page Content is available, DO NOT propose "readPageContent" again unless the page has significantly changed. Focus on concrete actions using available content.
- If your last two proposed tools were "readPageContent" or "getInteractiveElements" and were skipped as redundant, you MUST NOT propose them again; choose a concrete action instead.
- When selecting an element, heavily weigh its "purpose", "accessibleName", and labels (aria-label, placeholder, name, text, title). **CRITICAL: Do NOT use \`elementIndex\` unless there is no robust selector.** Prefer selectors like: button[aria-label="Send"], [role="button"]:has-text("Send"), input[name="to"], input[placeholder*="Subject"].
- For “finalizing” actions (submit/send/confirm), explicitly prefer elements whose purpose/score indicates finalization over nearby formatting/attachment/settings controls.
- If actions fail repeatedly, reassess the sub-task or mark as done to move forward.
- Prioritize actions that directly advance the current sub-task.
- Use screenshots only for complex visual disambiguation or validation—not as a default sensing step.

Page Content Preview (first 2000 chars):
---
${(pageContent || "").substring(0, 2000)}${pageContent && pageContent.length > 2000 ? "..." : ""}
---

Return ONLY a JSON object with your next action. Your entire reply must be a single JSON object with no extra commentary or markdown:
{
  "tool": "readPageContent|navigateToUrl|clickElement|typeText|scrollTo|waitForSelector|take_screenshot|tabs.query|tabs.activate|tabs.close|done|recordFinding|analyzeUrls|extractStructuredContent|extractLinks|scrapeSelector|getInteractiveElements",
  "params": { /* tool-specific parameters */ },
  "rationale": "Clear reasoning for this action based on context and progress",
  "element_analysis": "Brief analysis of the chosen element and why it was selected",
  "confidence": 0.85,
  "done": false
}
 
Choose the most contextually appropriate action to advance the current sub-task efficiently.`
  );
}

function generateContextualInsights(history, lastAction, lastObservation, failurePatterns) {
  if (!lastAction || !lastObservation) return "No previous action to analyze.";
  
  const insights = [];
  
  // Analyze last action success
  const failed = lastObservation.toLowerCase().includes('failed') ||
                 lastObservation.toLowerCase().includes('error') ||
                 lastObservation.toLowerCase().includes('not found');
  
  if (failed) {
    insights.push("⚠️ Last action failed - consider alternative approach");
  } else {
    insights.push("✓ Last action appears successful");
  }
  
  // Check for repetitive patterns
  const recentActions = history.slice(-3).map(h => h.action?.tool);
  const isRepeating = recentActions.length >= 2 &&
                     recentActions.every(tool => tool === recentActions[0]);
  
  if (isRepeating) {
    insights.push("🔄 Detected repetitive actions - try different strategy");
  }
  
  // Check for navigation patterns
  if (lastAction.tool === 'navigate' && lastObservation.includes('Navigated')) {
    insights.push("🌐 Page navigation completed - elements may need time to load");
  }
  
  return insights.length > 0 ? insights.join("\n") : "Action completed normally.";
}

function analyzeProgress(history, currentSubTask, progressMetrics) {
  const totalSteps = history.length;
  const successfulSteps = history.filter(h =>
    h.observation &&
    !h.observation.toLowerCase().includes('failed') &&
    !h.observation.toLowerCase().includes('error')
  ).length;
  
  const successRate = totalSteps > 0 ? (successfulSteps / totalSteps * 100).toFixed(1) : 0;
  
  return `Progress Analysis:
- Steps Taken: ${totalSteps}
- Success Rate: ${successRate}%
- Current Focus: ${currentSubTask}
- Momentum: ${successfulSteps >= 2 ? 'Good' : totalSteps > 5 ? 'Struggling' : 'Starting'}`;
}

function buildTaskDecompositionPrompt(goal, pageInfo = {}) {
  // Get template suggestions for enhanced planning
  const AutomationTemplatesRef = (typeof window !== 'undefined' && window.AutomationTemplates) || 
                                 (typeof globalThis !== 'undefined' && globalThis.AutomationTemplates);
  const suggestions = AutomationTemplatesRef ? 
    AutomationTemplatesRef.suggestTemplates(goal).slice(0, 2) : [];
  
  const templateContext = suggestions.length > 0 ? 
    `\n\nRELEVANT AUTOMATION TEMPLATES:\n${suggestions.map(t => 
      `- ${t.name}: ${t.description}\n  Typical workflow: ${t.workflow.slice(0, 3).join(' → ')}`
    ).join('\n')}` : '';

  return (
`You are an expert task planner with deep understanding of web automation workflows. Your job is to break down complex goals into a series of logical, executable sub-tasks that build upon each other.

User Goal: ${goal}

Current Page Context:
- URL: ${pageInfo.url || 'unknown'}
- Title: ${pageInfo.title || 'unknown'}
${templateContext}

ENHANCED PLANNING PRINCIPLES:
1. **STRICT Step Limit:** The plan must have a STRICT MAXIMUM of 5 steps. Be extremely concise.
2. **Template-Guided Planning:** If relevant templates exist above, adapt their proven workflows to the user's specific goal.
3. **Simplicity First:** Prioritize the simplest, most direct path. Avoid redundant steps.
4. **Logical Dependencies:** Tasks must follow a logical order (e.g., navigate before interacting).
5. **Mandatory Navigation:** If the current page is not relevant, the first step MUST be navigation (e.g., to google.com).
6. **Atomic & Verifiable:** Each sub-task should be a single, clear action.
7. **Final Synthesis:** The final step should typically be to synthesize information or generate a report.

AUTONOMOUS TASK CATEGORIES:
- Navigation: Moving between pages/sites (use proven URLs from templates when available)
- Search: Finding information or content (leverage template search strategies)
- Interaction: Clicking, filling forms, scrolling (use template-specific selectors/approaches)
- Data Collection: Extract and organize information (follow template data patterns)
- Validation: Checking if actions succeeded (template-based success criteria)
- Data Extraction: Gathering specific information
- Synthesis: Combining information from multiple sources

DECOMPOSITION STRATEGY:
1. Analyze the current page context. If it's not relevant, the first sub-task must be navigation.
2. Start with high-level phases (e.g., navigate, search, extract).
3. Break each phase into specific, actionable steps.
4. Add validation checkpoints where necessary.

Example for "Research the best restaurants in Paris" when on "chrome://newtab":
{
  "subTasks": [
    "Navigate to https://www.google.com",
    "Search for 'best restaurants in Paris'",
    "Analyze search results and navigate to the most promising link",
    "Extract key information (names, ratings) from the page",
    "Synthesize the findings into a final report"
  ],
  "context": {
    "taskType": "research",
    "expectedDuration": "short",
    "complexity": "low",
    "dependencies": ["web_search", "data_extraction"]
  }
}

Analyze the goal and current page context, then create a comprehensive task breakdown.
Return ONLY the JSON object with a subTasks array and context object.`
  );
}

/**
 * Build a research-specific task decomposition prompt
 */
function buildResearchTaskDecompositionPrompt(goal) {
  return `You are a research planning assistant. Your job is to break down the user's research goal into a series of systematic research steps that will gather comprehensive, reliable information.

Research Goal:
${goal}

Decompose this research goal into a JSON array of strings, where each string is a research sub-task. Follow this research methodology:

1. Start with broad searches on the main topic
2. Visit authoritative sources (Wikipedia, official websites, academic sources)
3. Gather multiple perspectives and recent information
4. Look for specific details, statistics, or examples
5. Synthesize findings from multiple sources

Example for "Research the benefits of renewable energy":
{
  "subTasks": [
    "Navigate to Google and search for 'renewable energy benefits 2024'",
    "Visit Wikipedia page on renewable energy to get foundational knowledge",
    "Search for 'renewable energy statistics latest data' to find current numbers",
    "Visit government energy department website for official information",
    "Search for 'renewable energy environmental impact studies' for scientific perspective",
    "Look up recent news articles about renewable energy developments",
    "Gather information about economic benefits and job creation",
    "Compile and synthesize all findings into comprehensive summary"
  ]
}

Create research steps that will provide thorough, multi-source coverage of the topic.
Return ONLY the JSON object. Do not include any other text or markdown.`;
}

/**
 * Build a YouTube-specific action prompt
 */
function buildYouTubeActionPrompt(goal, context = {}) {
  return `You are an AI agent that can navigate and interact with YouTube. Your goal is to help the user find and access YouTube content.

Current Goal: ${goal}

Current Context:
- URL: ${context.url || 'Unknown'}
- Page Title: ${context.title || 'Unknown'}
- Page Content: ${context.pageContent ? context.pageContent.substring(0, 500) + '...' : 'Not available'}

Available Tools (ONLY use these exact tool names):
- navigateToUrl: Go to a specific URL
- clickElement: Click on elements using CSS selectors
- typeText: Fill input fields with text
- scrollTo: Scroll to find more content. direction must be "up", "down", "top" or "bottom".
- waitForSelector: Wait for elements to appear
- take_screenshot: Take a screenshot
- done: Mark task as complete

For YouTube tasks, follow this approach:
1. If not on YouTube, navigate to youtube.com first
2. Use the search box to search for content (use "typeText" tool)
3. Click on relevant video results
4. Handle any popups or overlays that might appear
5. When the page shows indexed overlays, prefer using a robust CSS selector that includes text or a unique attribute. Use "elementIndex" only as a last resort if a stable selector cannot be found.

Important YouTube selectors:
- Search box: 'input#search' or '[name="search_query"]'
- Search button: 'button#search-icon-legacy' or '[aria-label="Search"]'
- Video thumbnails: 'a#video-title' or 'ytd-video-renderer a'
- Play button: '.ytp-play-button' or '[aria-label="Play"]'

Return your next action as JSON (use ONLY the exact tool names listed above):
{
  "tool": "navigateToUrl|clickElement|typeText|scrollTo|waitForSelector|take_screenshot|done",
  "params": {
    "url": "https://youtube.com" (for navigateToUrl only),
    "selector": "CSS selector" (for clickElement/typeText/scrollTo/waitForSelector),
    "text": "text to type" (for typeText only),
    "direction": "up|down|top|bottom" (for scrollTo only),
    "timeoutMs": 5000 (for waitForSelector only)
  },
  "rationale": "Why this action will help achieve the goal",
  "done": false
}

Focus on taking concrete actions rather than providing explanations.`;
}

/**
 * Build a general action-oriented prompt for navigation tasks
 */
function buildNavigationActionPrompt(goal, context = {}) {
  return `You are an AI agent that can navigate websites and perform actions. Your goal is to help the user accomplish their task through direct interaction.

Current Goal: ${goal}

Current Context:
- URL: ${context.url || 'Unknown'}
- Page Title: ${context.title || 'Unknown'}
- Page Content: ${context.pageContent ? context.pageContent.substring(0, 500) + '...' : 'Not available'}
- Last Action: ${context.lastAction || 'None'}
- Last Observation: ${context.lastObservation || 'None'}

Available Tools (ONLY use these exact tool names):
- navigateToUrl: Go to a specific URL
- clickElement: Click on elements using CSS selectors
- typeText: Fill input fields with text
- scrollTo: Scroll to find more content
- waitForSelector: Wait for elements to appear
- take_screenshot: Take a screenshot to see current state
- done: Mark task as complete

Action Guidelines:
1. Take concrete actions rather than providing explanations
2. If the goal involves a specific website, navigate there first
3. Use search functionality when looking for specific content
4. Click on relevant links or buttons to progress toward the goal
5. Fill forms or input fields as needed
6. Wait for elements to load when necessary
7. Prefer using a robust CSS "selector" that includes text or a unique attribute. Use "elementIndex" (overlay number) only as a last resort if a stable selector cannot be found.

Return your next action as JSON (use ONLY the exact tool names listed above):
{
  "tool": "navigateToUrl|clickElement|typeText|scrollTo|waitForSelector|take_screenshot|done",
  "params": {
    "url": "full URL" (for navigateToUrl only),
    "selector": "CSS selector" (for clickElement/typeText/scrollTo/waitForSelector),
    "text": "text to type" (for typeText only),
    "direction": "up|down|top|bottom" (for scrollTo only),
    "timeoutMs": 5000 (for waitForSelector only)
  },
  "rationale": "Brief explanation of why this action helps achieve the goal",
  "done": false
}

Focus on taking the most direct action to accomplish the user's request.`;
}

function buildSelfCorrectPrompt(fullGoal, currentSubTask, context = {}) {
  const {
    url = "",
    title = "",
    pageContent = "",
    interactiveElements = [],
    history = [],
    failedAction = {},
    observation = "",
    errorInfo = {}, // Enhanced error info
    taskContext = {},
    attemptCount = 1
  } = context || {};

  const historyLog = history.slice(-3).map((h, i) => {
    const success = h.observation && !h.observation.toLowerCase().includes('failed') && !h.observation.toLowerCase().includes('error');
    return `Step ${history.length - 3 + i}: ${success ? '✓' : '✗'} Action: ${h.action?.tool}, Params: ${JSON.stringify(h.action?.params)}, Observation: ${(h.observation || "").substring(0, 80)}`;
  }).join("\n");

  const trimmedElements = interactiveElements.slice(0, 12).map(el => ({
    idx: (el.index !== undefined ? el.index : (el.idx !== undefined ? el.idx : (el.elementIndex !== undefined ? el.elementIndex : null))),
    tag: el.tag || el.tagName || null,
    id: el.id || null,
    name: el.name || null,
    label: el.label || el.ariaLabel || null,
    placeholder: el.placeholder || null,
    text: el.text ? (el.text.length > 60 ? el.text.slice(0, 60) + '...' : el.text) : null,
    role: el.role || null,
    score: (el.score !== undefined ? el.score : null)
  }));

  const elementsLog = trimmedElements.length > 0
    ? `Available Interactive Elements (Top 12, trimmed):\n---\n${JSON.stringify(trimmedElements, null, 2)}\n---`
    : "No interactive elements found.";

  const failureAnalysis = analyzeFailurePattern(failedAction, observation, history);
  const recoveryStrategy = suggestRecoveryStrategy(failedAction, observation, history, attemptCount);

  return (
`You are an expert error recovery agent. Your task is to analyze a failed web automation action and propose a single, precise correction to fix it.

MISSION:
- Overall Goal: ${fullGoal}
- Current Sub-Task: ${currentSubTask}

FAILURE CONTEXT:
- Page: ${title} (${url})
- Failed Action: ${JSON.stringify(failedAction)}
- Observation: "${observation}"
- Error Code: "${errorInfo.code || 'N/A'}"
- Attempt: ${attemptCount}

ANALYSIS & STRATEGY:
- Failure Analysis: ${failureAnalysis}
- Suggested Strategy: ${recoveryStrategy}

AVAILABLE ELEMENTS & HISTORY:
${elementsLog}

Recent History (last 3 steps):
---
${historyLog || "No recent actions."}
---

INSTRUCTIONS:
1.  **Analyze the Root Cause**: Based on the observation, error code, and available elements, determine why the action failed.
2.  **Propose a Correction**: Generate a *single* new action to overcome the failure.
3.  **Prioritize Small Changes**: Prefer modifying the failed action (e.g., correcting a selector or index) over drastic changes like navigating away.
4.  **Avoid Redundant Sensing**: If interactive elements are already available or page content was just read, do NOT propose "readPageContent" or "getInteractiveElements" again. Advance with a concrete action (e.g., clickElement, typeText, waitForSelector, scrollTo).
5.  **Use Reliable Selectors**: Prefer correcting the CSS selector to be more specific (e.g., using text or an \`aria-label\`). Use \`elementIndex\` only as a last resort if a stable selector cannot be found.
6.  **Be Precise**: Do not explain or chat. Your entire response must be a single JSON object.

Respond with ONLY a valid JSON object for the corrected action:
{
  "tool": "...",
  "params": { ... },
  "rationale": "A brief, clear reason for this specific correction.",
  "confidence": 0.9,
  "done": false
}`
  );
}

function analyzeFailurePattern(failedAction, observation, history) {
  const analysis = [];
  
  // Categorize the error
  const errorType = categorizeError(observation);
  analysis.push(`Error Category: ${errorType}`);
  
  // Check for repeated failures
  const recentFailures = history.slice(-3).filter(h =>
    h.observation && (
      h.observation.toLowerCase().includes('failed') ||
      h.observation.toLowerCase().includes('error') ||
      h.observation.toLowerCase().includes('not found')
    )
  );
  
  if (recentFailures.length >= 2) {
    analysis.push(`⚠️ Pattern: ${recentFailures.length} recent failures detected`);
  }
  
  // Analyze specific failure reasons
  if (observation.toLowerCase().includes('selector')) {
    analysis.push("Issue: Element selector problem - element may not exist or be visible");
  } else if (observation.toLowerCase().includes('timeout')) {
    analysis.push("Issue: Timing problem - element may load slowly or action needs delay");
  } else if (observation.toLowerCase().includes('navigation')) {
    analysis.push("Issue: Navigation problem - page may not have loaded correctly");
  }
  
  return analysis.join('\n');
}

function suggestRecoveryStrategy(failedAction, observation, history, attemptCount) {
  const strategies = [];
  
  if (attemptCount === 1) {
    strategies.push("First failure - try modified approach with same goal");
  } else if (attemptCount === 2) {
    strategies.push("Second failure - consider alternative method or context refresh");
  } else {
    strategies.push("Multiple failures - consider navigation recovery or sub-task skip");
  }
  
  // Specific strategies based on action type
  if (failedAction.tool === 'clickElement') {
      strategies.push("Click failure options: try a more specific CSS selector, use 'waitForSelector' before clicking, or scroll the element into view.");
  } else if (failedAction.tool === 'typeText') {
      strategies.push("Type failure options: ensure the element is a visible input/textarea, try clearing the field first, or use a different selector.");
  } else if (failedAction.tool === 'navigateToUrl') {
      strategies.push("Navigation failure options: double-check the URL for typos, try a different URL, or check for network issues.");
  }
  
  return strategies.join('\n');
}

function categorizeError(observation) {
  const obs = observation.toLowerCase();
  if (obs.includes('not found') || obs.includes('selector')) return 'ELEMENT_NOT_FOUND';
  if (obs.includes('timeout')) return 'TIMEOUT';
  if (obs.includes('navigation') || obs.includes('navigate')) return 'NAVIGATION_ERROR';
  if (obs.includes('permission') || obs.includes('blocked')) return 'PERMISSION_ERROR';
  if (obs.includes('network') || obs.includes('connection')) return 'NETWORK_ERROR';
  return 'UNKNOWN_ERROR';
}

/**
 * Build a research-focused prompt for comprehensive information gathering
 */
function buildResearchPrompt(query, context = {}) {
  const { pageContent = "", searchResults = [], previousFindings = [] } = context;
  
  return `You are an AI research assistant. Your task is to help the user research and understand information about their query.

User's Research Query: "${query}"

${pageContent ? `Current Page Content:\n---\n${pageContent}\n---\n` : ''}

${searchResults.length > 0 ? `Search Results Found:\n${searchResults.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join('\n')}\n---\n` : ''}

${previousFindings.length > 0 ? `Previous Research Findings:\n${previousFindings.join('\n')}\n---\n` : ''}

Please provide a comprehensive response that:
1. Directly answers the user's query based on available information
2. Synthesizes information from multiple sources if available
3. Identifies key insights and important details
4. Suggests follow-up questions or areas for deeper research
5. Maintains a helpful, conversational tone like a personal assistant

If you need more information to fully answer the query, suggest specific search terms or websites that would be helpful.`;
}

/**
 * Build a prompt for multi-source research synthesis
 */
function buildResearchSynthesisPrompt(query, sources = []) {
  const sourcesText = sources.map((source, i) =>
    `Source ${i+1}: ${source.title || source.url}
Content: ${source.content}
---`
  ).join('\n');

  return `You are an AI research assistant synthesizing information from multiple sources.

Research Query: "${query}"

Sources to Synthesize:
${sourcesText}

Please provide a comprehensive research summary that:
1. Combines insights from all sources
2. Identifies common themes and contradictions
3. Provides a balanced, well-researched answer
4. Cites which sources support each point
5. Highlights the most reliable and recent information
6. Suggests areas where more research might be needed

Format your response as a personal assistant would - conversational but thorough.`;
}

/**
 * Enhanced agent planning prompt with research capabilities
 */
function buildResearchAgentPrompt(researchGoal, currentSubTask, context = {}) {
  const { url = "", title = "", pageContent = "", interactiveElements = [], lastAction = "", lastObservation = "", history = [] } = context || {};
  
  const historyLog = history.map((h, i) =>
    `Step ${i}:
- Action: ${JSON.stringify(h.action)}
- Observation: ${h.observation}`
  ).join("\n\n");

  const elementsLog = interactiveElements.length > 0
    ? `Available Interactive Elements (use these for selectors):
---
${JSON.stringify(interactiveElements.slice(0, 20), null, 2)}
---`
    : "No interactive elements were found.";


  return `You are an intelligent AI research assistant with advanced web analysis capabilities. Your mission is to conduct comprehensive, human-like research by automatically reading and analyzing URLs, extracting meaningful information, and synthesizing findings from multiple sources.

Research Goal: ${researchGoal}
Current Sub-Task: ${currentSubTask}

CURRENT CONTEXT:
Page: ${title} (${url})
Page Type: ${categorizePageForResearch(url)}

${elementsLog}

SEMANTIC SECTIONS (A structured overview of the page):
---
${context.sections ? JSON.stringify(context.sections.slice(0, 5), null, 2) : "No semantic sections found."}
---

ENHANCED PAGE ANALYSIS:
${pageContent ? `Content Preview (${pageContent.length} chars):
---
${pageContent.substring(0, 2000)}${pageContent.length > 2000 ? '...' : ''}
---` : 'No content extracted yet'}

DISCOVERED URLS & LINKS:
${context.interactiveElements ? analyzePageUrls(context.interactiveElements) : 'No URL analysis available'}

AVAILABLE RESEARCH TOOLS:
- readPageContent: Read and process the full content of the current page. This should be used after navigating to a new page.
- smart_navigate: Intelligently navigate to the best source for your query (location-aware)
- multi_search: Perform multiple location-aware searches for comprehensive results
- research_url: Automatically research a specific URL with depth control (supports recursive reading)
- analyze_url_depth: Analyze if current page URLs are worth reading deeper
- analyzeUrls: Analyze all URLs on current page for research relevance
- extractLinks: Extract and rank relevant links from current page
- navigateToUrl: Go to a specific URL
- clickElement: Click on elements using CSS selectors
- typeText: Fill input fields with text
- scrollTo: Scroll to find more content
- waitForSelector: Wait for elements to appear
- take_screenshot: Take a screenshot for visual analysis
- extractStructuredContent: Get enhanced content extraction with metadata
- extract_with_regex: Extract specific information from text using a regex pattern.
- recordFinding: Saves a structured data object to your findings. CRITICAL: All data MUST be passed in a single 'finding' object. DO NOT invent other parameters. Example: { "tool": "recordFinding", "params": { "finding": { "exchange_rate": "3.45", "currency_pair": "SGD_to_MYR" } } }
- generateReport: Create a comprehensive research report. You can only use this when the success criteria are met.
- done: Mark research complete. You can only use this when the success criteria are met.

// CORE_ACTION_LOOP:
// 1. **Sense**: After navigating, ALWAYS use \`readPageContent\` to understand the environment.
// 2. **Extract**: Use tools like \`extractStructuredContent\` to get specific data.
// 3. **Validate**: Check if the extracted data fits the SUCCESS CRITERIA.
// 4. **Record**: Use \`recordFinding\` to save the validated data.
// 5. **Repeat**: Continue until all success criteria are met.

LOCATION-AWARE FEATURES:
- Automatically detects user location from timezone (e.g., Singapore from Asia/Singapore)
- Generates location-specific search terms (e.g., "ipad price singapore", "apple store singapore")
- Prioritizes local and regional sources for relevant queries
- Supports multiple search strategies for comprehensive coverage

RESEARCH EXECUTION HISTORY:
${historyLog || "Starting research - no previous actions"}

LAST ACTION ANALYSIS:
Action: ${JSON.stringify(lastAction) || "None"}
Result: ${lastObservation || "None"}
${analyzeLastActionForResearch(lastAction, lastObservation)}

INTELLIGENT DECISION FRAMEWORK:
Consider these factors for your next action:
1. **Content Quality**: Is the current page providing valuable research information?
2. **URL Opportunities**: Are there relevant URLs on this page to explore?
3. **Source Diversity**: Have you gathered information from multiple types of sources?
4. **Research Depth**: Do you need more specific or general information?
5. **Synthesis Readiness**: Do you have enough information to provide comprehensive insights?

// **CRITICAL RULE 1: DO NOT use the \`generateReport\` tool until you have gathered sufficient information from at least 2-3 different sources.** If you have not gathered enough information, you MUST use tools like \`smart_navigate\`, \`research_url\`, or \`multi_search\` first.
// **CRITICAL RULE 2: DO NOT be repetitive. If you have already performed a search, analyze the results and navigate to a link. Do not perform the same search again.**

HUMAN-LIKE RESEARCH BEHAVIOR:
- Automatically read and follow relevant URLs found in content
- Prioritize authoritative sources (academic, government, established organizations)
- Cross-reference information from multiple sources
- Look for recent and up-to-date information
- Extract key facts, statistics, and insights
- Identify contradictions or different perspectives

Return a single, valid JSON object that conforms to the action schema.
Example:
{
  "tool": "smart_navigate",
  "params": { "query": "best laptops 2024" },
  "rationale": "The current page is not relevant, so I will start by searching for the research goal.",
  "confidence": 0.9,
  "done": false
}

Your response MUST be a valid JSON object.

Focus on taking intelligent, autonomous actions that mimic how a human researcher would naturally explore and analyze information.`;
}

/**
 * Build a prompt for intelligent search query generation
 */
function buildSearchQueryPrompt(userQuery, context = {}) {
  const { previousSearches = [], currentFindings = [] } = context;
  
  return `You are an AI research assistant helping to generate effective search queries.

User's Original Request: "${userQuery}"

${previousSearches.length > 0 ? `Previous Searches Performed:\n${previousSearches.join('\n')}\n` : ''}

${currentFindings.length > 0 ? `Current Findings:\n${currentFindings.join('\n')}\n` : ''}

Generate 3-5 specific, effective Google search queries that would help research this topic comprehensively. Consider:
1. Different aspects of the topic
2. Various perspectives (pros/cons, different viewpoints)
3. Recent developments and current information
4. Authoritative sources and expert opinions
5. Practical applications or real-world examples

Format as a simple list:
1. [search query 1]
2. [search query 2]
3. [search query 3]
etc.

Make the queries specific enough to find quality information but broad enough to capture comprehensive coverage.`;
}

/**
 * Build an AI-powered intent classification prompt
 */
function buildIntentClassificationPrompt(userMessage, currentContext = {}) {
  return `You are an AI intent classifier. Analyze the user's message and determine what type of action they want to perform.

User Message: "${userMessage}"

Current Context:
- Current URL: ${currentContext.url || 'Unknown'}
- Page Title: ${currentContext.title || 'Unknown'}

Available Intent Categories:
1. YOUTUBE - User wants to interact with YouTube (search videos, play videos, navigate YouTube)
2. NAVIGATION - User wants to navigate to websites, open pages, browse to specific URLs
3. RESEARCH - User wants to gather information, research topics, find comprehensive data from multiple sources
4. AUTOMATION - User wants to automate web interactions (click, fill forms, scroll, interact with page elements)
5. CONVERSATION - User wants to have a conversation, ask questions that don't require web actions

Classification Guidelines:
- YOUTUBE: Contains references to YouTube, videos, playing content, video searches
- NAVIGATION: Contains "go to", "visit", "navigate", "open", URLs, website names
- RESEARCH: Contains "research", "find information", "investigate", question words (what, how, why), requests for comprehensive information
- AUTOMATION: Contains action verbs like "click", "fill", "scroll", "login", "submit", specific UI interactions
- CONVERSATION: General questions, casual chat, requests for explanations without needing web actions

Return ONLY a JSON object with this exact format:
{
  "intent": "YOUTUBE|NAVIGATION|RESEARCH|AUTOMATION|CONVERSATION",
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this intent was chosen",
  "suggestedAction": "What the user likely wants to accomplish"
}

Examples:
- "youtube find yapweijun1996 and play related video" → {"intent": "YOUTUBE", "confidence": 0.98, "reasoning": "Explicitly mentions YouTube and video playing", "suggestedAction": "Navigate to YouTube, search for yapweijun1996, and play related videos"}
- "go to google.com" → {"intent": "NAVIGATION", "confidence": 0.99, "reasoning": "Clear navigation request to specific website", "suggestedAction": "Navigate to google.com"}
- "what is machine learning?" → {"intent": "RESEARCH", "confidence": 0.90, "reasoning": "Question seeking comprehensive information", "suggestedAction": "Research machine learning from multiple authoritative sources"}
- "click the login button" → {"intent": "AUTOMATION", "confidence": 0.95, "reasoning": "Specific UI interaction request", "suggestedAction": "Locate and click the login button on current page"}

Analyze the user's message and return the classification.`;
}
function buildReportGenerationPrompt(goal, content, format) {
  return (
`You are an AI assistant tasked with generating a user-facing report based on a completed goal and gathered information.

User's Goal: "${goal}"

Structured Findings (JSON):
---
${content}
---

Report Generation Guidelines:
1. Synthesize the gathered information into a coherent report.
2. Structure the report logically with clear headings, lists, and paragraphs.
3. Ensure the tone is helpful, professional, and easy to understand.
4. If the requested format is "markdown", use appropriate Markdown syntax for formatting (e.g., # for headings, * for lists, ** for bold).
5. If the requested format is "story", weave the information into a narrative.
6. The report should directly address the user's original goal.
7. If the findings are empty, state that you were unable to find the information and suggest alternative ways the user can find it.

Please generate the report in ${format} format.`
  );
}
// Helper functions for enhanced research prompts
function categorizePageForResearch(url) {
  if (!url) return 'unknown';
  
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('wikipedia.org')) return 'encyclopedia';
  if (lowerUrl.includes('youtube.com')) return 'video_platform';
  if (lowerUrl.includes('google.com/search')) return 'search_results';
  if (lowerUrl.includes('scholar.google')) return 'academic_search';
  if (lowerUrl.includes('github.com')) return 'code_repository';
  if (lowerUrl.includes('stackoverflow.com')) return 'qa_forum';
  if (lowerUrl.includes('reddit.com')) return 'social_forum';
  if (lowerUrl.includes('.edu')) return 'academic_institution';
  if (lowerUrl.includes('.gov')) return 'government';
  if (lowerUrl.includes('news') || lowerUrl.includes('bbc.com') || lowerUrl.includes('cnn.com')) return 'news_source';
  if (lowerUrl.includes('blog')) return 'blog';
  
  return 'general_website';
}

function analyzePageUrls(interactiveElements) {
  if (!interactiveElements || !Array.isArray(interactiveElements)) {
    return 'No interactive elements to analyze';
  }
  
  const links = interactiveElements.filter(el => el.tag === 'a' && el.text);
  if (links.length === 0) {
    return 'No links found on current page';
  }
  
  const categorizedLinks = {
    research_sources: [],
    external_sites: [],
    related_content: []
  };
  
  links.forEach(link => {
    const text = link.text.toLowerCase();
    if (text.includes('research') || text.includes('study') || text.includes('paper') || text.includes('academic')) {
      categorizedLinks.research_sources.push(`"${link.text}"`);
    } else if (text.includes('more') || text.includes('related') || text.includes('similar')) {
      categorizedLinks.related_content.push(`"${link.text}"`);
    } else if (link.text.length > 10) {
      categorizedLinks.external_sites.push(`"${link.text}"`);
    }
  });
  
  const analysis = [];
  if (categorizedLinks.research_sources.length > 0) {
    analysis.push(`Research Sources: ${categorizedLinks.research_sources.slice(0, 3).join(', ')}`);
  }
  if (categorizedLinks.related_content.length > 0) {
    analysis.push(`Related Content: ${categorizedLinks.related_content.slice(0, 3).join(', ')}`);
  }
  if (categorizedLinks.external_sites.length > 0) {
    analysis.push(`External Links: ${categorizedLinks.external_sites.slice(0, 3).join(', ')}`);
  }
  
  return analysis.length > 0 ? analysis.join('\n') : `Found ${links.length} links but none categorized as highly relevant`;
}

function analyzeLastActionForResearch(lastAction, lastObservation) {
  if (!lastAction || !lastObservation) {
    return 'No previous action to analyze - starting fresh research';
  }
  
  const analysis = [];
  const obs = lastObservation.toLowerCase();
  
  if (lastAction.tool === 'navigate' || lastAction.tool === 'smart_navigate') {
    if (obs.includes('navigated')) {
      analysis.push('✓ Successfully navigated to new page - ready to extract content');
    } else {
      analysis.push('⚠ Navigation may have failed - consider alternative approach');
    }
  } else if (lastAction.tool === 'extract_structured_content') {
    if (obs.includes('extracted')) {
      analysis.push('✓ Content extraction successful - analyze for research value');
    } else {
      analysis.push('⚠ Content extraction failed - try different approach');
    }
  } else if (lastAction.tool === 'get_page_links') {
    if (obs.includes('found')) {
      analysis.push('✓ Links discovered - consider following most relevant ones');
    } else {
      analysis.push('⚠ No links found - may need to search elsewhere');
    }
  } else if (lastAction.tool === 'research_url') {
    if (obs.includes('researched')) {
      analysis.push('✓ URL research completed - content should be available');
    } else {
      analysis.push('⚠ URL research incomplete - may need retry or alternative');
    }
  }
  
  // Check for research progress indicators
  if (obs.includes('comprehensive') || obs.includes('detailed')) {
    analysis.push('📊 Good research depth achieved');
  } else if (obs.includes('basic') || obs.includes('limited')) {
    analysis.push('📊 Research depth could be improved');
  }
  
  return analysis.length > 0 ? analysis.join('\n') : 'Action completed - continue research strategy';
}

function buildChatSummaryPrompt(transcript) {
  const formattedTranscript = transcript.map(m => `${m.role}: ${m.content}`).join('\n');
  return `Summarize the key points and user intent from the following chat transcript. Focus on the most recent user requests and any critical information provided by the agent.

Transcript:
---
${formattedTranscript}
---

Summary:`;
}

function buildCoordinatorPrompt(userMessage, pageInfo = {}) {
  return `You are an intelligent AI coordinator. Your job is to analyze a user's request and decide which tool is best suited to handle it.

User Request: "${userMessage}"

Current Page Context:
- URL: ${pageInfo.url || 'unknown'}
- Title: ${pageInfo.title || 'unknown'}

Available Tools:
1.  **quick_answer**: Use for simple questions, definitions, or requests that do not require accessing a web page.
    - Example: "What is a Chrome extension?", "Explain JavaScript promises"
2.  **web_automation**: Use for tasks that require navigating websites, clicking elements, filling forms, or extracting information from the current or other web pages.
    - Example: "Find the price of an iPad on apple.com", "Log in to my GitHub account"

Decision Framework:
- If the user is asking a general knowledge question, use "quick_answer".
- If the user is asking about the content of the *current* page, or wants to perform an action on *any* web page, use "web_automation".
- For ambiguous requests like "sgd myr", which could be a simple conversion or a request to find the best exchange rate, prefer "web_automation" to provide a more comprehensive answer.

Return ONLY a JSON object with your decision.

Schema:
{
  "tool": "quick_answer" | "web_automation",
  "params": {
    "question": "The user's question for a quick answer", // for quick_answer
    "goal": "The user's goal for web automation" // for web_automation
  }
}

Example 1:
User Request: "What is the capital of France?"
{
  "tool": "quick_answer",
  "params": {
    "question": "What is the capital of France?"
  }
}

Example 2:
User Request: "Find me a good recipe for chocolate cake"
{
  "tool": "web_automation",
  "params": {
    "goal": "Find a good recipe for chocolate cake"
  }
}

Example 3:
User Request: "sgd myr"
{
    "tool": "web_automation",
    "params": {
        "goal": "Find the current exchange rate for SGD to MYR"
    }
}
`;
}