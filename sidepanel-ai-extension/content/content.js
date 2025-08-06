// content/content.js
// Content script for full browser automation and page interaction

// Guard against multiple executions (manifest + dynamic injection)
(function() {
  if (typeof window.__CONTENT_SCRIPT_LOADED__ !== 'undefined') {
    // Already loaded, exit early
    return;
  }
  window.__CONTENT_SCRIPT_LOADED__ = true;

  // Pull centralized message constants from global if available; fallback to literals
  const MT = (typeof window !== 'undefined' ? window.MessageTypes : undefined) || {};
  const MSG = MT.MSG || {
    EXTRACT_PAGE_TEXT: "EXTRACT_PAGE_TEXT",
    CLICK_SELECTOR: "CLICK_SELECTOR",
    FILL_SELECTOR: "FILL_SELECTOR",
    SCROLL_TO_SELECTOR: "SCROLL_TO_SELECTOR",
    WAIT_FOR_SELECTOR: "WAIT_FOR_SELECTOR",
    GET_PAGE_INFO: "GET_PAGE_INFO",
    GET_INTERACTIVE_ELEMENTS: "GET_INTERACTIVE_ELEMENTS"
  };

function getPageText(maxChars = 20000) {
  // A simple text extraction. A more robust solution would handle invisible elements, etc.
  return document.body.innerText.trim().slice(0, maxChars);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // Validate message shape early to avoid "undefined" type logs
      if (!message || typeof message.type === 'undefined') {
        console.warn("[ContentScript] Received message without type:", JSON.stringify(message || {}));
        sendResponse({ ok: false, error: "Unknown message type in content script: undefined" });
        return;
      }

      switch (message.type) {
        case MSG.EXTRACT_PAGE_TEXT: {
          const text = getPageText(message.maxChars);
          sendResponse({ ok: true, text });
          break;
        }
        case MSG.CLICK_SELECTOR: {
          handleClickSelector(message, sendResponse);
          break;
        }
        case MSG.FILL_SELECTOR: {
          handleFillSelector(message, sendResponse);
          break;
        }
        case MSG.SCROLL_TO_SELECTOR: {
          handleScrollToSelector(message, sendResponse);
          break;
        }
        case MSG.WAIT_FOR_SELECTOR: {
          handleWaitForSelector(message, sendResponse);
          break;
        }
        case MSG.GET_PAGE_INFO: {
          handleGetPageInfo(message, sendResponse);
          break;
        }
        case MSG.GET_INTERACTIVE_ELEMENTS: {
          handleGetInteractiveElements(message, sendResponse);
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type in content script: " + message.type });
      }
    } catch (err) {
      console.error("[ContentScript] Error:", err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // Keep message channel open for async response
});

function handleClickSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }

    const element = document.querySelector(selector);
    if (!element) {
      return sendResponse({ ok: false, error: `Element not found: ${selector}` });
    }

    // Check if element is visible and clickable
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return sendResponse({ ok: false, error: `Element not visible: ${selector}` });
    }

    // Scroll element into view if needed
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Wait a bit for scroll to complete, then click
    setTimeout(() => {
      try {
        element.click();
        sendResponse({ ok: true, msg: `Clicked element: ${selector}` });
      } catch (clickError) {
        sendResponse({ ok: false, error: `Click failed: ${clickError.message}` });
      }
    }, 500);

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleFillSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    const value = message.value || "";
    
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }

    const element = document.querySelector(selector);
    if (!element) {
      return sendResponse({ ok: false, error: `Element not found: ${selector}` });
    }

    // Check if it's an input element
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) {
      return sendResponse({ ok: false, error: `Element is not fillable: ${selector}` });
    }

    // Focus the element
    element.focus();
    
    // Clear existing value
    element.value = "";
    
    // Set new value
    element.value = value;
    
    // Trigger input events to notify the page
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    
    sendResponse({ ok: true, msg: `Filled element ${selector} with: ${value}` });

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleScrollToSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    const direction = message.direction;

    if (selector) {
      const element = document.querySelector(selector);
      if (!element) {
        return sendResponse({ ok: false, error: `Element not found: ${selector}` });
      }
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sendResponse({ ok: true, msg: `Scrolled to element: ${selector}` });
    } else if (direction) {
      const amountPx = message.amountPx || 600;
      switch (direction.toLowerCase()) {
        case 'up':
          window.scrollBy({ top: -amountPx, behavior: 'smooth' });
          sendResponse({ ok: true, msg: `Scrolled up by ${amountPx}px` });
          break;
        case 'down':
          window.scrollBy({ top: amountPx, behavior: 'smooth' });
          sendResponse({ ok: true, msg: `Scrolled down by ${amountPx}px` });
          break;
        case 'top':
          window.scrollTo({ top: 0, behavior: 'smooth' });
          sendResponse({ ok: true, msg: "Scrolled to top" });
          break;
        case 'bottom':
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          sendResponse({ ok: true, msg: "Scrolled to bottom" });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown scroll direction: ${direction}. Use 'up', 'down', 'top', or 'bottom'` });
      }
    } else {
      sendResponse({ ok: false, error: "No selector or direction provided" });
    }

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleWaitForSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    const timeoutMs = message.timeoutMs || 5000;
    
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }

    const startTime = Date.now();
    
    function checkElement() {
      const element = document.querySelector(selector);
      if (element) {
        sendResponse({ ok: true, msg: `Element found: ${selector}` });
        return;
      }
      
      if (Date.now() - startTime > timeoutMs) {
        sendResponse({ ok: false, error: `Timeout waiting for element: ${selector}` });
        return;
      }
      
      setTimeout(checkElement, 100);
    }
    
    checkElement();

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleGetPageInfo(message, sendResponse) {
  try {
    const info = {
      title: document.title,
      url: window.location.href,
      domain: window.location.hostname,
      visibleText: document.body.innerText.substring(0, 1000) + "...",
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 10).map(a => ({
        text: a.textContent.trim(),
        href: a.href
      })),
      forms: Array.from(document.querySelectorAll('form')).length,
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).length
    };
    
    sendResponse({ ok: true, info });

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleGetInteractiveElements(message, sendResponse) {
  try {
    const elements = [];
    const seenElements = new Set();

    function processElement(el, type) {
        if (seenElements.has(el) || elements.length >= 25) return;

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) { // Only visible elements
            const common = {
                tag: el.tagName.toLowerCase(),
                selector: generateSelector(el),
                text: (el.textContent || el.innerText || "").trim().substring(0, 80),
                ariaLabel: el.getAttribute('aria-label') || '',
                position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
            };

            if (type === 'clickable') {
                elements.push({
                    type: 'clickable',
                    ...common,
                });
            } else if (type === 'input') {
                elements.push({
                    type: 'input',
                    ...common,
                    inputType: el.type || 'text',
                    placeholder: el.placeholder || '',
                    name: el.name || '',
                    value: el.value || '',
                });
            }
            seenElements.add(el);
        }
    }

    // Get clickable elements first
    const clickableSelectors = 'a, button, [onclick], [role="button"], input[type="submit"], input[type="button"], [tabindex]';
    document.querySelectorAll(clickableSelectors).forEach(el => processElement(el, 'clickable'));
    
    // Then get input elements
    const inputSelectors = 'input:not([type="submit"]):not([type="button"]), textarea, select';
    document.querySelectorAll(inputSelectors).forEach(el => processElement(el, 'input'));
    
    sendResponse({ ok: true, elements });

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function generateSelector(element) {
  if (!element) return "";

  // 1. Prefer ID if it exists and is reasonably simple
  if (element.id && !/^\d+$/.test(element.id)) {
    const idSelector = `#${CSS.escape(element.id)}`;
    try {
      if (document.querySelector(idSelector) === element) {
        return idSelector;
      }
    } catch (e) { /* ignore invalid selector */ }
  }

  // 2. Use a combination of data attributes or other unique identifiers
  const uniqueAttrs = ['data-testid', 'data-cy', 'name', 'aria-label', 'placeholder'];
  for (const attr of uniqueAttrs) {
    const attrValue = element.getAttribute(attr);
    if (attrValue) {
      const attrSelector = `[${attr}="${CSS.escape(attrValue)}"]`;
      const combinedSelector = element.tagName.toLowerCase() + attrSelector;
      try {
        if (document.querySelector(combinedSelector) === element) {
          return combinedSelector;
        }
      } catch(e) { /* ignore invalid selector */ }
    }
  }

  // 3. Class names (more carefully)
  if (element.className && typeof element.className === 'string') {
    const stableClasses = element.className.split(' ')
      .filter(c => c.trim() && isNaN(c) && !/^(is-|has-|js-)/.test(c));
    if (stableClasses.length > 0) {
      const classSelector = `.${stableClasses.map(c => CSS.escape(c)).join('.')}`;
      const combinedSelector = element.tagName.toLowerCase() + classSelector;
      try {
        const matches = document.querySelectorAll(combinedSelector);
        if (matches.length === 1 && matches === element) {
          return combinedSelector;
        }
      } catch (e) { /* ignore invalid selector */ }
    }
  }

  // 4. Fallback to path with attributes
  let path = '';
  let current = element;
  while (current && current.tagName !== 'BODY') {
    let segment = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) break;

    const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
    if (siblings.length > 1) {
      const index = siblings.indexOf(current) + 1;
      segment += `:nth-of-type(${index})`;
    }
    
    path = segment + (path ? ' > ' + path : '');
    
    try {
        if (document.querySelector(path) === element) {
            return path;
        }
    } catch(e) { break; }

    current = parent;
  }

  return path || element.tagName.toLowerCase(); // Final fallback
}

})(); // End of IIFE guard