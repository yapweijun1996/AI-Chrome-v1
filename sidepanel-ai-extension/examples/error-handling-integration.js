/**
 * examples/error-handling-integration.js
 * Demonstration of how to integrate the new error handling system into existing code
 * 
 * This file shows practical examples of:
 * - Converting existing error handling to use custom error classes
 * - Implementing error boundaries for critical operations
 * - Using structured logging with error serialization
 * - Setting up circuit breakers for external dependencies
 */

// Example 1: Converting basic error handling to use custom error classes
// BEFORE (old approach):
function oldApiCall() {
  try {
    // Some API call
    const response = fetch('/api/endpoint');
    if (!response.ok) {
      throw new Error('API call failed');
    }
    return response.json();
  } catch (error) {
    console.error('API error:', error);
    throw error;
  }
}

// AFTER (using new error system):
async function newApiCall() {
  const log = globalThis.Log?.createLogger('api') || console;
  
  try {
    const response = await fetch('/api/endpoint');
    if (!response.ok) {
      throw globalThis.ErrorSystem.createError(
        globalThis.ErrorSystem.ErrorCategory.NETWORK,
        `API call failed with status ${response.status}`,
        {
          code: 'API_CALL_FAILED',
          severity: globalThis.ErrorSystem.ErrorSeverity.HIGH,
          statusCode: response.status,
          endpoint: '/api/endpoint',
          requestMethod: 'GET',
          retryable: response.status >= 500, // Server errors are retryable
          context: { userAgent: navigator.userAgent }
        }
      );
    }
    return await response.json();
  } catch (error) {
    // Enhanced error wrapping
    const wrappedError = globalThis.ErrorSystem.wrapError(
      error, 
      globalThis.ErrorSystem.ErrorCategory.NETWORK,
      { endpoint: '/api/endpoint' }
    );
    
    // Structured logging with error serialization
    log.error('API call failed', { error: wrappedError, endpoint: '/api/endpoint' });
    throw wrappedError;
  }
}

// Example 2: Using error boundaries for critical operations
// BEFORE (no error isolation):
async function oldCriticalOperation(data) {
  const step1 = await processStep1(data);
  const step2 = await processStep2(step1);
  const step3 = await processStep3(step2);
  return step3;
}

// AFTER (with error boundaries):
async function newCriticalOperation(data) {
  const boundary = globalThis.ErrorBoundary?.create('critical-operation', {
    maxRetries: 2,
    retryDelay: 1000,
    isolationLevel: 'module',
    fallbackFunction: async (error, context) => {
      // Fallback to cached data or simplified processing
      const log = globalThis.Log?.createLogger('critical-operation') || console;
      log.warn('Using fallback for critical operation', { error: error.message });
      return getCachedResult(data);
    },
    errorCallback: async (error, context) => {
      // Custom error handling logic
      await notifyAdmin(error);
    }
  });

  return await boundary.executeWithRetry(async () => {
    const step1 = await processStep1(data);
    const step2 = await processStep2(step1);
    const step3 = await processStep3(step2);
    return step3;
  }, { operationId: 'critical-op-123', data: data.id });
}

// Example 3: Circuit breaker for external API dependencies
class GeminiAPIService {
  constructor() {
    this.log = globalThis.Log?.createLogger('gemini-api') || console;
    
    // Create circuit breaker for Gemini API
    this.circuitBreaker = new globalThis.ErrorBoundary.CircuitBreaker({
      name: 'gemini-api',
      failureThreshold: 3,
      recoveryTimeout: 30000, // 30 seconds
    });
  }

  async makeRequest(prompt, options = {}) {
    return await this.circuitBreaker.execute(
      async () => {
        const response = await fetch('https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${options.apiKey}`
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw globalThis.ErrorSystem.createError(
            globalThis.ErrorSystem.ErrorCategory.AI_API,
            `Gemini API request failed: ${response.status}`,
            {
              code: 'GEMINI_API_ERROR',
              severity: globalThis.ErrorSystem.ErrorSeverity.HIGH,
              statusCode: response.status,
              apiKey: '[REDACTED]',
              model: 'gemini-pro',
              rateLimited: response.status === 429,
              quotaExceeded: response.status === 403,
              context: { prompt: prompt.substring(0, 100), errorData }
            }
          );
        }

        return await response.json();
      },
      // Fallback function
      async () => {
        this.log.warn('Using fallback for Gemini API');
        return this.getFallbackResponse(prompt);
      }
    );
  }

