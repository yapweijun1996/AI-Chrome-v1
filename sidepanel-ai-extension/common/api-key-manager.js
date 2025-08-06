// common/api-key-manager.js
// API key rotation and health management system
// Idempotent, classic-script safe. Pulls constants from globalThis.MessageTypes without redeclaration
// and exposes a single global singleton apiKeyManager.

(function initApiKeyManager(global) {
  // If already initialized, do nothing to avoid redefinition in importScripts
  if (global.apiKeyManager && global.__API_KEY_MANAGER_LOCKED__) {
    return;
  }

  // Load constants from shared namespace
  const MT = (typeof global.MessageTypes !== 'undefined') ? global.MessageTypes : {};
  const API_KEY_ROTATION = MT.API_KEY_ROTATION || {
    MAX_KEYS: 10,
    RETRY_DELAY_MS: 1000,
    KEY_COOLDOWN_MS: 300000,
    MAX_CONSECUTIVE_FAILURES: 3,
    HEALTH_CHECK_INTERVAL_MS: 60000
  };
  const ERROR_TYPES = MT.ERROR_TYPES || {
    AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR"
  };
  const LOG_LEVELS = MT.LOG_LEVELS || {
    ERROR: "error", WARN: "warn", INFO: "info", DEBUG: "debug"
  };

  class ApiKeyManager {
  constructor() {
    this.keys = []; // Array of { key, name, status, consecutiveFailures, lastFailure, lastUsed }
    this.currentIndex = 0;
    this.healthCheckInterval = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    try {
      // Load API keys from storage
      const result = await chrome.storage.sync.get(['GEMINI_API_KEYS', 'GEMINI_API_KEY']);
      
      // Handle legacy single key migration
      if (result.GEMINI_API_KEY && !result.GEMINI_API_KEYS) {
        this.keys = [{
          key: result.GEMINI_API_KEY,
          name: 'Primary Key',
          status: 'active',
          consecutiveFailures: 0,
          lastFailure: null,
          lastUsed: null
        }];
        await this.saveKeys();
      } else if (result.GEMINI_API_KEYS) {
        this.keys = result.GEMINI_API_KEYS;
      }

      // Find first active key
      this.currentIndex = this.keys.findIndex(k => k.status === 'active');
      if (this.currentIndex === -1) this.currentIndex = 0;

      this.initialized = true;
      this.startHealthCheck();
    } catch (error) {
      console.error('[API Key Manager] Initialization failed:', error);
    }
  }

  async saveKeys() {
    try {
      await chrome.storage.sync.set({ 'GEMINI_API_KEYS': this.keys });
      
      // Also update legacy key for backward compatibility
      const activeKey = this.getCurrentKey();
      if (activeKey) {
        await chrome.storage.sync.set({ 'GEMINI_API_KEY': activeKey.key });
      }
    } catch (error) {
      console.error('[API Key Manager] Failed to save keys:', error);
    }
  }

  addKey(key, name = '') {
    if (!key || typeof key !== 'string') return false;
    if (this.keys.length >= API_KEY_ROTATION.MAX_KEYS) return false;
    if (this.keys.some(k => k.key === key)) return false; // Duplicate

    const keyObj = {
      key: key.trim(),
      name: name.trim() || `Key ${this.keys.length + 1}`,
      status: 'active',
      consecutiveFailures: 0,
      lastFailure: null,
      lastUsed: null
    };

    this.keys.push(keyObj);
    this.saveKeys();
    return true;
  }

  removeKey(index) {
    if (index < 0 || index >= this.keys.length) return false;
    
    this.keys.splice(index, 1);
    
    // Adjust current index if needed
    if (this.currentIndex >= this.keys.length) {
      this.currentIndex = Math.max(0, this.keys.length - 1);
    }
    
    this.saveKeys();
    return true;
  }

  getCurrentKey() {
    if (this.keys.length === 0) return null;
    
    // Find next available key starting from current index
    for (let i = 0; i < this.keys.length; i++) {
      const index = (this.currentIndex + i) % this.keys.length;
      const key = this.keys[index];
      
      if (this.isKeyAvailable(key)) {
        this.currentIndex = index;
        return key;
      }
    }
    
    return null; // No available keys
  }

  isKeyAvailable(key) {
    if (!key) return false;
    if (key.status === 'disabled') return false;

    // If status drifted but no failure metadata, treat as active
    if (key.status === 'cooldown' && (!key.lastFailure || !Number.isFinite(key.lastFailure))) {
      key.status = 'active';
      key.consecutiveFailures = 0;
      return true;
    }
    
    // Check if key is in cooldown after failures
    if (key.lastFailure && (key.consecutiveFailures || 0) >= API_KEY_ROTATION.MAX_CONSECUTIVE_FAILURES) {
      const cooldownEnd = key.lastFailure + API_KEY_ROTATION.KEY_COOLDOWN_MS;
      if (Date.now() < cooldownEnd) {
        return false;
      } else {
        // Reset after cooldown window
        key.consecutiveFailures = 0;
        key.status = 'active';
        key.lastFailure = null;
        return true;
      }
    }
    
    return key.status === 'active';
  }

  async rotateToNextKey(errorType = null) {
    const currentKey = this.keys[this.currentIndex];
    
    if (currentKey) {
      // Mark current key as failed
      currentKey.consecutiveFailures++;
      currentKey.lastFailure = Date.now();
      
      // Determine if this is a permanent failure
      const permanentErrors = [
        ERROR_TYPES.AUTHENTICATION_ERROR,
        'API_KEY_INVALID',
        'INVALID_API_KEY'
      ];
      
      if (permanentErrors.some(e => errorType?.includes(e))) {
        currentKey.status = 'disabled';
        console.log(`[API Key Manager] Key disabled due to authentication error: ${currentKey.name}`);
      } else if (currentKey.consecutiveFailures >= API_KEY_ROTATION.MAX_CONSECUTIVE_FAILURES) {
        currentKey.status = 'cooldown';
        console.log(`[API Key Manager] Key in cooldown: ${currentKey.name}`);
      }
    }

    // Find next available key
    const originalIndex = this.currentIndex;
    for (let i = 1; i < this.keys.length; i++) {
      const nextIndex = (this.currentIndex + i) % this.keys.length;
      const nextKey = this.keys[nextIndex];
      
      if (this.isKeyAvailable(nextKey)) {
        this.currentIndex = nextIndex;
        console.log(`[API Key Manager] Rotated to key: ${nextKey.name}`);
        await this.saveKeys();
        return nextKey;
      }
    }

    // No available keys found
    console.warn('[API Key Manager] No available API keys for rotation');
    await this.saveKeys();
    return null;
  }

  markKeySuccess() {
    const currentKey = this.keys[this.currentIndex];
    if (currentKey) {
      currentKey.consecutiveFailures = 0;
      currentKey.lastUsed = Date.now();
      if (currentKey.status === 'cooldown') {
        currentKey.status = 'active';
      }
      this.saveKeys();
    }
  }

  getKeyStats() {
    return {
      total: this.keys.length,
      active: this.keys.filter(k => k.status === 'active').length,
      disabled: this.keys.filter(k => k.status === 'disabled').length,
      cooldown: this.keys.filter(k => k.status === 'cooldown').length,
      current: this.keys[this.currentIndex]?.name || 'None'
    };
  }

  getAllKeys() {
    return this.keys.map((key, index) => ({
      index,
      name: key.name,
      status: key.status,
      consecutiveFailures: key.consecutiveFailures,
      lastFailure: key.lastFailure,
      lastUsed: key.lastUsed,
      isCurrent: index === this.currentIndex,
      // Don't expose the actual key for security
      keyPreview: key.key ? `${key.key.substring(0, 8)}...` : ''
    }));
  }

  updateKeyName(index, newName) {
    if (index >= 0 && index < this.keys.length) {
      this.keys[index].name = newName.trim();
      this.saveKeys();
      return true;
    }
    return false;
  }

  toggleKeyStatus(index) {
    if (index >= 0 && index < this.keys.length) {
      const key = this.keys[index];
      key.status = key.status === 'disabled' ? 'active' : 'disabled';
      
      // Reset failure count when re-enabling
      if (key.status === 'active') {
        key.consecutiveFailures = 0;
      }
      
      this.saveKeys();
      return true;
    }
    return false;
  }

  startHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, API_KEY_ROTATION.HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async performHealthCheck() {
    // Reset keys that have been in cooldown long enough
    let updated = false;
    
    for (const key of this.keys) {
      if (key.status === 'cooldown' && key.lastFailure) {
        const cooldownEnd = key.lastFailure + API_KEY_ROTATION.KEY_COOLDOWN_MS;
        if (Date.now() >= cooldownEnd) {
          key.status = 'active';
          key.consecutiveFailures = 0;
          key.lastFailure = null;
          console.log(`[API Key Manager] Key restored from cooldown: ${key.name}`);
          updated = true;
        }
      }
    }

    if (updated) {
      await this.saveKeys();
    }
  }

  // Manual recovery method for stuck keys
  async resetAllKeys() {
    console.log('[API Key Manager] Manually resetting all keys to active status');
    let updated = false;
    
    for (const key of this.keys) {
      if (key.status === 'cooldown' || key.consecutiveFailures > 0) {
        key.status = 'active';
        key.consecutiveFailures = 0;
        key.lastFailure = null;
        updated = true;
        console.log(`[API Key Manager] Reset key: ${key.name}`);
      }
    }
    
    if (updated) {
      await this.saveKeys();
    }
    
    return updated;
  }

  // Validate a single API key by making a test call
  async validateKey(keyObj) {
    if (!keyObj || !keyObj.key) return { valid: false, error: 'Invalid key object' };

    try {
      // Resolve API call function from global first (service worker safe), fallback to window
      const g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));
      const callFn = g.callGeminiGenerateText || (typeof window !== 'undefined' ? window.callGeminiGenerateText : null);
      if (typeof callFn !== 'function') {
        return { valid: false, error: 'API function not available in worker context' };
      }

      // Load selected model from sync storage with safe default
      let selectedModel = 'gemini-2.5-flash';
      try {
        const { GEMINI_MODEL } = await chrome.storage.sync.get('GEMINI_MODEL');
        if (GEMINI_MODEL) selectedModel = GEMINI_MODEL;
      } catch (_) {
        // ignore storage errors; keep default
      }

      // Minimal test prompt; wrapper may ignore token options
      const testPrompt = 'ping';
      const result = await callFn(keyObj.key, testPrompt, { model: selectedModel });

      if (result?.ok) {
        return { valid: true };
      }

      const errText = String(result?.error || '').toLowerCase();
      if (/permission|unauthorized|api key|invalid|forbidden/.test(errText)) {
        return { valid: false, error: result?.error || 'Authentication error', errorType: ERROR_TYPES.AUTHENTICATION_ERROR };
      }
      return { valid: false, error: result?.error || 'Test call failed' };
    } catch (error) {
      const msg = error && (error.message || String(error));
      const low = String(msg || '').toLowerCase();
      if (/permission|unauthorized|api key|invalid|forbidden/.test(low)) {
        return { valid: false, error: msg || 'Authentication error', errorType: ERROR_TYPES.AUTHENTICATION_ERROR };
      }
      return { valid: false, error: msg || 'Validation error' };
    }
  }

  // Validate all keys and update their status
  async validateAllKeys() {
    console.log('[API Key Manager] Starting validation of all keys...');
    const results = [];
    
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i];

      // Skip if there is no key material
      if (!key?.key) {
        results.push({ index: i, name: key?.name || `Key ${i+1}`, valid: false, error: 'Empty key' });
        continue;
      }
      
      // Skip recently validated active keys to save quota
      if (key.status === 'active' && key.lastUsed &&
          (Date.now() - key.lastUsed) < API_KEY_ROTATION.HEALTH_CHECK_INTERVAL_MS) {
        results.push({ index: i, name: key.name, valid: true, skipped: true });
        continue;
      }

      console.log(`[API Key Manager] Validating key: ${key.name}...`);
      const validation = await this.validateKey(key);
      
      if (validation.valid) {
        // success path: reset counters and ensure active
        key.consecutiveFailures = 0;
        key.status = 'active';
        key.lastUsed = Date.now();
        key.lastFailure = null;
        console.log(`[API Key Manager] Key validated OK: ${key.name}`);
      } else {
        // Only update failure status if validation actually ran (not just "API function not available")
        if (validation.error !== 'API function not available in worker context' &&
            validation.error !== 'API function not available') {
          
          // classify and mutate status accordingly
          const errorText = (validation.error || '').toLowerCase();
          const isPermanent = validation.errorType === ERROR_TYPES.AUTHENTICATION_ERROR ||
                              /invalid|authentication|unauthorized|forbidden|api key/.test(errorText);

          if (isPermanent) {
            key.status = 'disabled';
            console.log(`[API Key Manager] Key disabled due to authentication error: ${key.name} - ${validation.error}`);
          } else {
            // Only increment failures for actual API errors, not system errors
            key.consecutiveFailures = (key.consecutiveFailures || 0) + 1;
            if (key.consecutiveFailures >= API_KEY_ROTATION.MAX_CONSECUTIVE_FAILURES) {
              key.status = 'cooldown';
              key.lastFailure = Date.now();
              console.log(`[API Key Manager] Key put in cooldown: ${key.name}`);
            }
          }
        } else {
          console.log(`[API Key Manager] Skipping failure increment for system error: ${key.name} - ${validation.error}`);
        }
      }

      results.push({
        index: i,
        name: key.name,
        valid: !!validation.valid,
        error: validation.error,
        errorType: validation.errorType
      });

      // Small delay between validations to be respectful
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    await this.saveKeys();
    console.log(`[API Key Manager] Validation complete. Results:`, results);
    return results;
  }

  // Get validation status for a specific key
  getKeyValidationStatus(index) {
    if (index < 0 || index >= this.keys.length) return null;
    
    const key = this.keys[index];
    return {
      name: key.name,
      status: key.status,
      consecutiveFailures: key.consecutiveFailures,
      lastUsed: key.lastUsed,
      lastFailure: key.lastFailure,
      needsValidation: !key.lastUsed || (Date.now() - key.lastUsed) > API_KEY_ROTATION.HEALTH_CHECK_INTERVAL_MS
    };
  }

  destroy() {
    this.stopHealthCheck();
    this.keys = [];
    this.currentIndex = 0;
    this.initialized = false;
  }
}

  // Create or reuse singleton instance
  const apiKeyManager = global.apiKeyManager instanceof ApiKeyManager
    ? global.apiKeyManager
    : new ApiKeyManager();

  // Attach to appropriate global and lock to prevent redefinition
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ApiKeyManager, apiKeyManager };
  }
  if (typeof window !== 'undefined') {
    window.apiKeyManager = apiKeyManager;
  }
  global.apiKeyManager = apiKeyManager;
  global.__API_KEY_MANAGER_LOCKED__ = true;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));