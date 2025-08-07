// common/planner.js

(function (global) {
  if (global.buildReasoningPrompt) {
    return;
  }

  function buildReasoningPrompt(goal, context, history) {
    const { pageInfo, pageContent, interactiveElements } = context;

    const historyString = history.map(h => 
      `Step ${h.step}: I used the tool "${h.action.tool}" with params ${JSON.stringify(h.action.params)}. The result was: "${h.observation}"`
    ).join('\n');

    const interactiveElementString = interactiveElements.map(el => {
      return `  - ${el.type}: "${el.text}" (selector: ${el.selector})`
    }).join('\n');

    return `You are an AI agent controlling a web browser. Your goal is: "${goal}".

Current Page: "${pageInfo.title}" (${pageInfo.url})

Page Content:
---
${pageContent.substring(0, 4000)}
---

Interactive Elements:
---
${interactiveElementString}
---

History of actions taken:
---
${historyString}
---

Based on the current context and your goal, what is the single next best action to take?

Respond with a JSON object with two keys: "rationale" and "action".
- "rationale": A brief explanation of why you are taking this action.
- "action": An object with "tool" and "params" keys.

Available tools: "navigate", "click", "fill", "scroll", "waitForSelector", "done".

Example:
{
  "rationale": "I need to go to the login page to start the process.",
  "action": {
    "tool": "navigate",
    "params": { "url": "https://example.com/login" }
  }
}`;
  }

  global.buildReasoningPrompt = buildReasoningPrompt;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));