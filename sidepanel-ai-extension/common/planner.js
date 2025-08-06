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
      // This prompt will be designed to generate a multi-step plan
      // instead of a single action.
      return `
        You are an expert planner. Given the goal and context, create a multi-step plan to achieve the goal.
        Goal: ${goal}
        Context: ${JSON.stringify(context, null, 2)}

        Return a JSON object with an array of steps. Each step should be an action with a tool and parameters.
        Example:
        {
          "steps": [
            { "tool": "navigate", "params": { "url": "https://google.com" } },
            { "tool": "fill", "params": { "selector": "input[name=q]", "value": "ipad price" } },
            { "tool": "click", "params": { "selector": "input[type=submit]" } }
          ]
        }
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