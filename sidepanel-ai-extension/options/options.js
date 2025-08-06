// options/options.js
// Logic for the options page with multiple API key management

const newApiKeyInput = document.getElementById('newApiKey');
const keyNameInput = document.getElementById('keyName');
const addKeyBtn = document.getElementById('addKeyBtn');
const keysListEl = document.getElementById('keysList');
const keyStatsEl = document.getElementById('keyStats');
const modelSelect = document.getElementById('modelSelect');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const validateAllBtn = document.getElementById('validateAllBtn');
const resetAllBtn = document.getElementById('resetAllBtn');
const validationStatusEl = document.getElementById('validationStatus');

let keyManager;

// Load settings when the options page is opened
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize API key manager
  keyManager = window.apiKeyManager;
  await keyManager.initialize();
  
  // Load model setting
  const { GEMINI_MODEL } = await chrome.storage.sync.get('GEMINI_MODEL');
  const model = GEMINI_MODEL || 'gemini-2.5-flash';
  if (modelSelect) {
    modelSelect.value = model;
  }

  // Render current keys and stats
  renderKeys();
  renderStats();
});

function renderKeys() {
  const keys = keyManager.getAllKeys();
  
  if (keys.length === 0) {
    keysListEl.innerHTML = '<p class="no-keys">No API keys configured. Add one above to get started.</p>';
    return;
  }

  keysListEl.innerHTML = keys.map((key, index) => `
    <div class="key-item ${key.isCurrent ? 'current' : ''} ${key.status === 'disabled' ? 'disabled' : ''}">
      <div class="key-info">
        <div class="key-header">
          <span class="key-name" contenteditable="true" data-index="${key.index}" onblur="updateKeyName(this)">${escapeHtml(key.name)}</span>
          <span class="key-preview">${key.keyPreview}</span>
          ${key.isCurrent ? '<span class="current-badge">CURRENT</span>' : ''}
        </div>
        <div class="key-meta">
          <span class="status status-${key.status}">${key.status.toUpperCase()}</span>
          ${key.consecutiveFailures > 0 ? `<span class="failures">${key.consecutiveFailures} failures</span>` : ''}
          ${key.lastUsed ? `<span class="last-used">Last used: ${formatDate(key.lastUsed)}</span>` : ''}
        </div>
      </div>
      <div class="key-actions">
        <button onclick="toggleKey(${key.index})" class="btn-sm ${key.status === 'disabled' ? 'btn-enable' : 'btn-disable'}">
          ${key.status === 'disabled' ? 'Enable' : 'Disable'}
        </button>
        <button onclick="removeKey(${key.index})" class="btn-sm btn-danger">Remove</button>
      </div>
    </div>
  `).join('');
}

