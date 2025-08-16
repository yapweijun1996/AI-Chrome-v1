/**
 * common/errors.js
 * Custom error classes and error handling utilities for the AI Chrome Extension
 * 
 * Provides:
 * - Custom error types for different failure scenarios
 * - Error serialization/deserialization for cross-context communication
 * - Error recovery strategies and patterns
 * - Integration with the logging system
 */

(function initErrorSystem(global) {
  if (global.ErrorSystem && global.ErrorSystem.__LOCKED__) return;

  // Error severity levels
  const ErrorSeverity = {
    LOW: 'low',
    MEDIUM: 'medium', 
    HIGH: 'high',
    CRITICAL: 'critical'
  };

  // Error categories for classification
  const ErrorCategory = {
    NETWORK: 'network',
    PERMISSION: 'permission',
    DOM: 'dom',
    AI_API: 'ai_api',
    AUTOMATION: 'automation',
    CONTENT_SCRIPT: 'content_script',
    BACKGROUND: 'background',
    STORAGE: 'storage',
    VALIDATION: 'validation',
    TIMEOUT: 'timeout',
    UNKNOWN: 'unknown'
  };

  // Recovery strategies
  const RecoveryStrategy = {
    RETRY: 'retry',
    FALLBACK: 'fallback',
    SKIP: 'skip',
    ABORT: 'abort',
    USER_INTERVENTION: 'user_intervention'
  };

  /**
   * Base error class with enhanced metadata and recovery capabilities
   */
  class ExtensionError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = this.constructor.name;
      
      // Core metadata
      this.code = options.code || 'UNKNOWN_ERROR';
      this.category = options.category || ErrorCategory.UNKNOWN;
      this.severity = options.severity || ErrorSeverity.MEDIUM;
      this.recoveryStrategy = options.recoveryStrategy || RecoveryStrategy.ABORT;
      
      // Context information
      this.context = options.context || {};
      this.timestamp = new Date().toISOString();
      this.tabId = options.tabId || null;
      this.sessionId = options.sessionId || null;
      this.userId = options.userId || null;
      
      // Technical details
      this.originalError = options.originalError || null;
      this.stackTrace = this.stack;
      this.userAgent = global.navigator?.userAgent || null;
      this.url = global.location?.href || null;
      
      // Recovery metadata
      this.retryCount = options.retryCount || 0;
      this.maxRetries = options.maxRetries || 3;
      this.retryable = options.retryable !== false;
      this.fallbackOptions = options.fallbackOptions || [];
      
      // User-facing information
      this.userMessage = options.userMessage || null;
      this.actionRequired = options.actionRequired || null;
      
      // Capture additional stack trace
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
      }
    }

    /**
     * Serialize error for cross-context communication
     */
    toJSON() {
      return {
        name: this.name,
        message: this.message,
        code: this.code,
        category: this.category,
        severity: this.severity,
        recoveryStrategy: this.recoveryStrategy,
        context: this.context,
        timestamp: this.timestamp,
        tabId: this.tabId,
        sessionId: this.sessionId,
        userId: this.userId,
        stackTrace: this.stackTrace,
        userAgent: this.userAgent,
        url: this.url,
        retryCount: this.retryCount,
        maxRetries: this.maxRetries,
        retryable: this.retryable,
        fallbackOptions: this.fallbackOptions,
        userMessage: this.userMessage,
        actionRequired: this.actionRequired,
        originalError: this.originalError ? {
          name: this.originalError.name,
          message: this.originalError.message,
          stack: this.originalError.stack
        } : null
      };
    }

    /**
     * Create a user-friendly error description
     */
    getUserDescription() {
      if (this.userMessage) return this.userMessage;
      
      switch (this.category) {
        case ErrorCategory.NETWORK:
          return 'Network connection issue. Please check your internet connection.';
        case ErrorCategory.PERMISSION:
          return 'Permission denied. Please grant the necessary permissions.';
        case ErrorCategory.DOM:
          return 'Page element not found or not accessible.';
        case ErrorCategory.AI_API:
          return 'AI service is temporarily unavailable. Please try again.';
        case ErrorCategory.AUTOMATION:
          return 'Automation step failed. The page may have changed.';
        case ErrorCategory.TIMEOUT:
          return 'Operation timed out. Please try again.';
        default:
          return 'An unexpected error occurred.';
      }
    }

    /**
     * Check if error should be retried
     */
    shouldRetry() {
      return this.retryable && this.retryCount < this.maxRetries;
    }

    /**
     * Create a retry version of this error
     */
    createRetry(additionalContext = {}) {
      return new this.constructor(this.message, {
        ...this.toJSON(),
        retryCount: this.retryCount + 1,
        context: { ...this.context, ...additionalContext, previousAttempt: this.timestamp }
      });
    }
  }

  /**
   * Network-related errors (API calls, downloads, etc.)
   */
  class NetworkError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.NETWORK,
        severity: ErrorSeverity.MEDIUM,
        recoveryStrategy: RecoveryStrategy.RETRY,
        retryable: true,
        maxRetries: 3,
        ...options
      });
      
      this.statusCode = options.statusCode || null;
      this.responseText = options.responseText || null;
      this.endpoint = options.endpoint || null;
      this.requestMethod = options.requestMethod || null;
    }
  }

  /**
   * Permission-related errors
   */
  class PermissionError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.PERMISSION,
        severity: ErrorSeverity.HIGH,
        recoveryStrategy: RecoveryStrategy.USER_INTERVENTION,
        retryable: false,
        userMessage: 'Permission required to continue. Please grant the necessary permissions.',
        ...options
      });
      
      this.permission = options.permission || null;
      this.requiredPermissions = options.requiredPermissions || [];
    }
  }

  /**
   * DOM interaction errors
   */
  class DOMError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.DOM,
        severity: ErrorSeverity.MEDIUM,
        recoveryStrategy: RecoveryStrategy.RETRY,
        retryable: true,
        maxRetries: 2,
        ...options
      });
      
      this.selector = options.selector || null;
      this.elementType = options.elementType || null;
      this.expectedState = options.expectedState || null;
      this.actualState = options.actualState || null;
    }
  }

  /**
   * AI API related errors
   */
  class AIAPIError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.AI_API,
        severity: ErrorSeverity.HIGH,
        recoveryStrategy: RecoveryStrategy.RETRY,
        retryable: true,
        maxRetries: 2,
        userMessage: 'AI service is temporarily unavailable. Please try again in a moment.',
        ...options
      });
      
      this.apiKey = options.apiKey ? '[REDACTED]' : null;
      this.model = options.model || null;
      this.requestId = options.requestId || null;
      this.rateLimited = options.rateLimited || false;
      this.quotaExceeded = options.quotaExceeded || false;
    }
  }

  /**
   * Automation workflow errors
   */
  class AutomationError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.AUTOMATION,
        severity: ErrorSeverity.MEDIUM,
        recoveryStrategy: RecoveryStrategy.FALLBACK,
        retryable: true,
        maxRetries: 1,
        ...options
      });
      
      this.stepIndex = options.stepIndex || null;
      this.toolName = options.toolName || null;
      this.inputData = options.inputData || null;
      this.expectedOutcome = options.expectedOutcome || null;
    }
  }

  /**
   * Content script errors
   */
  class ContentScriptError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.CONTENT_SCRIPT,
        severity: ErrorSeverity.HIGH,
        recoveryStrategy: RecoveryStrategy.RETRY,
        retryable: true,
        maxRetries: 2,
        ...options
      });
      
      this.injectionFailed = options.injectionFailed || false;
      this.communicationLost = options.communicationLost || false;
      this.pageUrl = options.pageUrl || null;
    }
  }

  /**
   * Background script errors
   */
  class BackgroundError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.BACKGROUND,
        severity: ErrorSeverity.HIGH,
        recoveryStrategy: RecoveryStrategy.FALLBACK,
        retryable: false,
        ...options
      });
      
      this.serviceWorkerRestart = options.serviceWorkerRestart || false;
      this.messageType = options.messageType || null;
    }
  }

  /**
   * Storage operation errors
   */
  class StorageError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.STORAGE,
        severity: ErrorSeverity.MEDIUM,
        recoveryStrategy: RecoveryStrategy.RETRY,
        retryable: true,
        maxRetries: 3,
        ...options
      });
      
      this.storageType = options.storageType || null; // 'chrome.storage', 'indexedDB', 'localStorage'
      this.operation = options.operation || null; // 'read', 'write', 'delete'
      this.key = options.key || null;
      this.quotaExceeded = options.quotaExceeded || false;
    }
  }

  /**
   * Validation errors
   */
  class ValidationError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.VALIDATION,
        severity: ErrorSeverity.LOW,
        recoveryStrategy: RecoveryStrategy.USER_INTERVENTION,
        retryable: false,
        ...options
      });
      
      this.field = options.field || null;
      this.value = options.value || null;
      this.validationRules = options.validationRules || [];
    }
  }

  /**
   * Timeout errors
   */
  class TimeoutError extends ExtensionError {
    constructor(message, options = {}) {
      super(message, {
        category: ErrorCategory.TIMEOUT,
        severity: ErrorSeverity.MEDIUM,
        recoveryStrategy: RecoveryStrategy.RETRY,
        retryable: true,
        maxRetries: 2,
        userMessage: 'Operation timed out. The page may be loading slowly.',
        ...options
      });
      
      this.timeoutDuration = options.timeoutDuration || null;
      this.operation = options.operation || null;
    }
  }

  /**
   * Error factory for creating appropriate error types
   */
  class ErrorFactory {
    static createFromCategory(category, message, options = {}) {
      const errorOptions = { category, ...options };
      
      switch (category) {
        case ErrorCategory.NETWORK:
          return new NetworkError(message, errorOptions);
        case ErrorCategory.PERMISSION:
          return new PermissionError(message, errorOptions);
        case ErrorCategory.DOM:
          return new DOMError(message, errorOptions);
        case ErrorCategory.AI_API:
          return new AIAPIError(message, errorOptions);
        case ErrorCategory.AUTOMATION:
          return new AutomationError(message, errorOptions);
        case ErrorCategory.CONTENT_SCRIPT:
          return new ContentScriptError(message, errorOptions);
        case ErrorCategory.BACKGROUND:
          return new BackgroundError(message, errorOptions);
        case ErrorCategory.STORAGE:
          return new StorageError(message, errorOptions);
        case ErrorCategory.VALIDATION:
          return new ValidationError(message, errorOptions);
        case ErrorCategory.TIMEOUT:
          return new TimeoutError(message, errorOptions);
        default:
          return new ExtensionError(message, errorOptions);
      }
    }

    /**
     * Create error from serialized data
     */
    static fromJSON(data) {
      if (!data || typeof data !== 'object') return null;
      
      const options = { ...data };
      delete options.name;
      delete options.message;
      
      return this.createFromCategory(data.category, data.message, options);
    }

    /**
     * Wrap a native error in our error system
     */
    static wrap(error, category = ErrorCategory.UNKNOWN, options = {}) {
      if (error instanceof ExtensionError) return error;
      
      return this.createFromCategory(category, error.message, {
        originalError: error,
        stackTrace: error.stack,
        ...options
      });
    }
  }

  /**
   * Error handler utilities
   */
  class ErrorHandler {
    static logError(error, logger = null) {
      const log = logger || (global.Log && global.Log.createLogger('errors'));
      
      if (!log) {
        console.error('[ERROR]', error);
        return;
      }

      const logLevel = this.getLogLevel(error);
      const metadata = {
        code: error.code,
        category: error.category,
        severity: error.severity,
        context: error.context,
        tabId: error.tabId,
        sessionId: error.sessionId
      };

      log[logLevel](error.message, metadata);
      
      if (error.originalError) {
        log.debug('Original error:', error.originalError);
      }
    }

    static getLogLevel(error) {
      switch (error.severity) {
        case ErrorSeverity.CRITICAL:
          return 'error';
        case ErrorSeverity.HIGH:
          return 'error';
        case ErrorSeverity.MEDIUM:
          return 'warn';
        case ErrorSeverity.LOW:
          return 'info';
        default:
          return 'warn';
      }
    }

    /**
     * Handle error with automatic recovery
     */
    static async handleWithRecovery(error, recoveryFunction = null) {
      this.logError(error);
      
      // Check if we should retry
      if (error.shouldRetry()) {
        if (recoveryFunction && typeof recoveryFunction === 'function') {
          try {
            return await recoveryFunction(error);
          } catch (retryError) {
            const newError = error.createRetry({ retryError: retryError.message });
            return this.handleWithRecovery(newError, recoveryFunction);
          }
        }
      }
      
      // Apply recovery strategy
      switch (error.recoveryStrategy) {
        case RecoveryStrategy.RETRY:
          if (error.shouldRetry()) {
            throw error.createRetry();
          }
          break;
        case RecoveryStrategy.FALLBACK:
          // Return fallback options for caller to handle
          return { fallback: true, options: error.fallbackOptions };
        case RecoveryStrategy.SKIP:
          return { skip: true };
        case RecoveryStrategy.USER_INTERVENTION:
          return { userIntervention: true, message: error.getUserDescription() };
        case RecoveryStrategy.ABORT:
        default:
          throw error;
      }
      
      throw error;
    }
  }

  // Export the error system
  const ErrorSystem = {
    // Error classes
    ExtensionError,
    NetworkError,
    PermissionError,
    DOMError,
    AIAPIError,
    AutomationError,
    ContentScriptError,
    BackgroundError,
    StorageError,
    ValidationError,
    TimeoutError,
    
    // Utilities
    ErrorFactory,
    ErrorHandler,
    
    // Constants
    ErrorSeverity,
    ErrorCategory,
    RecoveryStrategy,
    
    // Utility functions
    createError: ErrorFactory.createFromCategory.bind(ErrorFactory),
    wrapError: ErrorFactory.wrap.bind(ErrorFactory),
    fromJSON: ErrorFactory.fromJSON.bind(ErrorFactory),
    handle: ErrorHandler.handleWithRecovery.bind(ErrorHandler),
    log: ErrorHandler.logError.bind(ErrorHandler),
    
    __LOCKED__: true
  };

  // Attach to global scope
  try { 
    global.ErrorSystem = ErrorSystem;
    global.ExtensionError = ExtensionError;
  } catch (e) {
    // Ignore if in restricted context
  }

  return ErrorSystem;

})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));