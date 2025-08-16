// Sync Manager for AI Chrome Extension

(function initSyncManager(global) {
  if (global.SyncManager && global.SyncManager.__LOCKED__) return;

  class SyncManager {
    constructor(db) {
      this.db = db;
      this.isServiceWorker = typeof global.importScripts === 'function' && typeof global.window === 'undefined';
      this.isContentScript = typeof global.window !== 'undefined' && global.window !== global.parent;
      this.isWebPage = typeof global.navigator !== 'undefined' && !this.isServiceWorker && !this.isContentScript;
    }

    register() {
      // Only register background sync if we're in a web page context with service worker support
      if (this.isWebPage && global.navigator?.serviceWorker) {
        global.navigator.serviceWorker.ready
          .then(registration => {
            if (registration.sync) {
              return registration.sync.register('sync-ai-actions');
            } else {
              console.warn('[SyncManager] Background Sync API not available');
            }
          })
          .catch(error => {
            console.warn('[SyncManager] Failed to register background sync:', error);
          });
      } else if (this.isServiceWorker) {
        // In service worker context, we handle sync events directly
        this.setupServiceWorkerSync();
      } else {
        console.warn('[SyncManager] Service Worker API not available in this context');
      }
    }

    setupServiceWorkerSync() {
      if (typeof global.addEventListener === 'function') {
        global.addEventListener('sync', (event) => {
          if (event.tag === 'sync-ai-actions') {
            event.waitUntil(this.sync());
          }
        });
      }
    }

    async sync() {
      try {
        if (!this.db) {
          console.warn('[SyncManager] Database not available for sync');
          return;
        }
        
        const actions = await this.db.getAll();
        console.log('[SyncManager] Syncing actions:', actions.length);
        
        // TODO: Implement actual sync logic with server
        // For now, just log the actions
        
        return actions;
      } catch (error) {
        console.error('[SyncManager] Sync failed:', error);
        throw error;
      }
    }

    // Check if background sync is supported
    isBackgroundSyncSupported() {
      if (this.isServiceWorker) {
        return typeof global.registration?.sync !== 'undefined';
      } else if (this.isWebPage) {
        return 'serviceWorker' in global.navigator && 'sync' in global.ServiceWorkerRegistration.prototype;
      }
      return false;
    }

    // Get sync status
    getStatus() {
      return {
        isServiceWorker: this.isServiceWorker,
        isContentScript: this.isContentScript,
        isWebPage: this.isWebPage,
        backgroundSyncSupported: this.isBackgroundSyncSupported(),
        hasDatabase: !!this.db
      };
    }
  }

  // Export for different module systems
  try {
    global.SyncManager = SyncManager;
  } catch (e) {
    // Ignore if in restricted context
  }

  // For CommonJS compatibility
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SyncManager;
  }

  // Mark as initialized
  if (global.SyncManager) {
    global.SyncManager.__LOCKED__ = true;
  }

  return SyncManager;

})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : window));