function renderStats() {
  const stats = keyManager.getKeyStats();
  
  keyStatsEl.innerHTML = `
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-label">Total Keys</div>
        <div class="stat-value">${stats.total}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Active</div>
        <div class="stat-value">${stats.active}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Disabled</div>
        <div class="stat-value">${stats.disabled}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">In Cooldown</div>
        <div class="stat-value">${stats.cooldown}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">Current Key</div>
        <div class="stat-value">${stats.current}</div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

// Add new API key
addKeyBtn.addEventListener('click', async () => {
  const apiKey = newApiKeyInput.value.trim();
  const keyName = keyNameInput.value.trim();

  if (!apiKey) {
    showStatus('Please enter an API key.', 'error');
    return;
  }

  const success = keyManager.addKey(apiKey, keyName);
  
  if (success) {
    newApiKeyInput.value = '';
    keyNameInput.value = '';
    renderKeys();
    renderStats();
    showStatus('API key added successfully!', 'success');
  } else {
    if (keyManager.keys.length >= window.MessageTypes.API_KEY_ROTATION.MAX_KEYS) {
      showStatus(`Maximum of ${window.MessageTypes.API_KEY_ROTATION.MAX_KEYS} keys allowed.`, 'error');
    } else {
      showStatus('Key already exists or invalid.', 'error');
    }
  }
});

// Global functions for key management
window.updateKeyName = function(element) {
  const index = parseInt(element.dataset.index);
  const newName = element.textContent.trim();
  if (newName) {
    keyManager.updateKeyName(index, newName);
    showStatus('Key name updated', 'success');
  }
};

window.toggleKey = function(index) {
  keyManager.toggleKeyStatus(index);
  renderKeys();
  renderStats();
  showStatus('Key status updated', 'success');
};

window.removeKey = function(index) {
  if (confirm('Are you sure you want to remove this API key?')) {
    keyManager.removeKey(index);
    renderKeys();
    renderStats();
    showStatus('Key removed', 'success');
  }
};

// Save model settings
saveBtn.addEventListener('click', async () => {
  const model = modelSelect ? String(modelSelect.value || '').trim() : 'gemini-2.5-flash';
  
  await chrome.storage.sync.set({ 'GEMINI_MODEL': model });
  showStatus('Settings saved!', 'success');
});

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = type;
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = '';
  }, 3000);
}

// Key validation
validateAllBtn.addEventListener('click', async () => {
  validateAllBtn.disabled = true;
  validateAllBtn.textContent = 'Validating...';
  validationStatusEl.textContent = 'Starting validation...';
  validationStatusEl.className = 'validation-status running';

  try {
    const results = await keyManager.validateAllKeys();
    
    const successCount = results.filter(r => r.valid).length;
    const totalCount = results.length;
    
    validationStatusEl.textContent = `Validation complete: ${successCount}/${totalCount} keys valid`;
    validationStatusEl.className = successCount === totalCount ? 'validation-status success' : 'validation-status warning';

    // Show detailed results
    const details = results.map(r => 
      `${r.name}: ${r.valid ? '✓ Valid' : `✗ ${r.error || 'Invalid'}`}${r.skipped ? ' (skipped)' : ''}`
    ).join('\n');
    
    if (results.some(r => !r.valid)) {
      console.log('Validation details:\n' + details);
    }

    // Refresh displays
    renderKeys();
    renderStats();
    
    showStatus(`Validated ${totalCount} keys. ${successCount} valid, ${totalCount - successCount} invalid.`, 
      successCount === totalCount ? 'success' : 'warning');

  } catch (error) {
    validationStatusEl.textContent = `Validation failed: ${error.message}`;
    validationStatusEl.className = 'validation-status error';
    showStatus('Key validation failed: ' + error.message, 'error');
  }

  validateAllBtn.disabled = false;
  validateAllBtn.textContent = 'Validate All Keys';
});

// Reset all keys button
resetAllBtn.addEventListener('click', async () => {
  if (!confirm('This will reset all keys to active status and clear failure counts. Continue?')) {
    return;
  }

  resetAllBtn.disabled = true;
  resetAllBtn.textContent = 'Resetting...';
  validationStatusEl.textContent = 'Resetting all keys...';
  validationStatusEl.className = 'validation-status running';

  try {
    const wasUpdated = await keyManager.resetAllKeys();
    
    if (wasUpdated) {
      validationStatusEl.textContent = 'All keys reset to active status';
      validationStatusEl.className = 'validation-status success';
      showStatus('All keys have been reset to active status', 'success');
    } else {
      validationStatusEl.textContent = 'No keys needed resetting';
      validationStatusEl.className = 'validation-status info';
      showStatus('All keys were already in good status', 'info');
    }

    // Refresh displays
    renderKeys();
    renderStats();

  } catch (error) {
    validationStatusEl.textContent = `Reset failed: ${error.message}`;
    validationStatusEl.className = 'validation-status error';
    showStatus('Key reset failed: ' + error.message, 'error');
  }

  resetAllBtn.disabled = false;
  resetAllBtn.textContent = 'Reset All Keys';
});

// Auto-refresh stats periodically
setInterval(() => {
  if (keyManager.initialized) {
    renderStats();
  }
}, 10000); // Every 10 seconds