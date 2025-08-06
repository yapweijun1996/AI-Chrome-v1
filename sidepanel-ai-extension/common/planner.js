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
          const parsedResult = this.parsePlan(result.text);
          if (parsedResult) {
            return { ok: true, plan: parsedResult };
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

        **Overall Goal:** ${goal}

        **Agent's Current State & Context:**
        - **Task Profile:** ${JSON.stringify(context.taskContext, null, 2)}
        - **Progress:** Step ${context.progress.step} of sub-task ${context.progress.subTaskIndex + 1}/${context.progress.totalSubTasks}. Current sub-task: "${context.progress.currentSubTask}"
        - **Location:**
            - URL: ${context.pageInfo.url}
            - Page Title: ${context.pageInfo.title}
        - **Page Content Summary (first 1000 chars):**
          ${(context.pageContent || "").substring(0, 1000)}...
        - **Recent History (last 3 actions):**
          ${JSON.stringify(context.history.slice(-3), null, 2)}
        - **Available Interactive Elements (first 15):**
          ${JSON.stringify(context.interactiveElements.slice(0, 15), null, 2)}

        **Your Mission:**
        Based on all the context provided, create a complete, end-to-end plan to achieve the **Overall Goal**.

        **Critical Instructions:**
        1.  **Chain of Thought (CoT):** First, provide a "thought" process. Explain your reasoning, analyze the situation, and outline your strategy before defining the steps. This helps in creating a logical and robust plan.
        2.  **Think Ahead:** Do not create a short-sighted plan. Your plan must include all steps required to get from the current state to the final goal. For example, if you search, you must include steps to analyze the results.
        3.  **Be Comprehensive:** The plan must be complete. Do not stop until the goal is fully achieved.
        4.  **Use Available Tools:** \`navigate\`, \`click\`, \`fill\`, \`scroll\`, \`waitForSelector\`, \`screenshot\`, \`tabs.query\`, \`tabs.activate\`, \`tabs.close\`, \`generate_report\`, \`smart_navigate\`, \`multi_search\`, \`continue_multi_search\`, \`research_url\`, \`analyze_url_depth\`, \`analyze_urls\`, \`get_page_links\`, \`extract_structured_content\`, \`done\`.
        5.  **Output Valid JSON:** Your response must be a single, valid JSON object with a "thought" string and a "steps" array.

        **Example of a COMPLETE Plan (Goal: "let me know ipad price"):**
        {
          "thought": "The user wants to know iPad prices. I'll use location-aware multi-search to find prices in their region (Singapore based on timezone), perform multiple searches with different terms, analyze URLs for deeper price information, and provide comprehensive pricing data.",
          "steps": [
            { "tool": "multi_search", "params": { "query": "ipad price", "location": "singapore", "maxSearches": 3 } },
            { "tool": "extract_structured_content", "params": {} },
            { "tool": "analyze_url_depth", "params": { "currentDepth": 1, "maxDepth": 3, "researchGoal": "ipad price singapore" } },
            { "tool": "research_url", "params": { "url": "https://www.apple.com/sg/ipad/", "depth": 2, "maxDepth": 3 } },
            { "tool": "continue_multi_search", "params": {} },
            { "tool": "extract_structured_content", "params": {} },
            { "tool": "get_page_links", "params": { "includeExternal": true, "maxLinks": 10 } },
            { "tool": "continue_multi_search", "params": {} },
            { "tool": "extract_structured_content", "params": {} },
            { "tool": "generate_report", "params": { "format": "markdown", "content": "Comprehensive iPad pricing information for Singapore market from multiple sources." } },
            { "tool": "done", "params": { "reason": "Location-aware price research completed with multi-source analysis." } }
          ]
        }

        Now, generate the complete, end-to-end plan for the user's goal.

        **Your Plan (JSON with 'thought' and 'steps'):**
      `;
    }

    parsePlan(responseText) {
      try {
        const jsonStart = responseText.indexOf("{");
        const jsonEnd = responseText.lastIndexOf("}");
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonStr);
          if (parsed.thought && Array.isArray(parsed.steps)) {
            return { thought: parsed.thought, steps: parsed.steps };
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