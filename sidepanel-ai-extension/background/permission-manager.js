// background/permission-manager.js
(function (global) {
  'use strict';

  // Capability Registry to define risky actions
  const CapabilityRegistry = {
    'click_element': { risky: true },
    'type_text': { risky: true },
    'select_option': { risky: true },
    // Canonical navigation tool
    'navigate': { risky: true, crossOrigin: true },
    // Back-compat alias (to be removed after schema/tooling migration)
    'goto_url': { risky: true, crossOrigin: true },
    'close_tab': { risky: true },
    'download_link': { risky: true },
    'set_cookie': { risky: true },
    // Non-risky actions
    'wait_for_selector': { risky: false },
    'scroll_to': { risky: false },
    'take_screenshot': { risky: false },
    'create_tab': { risky: false },
    'switch_tab': { risky: false },
    'read_page_content': { risky: false },
    'scrape': { risky: false },
    'think': { risky: false },
    'tabs.query': { risky: false },
    'record_finding': { risky: false },
  };

  class PermissionManager {
    constructor(storage) {
      this.storage = storage;
      this.pendingRequests = new Map(); // correlationId -> { resolve, reject }
    }

    async hasPermission(tabId, action) {
      const { tool } = action || {};
      const capability = CapabilityRegistry[tool];

      // Non-risky actions: always allowed
      if (!capability || !capability.risky) {
        return { granted: true };
      }

      // Determine origin safely (may be chrome:// or restricted)
      let origin = 'unknown';
      try {
        const tab = await chrome.tabs.get(tabId);
        try {
          origin = new URL(tab.url).origin;
        } catch (_) {
          origin = 'unknown';
        }
      } catch (_) {
        // ignore inability to read tab
      }

      // Full-auto mode: auto-grant all risky actions, no user prompt
      try {
        global.emitAgentLog?.(tabId, {
          level: global.MessageTypes?.LOG_LEVELS?.INFO,
          msg: "Permission auto-granted",
          tool,
          origin,
          autoGrant: true
        });
      } catch (_) {}

      // Mirror legacy "remember for 24h" behavior to keep downstream logic simple
      try {
        const permissionKey = `permission_${origin}_${tool}`;
        const expiry = Date.now() + (24 * 60 * 60 * 1000);
        await this.storage.set(permissionKey, { granted: true, expires: expiry, autoGrant: true });
      } catch (_) {
        // non-fatal
      }

      return { granted: true };
    }

    async requestPermission(tabId, origin, tool, action) {
      const correlationId = `perm_${tabId}_${Date.now()}`;

      return new Promise((resolve, reject) => {
        this.pendingRequests.set(correlationId, { resolve, reject });

        chrome.runtime.sendMessage({
          type: global.MessageTypes?.MSG?.AGENT_PERMISSION_REQUEST,
          tabId,
          payload: {
            correlationId,
            origin,
            tool,
            params: action?.params,
            rationale: action?.rationale,
          }
        }).catch(err => {
          this.pendingRequests.delete(correlationId);
          reject(new Error(`Failed to send permission request: ${err.message}`));
        });

        // Timeout for the permission request
        setTimeout(() => {
          if (this.pendingRequests.has(correlationId)) {
            this.pendingRequests.delete(correlationId);
            reject(new Error('Permission request timed out.'));
          }
        }, 60000); // 60 second timeout
      });
    }

    async handlePermissionDecision(decision) {
      const { correlationId, granted, remember, origin, tool } = decision || {};
      const request = this.pendingRequests.get(correlationId);

      if (!request) {
        console.warn(`No pending permission request found for correlationId: ${correlationId}`);
        return;
      }

      this.pendingRequests.delete(correlationId);

      if (granted) {
        if (remember) {
          const permissionKey = `permission_${origin}_${tool}`;
          const expiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
          await this.storage.set(permissionKey, { granted: true, expires: expiry });
        }
        request.resolve({ granted: true });
      } else {
        request.reject(new Error('Permission denied by user.'));
      }
    }
  }

  // Expose globals for classic script usage
  global.CapabilityRegistry = CapabilityRegistry;
  global.PermissionManager = PermissionManager;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));