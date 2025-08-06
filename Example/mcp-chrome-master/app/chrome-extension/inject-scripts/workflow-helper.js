/* eslint-disable */
// workflow-helper.js
// Enhanced content script for workflow orchestration features
// Provides element state checking, condition evaluation, and workflow support

(function () {
  // Prevent re-initialization
  if (window.__WORKFLOW_HELPER_INITIALIZED__) {
    return;
  }
  window.__WORKFLOW_HELPER_INITIALIZED__ = true;

  console.log('Workflow helper initialized');

  /**
   * Check element state for workflow conditions
   */
  function checkElementState(selector, state, text) {
    try {
      const element = document.querySelector(selector);
      
      if (!element) {
        return { conditionMet: state === 'not_exists', element: null };
      }

      // Element exists
      if (state === 'exists') {
        return { conditionMet: true, element: getElementInfo(element) };
      }

      if (state === 'not_exists') {
        return { conditionMet: false, element: getElementInfo(element) };
      }

      // Check visibility
      if (state === 'visible') {
        const isVisible = isElementVisible(element);
        return { conditionMet: isVisible, element: getElementInfo(element) };
      }

      if (state === 'hidden') {
        const isVisible = isElementVisible(element);
        return { conditionMet: !isVisible, element: getElementInfo(element) };
      }

      // Check clickability
      if (state === 'clickable') {
        const isClickable = isElementClickable(element);
        return { conditionMet: isClickable, element: getElementInfo(element) };
      }

      // Check text content
      if (state === 'text_matches' && text) {
        const elementText = element.textContent || element.innerText || '';
        const textMatches = elementText.toLowerCase().includes(text.toLowerCase());
        return { 
          conditionMet: textMatches, 
          element: getElementInfo(element),
          elementText: elementText.trim()
        };
      }

      return { conditionMet: false, element: getElementInfo(element), error: 'Unknown state' };

    } catch (error) {
      console.error('Error checking element state:', error);
      return { conditionMet: false, error: error.message };
    }
  }

  /**
   * Check if element is visible
   */
  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Check if element is clickable
   */
  function isElementClickable(element) {
    if (!element || !element.isConnected) return false;
    
    // Check if element is disabled
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    // Check visibility
    if (!isElementVisible(element)) {
      return false;
    }

    // Check if element is behind another element
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const topElement = document.elementFromPoint(centerX, centerY);
    
    // Element is clickable if it's the top element or contains the top element
    return topElement === element || element.contains(topElement);
  }

  /**
   * Get element information
   */
  function getElementInfo(element) {
    if (!element) return null;

    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      textContent: (element.textContent || '').trim().substring(0, 100),
      visible: isElementVisible(element),
      clickable: isElementClickable(element),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left
      }
    };
  }

  /**
   * Wait for element to appear
   */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver((mutations) => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(element);
        }
      });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element not found within ${timeout}ms: ${selector}`));
      }, timeout);

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    });
  }

  /**
   * Wait for element to be removed
   */
  function waitForElementRemoved(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (!element) {
        resolve(true);
        return;
      }

      const observer = new MutationObserver((mutations) => {
        const element = document.querySelector(selector);
        if (!element) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(true);
        }
      });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element still present after ${timeout}ms: ${selector}`));
      }, timeout);

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    });
  }

  /**
   * Check network idle state
   */
  function isNetworkIdle() {
    // Simple heuristic: check if there are pending requests
    return new Promise(resolve => {
      let requestCount = 0;
      
      // Monitor fetch requests
      const originalFetch = window.fetch;
      window.fetch = function(...args) {
        requestCount++;
        return originalFetch.apply(this, args).finally(() => {
          requestCount--;
        });
      };

      // Monitor XMLHttpRequests
      const originalXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(...args) {
        requestCount++;
        this.addEventListener('loadend', () => {
          requestCount--;
        });
        return originalXHROpen.apply(this, args);
      };

      // Check idle state after a delay
      setTimeout(() => {
        resolve(requestCount === 0);
      }, 1000);
    });
  }

  /**
   * Evaluate custom conditions
   */
  function evaluateCondition(condition, variables = {}) {
    try {
      // Simple variable substitution
      let resolved = condition;
      for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        resolved = resolved.replace(regex, String(value));
      }

      // Basic evaluation - could be enhanced with a proper expression parser
      return eval(resolved);
    } catch (error) {
      console.error('Error evaluating condition:', error);
      return false;
    }
  }

  /**
   * Extract form data from current page
   */
  function extractFormData() {
    const forms = document.querySelectorAll('form');
    const formData = [];

    forms.forEach((form, formIndex) => {
      const fields = [];
      const inputs = form.querySelectorAll('input, select, textarea');
      
      inputs.forEach(input => {
        const field = {
          type: input.type || input.tagName.toLowerCase(),
          name: input.name,
          id: input.id,
          value: input.value,
          placeholder: input.placeholder,
          label: getFieldLabel(input),
          required: input.required,
          disabled: input.disabled
        };
        
        if (input.tagName.toLowerCase() === 'select') {
          field.options = Array.from(input.options).map(opt => ({
            value: opt.value,
            text: opt.text,
            selected: opt.selected
          }));
        }
        
        fields.push(field);
      });

      formData.push({
        formIndex,
        action: form.action,
        method: form.method,
        fields
      });
    });

    return formData;
  }

  /**
   * Get label for form field
   */
  function getFieldLabel(input) {
    // Check for explicit label
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label.textContent.trim();

    // Check for parent label
    const parentLabel = input.closest('label');
    if (parentLabel) return parentLabel.textContent.replace(input.value, '').trim();

    // Check for aria-label
    if (input.getAttribute('aria-label')) {
      return input.getAttribute('aria-label');
    }

    // Check for placeholder
    if (input.placeholder) {
      return input.placeholder;
    }

    // Check for nearby text
    const parent = input.parentElement;
    if (parent) {
      const textContent = parent.textContent.replace(input.value, '').trim();
      if (textContent.length > 0 && textContent.length < 50) {
        return textContent;
      }
    }

    return input.name || input.id || 'Unknown';
  }

  /**
   * Message listener for workflow commands
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      switch (message.action) {
        case 'check_element_state':
          const result = checkElementState(message.selector, message.state, message.text);
          sendResponse(result);
          break;

        case 'wait_for_element':
          waitForElement(message.selector, message.timeout)
            .then(element => sendResponse({ success: true, element: getElementInfo(element) }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true; // Keep message channel open for async response

        case 'wait_for_element_removed':
          waitForElementRemoved(message.selector, message.timeout)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;

        case 'is_network_idle':
          isNetworkIdle()
            .then(idle => sendResponse({ networkIdle: idle }))
            .catch(error => sendResponse({ networkIdle: false, error: error.message }));
          return true;

        case 'evaluate_condition':
          const conditionResult = evaluateCondition(message.condition, message.variables);
          sendResponse({ result: conditionResult });
          break;

        case 'extract_form_data':
          const formData = extractFormData();
          sendResponse({ formData });
          break;

        case 'workflow_helper_ping':
          sendResponse({ status: 'pong', helper: 'workflow' });
          break;

        default:
          console.log('Unknown workflow helper action:', message.action);
          sendResponse({ error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Workflow helper error:', error);
      sendResponse({ error: error.message });
    }
  });

  console.log('Workflow helper message listeners registered');

})();