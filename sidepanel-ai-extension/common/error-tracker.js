/**
 * common/error-tracker.js
 * Centralized error tracking and reporting system
 * 
 * Provides:
 * - Error aggregation and analysis
 * - Error rate monitoring
 * - Performance impact tracking
 * - Error reporting and alerts
 */

(function initErrorTracker(global) {
  if (global.ErrorTracker && global.ErrorTracker.__LOCKED__) return;

  const ErrorSystem = global.ErrorSystem || null;
  const createLogger = global.Log?.createLogger || (() => console);

  /**
   * Error tracking and analysis system
   */
  class ErrorTracker {
    constructor(options = {}) {
      this.maxErrors = options.maxErrors || 1000;
      this.retentionPeriod = options.retentionPeriod || 24 * 60 * 60 * 1000; // 24 hours
      this.reportingThreshold = options.reportingThreshold || 10; // errors per minute
      this.analysisInterval = options.analysisInterval || 5 * 60 * 1000; // 5 minutes
      
      this.errors = [];
      this.errorCounts = new Map();
      this.sessionErrors = new Map();
      this.performanceImpact = new Map();
      
      this.log = createLogger('error-tracker');
      this.isAnalyzing = false;
      
      // Start background analysis
      this.startAnalysis();
      
      // Cleanup old errors periodically
      this.startCleanup();
    }

    /**
     * Track a new error
     */
    trackError(errorData) {
      const timestamp = Date.now();
      const errorId = this.generateErrorId(errorData);
      
      const trackedError = {
        id: errorId,
        timestamp,
        ...errorData,
        sessionId: this.getSessionId(),
        userAgent: global.navigator?.userAgent || null,
        url: global.location?.href || null,
        context: this.getExecutionContext()
      };

      // Add to errors list
      this.errors.unshift(trackedError);
      
      // Maintain max size
      if (this.errors.length > this.maxErrors) {
        this.errors = this.errors.slice(0, this.maxErrors);
      }

      // Update counts
      this.updateCounts(errorId, trackedError);
      
      // Check for immediate alerts
      this.checkAlerts(trackedError);
      
      this.log.debug('Error tracked', {
        errorId,
        category: errorData.category,
        severity: errorData.severity
      });

      return errorId;
    }

    /**
     * Generate unique error ID based on error characteristics
     */
    generateErrorId(errorData) {
      const key = [
        errorData.name || 'Unknown',
        errorData.code || 'NO_CODE',
        errorData.namespace || 'global',
        (errorData.message || '').substring(0, 100)
      ].join('|');
      
      return this.hashString(key);
    }

    /**
     * Simple string hash function
     */
    hashString(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return Math.abs(hash).toString(36);
    }

    /**
     * Update error counts and metrics
     */
    updateCounts(errorId, trackedError) {
      const now = Date.now();
      const minuteKey = Math.floor(now / 60000); // Errors per minute
      
      // Update overall counts
      const count = this.errorCounts.get(errorId) || { total: 0, recent: [] };
      count.total++;
      count.recent.push(now);
      
      // Keep only recent errors (last hour)
      count.recent = count.recent.filter(t => now - t < 60 * 60 * 1000);
      
      this.errorCounts.set(errorId, count);
      
      // Update session counts
      const sessionId = trackedError.sessionId;
      if (sessionId) {
        const sessionCount = this.sessionErrors.get(sessionId) || 0;
        this.sessionErrors.set(sessionId, sessionCount + 1);
      }
      
      // Track performance impact
      if (trackedError.severity === 'high' || trackedError.severity === 'critical') {
        const impactKey = `${trackedError.category}-${minuteKey}`;
        const impact = this.performanceImpact.get(impactKey) || 0;
        this.performanceImpact.set(impactKey, impact + 1);
      }
    }

    /**
     * Check for alert conditions
     */
    checkAlerts(trackedError) {
      const errorId = trackedError.id;
      const count = this.errorCounts.get(errorId);
      
      if (count && count.recent.length >= this.reportingThreshold) {
        this.triggerAlert('high_error_rate', {
          errorId,
          count: count.recent.length,
          threshold: this.reportingThreshold,
          error: trackedError
        });
      }
      
      if (trackedError.severity === 'critical') {
        this.triggerAlert('critical_error', {
          errorId,
          error: trackedError
        });
      }
    }

    /**
     * Trigger error alert
     */
    triggerAlert(alertType, data) {
      this.log.warn(`Error alert: ${alertType}`, data);
      
      // Send alert to background script if possible
      try {
        if (global.chrome?.runtime?.sendMessage) {
          global.chrome.runtime.sendMessage({
            type: 'ERROR_ALERT',
            alertType,
            data,
            timestamp: Date.now()
          });
        }
      } catch (e) {
        // Ignore if messaging fails
      }
    }

    /**
     * Get error statistics
     */
    getStatistics(timeframe = 60 * 60 * 1000) { // Last hour by default
      const now = Date.now();
      const cutoff = now - timeframe;
      
      const recentErrors = this.errors.filter(e => e.timestamp >= cutoff);
      
      const stats = {
        total: recentErrors.length,
        byCategory: {},
        bySeverity: {},
        byNamespace: {},
        topErrors: [],
        errorRate: 0,
        timeframe,
        timestamp: now
      };

      // Calculate statistics
      recentErrors.forEach(error => {
        // By category
        const category = error.category || 'unknown';
        stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
        
        // By severity
        const severity = error.severity || 'medium';
        stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;
        
        // By namespace
        const namespace = error.namespace || 'global';
        stats.byNamespace[namespace] = (stats.byNamespace[namespace] || 0) + 1;
      });

      // Top errors by frequency
      const errorFrequency = new Map();
      for (const [errorId, count] of this.errorCounts) {
        const recentCount = count.recent.filter(t => t >= cutoff).length;
        if (recentCount > 0) {
          errorFrequency.set(errorId, recentCount);
        }
      }

      stats.topErrors = Array.from(errorFrequency.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([errorId, count]) => ({ errorId, count }));

      // Error rate (errors per minute)
      const minutes = timeframe / (60 * 1000);
      stats.errorRate = minutes > 0 ? stats.total / minutes : 0;

      return stats;
    }

    /**
     * Get error trends over time
     */
    getErrorTrends(periods = 24) { // Last 24 hours by default
      const now = Date.now();
      const periodDuration = 60 * 60 * 1000; // 1 hour periods
      const trends = [];

      for (let i = 0; i < periods; i++) {
        const periodEnd = now - (i * periodDuration);
        const periodStart = periodEnd - periodDuration;
        
        const periodErrors = this.errors.filter(e => 
          e.timestamp >= periodStart && e.timestamp < periodEnd
        );

        trends.unshift({
          period: i,
          start: periodStart,
          end: periodEnd,
          count: periodErrors.length,
          critical: periodErrors.filter(e => e.severity === 'critical').length,
          high: periodErrors.filter(e => e.severity === 'high').length
        });
      }

      return trends;
    }

    /**
     * Get session error summary
     */
    getSessionSummary(sessionId = null) {
      if (sessionId) {
        const sessionErrors = this.errors.filter(e => e.sessionId === sessionId);
        return {
          sessionId,
          errorCount: sessionErrors.length,
          errors: sessionErrors,
          duration: this.getSessionDuration(sessionId)
        };
      }

      // All sessions
      const sessions = {};
      for (const [sid, count] of this.sessionErrors) {
        sessions[sid] = {
          sessionId: sid,
          errorCount: count,
          duration: this.getSessionDuration(sid)
        };
      }

      return sessions;
    }

    /**
     * Start background analysis
     */
    startAnalysis() {
      if (this.analysisTimer) return;
      
      this.analysisTimer = setInterval(() => {
        if (!this.isAnalyzing) {
          this.runAnalysis().catch(error => {
            this.log.warn('Background analysis failed', { error: error.message });
          });
        }
      }, this.analysisInterval);
    }

    /**
     * Run error pattern analysis
     */
    async runAnalysis() {
      this.isAnalyzing = true;
      
      try {
        const stats = this.getStatistics();
        
        // Check for unusual patterns
        if (stats.errorRate > this.reportingThreshold) {
          this.triggerAlert('high_global_error_rate', {
            rate: stats.errorRate,
            threshold: this.reportingThreshold,
            stats
          });
        }

        // Check for error spikes
        const trends = this.getErrorTrends(6); // Last 6 hours
        const recentTrend = trends.slice(-3); // Last 3 hours
        const averageRecent = recentTrend.reduce((sum, t) => sum + t.count, 0) / recentTrend.length;
        const previousTrend = trends.slice(-6, -3); // Previous 3 hours
        const averagePrevious = previousTrend.reduce((sum, t) => sum + t.count, 0) / previousTrend.length;
        
        if (averageRecent > averagePrevious * 2) {
          this.triggerAlert('error_spike_detected', {
            recentAverage: averageRecent,
            previousAverage: averagePrevious,
            trends
          });
        }

        this.log.debug('Error analysis completed', {
          totalErrors: this.errors.length,
          errorRate: stats.errorRate,
          topCategories: Object.keys(stats.byCategory).slice(0, 3)
        });

      } catch (error) {
        this.log.warn('Error analysis failed', error);
      } finally {
        this.isAnalyzing = false;
      }
    }

    /**
     * Start cleanup process
     */
    startCleanup() {
      if (this.cleanupTimer) return;
      
      this.cleanupTimer = setInterval(() => {
        try {
          this.cleanup();
        } catch (error) {
          this.log.warn('Cleanup failed', { error: error.message });
        }
      }, 60 * 60 * 1000); // Every hour
    }

    /**
     * Clean up old errors
     */
    cleanup() {
      const now = Date.now();
      const cutoff = now - this.retentionPeriod;
      
      // Remove old errors
      const initialCount = this.errors.length;
      this.errors = this.errors.filter(e => e.timestamp >= cutoff);
      
      // Clean up counts
      for (const [errorId, count] of this.errorCounts) {
        count.recent = count.recent.filter(t => t >= cutoff);
        if (count.recent.length === 0) {
          this.errorCounts.delete(errorId);
        }
      }
      
      // Clean up performance impact data
      const hourAgo = Math.floor((now - 60 * 60 * 1000) / 60000);
      for (const [key] of this.performanceImpact) {
        const keyTime = parseInt(key.split('-').pop());
        if (keyTime < hourAgo) {
          this.performanceImpact.delete(key);
        }
      }

      const removedCount = initialCount - this.errors.length;
      if (removedCount > 0) {
        this.log.debug(`Cleaned up ${removedCount} old errors`);
      }
    }

    /**
     * Get current session ID
     */
    getSessionId() {
      if (!this._sessionId) {
        this._sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
      return this._sessionId;
    }

    /**
     * Get session duration
     */
    getSessionDuration(sessionId) {
      const sessionErrors = this.errors.filter(e => e.sessionId === sessionId);
      if (sessionErrors.length === 0) return 0;
      
      const earliest = Math.min(...sessionErrors.map(e => e.timestamp));
      const latest = Math.max(...sessionErrors.map(e => e.timestamp));
      
      return latest - earliest;
    }

    /**
     * Get execution context information
     */
    getExecutionContext() {
      return {
        userAgent: global.navigator?.userAgent || null,
        url: global.location?.href || null,
        timestamp: Date.now(),
        memoryUsage: this.getMemoryUsage(),
        isBackground: typeof global.chrome?.runtime?.getBackgroundPage !== 'undefined',
        isContentScript: typeof global.window !== 'undefined' && global.window !== global.parent,
        isServiceWorker: typeof global.importScripts === 'function' && typeof global.window === 'undefined'
      };
    }

    /**
     * Get memory usage information if available
     */
    getMemoryUsage() {
      try {
        if (global.performance?.memory) {
          return {
            used: global.performance.memory.usedJSHeapSize,
            total: global.performance.memory.totalJSHeapSize,
            limit: global.performance.memory.jsHeapSizeLimit
          };
        }
      } catch (e) {
        // Memory API not available
      }
      return null;
    }

    /**
     * Export error data for analysis
     */
    exportData(options = {}) {
      const timeframe = options.timeframe || 24 * 60 * 60 * 1000; // 24 hours
      const includeStackTraces = options.includeStackTraces || false;
      const now = Date.now();
      const cutoff = now - timeframe;
      
      const exportData = {
        metadata: {
          exportTime: now,
          timeframe,
          version: '1.0.0'
        },
        statistics: this.getStatistics(timeframe),
        trends: this.getErrorTrends(),
        errors: this.errors
          .filter(e => e.timestamp >= cutoff)
          .map(error => {
            const exported = { ...error };
            if (!includeStackTraces && exported.stack) {
              delete exported.stack;
            }
            return exported;
          })
      };

      return exportData;
    }

    /**
     * Stop tracking and cleanup
     */
    destroy() {
      if (this.analysisTimer) {
        clearInterval(this.analysisTimer);
        this.analysisTimer = null;
      }
      
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
      
      this.errors = [];
      this.errorCounts.clear();
      this.sessionErrors.clear();
      this.performanceImpact.clear();
      
      this.log.info('Error tracker destroyed');
    }
  }

  // Create global instance
  const tracker = new ErrorTracker();

  // Export the error tracking system
  const ErrorTrackerSystem = {
    ErrorTracker,
    
    // Global instance
    instance: tracker,
    
    // Convenience methods
    trackError: tracker.trackError.bind(tracker),
    getStatistics: tracker.getStatistics.bind(tracker),
    getErrorTrends: tracker.getErrorTrends.bind(tracker),
    getSessionSummary: tracker.getSessionSummary.bind(tracker),
    exportData: tracker.exportData.bind(tracker),
    
    __LOCKED__: true
  };

  // Attach to global scope
  try {
    global.ErrorTracker = ErrorTrackerSystem;
  } catch (e) {
    // Ignore if in restricted context
  }

  return ErrorTrackerSystem;

})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));