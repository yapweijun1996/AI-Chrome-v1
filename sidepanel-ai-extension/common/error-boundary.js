/**
 * common/error-boundary.js
 * Error boundary implementation for Chrome extension contexts
 * 
 * Provides:
 * - Error boundaries for different execution contexts
 * - Automatic error recovery and fallback mechanisms
 * - Circuit breaker pattern for failing operations
 * - Error isolation and containment
 */

(function initErrorBoundary(global) {
  if (global.ErrorBoundary && global.ErrorBoundary.__LOCKED__) return;

  // Import error system if available
  const ErrorSystem = global.ErrorSystem || null;
  const createLogger = global.Log?.createLogger || (() => console);
  
  /**
   * Circuit breaker states
   */
  const CircuitState = {
    CLOSED: 'closed',     // Normal operation
    OPEN: 'open',         // Failing, blocking calls
    HALF_OPEN: 'half_open' // Testing if service recovered
  };

  /**
   * Circuit breaker for preventing cascading failures
   */
  class CircuitBreaker {
    constructor(options = {}) {
      this.name = options.name || 'circuit';
      this.failureThreshold = options.failureThreshold || 5;
      this.recoveryTimeout = options.recoveryTimeout || 60000; // 1 minute
      this.monitoringPeriod = options.monitoringPeriod || 120000; // 2 minutes
      
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
      this.lastFailureTime = null;
      this.nextAttemptTime = null;
      this.successCount = 0;
      
      this.log = createLogger(`circuit:${this.name}`);
    }

    async execute(operation, fallback = null) {
      if (this.state === CircuitState.OPEN) {
        if (Date.now() < this.nextAttemptTime) {
          this.log.debug('Circuit breaker is OPEN, using fallback');
          if (fallback && typeof fallback === 'function') {
            try {
              return await fallback();
            } catch (fallbackError) {
              this.log.warn('Fallback function failed', { error: fallbackError.message });
              throw fallbackError;
            }
          }
          throw this.createCircuitOpenError();
        } else {
          this.state = CircuitState.HALF_OPEN;
          this.log.info('Circuit breaker transitioning to HALF_OPEN');
        }
      }

      try {
        const result = await Promise.resolve(operation());
        this.onSuccess();
        return result;
      } catch (error) {
        this.onFailure(error);
        if (fallback && typeof fallback === 'function' && this.state === CircuitState.OPEN) {
          this.log.debug('Using fallback due to circuit breaker');
          try {
            return await fallback();
          } catch (fallbackError) {
            this.log.warn('Fallback function failed', { error: fallbackError.message });
            throw fallbackError;
          }
        }
        throw error;
      }
    }

    onSuccess() {
      this.failureCount = 0;
      if (this.state === CircuitState.HALF_OPEN) {
        this.state = CircuitState.CLOSED;
        this.log.info('Circuit breaker recovered, state: CLOSED');
      }
      this.successCount++;
    }

    onFailure(error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      
      this.log.warn(`Circuit breaker failure ${this.failureCount}/${this.failureThreshold}`, {
        error: error.message,
        state: this.state
      });

      if (this.failureCount >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.nextAttemptTime = Date.now() + this.recoveryTimeout;
        this.log.error('Circuit breaker OPENED', {
          failureCount: this.failureCount,
          nextAttempt: new Date(this.nextAttemptTime).toISOString()
        });
      }
    }

    createCircuitOpenError() {
      const error = ErrorSystem ? 
        ErrorSystem.createError(ErrorSystem.ErrorCategory.TIMEOUT, 
          `Circuit breaker '${this.name}' is open`, {
            code: 'CIRCUIT_BREAKER_OPEN',
            severity: ErrorSystem.ErrorSeverity.HIGH,
            recoveryStrategy: ErrorSystem.RecoveryStrategy.FALLBACK,
            context: {
              circuitName: this.name,
              failureCount: this.failureCount,
              nextAttemptTime: this.nextAttemptTime
            }
          }) :
        new Error(`Circuit breaker '${this.name}' is open`);
      
      return error;
    }

    getStatus() {
      return {
        name: this.name,
        state: this.state,
        failureCount: this.failureCount,
        successCount: this.successCount,
        lastFailureTime: this.lastFailureTime,
        nextAttemptTime: this.nextAttemptTime
      };
    }

    reset() {
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
      this.successCount = 0;
      this.lastFailureTime = null;
      this.nextAttemptTime = null;
      this.log.info('Circuit breaker reset');
    }

    destroy() {
      this.reset();
      this.log.info('Circuit breaker destroyed');
    }
  }

  /**
   * Error boundary for isolating and recovering from errors
   */
  class ErrorBoundary {
    constructor(options = {}) {
      this.name = options.name || 'boundary';
      this.maxRetries = options.maxRetries || 3;
      this.retryDelay = options.retryDelay || 1000;
      this.fallbackFunction = options.fallbackFunction || null;
      this.errorCallback = options.errorCallback || null;
      this.isolationLevel = options.isolationLevel || 'operation'; // 'operation', 'module', 'system'
      
      this.circuitBreaker = new CircuitBreaker({
        name: `${this.name}-circuit`,
        ...options.circuitBreaker
      });
      
      this.log = createLogger(`boundary:${this.name}`);
      this.errorCount = 0;
      this.recoveryCount = 0;
    }

    /**
     * Execute operation within error boundary
     */
    async execute(operation, context = {}) {
      const boundaryContext = {
        boundaryName: this.name,
        timestamp: Date.now(),
        ...context
      };

      try {
        this.log.debug('Executing operation within boundary', boundaryContext);
        
        const result = await this.circuitBreaker.execute(
          operation,
          this.fallbackFunction
        );
        
        this.log.debug('Operation completed successfully');
        return result;
        
      } catch (error) {
        return await this.handleError(error, operation, boundaryContext);
      }
    }

    /**
     * Execute with retry logic
     */
    async executeWithRetry(operation, context = {}) {
      let lastError = null;
      
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            this.log.debug(`Retry attempt ${attempt}/${this.maxRetries}`);
            await this.delay(this.retryDelay * Math.pow(2, attempt - 1)); // Exponential backoff
          }
          
          return await this.execute(operation, { ...context, attempt });
          
        } catch (error) {
          lastError = error;
          
          // Check if error is retryable
          if (ErrorSystem && error instanceof ErrorSystem.ExtensionError) {
            if (!error.shouldRetry()) {
              this.log.debug('Error is not retryable, aborting');
              break;
            }
          }
          
          if (attempt === this.maxRetries) {
            this.log.warn(`All retry attempts exhausted for ${this.name}`);
            break;
          }
        }
      }
      
      throw lastError;
    }

    /**
     * Handle errors with recovery strategies
     */
    async handleError(error, operation = null, context = {}) {
      this.errorCount++;
      
      // Enhance error with boundary context
      const enhancedError = this.enhanceError(error, context);
      
      this.log.error('Error caught by boundary', {
        errorMessage: enhancedError.message,
        errorCode: enhancedError.code,
        context
      });

      // Call error callback if provided
      if (this.errorCallback) {
        try {
          await this.errorCallback(enhancedError, context);
        } catch (callbackError) {
          this.log.warn('Error callback failed', callbackError);
        }
      }

      // Apply recovery strategies
      if (ErrorSystem && enhancedError instanceof ErrorSystem.ExtensionError) {
        try {
          const recoveryResult = await ErrorSystem.handle(enhancedError, operation);
          
          if (recoveryResult.fallback) {
            this.log.info('Applying fallback recovery');
            this.recoveryCount++;
            if (this.fallbackFunction) {
              return await this.fallbackFunction(enhancedError, context);
            }
          }
          
          if (recoveryResult.skip) {
            this.log.info('Skipping failed operation');
            return null;
          }
          
          if (recoveryResult.userIntervention) {
            this.log.info('User intervention required');
            throw this.createUserInterventionError(recoveryResult.message, enhancedError);
          }
          
        } catch (recoveryError) {
          // Recovery failed, continue with original error handling
          this.log.warn('Recovery strategy failed', recoveryError);
        }
      }

      // Apply isolation based on isolation level
      await this.applyIsolation(enhancedError);
      
      throw enhancedError;
    }

    /**
     * Enhance error with boundary metadata
     */
    enhanceError(error, context = {}) {
      if (ErrorSystem && !(error instanceof ErrorSystem.ExtensionError)) {
        // Wrap native errors
        return ErrorSystem.wrapError(error, ErrorSystem.ErrorCategory.UNKNOWN, {
          context: {
            boundary: this.name,
            isolationLevel: this.isolationLevel,
            ...context
          }
        });
      }
      
      if (ErrorSystem && error instanceof ErrorSystem.ExtensionError) {
        // Add boundary context to existing ExtensionError
        error.context = {
          ...error.context,
          boundary: this.name,
          isolationLevel: this.isolationLevel,
          ...context
        };
      }
      
      return error;
    }

    /**
     * Apply isolation based on error severity and isolation level
     */
    async applyIsolation(error) {
      if (!ErrorSystem) return;
      
      const severity = error.severity || ErrorSystem.ErrorSeverity.MEDIUM;
      
      switch (this.isolationLevel) {
        case 'operation':
          // Isolate only the current operation
          this.log.debug('Operation-level isolation applied');
          break;
          
        case 'module':
          // Isolate the entire module/component
          if (severity === ErrorSystem.ErrorSeverity.HIGH || 
              severity === ErrorSystem.ErrorSeverity.CRITICAL) {
            this.log.warn('Module-level isolation applied');
            this.circuitBreaker.onFailure(error);
          }
          break;
          
        case 'system':
          // System-wide isolation for critical errors
          if (severity === ErrorSystem.ErrorSeverity.CRITICAL) {
            this.log.error('System-level isolation applied');
            // Could trigger extension reload or safe mode
            await this.triggerSystemIsolation(error);
          }
          break;
      }
    }

    /**
     * Trigger system-wide isolation
     */
    async triggerSystemIsolation(error) {
      this.log.error('Triggering system isolation', {
        errorCode: error.code,
        errorMessage: error.message
      });
      
      // Notify other components of critical failure
      try {
        if (global.chrome?.runtime?.sendMessage) {
          await global.chrome.runtime.sendMessage({
            type: 'SYSTEM_ISOLATION_TRIGGERED',
            error: error.toJSON(),
            boundary: this.name,
            timestamp: Date.now()
          });
        }
      } catch (e) {
        this.log.warn('Failed to notify system of isolation', e);
      }
    }

    /**
     * Create user intervention error
     */
    createUserInterventionError(message, originalError) {
      return ErrorSystem ? 
        ErrorSystem.createError(ErrorSystem.ErrorCategory.VALIDATION, message, {
          code: 'USER_INTERVENTION_REQUIRED',
          severity: ErrorSystem.ErrorSeverity.MEDIUM,
          recoveryStrategy: ErrorSystem.RecoveryStrategy.USER_INTERVENTION,
          userMessage: message,
          originalError,
          context: { boundary: this.name }
        }) :
        new Error(message);
    }

    /**
     * Utility delay function
     */
    delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get boundary status
     */
    getStatus() {
      return {
        name: this.name,
        errorCount: this.errorCount,
        recoveryCount: this.recoveryCount,
        circuitBreaker: this.circuitBreaker.getStatus(),
        isolationLevel: this.isolationLevel
      };
    }

    /**
     * Reset boundary state
     */
    reset() {
      this.errorCount = 0;
      this.recoveryCount = 0;
      this.circuitBreaker.reset();
      this.log.info('Error boundary reset');
    }

    /**
     * Destroy boundary and cleanup resources
     */
    destroy() {
      this.circuitBreaker.destroy();
      this.errorCount = 0;
      this.recoveryCount = 0;
      this.log.info('Error boundary destroyed');
    }
  }

  /**
   * Global error boundary manager
   */
  class ErrorBoundaryManager {
    constructor() {
      this.boundaries = new Map();
      this.globalErrorCount = 0;
      this.log = createLogger('boundary-manager');
    }

    /**
     * Create or get named error boundary
     */
    create(name, options = {}) {
      if (this.boundaries.has(name)) {
        return this.boundaries.get(name);
      }
      
      const boundary = new ErrorBoundary({ name, ...options });
      this.boundaries.set(name, boundary);
      
      this.log.debug('Created error boundary', { name, options });
      return boundary;
    }

    /**
     * Execute operation in named boundary
     */
    async execute(boundaryName, operation, options = {}) {
      const boundary = this.create(boundaryName, options);
      return await boundary.execute(operation, options.context);
    }

    /**
     * Execute with retry in named boundary
     */
    async executeWithRetry(boundaryName, operation, options = {}) {
      const boundary = this.create(boundaryName, options);
      return await boundary.executeWithRetry(operation, options.context);
    }

    /**
     * Get all boundary statuses
     */
    getStatus() {
      const statuses = {};
      for (const [name, boundary] of this.boundaries) {
        statuses[name] = boundary.getStatus();
      }
      return {
        globalErrorCount: this.globalErrorCount,
        boundaries: statuses
      };
    }

    /**
     * Reset all boundaries
     */
    resetAll() {
      for (const boundary of this.boundaries.values()) {
        boundary.reset();
      }
      this.globalErrorCount = 0;
      this.log.info('All error boundaries reset');
    }

    /**
     * Destroy all boundaries and cleanup resources
     */
    destroyAll() {
      for (const boundary of this.boundaries.values()) {
        boundary.destroy();
      }
      this.boundaries.clear();
      this.globalErrorCount = 0;
      this.log.info('All error boundaries destroyed');
    }

    /**
     * Handle global unhandled errors
     */
    setupGlobalHandlers() {
      // Handle unhandled promise rejections
      if (global.addEventListener) {
        global.addEventListener('unhandledrejection', (event) => {
          this.globalErrorCount++;
          this.log.error('Unhandled promise rejection', {
            reason: event.reason,
            promise: event.promise
          });
          
          // Try to handle with global boundary
          this.execute('global', () => {
            throw event.reason;
          }).catch(() => {
            // Global boundary handled it
          });
        });

        // Handle regular errors
        global.addEventListener('error', (event) => {
          this.globalErrorCount++;
          this.log.error('Unhandled error', {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: event.error
          });
        });
      }
    }
  }

  // Create global manager instance
  const manager = new ErrorBoundaryManager();
  
  // Setup global error handlers
  try {
    manager.setupGlobalHandlers();
  } catch (e) {
    // Ignore if in restricted context
  }

  // Export the error boundary system
  const ErrorBoundarySystem = {
    ErrorBoundary,
    CircuitBreaker,
    ErrorBoundaryManager,
    CircuitState,
    
    // Global manager instance
    manager,
    
    // Convenience methods
    create: manager.create.bind(manager),
    execute: manager.execute.bind(manager),
    executeWithRetry: manager.executeWithRetry.bind(manager),
    getStatus: manager.getStatus.bind(manager),
    resetAll: manager.resetAll.bind(manager),
    
    __LOCKED__: true
  };

  // Attach to global scope
  try {
    global.ErrorBoundary = ErrorBoundarySystem;
  } catch (e) {
    // Ignore if in restricted context
  }

  return ErrorBoundarySystem;

})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));