// sidepanel-ai-extension/common/planner.js
// New multi-step planning logic for the AI agent

(function(global) {
  if (global.AIPlanner) {
    return;
  }

  class AIPlanner {
    constructor(options = {}) {
      this.model = options.model || "gemini-1.5-flash";
      this.maxRetries = options.maxRetries || 3;
    }

    async generatePlan(goal, context) {
      const prompt = this.buildMultiStepPrompt(goal, context);
      let attempts = 0;

      while (attempts < this.maxRetries) {
        const result = await callModelWithRotation(prompt, { model: this.model });

        if (result.ok) {
          const plan = this.parsePlan(result.text);
          if (plan) {
            return { ok: true, plan };
          }
        }

        attempts++;
      }

      return { ok: false, error: "Failed to generate a valid plan." };
    }

    buildMultiStepPrompt(goal, context) {
      // This prompt is designed to generate a complete, end-to-end, multi-step plan.
      return `
        You are an expert web automation agent. Your task is to create a complete, multi-step plan to achieve a user's goal.

        **Goal:** ${goal}

        **Context:**
        - Current URL: ${context.pageInfo.url}
        - Page Title: ${context.pageInfo.title}
        - History (last 3 actions): ${JSON.stringify(context.history.slice(-3), null, 2)}
        - Interactive Elements (first 20): ${JSON.stringify(context.interactiveElements.slice(0, 20), null, 2)}

        **Instructions:**
        1.  **Think Step-by-Step:** Analyze the goal and the current context. Create a complete plan from start to finish.
        2.  **Anticipate Changes:** Your plan should account for page navigations and new information. For example, after a search, the next step should be to analyze the results, not just stop.
        3.  **Be Comprehensive:** Do not create a partial plan. The plan must include all steps necessary to fully achieve the goal.
        4.  **Use Available Tools:** The available tools are: navigate, click, fill, scroll, waitForSelector, screenshot, tabs.query, tabs.activate, tabs.close, and done.
        5.  **Output JSON:** Your response must be a single JSON object containing a "steps" array.

        **Example of a COMPLETE Plan:**
        If the goal is "find the price of an iPad", a good plan would be:
        {
          "steps": [
            { "tool": "navigate", "params": { "url": "https://www.google.com" } },
            { "tool": "fill", "params": { "selector": "input[name=q]", "value": "iPad price" } },
            { "tool": "click", "params": { "selector": "input[type=submit]" } },
            { "tool": "waitForSelector", "params": { "selector": "#search" } },
            { "tool": "screenshot", "params": {} },
            { "tool": "generate_report", "params": { "format": "markdown", "content": "Analyze the search results to find the price of the iPad." } },
            { "tool": "done", "params": { "reason": "Price found and reported." } }
          ]
        }

        Now, generate the complete plan for the user's goal.

        **Your Plan:**
      `;
    }

    parsePlan(responseText) {
      try {
        const jsonStart = responseText.indexOf("{");
        const jsonEnd = responseText.lastIndexOf("}");
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed.steps)) {
            return parsed.steps;
          }
        }
      } catch (e) {
        console.error("Failed to parse plan:", e);
      }
      return null;
    }
  }

  global.AIPlanner = AIPlanner;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));