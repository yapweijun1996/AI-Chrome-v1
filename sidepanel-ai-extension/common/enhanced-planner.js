// common/enhanced-planner.js
// Enhanced multi-step planning with broader search capabilities and query refinement

(function(global) {
  if (global.EnhancedPlanner) {
    return;
  }

  class EnhancedPlanner {
    constructor(options = {}) {
      this.model = options.model || "gemini-2.5-flash";
      this.maxRetries = options.maxRetries || 3;
      this.searchAPIs = options.searchAPIs || ['google', 'bing', 'duckduckgo'];
      this.pricingAPIs = options.pricingAPIs || ['google_shopping', 'amazon', 'local_stores'];
    }

    /**
     * Generate enhanced plan with broader search capabilities
     */
    async generateEnhancedPlan(goal, context, options = {}) {
      const { 
        includeMultiSourceSearch = true,
        includePricingData = false,
        maxSearchDepth = 3,
        queryRefinement = true 
      } = options;

      try {
        // First, analyze and refine the goal if it's vague
        const refinedGoal = queryRefinement ? await this.refineVagueQuery(goal, context) : { refined: goal, confidence: 1.0 };
        
        // Generate the base plan
        const basePlan = await this.generateBasePlan(refinedGoal.refined, context);
        
        if (!basePlan.ok) {
          return basePlan;
        }

        // Enhance the plan with additional capabilities
        const enhancedSteps = await this.enhancePlanWithSearchCapabilities(
          basePlan.plan.steps, 
          refinedGoal.refined, 
          context,
          {
            includeMultiSourceSearch,
            includePricingData,
            maxSearchDepth
          }
        );

        return {
          ok: true,
          plan: {
            ...basePlan.plan,
            steps: enhancedSteps,
            originalGoal: goal,
            refinedGoal: refinedGoal.refined,
            refinementConfidence: refinedGoal.confidence,
            enhancements: {
              multiSourceSearch: includeMultiSourceSearch,
              pricingData: includePricingData,
              searchDepth: maxSearchDepth
            }
          }
        };

      } catch (error) {
        return { 
          ok: false, 
          error: `Enhanced planning failed: ${error.message}`,
          fallbackPlan: await this.generateFallbackPlan(goal, context)
        };
      }
    }

    /**
     * Refine vague queries to be more specific and actionable
     */
    async refineVagueQuery(goal, context) {
      const refinementPrompt = this.buildQueryRefinementPrompt(goal, context);
      
      try {
        const result = await callModelWithRotation(refinementPrompt, { model: this.model });
        
        if (result.ok) {
          const refinement = this.parseRefinementResult(result.text);
          if (refinement.success) {
            return {
              refined: refinement.data.refinedQuery,
              confidence: refinement.data.confidence,
              reasoning: refinement.data.reasoning,
              addedContext: refinement.data.addedContext
            };
          }
        }
      } catch (error) {
        console.warn('Query refinement failed:', error);
      }

      // Return original goal if refinement fails
      return { refined: goal, confidence: 0.8, reasoning: 'No refinement needed or refinement failed' };
    }

    /**
     * Build query refinement prompt
     */
    buildQueryRefinementPrompt(goal, context) {
      return `You are an expert query refinement assistant. Your task is to analyze user goals and make them more specific and actionable when they are vague or ambiguous.

Original Goal: "${goal}"

Current Context:
- URL: ${context.pageInfo?.url || 'unknown'}
- Page Title: ${context.pageInfo?.title || 'unknown'}
- User Location: ${context.userLocation || 'singapore'}
- Previous Actions: ${JSON.stringify(context.history?.slice(-3) || [])}

Query Refinement Guidelines:
1. If the goal is already specific and actionable, return it unchanged with high confidence
2. If the goal is vague, add context and specificity while preserving the user's intent
3. Consider the user's location for location-specific queries
4. Add relevant search terms and context that would improve results
5. For product/shopping queries, include relevant specifications or categories

Vague Query Indicators:
- Pronouns without clear referents ("it", "that", "this")
- Generic terms ("best", "good", "cheap") without context
- Missing key details (what, where, when, how much)
- Ambiguous product references
- Incomplete comparisons

Examples:
- "find ipad price" → "find current iPad prices in Singapore including latest models and where to buy"
- "research that" → [NEEDS MORE CONTEXT - cannot refine without knowing what "that" refers to]
- "best laptop" → "find best laptop recommendations for [inferred use case] within [reasonable price range] available in Singapore"
- "buy cheap phone" → "find affordable smartphone options under $500 in Singapore with good reviews and specifications"

Return ONLY a JSON object:
{
  "refinedQuery": "The refined, more specific version of the goal",
  "confidence": 0.95,
  "reasoning": "Explanation of what was refined and why",
  "addedContext": ["list", "of", "context", "added"],
  "needsMoreInfo": false,
  "missingInfo": ["what", "additional", "info", "needed"]
}

If the query cannot be refined due to insufficient context, set needsMoreInfo to true and list what information is needed.

Analyze and refine the goal:`;
    }

    /**
     * Parse refinement result
     */
    parseRefinementResult(responseText) {
      try {
        const jsonStart = responseText.indexOf("{");
        const jsonEnd = responseText.lastIndexOf("}");
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonStr);
          
          if (parsed.refinedQuery && parsed.confidence !== undefined) {
            return { success: true, data: parsed };
          }
        }
        throw new Error("Invalid refinement format");
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    /**
     * Generate base plan using existing planner
     */
    async generateBasePlan(goal, context) {
      const prompt = this.buildEnhancedPlanningPrompt(goal, context);
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

    /**
     * Build enhanced planning prompt with multi-source search capabilities
     */
    buildEnhancedPlanningPrompt(goal, context) {
      return `You are an expert web automation agent with advanced research and search capabilities. Create a comprehensive plan to achieve the user's goal using multiple sources and search strategies.

**Overall Goal:** ${goal}

**Agent's Current State & Context:**
- **Task Profile:** ${JSON.stringify(context.taskContext, null, 2)}
- **Progress:** Step ${context.progress?.step || 0} of sub-task ${(context.progress?.subTaskIndex || 0) + 1}/${context.progress?.totalSubTasks || 1}
- **Location:**
    - URL: ${context.pageInfo?.url || 'unknown'}
    - Page Title: ${context.pageInfo?.title || 'unknown'}
    - User Location: ${context.userLocation || 'singapore'}
- **Page Content Summary (first 1000 chars):**
  ${(context.pageContent || "").substring(0, 1000)}...
- **Recent History (last 3 actions):**
  ${JSON.stringify(context.history?.slice(-3) || [], null, 2)}
- **Available Interactive Elements (first 15):**
  ${JSON.stringify(context.interactiveElements?.slice(0, 15) || [], null, 2)}

**Enhanced Search Capabilities Available:**
1. **Multi-Source Search:** \`multi_search\` - Search across multiple search engines and sources
2. **Smart Navigation:** \`smart_navigate\` - Intelligent navigation with location awareness
3. **Deep Research:** \`research_url\` - Recursive content analysis with depth control
4. **URL Analysis:** \`analyze_url_depth\` - Determine if deeper research is needed
5. **Link Discovery:** \`get_page_links\` - Find and rank relevant links
6. **Content Extraction:** \`extract_structured_content\` - Enhanced content parsing
7. **Pricing Research:** \`research_pricing\` - Specialized pricing data collection
8. **Comparison Analysis:** \`compare_sources\` - Compare information from multiple sources

**Planning Strategy for Different Goal Types:**

**For Research Goals:**
- Use \`multi_search\` with location-aware terms
- Follow up with \`research_url\` for authoritative sources
- Use \`analyze_url_depth\` to determine research completeness
- Employ \`compare_sources\` to synthesize findings

**For Shopping/Pricing Goals:**
- Start with \`multi_search\` using product + location terms
- Use \`research_pricing\` for comprehensive price comparison
- Include \`get_page_links\` to find retailer pages
- Add \`compare_sources\` for price analysis

**For Navigation Goals:**
- Use \`smart_navigate\` for intelligent routing
- Include \`extract_structured_content\` to verify arrival
- Add interaction steps as needed

**Critical Instructions:**
1. **Multi-Source Strategy:** Always include multiple search approaches for comprehensive coverage
2. **Location Awareness:** Consider user location (${context.userLocation || 'singapore'}) for relevant results
3. **Depth Control:** Use recursive research with appropriate depth limits (1-3 levels)
4. **Source Verification:** Include steps to verify information quality and authority
5. **Synthesis:** Always end with synthesis/comparison steps for comprehensive results

**Available Tools:** \`navigate\`, \`click\`, \`fill\`, \`scroll\`, \`waitForSelector\`, \`screenshot\`, \`tabs.query\`, \`tabs.activate\`, \`tabs.close\`, \`smart_navigate\`, \`multi_search\`, \`continue_multi_search\`, \`research_url\`, \`analyze_url_depth\`, \`analyze_urls\`, \`get_page_links\`, \`extract_structured_content\`, \`research_pricing\`, \`compare_sources\`, \`generate_report\`, \`done\`.

**Example Enhanced Plan for "find ipad price singapore":**
{
  "thought": "User wants comprehensive iPad pricing in Singapore. I'll use multi-source search, research official and retail sources, compare prices, and provide detailed analysis.",
  "steps": [
    { "tool": "multi_search", "params": { "query": "ipad price singapore 2024", "location": "singapore", "maxSearches": 4, "sources": ["google", "shopping"] } },
    { "tool": "research_url", "params": { "url": "https://www.apple.com/sg/ipad/", "depth": 1, "maxDepth": 2 } },
    { "tool": "extract_structured_content", "params": {} },
    { "tool": "continue_multi_search", "params": {} },
    { "tool": "research_pricing", "params": { "product": "ipad", "location": "singapore", "sources": ["official", "retail", "comparison"] } },
    { "tool": "get_page_links", "params": { "includeExternal": true, "maxLinks": 10, "filter": "shopping" } },
    { "tool": "compare_sources", "params": { "category": "pricing", "synthesize": true } },
    { "tool": "generate_report", "params": { "format": "markdown", "content": "Comprehensive iPad pricing analysis for Singapore market" } },
    { "tool": "done", "params": { "reason": "Multi-source pricing research completed with comprehensive analysis" } }
  ]
}

Now, generate a comprehensive, multi-source plan for the user's goal:

**Your Enhanced Plan (JSON with 'thought' and 'steps'):**`;
    }

    /**
     * Enhance plan with additional search capabilities
     */
    async enhancePlanWithSearchCapabilities(steps, goal, context, options) {
      const enhancedSteps = [...steps];
      
      // Add multi-source search if not present and goal involves research/shopping
      if (options.includeMultiSourceSearch && this.shouldAddMultiSourceSearch(goal, steps)) {
        const searchSteps = this.generateMultiSourceSearchSteps(goal, context);
        enhancedSteps.splice(1, 0, ...searchSteps);
      }

      // Add pricing research for shopping-related goals
      if (options.includePricingData && this.shouldAddPricingResearch(goal, steps)) {
        const pricingSteps = this.generatePricingResearchSteps(goal, context);
        enhancedSteps.splice(-2, 0, ...pricingSteps);
      }

      // Add source comparison and synthesis steps
      if (this.shouldAddSourceComparison(goal, enhancedSteps)) {
        const comparisonSteps = this.generateSourceComparisonSteps(goal, context);
        enhancedSteps.splice(-1, 0, ...comparisonSteps);
      }

      return enhancedSteps;
    }

    /**
     * Generate multi-source search steps
     */
    generateMultiSourceSearchSteps(goal, context) {
      const userLocation = context.userLocation || 'singapore';
      
      return [
        {
          tool: "multi_search",
          params: {
            query: goal,
            location: userLocation,
            maxSearches: 3,
            sources: ["google", "bing"]
          }
        },
        {
          tool: "analyze_url_depth",
          params: {
            currentDepth: 1,
            maxDepth: 3,
            researchGoal: goal
          }
        }
      ];
    }

    /**
     * Generate pricing research steps
     */
    generatePricingResearchSteps(goal, context) {
      const userLocation = context.userLocation || 'singapore';
      
      return [
        {
          tool: "research_pricing",
          params: {
            query: goal,
            location: userLocation,
            sources: ["official", "retail", "comparison"],
            includeSpecs: true
          }
        },
        {
          tool: "get_page_links",
          params: {
            includeExternal: true,
            maxLinks: 15,
            filter: "shopping"
          }
        }
      ];
    }

    /**
     * Generate source comparison steps
     */
    generateSourceComparisonSteps(goal, context) {
      return [
        {
          tool: "compare_sources",
          params: {
            category: this.inferComparisonCategory(goal),
            synthesize: true,
            includeCredibility: true
          }
        }
      ];
    }

    /**
     * Check if multi-source search should be added
     */
    shouldAddMultiSourceSearch(goal, steps) {
      const hasMultiSearch = steps.some(step => 
        step.tool === 'multi_search' || 
        step.tool === 'smart_navigate' ||
        step.tool === 'research_url'
      );
      
      const isResearchGoal = goal.toLowerCase().includes('research') ||
                           goal.toLowerCase().includes('find') ||
                           goal.toLowerCase().includes('compare') ||
                           goal.toLowerCase().includes('price');
      
      return !hasMultiSearch && isResearchGoal;
    }

    /**
     * Check if pricing research should be added
     */
    shouldAddPricingResearch(goal, steps) {
      const hasPricingResearch = steps.some(step => step.tool === 'research_pricing');
      
      const isPricingGoal = goal.toLowerCase().includes('price') ||
                          goal.toLowerCase().includes('cost') ||
                          goal.toLowerCase().includes('buy') ||
                          goal.toLowerCase().includes('shop') ||
                          goal.toLowerCase().includes('purchase');
      
      return !hasPricingResearch && isPricingGoal;
    }

    /**
     * Check if source comparison should be added
     */
    shouldAddSourceComparison(goal, steps) {
      const hasComparison = steps.some(step => step.tool === 'compare_sources');
      const hasMultipleSources = steps.filter(step => 
        step.tool === 'research_url' || 
        step.tool === 'multi_search' ||
        step.tool === 'research_pricing'
      ).length > 1;
      
      return !hasComparison && hasMultipleSources;
    }

    /**
     * Infer comparison category from goal
     */
    inferComparisonCategory(goal) {
      const goalLower = goal.toLowerCase();
      
      if (goalLower.includes('price') || goalLower.includes('cost') || goalLower.includes('buy')) {
        return 'pricing';
      }
      if (goalLower.includes('spec') || goalLower.includes('feature') || goalLower.includes('compare')) {
        return 'features';
      }
      if (goalLower.includes('review') || goalLower.includes('rating') || goalLower.includes('opinion')) {
        return 'reviews';
      }
      
      return 'general';
    }

    /**
     * Parse plan from response text
     */
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
        console.error("Failed to parse enhanced plan:", e);
      }
      return null;
    }

    /**
     * Generate fallback plan for error cases
     */
    async generateFallbackPlan(goal, context) {
      return {
        thought: "Fallback plan due to planning error",
        steps: [
          { tool: "smart_navigate", params: { query: goal } },
          { tool: "extract_structured_content", params: {} },
          { tool: "generate_report", params: { format: "markdown", content: goal } },
          { tool: "done", params: { reason: "Fallback plan completed" } }
        ]
      };
    }
  }

  // Export to global scope
  global.EnhancedPlanner = EnhancedPlanner;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));