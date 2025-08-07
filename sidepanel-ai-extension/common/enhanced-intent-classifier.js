// common/enhanced-intent-classifier.js
// Enhanced intent classification with ambiguity detection and clarification prompts

(function(global) {
  if (global.EnhancedIntentClassifier) {
    return;
  }

  class EnhancedIntentClassifier {
    constructor(options = {}) {
      this.confidenceThreshold = options.confidenceThreshold || 0.7;
      this.ambiguityThreshold = options.ambiguityThreshold || 0.3;
      this.maxClarificationAttempts = options.maxClarificationAttempts || 2;
    }

    /**
     * Enhanced intent classification with ambiguity detection
     */
    async classifyWithAmbiguityDetection(userMessage, currentContext = {}) {
      try {
        // First pass: Basic intent classification
        const basicClassification = await this.performBasicClassification(userMessage, currentContext);
        
        // Check for ambiguity indicators
        const ambiguityAnalysis = this.analyzeAmbiguity(userMessage, basicClassification);
        
        if (ambiguityAnalysis.isAmbiguous) {
          return {
            success: true,
            classification: basicClassification,
            ambiguity: ambiguityAnalysis,
            needsClarification: true,
            clarificationPrompts: this.generateClarificationPrompts(userMessage, basicClassification, ambiguityAnalysis)
          };
        }

        // If confidence is low, suggest clarification
        if (basicClassification.confidence < this.confidenceThreshold) {
          return {
            success: true,
            classification: basicClassification,
            needsClarification: true,
            lowConfidence: true,
            clarificationPrompts: this.generateLowConfidenceClarifications(userMessage, basicClassification)
          };
        }

        return {
          success: true,
          classification: basicClassification,
          needsClarification: false
        };

      } catch (error) {
        return {
          success: false,
          error: error.message,
          fallbackClassification: this.getFallbackClassification(userMessage)
        };
      }
    }

    /**
     * Perform basic intent classification
     */
    async performBasicClassification(userMessage, currentContext) {
      const prompt = this.buildEnhancedClassificationPrompt(userMessage, currentContext);
      
      // This would call the model - for now we'll simulate the structure
      const result = await callModelWithRotation(prompt, { model: "gemini-1.5-flash" });
      
      if (!result?.ok) {
        throw new Error(result?.error || "Classification failed");
      }

      return this.parseClassificationResult(result.text);
    }

    /**
     * Build enhanced classification prompt with ambiguity detection
     */
    buildEnhancedClassificationPrompt(userMessage, currentContext) {
      return `You are an advanced AI intent classifier with ambiguity detection capabilities. Analyze the user's message and provide detailed classification.

User Message: "${userMessage}"

Current Context:
- Current URL: ${currentContext.url || 'Unknown'}
- Page Title: ${currentContext.title || 'Unknown'}
- Previous Actions: ${JSON.stringify(currentContext.previousActions || [])}

Available Intent Categories:
1. YOUTUBE - User wants to interact with YouTube (search videos, play videos, navigate YouTube)
2. NAVIGATION - User wants to navigate to websites, open pages, browse to specific URLs
3. RESEARCH - User wants to gather information, research topics, find comprehensive data from multiple sources
4. AUTOMATION - User wants to automate web interactions (click, fill forms, scroll, interact with page elements)
5. CONVERSATION - User wants to have a conversation, ask questions that don't require web actions
6. SHOPPING - User wants to find products, compare prices, or make purchases
7. AMBIGUOUS - The intent is unclear and needs clarification

Classification Guidelines:
- YOUTUBE: Contains references to YouTube, videos, playing content, video searches
- NAVIGATION: Contains "go to", "visit", "navigate", "open", URLs, website names
- RESEARCH: Contains "research", "find information", "investigate", question words (what, how, why), requests for comprehensive information
- AUTOMATION: Contains action verbs like "click", "fill", "scroll", "login", "submit", specific UI interactions
- CONVERSATION: General questions, casual chat, requests for explanations without needing web actions
- SHOPPING: Contains "buy", "purchase", "price", "shop", "store", product names, comparison requests
- AMBIGUOUS: Vague terms, multiple possible interpretations, insufficient context

Ambiguity Indicators:
- Vague pronouns without clear referents ("it", "that", "this")
- Multiple possible interpretations
- Missing critical details (what, where, how)
- Conflicting signals (e.g., mentions both research and shopping)
- Context-dependent terms without sufficient context

Return ONLY a JSON object with this exact format:
{
  "intent": "YOUTUBE|NAVIGATION|RESEARCH|AUTOMATION|CONVERSATION|SHOPPING|AMBIGUOUS",
  "confidence": 0.95,
  "reasoning": "Detailed explanation of classification decision",
  "suggestedAction": "What the user likely wants to accomplish",
  "ambiguityFactors": ["list", "of", "ambiguous", "elements"],
  "missingContext": ["what", "information", "would", "help"],
  "alternativeInterpretations": [
    {
      "intent": "ALTERNATIVE_INTENT",
      "confidence": 0.3,
      "reasoning": "Why this could be an alternative interpretation"
    }
  ]
}

Examples:
- "find ipad price" → Clear SHOPPING intent with high confidence
- "research that" → AMBIGUOUS - unclear what "that" refers to
- "buy the best one" → AMBIGUOUS - missing product context
- "help me with this page" → AMBIGUOUS - unclear what help is needed

Analyze the user's message and return the classification with ambiguity analysis.`;
    }

    /**
     * Parse classification result from model response
     */
    parseClassificationResult(responseText) {
      try {
        const jsonStart = responseText.indexOf("{");
        const jsonEnd = responseText.lastIndexOf("}");
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const jsonStr = responseText.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonStr);
          
          // Validate required fields
          if (parsed.intent && parsed.confidence !== undefined && parsed.reasoning) {
            return parsed;
          }
        }
        throw new Error("Invalid classification format");
      } catch (error) {
        throw new Error(`Failed to parse classification: ${error.message}`);
      }
    }

    /**
     * Analyze ambiguity in the classification result
     */
    analyzeAmbiguity(userMessage, classification) {
      const ambiguityFactors = classification.ambiguityFactors || [];
      const alternativeInterpretations = classification.alternativeInterpretations || [];
      const missingContext = classification.missingContext || [];

      // Check for explicit ambiguous classification
      if (classification.intent === 'AMBIGUOUS') {
        return {
          isAmbiguous: true,
          reason: 'explicit_ambiguous_classification',
          factors: ambiguityFactors,
          missingContext: missingContext,
          alternatives: alternativeInterpretations
        };
      }

      // Check for low confidence with high-confidence alternatives
      const highConfidenceAlternatives = alternativeInterpretations.filter(alt => alt.confidence > 0.4);
      if (classification.confidence < 0.6 && highConfidenceAlternatives.length > 0) {
        return {
          isAmbiguous: true,
          reason: 'competing_interpretations',
          factors: ambiguityFactors,
          missingContext: missingContext,
          alternatives: highConfidenceAlternatives
        };
      }

      // Check for significant missing context
      if (missingContext.length > 2) {
        return {
          isAmbiguous: true,
          reason: 'insufficient_context',
          factors: ambiguityFactors,
          missingContext: missingContext,
          alternatives: alternativeInterpretations
        };
      }

      return {
        isAmbiguous: false,
        factors: ambiguityFactors,
        missingContext: missingContext,
        alternatives: alternativeInterpretations
      };
    }

    /**
     * Generate clarification prompts for ambiguous queries
     */
    generateClarificationPrompts(userMessage, classification, ambiguityAnalysis) {
      const prompts = [];

      switch (ambiguityAnalysis.reason) {
        case 'explicit_ambiguous_classification':
          prompts.push({
            type: 'context_request',
            message: "I need more details to help you effectively. Could you provide more specific information about what you'd like to do?",
            suggestions: this.generateContextSuggestions(classification, ambiguityAnalysis)
          });
          break;

        case 'competing_interpretations':
          prompts.push({
            type: 'interpretation_choice',
            message: "I see a few ways to interpret your request. Which one matches what you want to do?",
            suggestions: ambiguityAnalysis.alternatives.map(alt => ({
              intent: alt.intent,
              description: this.getIntentDescription(alt.intent),
              action: alt.reasoning
            }))
          });
          break;

        case 'insufficient_context':
          prompts.push({
            type: 'missing_context',
            message: "To help you better, I need some additional information:",
            suggestions: ambiguityAnalysis.missingContext.map(context => ({
              question: this.formatContextQuestion(context),
              type: context
            }))
          });
          break;
      }

      return prompts;
    }

    /**
     * Generate clarification prompts for low confidence classifications
     */
    generateLowConfidenceClarifications(userMessage, classification) {
      return [{
        type: 'confidence_check',
        message: `I think you want to ${this.getIntentDescription(classification.intent).toLowerCase()}, but I'm not entirely sure. Is this correct?`,
        suggestions: [
          {
            intent: classification.intent,
            description: `Yes, ${this.getIntentDescription(classification.intent).toLowerCase()}`,
            action: classification.suggestedAction
          },
          {
            intent: 'CLARIFY',
            description: "No, let me explain what I want to do",
            action: "Provide more specific details about your request"
          }
        ]
      }];
    }

    /**
     * Generate context suggestions based on classification and ambiguity
     */
    generateContextSuggestions(classification, ambiguityAnalysis) {
      const suggestions = [];

      // Add suggestions based on missing context
      if (ambiguityAnalysis.missingContext.includes('what')) {
        suggestions.push({
          type: 'what',
          text: "What specifically would you like me to help you with?",
          examples: ["research a topic", "find a product", "navigate to a website"]
        });
      }

      if (ambiguityAnalysis.missingContext.includes('where')) {
        suggestions.push({
          type: 'where',
          text: "Where would you like me to look or go?",
          examples: ["on this page", "on Google", "on a specific website"]
        });
      }

      if (ambiguityAnalysis.missingContext.includes('how')) {
        suggestions.push({
          type: 'how',
          text: "How would you like me to approach this?",
          examples: ["automatically", "step by step", "with detailed research"]
        });
      }

      return suggestions;
    }

    /**
     * Get user-friendly description for intent types
     */
    getIntentDescription(intent) {
      const descriptions = {
        'YOUTUBE': 'Search or interact with YouTube videos',
        'NAVIGATION': 'Navigate to websites or pages',
        'RESEARCH': 'Research information from multiple sources',
        'AUTOMATION': 'Automate web interactions and tasks',
        'CONVERSATION': 'Have a conversation or get explanations',
        'SHOPPING': 'Find products, compare prices, or shop',
        'AMBIGUOUS': 'Clarify your request'
      };
      return descriptions[intent] || 'Perform the requested action';
    }

    /**
     * Format context questions for missing information
     */
    formatContextQuestion(contextType) {
      const questions = {
        'what': 'What specifically are you looking for?',
        'where': 'Where should I look for this information?',
        'how': 'How would you like me to approach this?',
        'when': 'What timeframe are you interested in?',
        'why': 'What is the purpose or goal of this request?',
        'product': 'What product are you interested in?',
        'location': 'What location or region should I focus on?',
        'price_range': 'What is your budget or price range?',
        'specifications': 'What specific features or requirements do you have?'
      };
      return questions[contextType] || `Could you provide more details about ${contextType}?`;
    }

    /**
     * Get fallback classification for error cases
     */
    getFallbackClassification(userMessage) {
      // Simple keyword-based fallback
      const message = userMessage.toLowerCase();
      
      if (message.includes('youtube') || message.includes('video')) {
        return { intent: 'YOUTUBE', confidence: 0.5, reasoning: 'Fallback: Contains video-related keywords' };
      }
      if (message.includes('research') || message.includes('find') || message.includes('what')) {
        return { intent: 'RESEARCH', confidence: 0.5, reasoning: 'Fallback: Contains research-related keywords' };
      }
      if (message.includes('buy') || message.includes('price') || message.includes('shop')) {
        return { intent: 'SHOPPING', confidence: 0.5, reasoning: 'Fallback: Contains shopping-related keywords' };
      }
      if (message.includes('go to') || message.includes('navigate') || message.includes('open')) {
        return { intent: 'NAVIGATION', confidence: 0.5, reasoning: 'Fallback: Contains navigation-related keywords' };
      }
      
      return { intent: 'CONVERSATION', confidence: 0.3, reasoning: 'Fallback: Default to conversation' };
    }

    /**
     * Refine classification based on user feedback
     */
    refineClassificationWithFeedback(originalClassification, userFeedback, selectedOption) {
      return {
        intent: selectedOption.intent,
        confidence: 0.9, // High confidence after user confirmation
        reasoning: `User confirmed: ${selectedOption.description}`,
        suggestedAction: selectedOption.action,
        refinedFromAmbiguous: true,
        originalClassification: originalClassification
      };
    }
  }

  // Export to global scope
  global.EnhancedIntentClassifier = EnhancedIntentClassifier;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));