  async getFallbackResponse(prompt) {
    // Return cached response or simplified logic
    return {
      candidates: [{
        content: {
          parts: [{ text: 'I apologize, but the AI service is temporarily unavailable. Please try again later.' }]
        }
      }]
    };
  }
}

// Example 4: DOM operation with proper error handling
// BEFORE (basic DOM error handling):
function oldDOMOperation(selector) {
  try {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error('Element not found');
    }
    element.click();
    return true;
  } catch (error) {
    console.error('DOM operation failed:', error);
    return false;
  }
}

// AFTER (enhanced DOM error handling):
async function newDOMOperation(selector, options = {}) {
  const log = globalThis.Log?.createLogger('dom-operations') || console;
  const boundary = globalThis.ErrorBoundary?.create('dom-operation', {
    maxRetries: 3,
    retryDelay: 500,
    isolationLevel: 'operation'
  });

  try {
    return await boundary.executeWithRetry(async () => {
      const element = document.querySelector(selector);
      
      if (!element) {
        throw globalThis.ErrorSystem.createError(
          globalThis.ErrorSystem.ErrorCategory.DOM,
          `Element not found: ${selector}`,
          {
            code: 'ELEMENT_NOT_FOUND',
            severity: globalThis.ErrorSystem.ErrorSeverity.MEDIUM,
            selector,
            elementType: 'unknown',
            expectedState: 'present',
            actualState: 'not_found',
            context: {
              url: window.location.href,
              elementCount: document.querySelectorAll('*').length,
              retryAttempt: options.retryAttempt || 0
            }
          }
        );
      }

      // Check if element is visible and clickable
      const rect = element.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(element);
      
      if (rect.width === 0 || rect.height === 0 || computedStyle.visibility === 'hidden') {
        throw globalThis.ErrorSystem.createError(
          globalThis.ErrorSystem.ErrorCategory.DOM,
          `Element not visible: ${selector}`,
          {
            code: 'ELEMENT_NOT_VISIBLE',
            severity: globalThis.ErrorSystem.ErrorSeverity.LOW,
            selector,
            elementType: element.tagName.toLowerCase(),
            expectedState: 'visible',
            actualState: 'hidden',
            context: { rect, visibility: computedStyle.visibility }
          }
        );
      }

      // Perform the click
      element.click();
      log.debug('DOM operation successful', { selector, elementType: element.tagName });
      
      return true;
    });
    
  } catch (error) {
    // Enhanced error logging with context
    log.error('DOM operation failed', {
      error,
      selector,
      url: window.location.href,
      timestamp: Date.now()
    });
    
    return false;
  }
}

// Example 5: Session management with comprehensive error handling
class SessionManager {
  constructor() {
    this.log = globalThis.Log?.createLogger('session-manager') || console;
    this.sessions = new Map();
    
    // Error boundary for session operations
    this.boundary = globalThis.ErrorBoundary?.create('session-manager', {
      maxRetries: 1,
      isolationLevel: 'module',
      errorCallback: async (error) => {
        await this.handleSessionError(error);
      }
    });
  }

  async createSession(sessionData) {
    return await this.boundary.execute(async () => {
      const sessionId = this.generateSessionId();
      
      try {
        // Validate session data
        if (!sessionData || typeof sessionData !== 'object') {
          throw globalThis.ErrorSystem.createError(
            globalThis.ErrorSystem.ErrorCategory.VALIDATION,
            'Invalid session data provided',
            {
              code: 'INVALID_SESSION_DATA',
              severity: globalThis.ErrorSystem.ErrorSeverity.LOW,
              field: 'sessionData',
              value: sessionData,
              validationRules: ['must be object', 'cannot be null']
            }
          );
        }

        // Store session
        this.sessions.set(sessionId, {
          ...sessionData,
          id: sessionId,
          createdAt: Date.now(),
          lastAccessed: Date.now()
        });

        // Persist to storage
        await this.persistSession(sessionId);
        
        this.log.info('Session created successfully', { sessionId });
        return sessionId;
        
      } catch (error) {
        // Clean up failed session
        this.sessions.delete(sessionId);
        
        throw globalThis.ErrorSystem.wrapError(
          error,
          globalThis.ErrorSystem.ErrorCategory.BACKGROUND,
          {
            operation: 'createSession',
            sessionId,
            context: { sessionDataKeys: Object.keys(sessionData || {}) }
          }
        );
      }
    });
  }

