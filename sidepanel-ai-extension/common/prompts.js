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
 *   "tool": string, // one of: "navigate","click","fill","scroll","waitForSelector","screenshot","tabs.query","tabs.activate","tabs.close","done"
 *   "params": object, // as required by the tool (see constraints)
 *   "rationale": string, // brief reason for the chosen action
 *   "done": boolean // true when the overall goal is met
 * }
 * Constraints per tool:
 * - navigate: { "url": "https://..." }
 * - click: { "selector": "CSS selector" }
 * - fill: { "selector": "CSS selector", "value": "text" }
 * - scroll: { "selector": "CSS selector" } OR { "direction": "top"|"bottom" }
 * - waitForSelector: { "selector": "CSS selector", "timeoutMs": number (optional, default 5000) }
 * - screenshot: { "reason": "optional string" }
 * - tabs.query: { "titleContains": "optional", "urlContains": "optional" }
 * - tabs.activate: { "tabId": number }
 * - tabs.close: { "tabId": number }
 * - done: use when you judge the goal is achieved; params can be {}
 *
 * Safety:
 * - Do not propose actions on restricted pages (chrome://, chrome-extension://, edge://, about:, moz-extension://).
 * - Prefer simple and robust selectors; only click visible, interactive elements.
 * - One step per JSON; do not return arrays.
 * - Respond with JSON only, no markdown or prose.
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
    taskContext = {},
    progressMetrics = {},
    failurePatterns = []
  } = context || {};
  
  const historyLog = history.map((h, i) => {
    const success = h.observation && !h.observation.toLowerCase().includes('failed') && !h.observation.toLowerCase().includes('error');
    return `Step ${i + 1}: ${success ? '✓' : '✗'}
- Action: ${JSON.stringify(h.action)}
- Observation: ${h.observation}
- Success: ${success}`;
  }).join("\n\n");

  const elementsLog = interactiveElements.length > 0
    ? `Available Interactive Elements (prioritized by relevance):
---
${JSON.stringify(interactiveElements.slice(0, 15), null, 2)}
---`
    : "No interactive elements found. Consider navigation or page loading issues.";

  const contextualInsights = generateContextualInsights(history, lastAction, lastObservation, failurePatterns);
  
  const progressAnalysis = analyzeProgress(history, currentSubTask, progressMetrics);

  return (
`You are an intelligent web automation agent with contextual reasoning capabilities.

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

EXECUTION CONTEXT:
${progressAnalysis}

RECENT HISTORY (last ${Math.min(history.length, 10)} steps):
---
${historyLog || "No previous actions taken"}
---

LAST ACTION ANALYSIS:
Action: ${JSON.stringify(lastAction) || "None"}
Result: ${lastObservation || "No observation"}
${contextualInsights}

CONTEXTUAL REASONING:
Before deciding your next action, consider:
1. PROGRESS: Are you making meaningful progress toward the sub-task?
2. PATTERNS: Have you tried similar actions before? What were the results?
3. CONTEXT: Does the current page state align with your sub-task requirements?
4. EFFICIENCY: Is there a more direct path to accomplish the goal?
5. VALIDATION: Can you verify if previous actions actually succeeded?

DECISION FRAMEWORK:
- If stuck in a loop, try a different approach or navigate elsewhere
- If elements aren't found, consider waiting, scrolling, or page navigation
- If actions fail repeatedly, reassess the sub-task or mark as done to move forward
- Prioritize actions that directly advance the current sub-task
- Use screenshots for complex pages or when validation is needed

Page Content Preview (first 2000 chars):
---
${(pageContent || "").substring(0, 2000)}${pageContent && pageContent.length > 2000 ? "..." : ""}
---

Return ONLY a JSON object with your next action:
{
  "tool": "navigate|click|fill|scroll|waitForSelector|screenshot|tabs.query|tabs.activate|tabs.close|generate_report|done",
  "params": { /* tool-specific parameters */ },
  "rationale": "Clear reasoning for this action based on context and progress",
  "confidence": 0.85, // 0.0-1.0 confidence in this action
  "done": false // true only when the CURRENT SUB-TASK is definitively complete. This will advance the agent to the next sub-task in the plan.
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
  return (
`You are an expert task planner with deep understanding of web automation workflows. Your job is to break down complex goals into a series of logical, executable sub-tasks that build upon each other.

User Goal: ${goal}

Current Page Context:
- URL: ${pageInfo.url || 'unknown'}
- Title: ${pageInfo.title || 'unknown'}

PLANNING PRINCIPLES:
1. **STRICT Step Limit:** The plan must have a STRICT MAXIMUM of 5 steps. Be extremely concise.
2. **Simplicity First:** Prioritize the simplest, most direct path. Avoid redundant steps.
3. **Logical Dependencies:** Tasks must follow a logical order (e.g., navigate before interacting).
4. **Mandatory Navigation:** If the current page is not relevant, the first step MUST be navigation (e.g., to google.com).
5. **Atomic & Verifiable:** Each sub-task should be a single, clear action.
6. **Final Synthesis:** The final step should typically be to synthesize information or generate a report.

TASK CATEGORIES TO CONSIDER:
- Navigation: Moving between pages/sites
- Search: Finding information or content
- Interaction: Clicking, filling forms, scrolling
- Validation: Checking if actions succeeded
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
- navigate: Go to a specific URL
- click: Click on elements using CSS selectors
- fill: Fill input fields with text
- scroll: Scroll to find more content. direction must be "up" or "down" (lowercase). amountPx optional number.
- waitForSelector: Wait for elements to appear
- screenshot: Take a screenshot
- done: Mark task as complete

For YouTube tasks, follow this approach:
1. If not on YouTube, navigate to youtube.com first
2. Use the search box to search for content (use "fill" tool)
3. Click on relevant video results
4. Handle any popups or overlays that might appear

Important YouTube selectors:
- Search box: 'input#search' or '[name="search_query"]'
- Search button: 'button#search-icon-legacy' or '[aria-label="Search"]'
- Video thumbnails: 'a#video-title' or 'ytd-video-renderer a'
- Play button: '.ytp-play-button' or '[aria-label="Play"]'

Return your next action as JSON (use ONLY the exact tool names listed above):
{
  "tool": "navigate|click|fill|scroll|waitForSelector|screenshot|done",
  "params": {
    "url": "https://youtube.com" (for navigate only),
    "selector": "CSS selector" (for click/fill/scroll/waitForSelector),
    "value": "text to type" (for fill only),
    "direction": "up|down" (for scroll only),
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
- navigate: Go to a specific URL
- click: Click on elements using CSS selectors
- fill: Fill input fields with text
- scroll: Scroll to find more content
- waitForSelector: Wait for elements to appear
- screenshot: Take a screenshot to see current state
- done: Mark task as complete

Action Guidelines:
1. Take concrete actions rather than providing explanations
2. If the goal involves a specific website, navigate there first
3. Use search functionality when looking for specific content
4. Click on relevant links or buttons to progress toward the goal
5. Fill forms or input fields as needed
6. Wait for elements to load when necessary

Return your next action as JSON (use ONLY the exact tool names listed above):
{
  "tool": "navigate|click|fill|scroll|waitForSelector|screenshot|done",
  "params": {
    "url": "full URL" (for navigate only),
    "selector": "CSS selector" (for click/fill/scroll/waitForSelector),
    "value": "text to type" (for fill only),
    "direction": "up|down" (for scroll only),
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
    taskContext = {},
    attemptCount = 1
  } = context || {};
  
  const historyLog = history.map((h, i) => {
    const success = h.observation && !h.observation.toLowerCase().includes('failed') && !h.observation.toLowerCase().includes('error');
    return `Step ${i + 1}: ${success ? '✓' : '✗'}
- Action: ${JSON.stringify(h.action)}
- Observation: ${h.observation}`;
  }).join("\n\n");

  const elementsLog = interactiveElements.length > 0
    ? `Available Interactive Elements:
---
${JSON.stringify(interactiveElements.slice(0, 15), null, 2)}
---`
    : "No interactive elements found - may need navigation or page refresh.";

  // Analyze failure patterns
  const failureAnalysis = analyzeFailurePattern(failedAction, observation, history);
  const recoveryStrategy = suggestRecoveryStrategy(failedAction, observation, history, attemptCount);

  return (
`You are an intelligent web automation agent with advanced error recovery capabilities. You just encountered a failure and need to adapt your strategy.

MISSION CONTEXT:
Overall Goal: ${fullGoal}
Current Sub-Task: ${currentSubTask}
Task Type: ${taskContext.taskType || 'general'}
Attempt #: ${attemptCount}

CURRENT ENVIRONMENT:
Page: ${title} (${url})
Elements Available: ${interactiveElements.length}

${elementsLog}

FAILURE ANALYSIS:
${failureAnalysis}

RECOVERY STRATEGY:
${recoveryStrategy}

EXECUTION HISTORY (last ${Math.min(history.length, 8)} steps):
---
${historyLog || "No previous actions"}
---

FAILED ACTION DETAILS:
Action: ${JSON.stringify(failedAction)}
Result: ${observation}
Error Type: ${categorizeError(observation)}

RECOVERY DECISION FRAMEWORK:
1. ROOT CAUSE: What specifically caused the failure?
2. ALTERNATIVES: What other approaches could work?
3. CONTEXT: Has the page state changed since the action was planned?
4. PROGRESSION: Should we try a variation or completely different approach?
5. FALLBACK: Should we navigate elsewhere or try a different sub-task?

RECOVERY OPTIONS (in order of preference):
A) RETRY WITH VARIATION: Modify the failed action (different selector, timing, etc.)
B) ALTERNATIVE APPROACH: Try a completely different method for the same goal
C) CONTEXT REFRESH: Take screenshot, scroll, or wait for page changes
D) NAVIGATION RECOVERY: Go to a different page or restart the flow
E) SUB-TASK SKIP: Mark current sub-task as done and move to next

Page Content Preview (first 1500 chars):
---
${(pageContent || "").substring(0, 1500)}${pageContent && pageContent.length > 1500 ? "..." : ""}
---

Based on the failure analysis and available options, return your recovery action:
{
  "tool": "navigate|click|fill|scroll|waitForSelector|screenshot|tabs.query|tabs.activate|tabs.close|done",
  "params": { /* parameters for the recovery action */ },
  "rationale": "Detailed explanation of why this recovery approach will work",
  "confidence": 0.75, // 0.0-1.0 confidence this will succeed
  "recoveryType": "retry|alternative|refresh|navigate|skip", // type of recovery strategy
  "done": false // only true if giving up on current sub-task
}

Choose a recovery action that addresses the root cause and maximizes chance of success.`
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
  if (failedAction.tool === 'click') {
    strategies.push("Click failure options: try different selector, wait for element, or scroll to element");
  } else if (failedAction.tool === 'fill') {
    strategies.push("Fill failure options: try different selector, clear field first, or use different input method");
  } else if (failedAction.tool === 'navigate') {
    strategies.push("Navigation failure options: retry with delay, check URL validity, or try alternative URL");
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

ENHANCED PAGE ANALYSIS:
${pageContent ? `Content Preview (${pageContent.length} chars):
---
${pageContent.substring(0, 3000)}${pageContent.length > 3000 ? '...' : ''}
---` : 'No content extracted yet'}

DISCOVERED URLS & LINKS:
${context.interactiveElements ? analyzePageUrls(context.interactiveElements) : 'No URL analysis available'}

AVAILABLE RESEARCH TOOLS:
- read_page_content: Read and process the full content of the current page. This should be used after navigating to a new page.
- smart_navigate: Intelligently navigate to the best source for your query (location-aware)
- multi_search: Perform multiple location-aware searches for comprehensive results
- research_url: Automatically research a specific URL with depth control (supports recursive reading)
- analyze_url_depth: Analyze if current page URLs are worth reading deeper
- analyze_urls: Analyze all URLs on current page for research relevance
- get_page_links: Extract and rank relevant links from current page
- navigate: Go to a specific URL
- click: Click on elements using CSS selectors
- fill: Fill input fields with text
- scroll: Scroll to find more content
- waitForSelector: Wait for elements to appear
- screenshot: Take a screenshot for visual analysis
- extract_structured_content: Get enhanced content extraction with metadata
- generate_report: Create a comprehensive research report
- done: Mark research complete

// CORE RESEARCH STRATEGY:
// 1. **Search**: Use \`multi_search\` or \`smart_navigate\` to find a relevant page.
// 2. **Read**: Use \`read_page_content\` to understand the page's content. This is a mandatory step after navigation.
// 3. **Analyze & Extract**: Based on the content you just read, use \`extract_structured_content\`, \`get_page_links\`, or \`analyze_urls\` to gather specific information.
// 4. **Synthesize**: Once enough information is gathered from 2-3 sources, use \`generate_report\`.
// 5. **Repeat**: If more information is needed, repeat from step 1 or 2 with a new source.

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

// **CRITICAL RULE 1: DO NOT use the \`generate_report\` tool until you have gathered sufficient information from at least 2-3 different sources.** If you have not gathered enough information, you MUST use tools like \`smart_navigate\`, \`research_url\`, or \`multi_search\` first.
// **CRITICAL RULE 2: DO NOT be repetitive. If you have already performed a search, analyze the results and navigate to a link. Do not perform the same search again.**

HUMAN-LIKE RESEARCH BEHAVIOR:
- Automatically read and follow relevant URLs found in content
- Prioritize authoritative sources (academic, government, established organizations)
- Cross-reference information from multiple sources
- Look for recent and up-to-date information
- Extract key facts, statistics, and insights
- Identify contradictions or different perspectives

Return your next intelligent research action:
{
  "tool": "read_page_content|smart_navigate|multi_search|research_url|analyze_url_depth|analyze_urls|get_page_links|navigate|click|fill|scroll|waitForSelector|screenshot|extract_structured_content|generate_report|done",
  "params": {
    "query": "search query for smart_navigate/multi_search",
    "location": "user location (auto-detected from timezone if not specified)",
    "maxSearches": 3,
    "url": "URL to research for research_url",
    "depth": 1,
    "maxDepth": 3,
    "currentDepth": 1,
    "researchGoal": "research goal for analyze_url_depth",
    "selector": "CSS selector for click/fill/wait",
    "value": "text to type for fill",
    "direction": "up|down for scroll",
    "includeExternal": true,
    "maxLinks": 20,
    "format": "markdown for generate_report"
  },
  "rationale": "Detailed reasoning for this research action based on current context and goals",
  "confidence": 0.85,
  "research_strategy": "location_aware_search|multi_source_discovery|deep_analysis|recursive_reading|synthesis|verification",
  "done": false // true ONLY when the current sub-task is complete. This moves to the next sub-task.
}

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

Gathered Information:
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