// common/clarification-manager.js
// Manages clarification requests and feedback loops for ambiguous queries

(function(global) {
  if (global.ClarificationManager) {
    return;
  }

  class ClarificationManager {
    constructor(options = {}) {
      this.maxClarificationAttempts = options.maxClarificationAttempts || 3;
      this.clarificationTimeout = options.clarificationTimeout || 300000; // 5 minutes
      this.activeClarifications = new Map(); // sessionId -> clarification data
    }

    /**
     * Create a clarification request for ambiguous queries
     */
    createClarificationRequest(sessionId, userMessage, classificationResult, context = {}) {
      const clarificationId = this.generateClarificationId();
      
      const clarificationRequest = {
        id: clarificationId,
        sessionId: sessionId,
        originalMessage: userMessage,
        classification: classificationResult,
        context: context,
        timestamp: Date.now(),
        attempts: 0,
        status: 'pending',
        prompts: this.generateClarificationPrompts(classificationResult, context),
        responses: []
      };

      this.activeClarifications.set(clarificationId, clarificationRequest);
      
      // Set timeout for cleanup
      setTimeout(() => {
        this.cleanupClarification(clarificationId);
      }, this.clarificationTimeout);

      return {
        success: true,
        clarificationId: clarificationId,
        request: clarificationRequest
      };
    }

    /**
     * Generate clarification prompts based on classification result
     */
    generateClarificationPrompts(classificationResult, context) {
      const prompts = [];

      if (classificationResult.needsClarification) {
        if (classificationResult.ambiguity?.isAmbiguous) {
          prompts.push(...this.generateAmbiguityPrompts(classificationResult));
        }
        
        if (classificationResult.lowConfidence) {
          prompts.push(...this.generateLowConfidencePrompts(classificationResult));
        }
      }

      // Add context-specific prompts
      prompts.push(...this.generateContextualPrompts(classificationResult, context));

      return prompts;
    }

    /**
     * Generate prompts for ambiguous classifications
     */
    generateAmbiguityPrompts(classificationResult) {
      const prompts = [];
      const ambiguity = classificationResult.ambiguity;

      switch (ambiguity.reason) {
        case 'explicit_ambiguous_classification':
          prompts.push({
            type: 'open_clarification',
            message: "I need more details to help you effectively. Could you be more specific about what you'd like me to do?",
            suggestions: [
              "I want to research information about a topic",
              "I want to find and compare product prices",
              "I want to navigate to a specific website",
              "I want to automate actions on this page",
              "I just want to have a conversation"
            ],
            followUp: "What specifically would you like me to help you with?"
          });
          break;

        case 'competing_interpretations':
          prompts.push({
            type: 'multiple_choice',
            message: "I see a few ways to interpret your request. Which one matches what you want to do?",
            options: ambiguity.alternatives.map((alt, index) => ({
              id: `option_${index}`,
              intent: alt.intent,
              description: this.getIntentDescription(alt.intent),
              confidence: alt.confidence,
              reasoning: alt.reasoning
            })),
            allowCustom: true,
            customPrompt: "None of these match - let me explain what I want"
          });
          break;

        case 'insufficient_context':
          prompts.push({
            type: 'context_gathering',
            message: "To help you better, I need some additional information:",
            questions: ambiguity.missingContext.map(context => ({
              type: context,
              question: this.formatContextQuestion(context),
              required: true
            })),
            submitText: "Continue with this information"
          });
          break;
      }

      return prompts;
    }

    /**
     * Generate prompts for low confidence classifications
     */
    generateLowConfidencePrompts(classificationResult) {
      const classification = classificationResult.classification;
      
      return [{
        type: 'confidence_check',
        message: `I think you want to ${this.getIntentDescription(classification.intent).toLowerCase()}, but I'm not entirely sure. Is this correct?`,
        options: [
          {
            id: 'confirm',
            text: `Yes, ${this.getIntentDescription(classification.intent).toLowerCase()}`,
            action: 'proceed',
            intent: classification.intent
          },
          {
            id: 'clarify',
            text: "No, let me explain what I want",
            action: 'clarify',
            intent: 'CLARIFY'
          },
          {
            id: 'alternative',
            text: "Something similar but different",
            action: 'refine',
            intent: 'REFINE'
          }
        ]
      }];
    }

    /**
     * Generate contextual prompts based on current context
     */
    generateContextualPrompts(classificationResult, context) {
      const prompts = [];
      
      // Add page-specific context prompts
      if (context.pageInfo?.url) {
        const url = context.pageInfo.url;
        
        if (url.includes('youtube.com')) {
          prompts.push({
            type: 'page_context',
            message: "I see you're on YouTube. Are you looking to:",
            suggestions: [
              "Search for specific videos",
              "Play a particular video",
              "Navigate to a channel",
              "Download or save content",
              "Get information about videos"
            ]
          });
        } else if (url.includes('amazon.com') || url.includes('shopping')) {
          prompts.push({
            type: 'page_context',
            message: "I see you're on a shopping site. Would you like me to:",
            suggestions: [
              "Find product information and prices",
              "Compare products",
              "Add items to cart",
              "Check reviews and ratings",
              "Find similar products"
            ]
          });
        } else if (url.includes('google.com/search')) {
          prompts.push({
            type: 'page_context',
            message: "I see you're on Google search results. Do you want me to:",
            suggestions: [
              "Research information from these results",
              "Visit specific search results",
              "Refine the search with different terms",
              "Compare information from multiple results",
              "Extract specific data from the results"
            ]
          });
        }
      }

      return prompts;
    }

    /**
     * Process clarification response from user
     */
    processClarificationResponse(clarificationId, response) {
      const clarification = this.activeClarifications.get(clarificationId);
      
      if (!clarification) {
        return {
          success: false,
          error: 'Clarification request not found or expired'
        };
      }

      clarification.responses.push({
        timestamp: Date.now(),
        response: response
      });

      clarification.attempts++;

      // Process the response based on type
      const processedResponse = this.processResponseByType(clarification, response);
      
      if (processedResponse.resolved) {
        clarification.status = 'resolved';
        clarification.resolvedClassification = processedResponse.classification;
        
        // Clean up after successful resolution
        setTimeout(() => {
          this.cleanupClarification(clarificationId);
        }, 60000); // Keep for 1 minute after resolution
        
        return {
          success: true,
          resolved: true,
          classification: processedResponse.classification,
          nextAction: processedResponse.nextAction
        };
      } else if (clarification.attempts >= this.maxClarificationAttempts) {
        clarification.status = 'failed';
        
        return {
          success: true,
          resolved: false,
          fallback: true,
          classification: this.getFallbackClassification(clarification.originalMessage),
          message: "I'll do my best to help with your original request."
        };
      } else {
        // Generate follow-up clarification
        const followUp = this.generateFollowUpClarification(clarification, response);
        clarification.prompts = followUp.prompts;
        
        return {
          success: true,
          resolved: false,
          needsMoreClarification: true,
          prompts: followUp.prompts
        };
      }
    }

    /**
     * Process response based on prompt type
     */
    processResponseByType(clarification, response) {
      const lastPrompt = clarification.prompts[clarification.prompts.length - 1];
      
      switch (lastPrompt?.type) {
        case 'multiple_choice':
          return this.processMultipleChoiceResponse(clarification, response);
        
        case 'context_gathering':
          return this.processContextGatheringResponse(clarification, response);
        
        case 'confidence_check':
          return this.processConfidenceCheckResponse(clarification, response);
        
        case 'open_clarification':
          return this.processOpenClarificationResponse(clarification, response);
        
        default:
          return this.processGenericResponse(clarification, response);
      }
    }

    /**
     * Process multiple choice response
     */
    processMultipleChoiceResponse(clarification, response) {
      if (response.selectedOption) {
        const option = response.selectedOption;
        
        return {
          resolved: true,
          classification: {
            intent: option.intent,
            confidence: 0.9,
            reasoning: `User selected: ${option.description}`,
            clarified: true,
            originalMessage: clarification.originalMessage
          },
          nextAction: {
            type: 'proceed_with_intent',
            intent: option.intent,
            context: response.additionalContext || {}
          }
        };
      }
      
      if (response.customResponse) {
        // Process custom response as open clarification
        return this.processOpenClarificationResponse(clarification, { text: response.customResponse });
      }
      
      return { resolved: false };
    }

    /**
     * Process context gathering response
     */
    processContextGatheringResponse(clarification, response) {
      const gatheredContext = response.context || {};
      const requiredFields = clarification.prompts.find(p => p.type === 'context_gathering')?.questions || [];
      
      // Check if all required fields are provided
      const missingFields = requiredFields
        .filter(q => q.required)
        .filter(q => !gatheredContext[q.type] || gatheredContext[q.type].trim() === '');
      
      if (missingFields.length > 0) {
        return { resolved: false, missingFields };
      }
      
      // Reconstruct the intent with gathered context
      const enhancedMessage = this.reconstructMessageWithContext(clarification.originalMessage, gatheredContext);
      
      return {
        resolved: true,
        classification: {
          intent: this.inferIntentFromContext(gatheredContext),
          confidence: 0.85,
          reasoning: 'Intent clarified through context gathering',
          clarified: true,
          originalMessage: clarification.originalMessage,
          enhancedMessage: enhancedMessage,
          gatheredContext: gatheredContext
        },
        nextAction: {
          type: 'proceed_with_enhanced_message',
          message: enhancedMessage,
          context: gatheredContext
        }
      };
    }

    /**
     * Process confidence check response
     */
    processConfidenceCheckResponse(clarification, response) {
      if (response.action === 'proceed') {
        return {
          resolved: true,
          classification: {
            ...clarification.classification.classification,
            confidence: 0.9,
            reasoning: 'User confirmed intent',
            clarified: true
          },
          nextAction: {
            type: 'proceed_with_intent',
            intent: clarification.classification.classification.intent
          }
        };
      }
      
      if (response.action === 'clarify' || response.action === 'refine') {
        return { resolved: false, needsOpenClarification: true };
      }
      
      return { resolved: false };
    }

    /**
     * Process open clarification response
     */
    processOpenClarificationResponse(clarification, response) {
      const clarifiedMessage = response.text || response.message || '';
      
      if (clarifiedMessage.trim().length < 10) {
        return { resolved: false, needsMoreDetail: true };
      }
      
      // Re-classify the clarified message
      return {
        resolved: true,
        classification: {
          intent: 'RECLASSIFY',
          confidence: 0.8,
          reasoning: 'User provided clarification',
          clarified: true,
          originalMessage: clarification.originalMessage,
          clarifiedMessage: clarifiedMessage
        },
        nextAction: {
          type: 'reclassify_message',
          message: clarifiedMessage,
          originalContext: clarification.context
        }
      };
    }

    /**
     * Process generic response
     */
    processGenericResponse(clarification, response) {
      // Try to extract intent from free-form response
      const text = response.text || response.message || JSON.stringify(response);
      
      return {
        resolved: true,
        classification: {
          intent: 'CONVERSATION',
          confidence: 0.6,
          reasoning: 'Fallback to conversation based on user response',
          clarified: true,
          originalMessage: clarification.originalMessage,
          userResponse: text
        },
        nextAction: {
          type: 'proceed_with_conversation',
          message: text
        }
      };
    }

    /**
     * Generate follow-up clarification
     */
    generateFollowUpClarification(clarification, response) {
      return {
        prompts: [{
          type: 'open_clarification',
          message: "I still need a bit more information. Could you please describe what you'd like me to do in more detail?",
          suggestions: [
            "I want to find information about...",
            "I want to buy or compare prices for...",
            "I want to navigate to...",
            "I want to interact with this page by...",
            "I just want to chat about..."
          ],
          followUp: "Please be as specific as possible about your request."
        }]
      };
    }

    /**
     * Utility methods
     */
    generateClarificationId() {
      return `clarification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

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

    reconstructMessageWithContext(originalMessage, context) {
      let enhanced = originalMessage;
      
      // Add context information to make the message more specific
      Object.entries(context).forEach(([key, value]) => {
        if (value && value.trim()) {
          enhanced += ` ${value}`;
        }
      });
      
      return enhanced.trim();
    }

    inferIntentFromContext(context) {
      // Simple intent inference based on gathered context
      if (context.product || context.price_range) return 'SHOPPING';
      if (context.research || context.information) return 'RESEARCH';
      if (context.website || context.url) return 'NAVIGATION';
      if (context.action || context.interaction) return 'AUTOMATION';
      
      return 'CONVERSATION';
    }

    getFallbackClassification(originalMessage) {
      return {
        intent: 'CONVERSATION',
        confidence: 0.5,
        reasoning: 'Fallback after failed clarification attempts',
        fallback: true,
        originalMessage: originalMessage
      };
    }

    cleanupClarification(clarificationId) {
      this.activeClarifications.delete(clarificationId);
    }

    /**
     * Get active clarification by ID
     */
    getClarification(clarificationId) {
      return this.activeClarifications.get(clarificationId);
    }

    /**
     * Get all active clarifications for a session
     */
    getSessionClarifications(sessionId) {
      const clarifications = [];
      for (const [id, clarification] of this.activeClarifications) {
        if (clarification.sessionId === sessionId) {
          clarifications.push({ id, ...clarification });
        }
      }
      return clarifications;
    }
  }

  // Export to global scope
  global.ClarificationManager = ClarificationManager;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));