  async persistSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw globalThis.ErrorSystem.createError(
        globalThis.ErrorSystem.ErrorCategory.STORAGE,
        `Session not found: ${sessionId}`,
        {
          code: 'SESSION_NOT_FOUND',
          severity: globalThis.ErrorSystem.ErrorSeverity.MEDIUM,
          operation: 'persist',
          key: sessionId
        }
      );
    }

    try {
      await chrome.storage.local.set({ [`session_${sessionId}`]: session });
    } catch (error) {
      throw globalThis.ErrorSystem.createError(
        globalThis.ErrorSystem.ErrorCategory.STORAGE,
        'Failed to persist session to storage',
        {
          code: 'STORAGE_PERSIST_FAILED',
          severity: globalThis.ErrorSystem.ErrorSeverity.HIGH,
          storageType: 'chrome.storage',
          operation: 'write',
          key: `session_${sessionId}`,
          originalError: error,
          quotaExceeded: error.message?.includes('QUOTA_EXCEEDED')
        }
      );
    }
  }

  async handleSessionError(error) {
    this.log.error('Session manager error', { error });
    
    // Implement recovery strategies based on error type
    if (error.category === globalThis.ErrorSystem.ErrorCategory.STORAGE) {
      if (error.quotaExceeded) {
        await this.cleanupOldSessions();
      }
    }
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async cleanupOldSessions() {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    let cleaned = 0;
    
    for (const [sessionId, session] of this.sessions) {
      if (session.lastAccessed < cutoff) {
        this.sessions.delete(sessionId);
        try {
          await chrome.storage.local.remove(`session_${sessionId}`);
          cleaned++;
        } catch (error) {
          this.log.warn('Failed to cleanup session', { sessionId, error });
        }
      }
    }
    
    this.log.info(`Cleaned up ${cleaned} old sessions`);
  }
}

// Example 6: Integration with existing message handlers
// Enhanced message handler with error boundaries
function enhancedMessageHandler(message, sender, sendResponse) {
  const log = globalThis.Log?.createLogger('message-handler') || console;
  const boundary = globalThis.ErrorBoundary?.create('message-handler', {
    maxRetries: 0, // Don't retry message handling
    isolationLevel: 'operation',
    errorCallback: async (error) => {
      // Send error response back to sender
      sendResponse({
        success: false,
        error: {
          message: error.getUserDescription ? error.getUserDescription() : error.message,
          code: error.code || 'UNKNOWN_ERROR',
          retryable: error.retryable || false
        }
      });
    }
  });

  // Wrap message handling in error boundary
  boundary.execute(async () => {
    log.debug('Processing message', { type: message.type, sender: sender.tab?.id });
    
    switch (message.type) {
      case 'AUTOMATION_REQUEST':
        return await handleAutomationRequest(message, sender);
      case 'SESSION_CREATE':
        return await handleSessionCreate(message, sender);
      default:
        throw globalThis.ErrorSystem.createError(
          globalThis.ErrorSystem.ErrorCategory.VALIDATION,
          `Unknown message type: ${message.type}`,
          {
            code: 'UNKNOWN_MESSAGE_TYPE',
            severity: globalThis.ErrorSystem.ErrorSeverity.LOW,
            messageType: message.type,
            validTypes: ['AUTOMATION_REQUEST', 'SESSION_CREATE']
          }
        );
    }
  }).then(result => {
    sendResponse({ success: true, data: result });
  }).catch(error => {
    // Error callback will handle sending error response
    log.error('Message handler failed', { error, messageType: message.type });
  });

  return true; // Keep message channel open for async response
}

// Export examples for documentation
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    newApiCall,
    newCriticalOperation,
    GeminiAPIService,
    newDOMOperation,
    SessionManager,
    enhancedMessageHandler
  };
}