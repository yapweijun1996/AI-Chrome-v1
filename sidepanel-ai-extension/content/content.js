// content/content.js
// Content script for full browser automation and page interaction

// Guard against multiple executions (manifest + dynamic injection)
(function() {
  if (typeof window.__CONTENT_SCRIPT_LOADED__ !== 'undefined') {
    // Already loaded, exit early
    return;
  }
  window.__CONTENT_SCRIPT_LOADED__ = true;

  // Inject the CSS for animations
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = chrome.runtime.getURL('content/content.css');
    (document.head || document.documentElement).appendChild(link);
  } catch (e) {
    console.warn("Failed to inject content.css:", e);
  }

  // Pull centralized message constants from global if available; fallback to literals
  const MT = (typeof window !== 'undefined' ? window.MessageTypes : undefined) || {};
  const MSG = MT.MSG || {
    EXTRACT_PAGE_TEXT: "EXTRACT_PAGE_TEXT",
    CLICK_SELECTOR: "CLICK_SELECTOR",
    FILL_SELECTOR: "FILL_SELECTOR",
    SCROLL_TO_SELECTOR: "SCROLL_TO_SELECTOR",
    WAIT_FOR_SELECTOR: "WAIT_FOR_SELECTOR",
    GET_PAGE_INFO: "GET_PAGE_INFO",
    GET_INTERACTIVE_ELEMENTS: "GET_INTERACTIVE_ELEMENTS",
    GET_ELEMENT_MAP: "GET_ELEMENT_MAP",
    EXTRACT_STRUCTURED_CONTENT: "EXTRACT_STRUCTURED_CONTENT",
    ANALYZE_PAGE_URLS: "ANALYZE_PAGE_URLS",
    FETCH_URL_CONTENT: "FETCH_URL_CONTENT",
    GET_PAGE_LINKS: "GET_PAGE_LINKS",
    SCRAPE_SELECTOR: "SCRAPE_SELECTOR",
    SETTLE: "SETTLE",
    CHECK_SELECTOR: "CHECK_SELECTOR",
    // Advanced interaction types
    UPLOAD_FILE: "UPLOAD_FILE",
    FILL_FORM: "FILL_FORM",
    SELECT_OPTION: "SELECT_OPTION",
    DRAG_AND_DROP: "DRAG_AND_DROP",
    GET_DOM_STATE: "GET_DOM_STATE",
    // Debug overlay (fallback constants if common/messages.js isn't loaded yet)
    DEBUG_SHOW_OVERLAY: "DEBUG_SHOW_OVERLAY",
    DEBUG_HIDE_OVERLAY: "DEBUG_HIDE_OVERLAY",
    DEBUG_UPDATE_OVERLAY: "DEBUG_UPDATE_OVERLAY",
    DEBUG_CLICK_INDEX: "DEBUG_CLICK_INDEX",
    DEBUG_FILL_INDEX: "DEBUG_FILL_INDEX",
    DEBUG_HIGHLIGHT_SELECTOR: "DEBUG_HIGHLIGHT_SELECTOR"
  };

  // Element map cache for performance optimization
  let __ELEMENT_MAP_CACHE__ = {
    map: null,
    timestamp: 0,
    // Invalidate after 2.5 seconds to balance performance with freshness
    ttl: 2500,
  };
 
  // Fast Mode runtime flag + helpers
  let FAST_MODE = false;
  try {
    chrome.storage.local.get('FAST_MODE').then(({ FAST_MODE: fm }) => { FAST_MODE = !!fm; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'FAST_MODE')) {
        FAST_MODE = !!changes.FAST_MODE.newValue;
      }
    });
  } catch (_) {}
  function getScrollBehavior() { return FAST_MODE ? 'auto' : 'smooth'; }
  const settleNextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Invalidate cache on significant DOM mutations
  try {
    const observer = new MutationObserver(() => {
      __ELEMENT_MAP_CACHE__.timestamp = 0; // Invalidate cache
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'id', 'role']
    });
  } catch (e) {
    console.warn("MutationObserver for cache invalidation failed:", e);
  }

  // In Fast Mode, prefer double-rAF settle instead of timeouts before responding
  function respondAfterSettle(sendResponse, payload) {
    try {
      if (FAST_MODE) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { sendResponse(payload); } catch (_) {}
        }));
      } else {
        sendResponse(payload);
      }
    } catch (_) {
      try { sendResponse(payload); } catch (_) {}
    }
  }

  // Visibility helper reused by multiple handlers
  function isElementVisible(el) {
    try {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return false;
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (!cs) return true;
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
      return true;
    } catch (_) {
      return false;
    }
  }
// Normalize common selector shorthands from LLM outputs to robust CSS/text locators
function normalizeSelectorInput(input) {
  let selector = String(input || '').trim();
  let containsText = null;
  let preferredTag = null;
  try {
    // [aria-label="Compose"] or aria-label="Compose" -> [aria-label="Compose"]
    const aria = selector.match(/^\s*\[?\s*aria-label\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\]?\s*$/i);
    if (aria) {
      const val = aria[1] || aria[2] || '';
      selector = `[aria-label="${val}"]`;
    }

    // text="Compose" | text='Compose' | text=Compose
    const textEq = selector.match(/^\s*text\s*=\s*(?:"([^"]+)"|'([^']+)'|(.+))\s*$/i);
    if (textEq) {
      containsText = (textEq[1] || textEq[2] || textEq[3] || '').trim();
    }

    // text/Compose
    if (!containsText) {
      const textSlash = selector.match(/^\s*text\/(.+)\s*$/i);
      if (textSlash) containsText = textSlash[1].trim();
    }
  } catch (_) {}

  return { selector, containsText, preferredTag };
}

function getPageText(maxChars = 20000) {
  // Enhanced text extraction with structured content
  const content = extractStructuredContent();
  const textContent = [
    content.title ? `Title: ${content.title}` : '',
    content.description ? `Description: ${content.description}` : '',
    content.mainContent,
    content.links.length > 0 ? `\nRelevant Links:\n${content.links.slice(0, 10).map(l => `- ${l.text}: ${l.url}`).join('\n')}` : '',
    content.metadata.length > 0 ? `\nPage Metadata:\n${content.metadata.join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  
  return textContent.trim().slice(0, maxChars);
}

function extractStructuredContent() {
  // Always build a complete content object to ensure consistent shape
  const content = {
    source: 'html', // Default source
    title: document.title || '',
    description: '',
    mainContent: '',
    links: [],
    metadata: [],
    urls: [],
    sections: [],
    jsonLd: null // To store parsed JSON-LD data
  };

  // 1. Try to get JSON-LD for structured data
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  if (jsonLdScripts.length > 0) {
    try {
      const jsonLdData = Array.from(jsonLdScripts).map(script => JSON.parse(script.textContent));
      content.source = 'json-ld';
      content.jsonLd = jsonLdData;
      // Also assign it to 'data' for compatibility with background script
      content.data = jsonLdData;
    } catch (e) {
      console.warn("Failed to parse JSON-LD script:", e);
    }
  }

  // 2. Always perform HTML structure analysis to populate all fields
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    content.description = metaDesc.getAttribute('content') || '';
  }

  const mainContentSelectors = [
    'main', 'article', '[role="main"]', '.content', '.main-content',
    '.post-content', '.entry-content', '.article-content'
  ];
  
  let mainElement = null;
  for (const selector of mainContentSelectors) {
    mainElement = document.querySelector(selector);
    if (mainElement) break;
  }
  
  if (!mainElement) {
    mainElement = document.body;
  }

  content.mainContent = getCleanTextContent(mainElement);

  const links = Array.from(document.querySelectorAll('a[href]'))
    .filter(link => {
      const href = link.href;
      const text = link.textContent.trim();
      return href && text &&
             !href.startsWith('javascript:') &&
             !href.startsWith('#') &&
             text.length > 3 &&
             text.length < 200;
    })
    .map(link => ({
      text: link.textContent.trim(),
      url: link.href,
      isExternal: !link.href.startsWith(window.location.origin)
    }))
    .slice(0, 20);

  content.links = links;

  content.urls = extractUrlsFromText(content.mainContent);

  const metaTags = Array.from(document.querySelectorAll('meta[name], meta[property]'));
  content.metadata = metaTags
    .filter(meta => {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      return name && !name.startsWith('twitter:') && !name.startsWith('fb:');
    })
    .map(meta => {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      const contentValue = meta.getAttribute('content');
      return `${name}: ${contentValue}`;
    })
    .slice(0, 10);

  content.sections = getSemanticSections();
  return content;
}

function getCleanTextContent(element) {
  // Clone the element to avoid modifying the original
  const clone = element.cloneNode(true);
  
  // Remove script and style elements
  const unwantedElements = clone.querySelectorAll('script, style, nav, header, footer, .ad, .advertisement, .sidebar');
  unwantedElements.forEach(el => el.remove());
  
  // Get text content and clean it up
  let text = clone.innerText || clone.textContent || '';
  
  // Clean up whitespace and formatting
  text = text
    .replace(/\s+/g, ' ')  // Replace multiple whitespace with single space
    .replace(/\n\s*\n/g, '\n')  // Remove empty lines
    .trim();
    
  return text;
}

function extractUrlsFromText(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const urls = text.match(urlRegex) || [];
  return [...new Set(urls)].slice(0, 10); // Remove duplicates and limit
}

function getSemanticSections() {
  const sections = [];
  const selectors = [
    { tag: 'article', role: 'article' },
    { tag: 'section', role: 'section' },
    { tag: 'nav', role: 'navigation' },
    { tag: 'aside', role: 'complementary' },
    { tag: 'header', role: 'banner' },
    { tag: 'footer', role: 'contentinfo' },
  ];

  selectors.forEach(({ tag, role }) => {
    document.querySelectorAll(tag).forEach((el, index) => {
      const text = getCleanTextContent(el);
      if (text.length > 100) { // Only include sections with substantial content
        sections.push({
          role: role,
          id: el.id || `${tag}-${index}`,
          text: text.substring(0, 2000), // Truncate for brevity
        });
      }
    });
  });

  return sections;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
(async () => {
  try {
        // Validate message; if no type, try to infer for backward/foreign senders
        if (!message || typeof message.type === 'undefined') {
          const m = message && typeof message === 'object' ? message : {};
          let inferredType = null;
    
          // Heuristics to infer action type from loose payloads
          if (typeof m.selector === 'string' && m.selector.trim()) {
            if (typeof m.value !== 'undefined') {
              inferredType = MSG.FILL_SELECTOR;
              message = { type: inferredType, selector: String(m.selector), value: m.value };
            } else if (typeof m.timeoutMs === 'number') {
              inferredType = MSG.WAIT_FOR_SELECTOR;
              message = { type: inferredType, selector: String(m.selector), timeoutMs: m.timeoutMs };
            } else if (typeof m.direction === 'string') {
              inferredType = MSG.SCROLL_TO_SELECTOR;
              message = { type: inferredType, selector: String(m.selector), direction: m.direction };
            } else if (m.scrape === true || m.mode === 'scrape') {
              inferredType = MSG.SCRAPE_SELECTOR;
              message = { type: inferredType, selector: String(m.selector) };
            } else {
              // Default to click if only selector provided
              inferredType = MSG.CLICK_SELECTOR;
              message = { type: inferredType, selector: String(m.selector) };
            }
          } else if (typeof m.url === 'string' && m.url) {
            inferredType = MSG.FETCH_URL_CONTENT;
            message = { type: inferredType, url: String(m.url), maxChars: Number(m.maxChars || 5000) };
          }
    
          if (!inferredType) {
            console.debug("[ContentScript] Ignoring message without type:", JSON.stringify(m));
            sendResponse({ ok: false, error: "Unknown message type in content script: undefined", errorCode: "UNKNOWN_MESSAGE_TYPE" });
            return;
          }
        }

    switch (message.type) {
      case "__PING_CONTENT__": {
        try { sendResponse({ ok: true, ts: Date.now() }); } catch (_) {}
        break;
      }
      case "AGENT_CAPS": {
        try {
          const caps = {
            ok: true,
            supportsDebugOverlay: true,
            supportsIndexFill: true,
            supportedMessages: Object.keys(MSG || {}).slice(0, 200),
            overlayVersion: "1.0.0"
          };
          sendResponse(caps);
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        break;
      }
      case MSG.AGENT_EXECUTE_TOOL: {
        const { tool, params } = message;
        let result;
        switch (tool) {
          case "click":
            result = await new Promise(resolve => handleClickSelector({ selector: params.selector }, resolve));
            break;
          case "fill":
            result = await new Promise(resolve => handleFillSelector({ selector: params.selector, value: params.value }, resolve));
            break;
          case "scroll":
            result = await new Promise(resolve => handleScrollToSelector({ selector: params.selector, direction: params.direction }, resolve));
            break;
          case "waitForSelector":
            result = await new Promise(resolve => handleWaitForSelector({ selector: params.selector, timeoutMs: params.timeoutMs }, resolve));
            break;
          case "scrape":
            result = await new Promise(resolve => handleScrapeSelector({ selector: params.selector }, resolve));
            break;
          default:
            result = { ok: false, error: `Unknown tool: ${tool}` };
        }
        sendResponse(result);
        break;
      }
      case MSG.EXTRACT_PAGE_TEXT: {
        const text = getPageText(message.maxChars);
        sendResponse({ ok: true, text });
        break;
      }
      case MSG.CLICK_SELECTOR: {
        handleClickSelector(message, sendResponse);
        break;
      }
      case MSG.CHECK_SELECTOR: {
        handleCheckSelector(message, sendResponse);
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
      case MSG.SETTLE: {
        settleNextFrame().then(() => sendResponse({ ok: true }));
        break;
      }
      case MSG.CHECK_SELECTOR: {
        handleCheckSelector(message, sendResponse);
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
      case MSG.EXTRACT_STRUCTURED_CONTENT: {
        handleExtractStructuredContent(message, sendResponse);
        break;
      }
      case MSG.ANALYZE_PAGE_URLS: {
        handleAnalyzePageUrls(message, sendResponse);
        break;
      }
      case MSG.FETCH_URL_CONTENT: {
        handleFetchUrlContent(message, sendResponse);
        break;
      }
      case MSG.GET_PAGE_LINKS: {
        handleGetPageLinks(message, sendResponse);
        break;
      }
      case MSG.SCRAPE_SELECTOR: {
        handleScrapeSelector(message, sendResponse);
        break;
      }
      case MSG.UPLOAD_FILE: {
        handleUploadFile(message, sendResponse);
        break;
      }
      case MSG.FILL_FORM: {
        handleFillForm(message, sendResponse);
        break;
      }
      case MSG.SELECT_OPTION: {
        handleSelectOption(message, sendResponse);
        break;
      }
      case MSG.DRAG_AND_DROP: {
        handleDragAndDrop(message, sendResponse);
        break;
      }
      case MSG.GET_DOM_STATE: {
        handleGetDOMState(message, sendResponse);
        break;
      }
      case "READ_PAGE_CONTENT": {
        const text = getPageText(message.maxChars);
        sendResponse({ ok: true, text });
        break;
      }

      // Debug overlay controls
      case MSG.DEBUG_SHOW_OVERLAY: {
        try {
          overlayShow({
            limit: Number.isFinite(message.limit) ? message.limit : 50,
            minScore: typeof message.minScore === 'number' ? message.minScore : 0,
            colorScheme: message.colorScheme || 'type',
            clickableBadges: !!message.clickableBadges
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        break;
      }
      case MSG.DEBUG_HIDE_OVERLAY: {
        try { overlayHide(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
        break;
      }
      case MSG.DEBUG_UPDATE_OVERLAY: {
        try { overlayUpdate(true); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
        break;
      }
      case MSG.DEBUG_CLICK_INDEX: {
        (async () => {
          const idx = Number(message.index);
          if (!Number.isFinite(idx)) return sendResponse({ ok: false, error: "Invalid index" });
          const res = await overlayClickIndex(idx);
          sendResponse(res);
        })();
        break;
      }
      case MSG.DEBUG_FILL_INDEX: {
        (async () => {
          const idx = Number(message.index);
          if (!Number.isFinite(idx)) return sendResponse({ ok: false, error: "Invalid index" });
          const value = String(message.value || "");
          const res = await overlayFillIndex(idx, value);
          sendResponse(res);
        })();
        break;
      }
      case MSG.DEBUG_HIGHLIGHT_SELECTOR: {
        (async () => {
          try {
            const selector = String(message.selector || '');
            const label = typeof message.label === 'string' ? message.label : '';
            const color = message.color || '#ff9800';
            const durationMs = Number(message.durationMs || 1200);

            let el = null;
            try { el = document.querySelector(selector); }
            catch (e) { return sendResponse({ ok: false, error: `Invalid CSS selector: ${String(e?.message || e)}` }); }
            if (!el) return sendResponse({ ok: false, error: `No element found for selector: ${selector}` });

            const rect = el.getBoundingClientRect();
            const containerId = '__ai_debug_overlay__';
            let container = document.getElementById(containerId);
            if (!container) {
              container = document.createElement('div');
              container.id = containerId;
              Object.assign(container.style, {
                position: 'fixed',
                left: '0',
                top: '0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: '2147483647'
              });
              document.documentElement.appendChild(container);
            }

            // Remove previous highlight rings to avoid clutter
            Array.from(container.querySelectorAll('.__ai_highlight_ring__')).forEach(n => {
              try { n.remove(); } catch (_) {}
            });

            const ring = document.createElement('div');
            // Add the new animation class alongside the base class
            ring.className = '__ai_highlight_ring__ ai-agent-highlight-animated';
            Object.assign(ring.style, {
              position: 'fixed',
              left: `${Math.max(0, rect.left)}px`,
              top: `${Math.max(0, rect.top)}px`,
              width: `${Math.max(0, rect.width)}px`,
              height: `${Math.max(0, rect.height)}px`,
              // The animation is now driven by the CSS class, but we can keep a base style
              border: `2px solid ${color}`,
              borderRadius: '5px', // Match the CSS file
              pointerEvents: 'none',
              zIndex: '2147483647',
              transition: 'opacity 0.3s ease-out'
            });
            container.appendChild(ring);

            if (label) {
              const badge = document.createElement('div');
              Object.assign(badge.style, {
                position: 'fixed',
                left: `${Math.max(0, rect.left)}px`,
                top: `${Math.max(0, rect.top) - 18}px`,
                background: color,
                color: '#fff',
                font: '12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif',
                padding: '2px 6px',
                borderRadius: '3px',
                pointerEvents: 'none',
                zIndex: '2147483647'
              });
              badge.textContent = label;
              container.appendChild(badge);
              setTimeout(() => { try { badge.remove(); } catch (_) {} }, durationMs);
            }

            setTimeout(() => { try { ring.style.opacity = '0'; ring.remove(); } catch (_) {} }, durationMs);
            sendResponse({ ok: true, msg: `Highlighted ${selector}` });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
        })();
        break;
      }
 
       // Lightweight liveness ping used by background.ensureContentScript
       case "__PING_CONTENT__": {
         try { sendResponse({ ok: true, ts: Date.now() }); }
         catch (_) {}
         break;
       }
 
       default:
         sendResponse({ ok: false, error: "Unknown message type in content script: " + message.type, errorCode: "UNKNOWN_MESSAGE_TYPE" });
     }
     } catch (err) {
       console.error("[ContentScript] Error:", err);
       sendResponse({ ok: false, error: String(err?.message || err), errorCode: "HANDLER_EXCEPTION" });
     }
   })();
   return true; // Keep message channel open for async response
 });

// Persistent Port-based RPC to reduce per-action message overhead
// Background will connect via chrome.tabs.connect(tabId, { name: 'agent-port' })
// We respond with { id, result } for each inbound { id, message }.
chrome.runtime.onConnect.addListener((port) => {
  try {
    if (!port || port.name !== 'agent-port') return;
    port.onMessage.addListener(async (packet) => {
      const id = packet && packet.id;
      const message = packet && (packet.message || packet.payload || packet);
      if (id === '__HEARTBEAT_PING__') {
        try { port.postMessage({ id: '__HEARTBEAT_PONG__' }); } catch (_) {}
        return;
      }
      try {
        const result = await __dispatchMessageForPort(message);
        try { port.postMessage({ id, result }); } catch (_) {}
      } catch (e) {
        try { port.postMessage({ id, result: { ok: false, error: String(e?.message || e) } }); } catch (_) {}
      }
    });
  } catch (_) { /* ignore */ }
});

// Internal dispatcher that mirrors the onMessage switch but returns a Promise with the result
async function __dispatchMessageForPort(message) {
  const wrap = (fn, msg) => new Promise((resolve) => {
    try { fn(msg, resolve); } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); }
  });

  try {
    switch (message?.type) {
      case "__PING_CONTENT__": {
        return { ok: true, ts: Date.now() };
      }
      case "AGENT_CAPS": {
        try {
          return {
            ok: true,
            supportsDebugOverlay: true,
            supportsIndexFill: true,
            supportedMessages: Object.keys(MSG || {}).map(k => MSG[k]).filter(Boolean).slice(0, 200),
            overlayVersion: "1.0.0"
          };
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }
      case MSG.EXTRACT_PAGE_TEXT: {
        const text = getPageText(message.maxChars);
        return { ok: true, text };
      }
      case MSG.CHECK_SELECTOR:
        return await new Promise((resolve) => handleCheckSelector(message, resolve));
      case MSG.CLICK_SELECTOR:
        return await wrap(handleClickSelector, message);
      case MSG.FILL_SELECTOR:
        return await wrap(handleFillSelector, message);
      case MSG.SCROLL_TO_SELECTOR:
        return await wrap(handleScrollToSelector, message);
      case MSG.WAIT_FOR_SELECTOR:
        return await wrap(handleWaitForSelector, message);
      case MSG.SETTLE:
        await settleNextFrame();
        return { ok: true };
      case MSG.CHECK_SELECTOR:
        return await wrap(handleCheckSelector, message);
      case MSG.GET_PAGE_INFO:
        return await new Promise((resolve) => handleGetPageInfo(message, resolve));
      case MSG.GET_INTERACTIVE_ELEMENTS:
        return await wrap(handleGetInteractiveElements, message);
      case MSG.EXTRACT_STRUCTURED_CONTENT:
        return await wrap(handleExtractStructuredContent, message);
      case MSG.ANALYZE_PAGE_URLS:
        return await wrap(handleAnalyzePageUrls, message);
      case MSG.FETCH_URL_CONTENT:
        return await wrap(handleFetchUrlContent, message);
      case MSG.GET_PAGE_LINKS:
        return await wrap(handleGetPageLinks, message);
      case MSG.SCRAPE_SELECTOR:
        return await wrap(handleScrapeSelector, message);
      case "READ_PAGE_CONTENT": {
        const text = getPageText(message.maxChars);
        return { ok: true, text };
      }
      case "GET_ELEMENT_MAP": {
        return await wrap(handleGetElementMap, message);
      }

      // Debug overlay controls via Port RPC
      case MSG.DEBUG_SHOW_OVERLAY: {
        try {
          overlayShow({
            limit: Number.isFinite(message.limit) ? message.limit : 50,
            minScore: typeof message.minScore === 'number' ? message.minScore : 0,
            colorScheme: message.colorScheme || 'type',
            clickableBadges: !!message.clickableBadges
          });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }
      case MSG.DEBUG_HIDE_OVERLAY: {
        try { overlayHide(); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e?.message || e) }; }
      }
      case MSG.DEBUG_UPDATE_OVERLAY: {
        try { overlayUpdate(true); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e?.message || e) }; }
      }
      case MSG.DEBUG_FILL_INDEX: {
        try {
          const idx = Number(message.index);
          if (!Number.isFinite(idx)) return { ok: false, error: "Invalid index" };
          const val = String(message.value || "");
          return await overlayFillIndex(idx, val);
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }
      case MSG.DEBUG_CLICK_INDEX: {
        try {
          const idx = Number(message.index);
          if (!Number.isFinite(idx)) return { ok: false, error: "Invalid index" };
          return await overlayClickIndex(idx);
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }
      case MSG.DEBUG_HIGHLIGHT_SELECTOR: {
        try {
          const selector = String(message.selector || '');
          const label = typeof message.label === 'string' ? message.label : '';
          const color = message.color || '#ff9800';
          const durationMs = Number(message.durationMs || 1200);

          let el = null;
          try { el = document.querySelector(selector); }
          catch (e) { return { ok: false, error: `Invalid CSS selector: ${String(e?.message || e)}` }; }
          if (!el) return { ok: false, error: `No element found for selector: ${selector}` };

          const rect = el.getBoundingClientRect();
          const containerId = '__ai_debug_overlay__';
          let container = document.getElementById(containerId);
          if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            Object.assign(container.style, {
              position: 'fixed',
              left: '0',
              top: '0',
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              zIndex: '2147483647'
            });
            document.documentElement.appendChild(container);
          }

          // Remove previous highlight rings
          Array.from(container.querySelectorAll('.__ai_highlight_ring__')).forEach(n => {
            try { n.remove(); } catch (_) {}
          });

          const ring = document.createElement('div');
          // Add the new animation class alongside the base class
          ring.className = '__ai_highlight_ring__ ai-agent-highlight-animated';
          Object.assign(ring.style, {
            position: 'fixed',
            left: `${Math.max(0, rect.left)}px`,
            top: `${Math.max(0, rect.top)}px`,
            width: `${Math.max(0, rect.width)}px`,
            height: `${Math.max(0, rect.height)}px`,
            // The animation is now driven by the CSS class, but we can keep a base style
            border: `2px solid ${color}`,
            borderRadius: '5px', // Match the CSS file
            pointerEvents: 'none',
            zIndex: '2147483647',
            transition: 'opacity 0.3s ease-out'
          });
          container.appendChild(ring);

          if (label) {
            const badge = document.createElement('div');
            Object.assign(badge.style, {
              position: 'fixed',
              left: `${Math.max(0, rect.left)}px`,
              top: `${Math.max(0, rect.top) - 18}px`,
              background: color,
              color: '#fff',
              font: '12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif',
              padding: '2px 6px',
              borderRadius: '3px',
              pointerEvents: 'none',
              zIndex: '2147483647'
            });
            badge.textContent = label;
            container.appendChild(badge);
            setTimeout(() => { try { badge.remove(); } catch (_) {} }, durationMs);
          }

          setTimeout(() => { try { ring.style.opacity = '0'; ring.remove(); } catch (_) {} }, durationMs);
          return { ok: true, msg: `Highlighted ${selector}` };
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }
      
      function handleCheckSelector(message, sendResponse) {
        try {
          const selector = message.selector;
          const visibleOnly = typeof message.visibleOnly === 'boolean' ? message.visibleOnly : true;
          if (!selector) {
            return sendResponse({ ok: false, error: "No selector provided" });
          }
          let el = null;
          try {
            el = document.querySelector(selector);
          } catch (e) {
            return sendResponse({ ok: false, error: `Invalid CSS selector: ${String(e?.message || e)}` });
          }
          if (!el) {
            return sendResponse({ ok: true, found: false, visible: false });
          }
          const rect = el.getBoundingClientRect?.();
          const cs = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
          const visible = !!rect && rect.width > 0 && rect.height > 0 &&
            cs && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') !== 0;
          if (visibleOnly) {
            return sendResponse({ ok: true, found: visible, visible });
          }
          return sendResponse({ ok: true, found: true, visible });
        } catch (error) {
          sendResponse({ ok: false, error: String(error?.message || error) });
        }
      }
      default:
        return { ok: false, error: "Unknown message type in content script: " + String(message?.type), errorCode: "UNKNOWN_MESSAGE_TYPE" };
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function highlightElement(element, durationMs = 1500, color = '#ff9800', label = '') {
  if (!element) return;

  try {
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const containerId = '__ai_debug_overlay__';
    let container = document.getElementById(containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = containerId;
      Object.assign(container.style, {
        position: 'fixed',
        left: '0', top: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '2147483647'
      });
      document.documentElement.appendChild(container);
    }

    const ring = document.createElement('div');
    ring.className = '__ai_highlight_ring__ ai-agent-highlight-animated';
    Object.assign(ring.style, {
      position: 'fixed',
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`,
      border: `2px solid ${color}`,
      borderRadius: '5px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'opacity 0.3s ease-out'
    });
    container.appendChild(ring);

    if (label) {
      const badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed',
        left: `${Math.max(0, rect.left)}px`,
        top: `${Math.max(0, rect.top) - 18}px`,
        background: color,
        color: '#fff',
        font: '12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif',
        padding: '2px 6px',
        borderRadius: '3px',
        pointerEvents: 'none',
        zIndex: '2147483647'
      });
      badge.textContent = label;
      container.appendChild(badge);
      setTimeout(() => { try { badge.remove(); } catch (_) {} }, durationMs);
    }

    setTimeout(() => {
      try {
        ring.style.opacity = '0';
        // Use a transitionend event listener to remove the element after the fade-out
        ring.addEventListener('transitionend', () => {
          try { ring.remove(); } catch (_) {}
        });
      } catch (_) {}
    }, durationMs);
  } catch (e) {
    console.warn("AI-Agent: Failed to highlight element", e);
  }
}

function handleClickSelector(message, sendResponse) {
  try {
    let selector = message.selector;
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }

    // Heuristic normalization for common locator shorthands
    // 1) aria-label="Compose" or [aria-label="Compose"] -> [aria-label="Compose"]
    let containsText = null;
    let preferredTag = null;
    try {
      const s = String(selector);
      const aria = s.match(/^\s*\[?\s*aria-label\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\]?\s*$/i);
      if (aria) {
        const val = aria[1] || aria[2] || '';
        selector = `[aria-label="${val}"]`;
      }
      // 2) text=Compose or text="Compose"
      const textEq = s.match(/^\s*text\s*=\s*(?:"([^"]+)"|'([^']+)'|(.+))\s*$/i);
      if (textEq) {
        containsText = (textEq[1] || textEq[2] || textEq[3] || '').trim();
      }
      // 3) text/Compose
      if (!containsText) {
        const textSlash = s.match(/^\s*text\/(.+)\s*$/i);
        if (textSlash) containsText = textSlash[1].trim();
      }
    } catch (_) {}

    // Helper utilities for robust clicking
    const isVisible = (el) => {
      try {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return false;
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        if (!cs) return true;
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
        return true;
      } catch (_) {
        return false;
      }
    };

    const isClickable = (el) => {
      if (!el || !isVisible(el)) return false;
      const tn = (el.tagName || '').toUpperCase();
      if (tn === 'A' || tn === 'BUTTON') return true;
      if (tn === 'INPUT' && ['button','submit','checkbox','radio','file','image','reset'].includes((el.type || '').toLowerCase())) return true;
      if (el.getAttribute && el.getAttribute('role') === 'button') return true;
      if ('onclick' in el) return true;
      const tabindex = el.getAttribute && el.getAttribute('tabindex');
      if (tabindex !== null && Number(tabindex) >= 0) return true;
      try {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        if (cs && cs.cursor === 'pointer') return true;
      } catch(_) {}
      return false;
    };

    const findClickableAncestor = (el) => {
      let cur = el;
      for (let i = 0; cur && i < 6; i++) {
        if (isClickable(cur)) return cur;
        cur = cur.parentElement;
      }
      return null;
    };

    const robustClick = (el) => {
      try { el.scrollIntoView({ behavior: getScrollBehavior(), block: 'center', inline: 'center' }); } catch(_) {}
      try { el.click(); return true; } catch(_) {}
      try {
        const evtInit = { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView };
        el.dispatchEvent(new MouseEvent('pointerdown', evtInit));
        el.dispatchEvent(new MouseEvent('mousedown', evtInit));
        el.dispatchEvent(new MouseEvent('mouseup', evtInit));
        el.dispatchEvent(new MouseEvent('click', evtInit));
        return true;
      } catch(_) {}
      if ((el.tagName || '').toUpperCase() === 'A') {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try { el.ownerDocument.defaultView.location.href = href; return true; } catch(_) {}
        }
      }
      return false;
    };

    const findClickableByText = (text, preferredTag) => {
      const needle = String(text).toLowerCase();
      const clickableSel = 'a, button, [role="button"], [onclick], [tabindex], label, summary';
      const clickables = Array.from(document.querySelectorAll(clickableSel));
      // Pass 1: obvious clickables
      let candidate = clickables.find(el => {
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        return txt && txt.includes(needle) && isVisible(el);
      });
      // If tag hint provided (e.g., "a"), prefer it
      if (!candidate && preferredTag) {
        const typed = Array.from(document.querySelectorAll(preferredTag));
        candidate = typed.find(el => {
          const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
          return txt && txt.includes(needle) && isVisible(el);
        });
      }
      if (candidate) return candidate;
      // Pass 2: any element by text -> ascend to clickable ancestor
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (txt && txt.includes(needle) && isVisible(el)) {
          const clickable = findClickableAncestor(el) || el;
          if (isClickable(clickable)) return clickable;
        }
      }
      return null;
    };

    // Parse jQuery-like :contains('text') and optional preferred tag before it (e.g., "a:contains('View Code')")
    if (typeof selector === 'string' && !containsText) {
      const m1 = selector.match(/^\s*([a-z0-9]+)?[^:]*:contains\((['"])(.*?)\2\)/i);
      if (m1) {
        preferredTag = (m1[1] || '').toLowerCase() || null;
        containsText = (m1[3] || '').trim();
      } else {
        const m2 = selector.match(/:contains\((['"])(.*?)\1\)/i);
        if (m2 && m2[2]) {
          containsText = m2[2].trim();
        }
      }
    }

    // Prefer DOMAgent if available (handles Shadow DOM and same-origin iframes)
    const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
    if (DA && typeof DA.click === 'function') {
      (async () => {
        try {
          let res = null;
          if (containsText) {
            res = await DA.click({ text: containsText }, { ensureVisible: true, scrollBehavior: getScrollBehavior() });
          } else {
            res = await DA.click({ css: selector }, { ensureVisible: true, scrollBehavior: getScrollBehavior() });
          }

          if (res && res.ok !== false) {
            const label = containsText ? `:contains("${containsText}")` : selector;
            sendResponse({ ok: true, msg: res.observation || `Clicked element: ${label}` });
            return;
          }

          // Fallback if DOMAgent failed: try DOM-based heuristics
          let target = null;
          if (containsText) {
            target = findClickableByText(containsText, preferredTag);
          } else {
            try {
              const el = document.querySelector(selector);
              target = el ? (isClickable(el) ? el : findClickableAncestor(el)) : null;
            } catch(_) { /* ignore */ }
          }

          if (target) {
            highlightElement(target);
            if (robustClick(target)) {
              const label = containsText ? `:contains("${containsText}")` : selector;
              sendResponse({ ok: true, msg: `Clicked element: ${label}` });
            } else {
              const label = containsText ? `:contains("${containsText}")` : selector;
              sendResponse({ ok: false, error: res?.observation || `Click failed for: ${label}` });
            }
          } else {
            const label = containsText ? `:contains("${containsText}")` : selector;
            sendResponse({ ok: false, error: res?.observation || `Click failed for: ${label}` });
          }
        } catch (e) {
          sendResponse({ ok: false, error: `Click failed: ${e.message || String(e)}` });
        }
      })();
      return;
    }

    // Legacy path (no DOMAgent)
    if (containsText) {
      const target = findClickableByText(containsText, preferredTag);
      if (!target) {
        return sendResponse({ ok: false, error: `Element not found for text: ${containsText}` });
      }
      highlightElement(target);
      if (!robustClick(target)) {
        return sendResponse({ ok: false, error: `Click failed for text: ${containsText}` });
      }
      return sendResponse({ ok: true, msg: `Clicked element with text: ${containsText}` });
    }

    // Non-text selector path
    let element = null;
    try {
      element = document.querySelector(selector);
    } catch (selErr) {
      return sendResponse({ ok: false, error: `Invalid CSS selector: ${String(selErr?.message || selErr)}` });
    }
    if (!element) {
      return sendResponse({ ok: false, error: `Element not found: ${selector}` });
    }

    const target = isClickable(element) ? element : (findClickableAncestor(element) || element);
    if (!isVisible(target)) {
      return sendResponse({ ok: false, error: `Element not visible: ${selector}` });
    }
    highlightElement(target);
    if (!robustClick(target)) {
      return sendResponse({ ok: false, error: `Click failed for: ${selector}` });
    }
    if (FAST_MODE) {
      settleNextFrame().then(() => sendResponse({ ok: true, msg: `Clicked element: ${selector}` }));
    } else {
      return sendResponse({ ok: true, msg: `Clicked element: ${selector}` });
    }

  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

async function handleFillSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    const value = String(message.value || "");

    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided", errorCode: "MISSING_SELECTOR" });
    }

    // Small helpers
    const scrollIntoViewSafe = (el) => {
      try { el.scrollIntoView({ behavior: getScrollBehavior(), block: 'center', inline: 'center' }); } catch (_) {}
    };
    const dispatchBeforeInput = (el, data) => {
      try {
        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data,
          inputType: "insertReplacementText"
        }));
      } catch (_) {}
    };
    const dispatchInputChange = (el, data) => {
      try { el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data })); } catch (_) {}
      try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
    };
    const verifyValue = (el, expected) => {
      try {
        if (el.isContentEditable) {
          const txt = (el.innerText || el.textContent || "").trim();
          return txt === String(expected);
        }
        if (typeof el.value !== "undefined") {
          return String(el.value) === String(expected);
        }
        return false;
      } catch (_) { return false; }
    };
    const trySetSelectionRange = (el, start, end) => {
      try { if (typeof el.setSelectionRange === "function") el.setSelectionRange(start, end); } catch (_) {}
    };
    const trySetRangeText = (el, text) => {
      try {
        if (typeof el.setRangeText === "function") {
          trySetSelectionRange(el, 0, (el.value || "").length);
          el.setRangeText(text, 0, (el.value || "").length, "end");
          return true;
        }
      } catch (_) {}
      return false;
    };
    const pasteFallback = async (el, text) => {
      // Best-effort only; may be blocked by permissions/gesture policies.
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
        }
      } catch (_) { /* ignore */ }
      try { el.focus?.(); } catch (_) {}
      try {
        document.execCommand && document.execCommand("paste");
      } catch (_) {}
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        const pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
        el.dispatchEvent(pasteEvt);
      } catch (_) {}
    };

    // Prefer DOMAgent if available (robust/cross-frame handler)
    const DA = (typeof window !== "undefined" ? window.DOMAgent : null);
    if (DA && typeof DA.type === "function") {
      (async () => {
        try {
          // Support semantic/text-based selectors like: text=..., text:..., [aria-label="..."]
          const { selector: normalizedSel, containsText } = normalizeSelectorInput(selector);
          const locator = containsText ? { text: containsText } : { css: normalizedSel || selector };
          const res = await DA.type(locator, value, { ensureVisible: true });
          if (res && res.ok !== false) {
            // Best-effort highlight for DA path
            try {
              let targetEl = null;
              if (containsText) {
                // Reuse local resolver to find a nearby fillable element by text
                const byText = (() => {
                  const needle = String(containsText).toLowerCase();
                  const all = Array.from(document.querySelectorAll('*'));
                  for (const el of all) {
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (txt && txt.includes(needle) && isElementVisible(el)) return el;
                  }
                  return null;
                })();
                if (byText) {
                  targetEl = (function resolveFillTargetLocal(el) {
                    if (!el) return null;
                    const role = (el.getAttribute('role') || '').toLowerCase();
                    const isCE = !!el.isContentEditable || (el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
                    const tag = (el.tagName || '').toUpperCase();
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isCE || role === 'textbox' || role === 'searchbox' || role === 'combobox') return el;
                    const candidates = el.querySelectorAll(['input','textarea','[contenteditable=""]','[contenteditable="true"]','[role="textbox"]','[role="searchbox"]','[role="combobox"] input','[role="combobox"] [contenteditable="true"]','[role="combobox"] [role="textbox"]'].join(','));
                    for (const c of candidates) {
                      const role2 = (c.getAttribute('role') || '').toLowerCase();
                      const isCE2 = !!c.isContentEditable || (c.getAttribute('contenteditable') || '').toLowerCase() === 'true';
                      const tag2 = (c.tagName || '').toUpperCase();
                      if (tag2 === 'INPUT' || tag2 === 'TEXTAREA' || tag2 === 'SELECT' || isCE2 || role2 === 'textbox' || role2 === 'searchbox' || role2 === 'combobox') return c;
                    }
                    return null;
                  })(byText);
                }
              } else {
                try { targetEl = document.querySelector(normalizedSel || selector); } catch (_) {}
              }
              if (targetEl) highlightElement(targetEl);
            } catch (_) {}
            sendResponse({ ok: true, msg: res.observation || `Filled element ${containsText ? `text:${containsText}` : (normalizedSel || selector)} with: ${value}` });
          } else {
            sendResponse({ ok: false, error: res?.observation || `Fill failed for: ${containsText ? `text:${containsText}` : (normalizedSel || selector)}`, errorCode: "DA_FILL_FAILED" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: `Fill failed: ${e.message || String(e)}`, errorCode: "DA_EXCEPTION" });
        }
      })();
      return;
    }

    // Legacy fallback path
    // First, support text-based targeting if selector is text=... or text:...
    try {
      const { selector: normalizedSel, containsText } = normalizeSelectorInput(selector);
      if (containsText) {
        // Try DOMAgent path if available (already handled above). Here, emulate by finding element with text and filling it.
        const clickable = (() => {
          const needle = String(containsText).toLowerCase();
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (txt && txt.includes(needle) && isElementVisible(el)) {
              return el;
            }
          }
          return null;
        })();
        if (clickable) {
          // Prefer actual fill target resolution like in DOMAgent.resolveFillTarget
          const target = (function resolveFillTargetLocal(el) {
            if (!el) return null;
            const role = (el.getAttribute('role') || '').toLowerCase();
            const isCE = !!el.isContentEditable || (el.getAttribute('contenteditable') || '').toLowerCase() === 'true';
            const tag = (el.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isCE || role === 'textbox' || role === 'searchbox' || role === 'combobox') {
              return el;
            }
            const candidates = el.querySelectorAll(['input','textarea','[contenteditable=""]','[contenteditable="true"]','[role="textbox"]','[role="searchbox"]','[role="combobox"] input','[role="combobox"] [contenteditable="true"]','[role="combobox"] [role="textbox"]'].join(','));
            for (const c of candidates) {
              const role2 = (c.getAttribute('role') || '').toLowerCase();
              const isCE2 = !!c.isContentEditable || (c.getAttribute('contenteditable') || '').toLowerCase() === 'true';
              const tag2 = (c.tagName || '').toUpperCase();
              if (tag2 === 'INPUT' || tag2 === 'TEXTAREA' || tag2 === 'SELECT' || isCE2 || role2 === 'textbox' || role2 === 'searchbox' || role2 === 'combobox') {
                return c;
              }
            }
            return null;
          })(clickable);
          if (target) {
            try { target.scrollIntoView({ behavior: getScrollBehavior(), block: 'center', inline: 'center' }); } catch (_) {}
            try { target.focus?.(); } catch (_) {}
            // Set using same helper paths as below
            const setOK = (() => {
              try {
                if (target.tagName === 'SELECT') {
                  target.value = value;
                  target.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
                if (typeof target.value !== 'undefined') {
                  const proto = Object.getPrototypeOf(target);
                  const descriptor = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(target.constructor.prototype, "value");
                  const setter = descriptor && descriptor.set;
                  if (setter) setter.call(target, value); else target.value = value;
                  target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: String(value) }));
                  target.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
                if (target.isContentEditable) {
                  target.innerText = String(value);
                  target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: String(value) }));
                  target.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
                target.textContent = String(value);
                target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: String(value) }));
                target.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
              } catch (_) { return false; }
            })();
            if (setOK) {
              try { highlightElement(target); } catch (_) {}
              return sendResponse({ ok: true, msg: `Filled element by text: ${containsText}`, value });
            }
          }
        }
        // If text path fails, continue to CSS path using normalizedSel if available
        selector = normalizedSel || selector;
      }
    } catch (_) {}
    let element = null;
    try {
      element = document.querySelector(selector);
    } catch (selErr) {
      return sendResponse({ ok: false, error: `Invalid CSS selector: ${String(selErr?.message || selErr)}`, errorCode: "INVALID_SELECTOR" });
    }

    if (!element) {
      return sendResponse({ ok: false, error: `Element not found: ${selector}`, errorCode: "ELEMENT_NOT_FOUND" });
    }

    // Ensure in-view and focused for better reliability
    scrollIntoViewSafe(element);
    try { element.focus?.(); } catch (_) {}

    // Utility: set value in a React-friendly way when possible
    function setNativeValue(el, val) {
      try {
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value") ||
                           Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
        const setter = descriptor && descriptor.set;
        if (setter) {
          setter.call(el, val);
        } else {
          el.value = val;
        }
      } catch (_) {
        try { el.value = val; } catch (_) {}
      }
      // Robust event ordering
      dispatchBeforeInput(el, val);
      const inputEvent = new Event("input", { bubbles: true, cancelable: true });
      try { el.dispatchEvent(inputEvent); } catch (_) {}
    }

    // Contenteditable handling
    if (element.isContentEditable) {
      try {
        element.focus?.();
        scrollIntoViewSafe(element);
        // Try execCommand insertText where available (deprecated but still useful)
        let usedExec = false;
        try {
          document.execCommand("selectAll", false, null);
          document.execCommand("insertText", false, value);
          usedExec = true;
        } catch (_) { usedExec = false; }

        if (!usedExec) {
          // Attempt paste fallback before manual range replacement
          try { await pasteFallback(element, value); } catch (_) {}
          if (!verifyValue(element, value)) {
            try {
              const range = document.createRange();
              range.selectNodeContents(element);
              range.deleteContents();
              range.insertNode(document.createTextNode(value));
              range.collapse(false);
            } catch (_) {
              try { element.innerText = value; } catch (_) { element.textContent = value; }
            }
          }
        }

        // Notify listeners
        try {
          dispatchBeforeInput(element, value);
          element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
        } catch (_) {}
        try { element.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}

        if (verifyValue(element, value)) {
          try { highlightElement(element); } catch (_) {}
          return sendResponse({ ok: true, msg: `Filled contenteditable ${selector}`, value });
        }
        // Last attempt
        try { element.innerText = value; } catch (_) { element.textContent = value; }
        dispatchInputChange(element, value);
        const okCE = verifyValue(element, value);
        return sendResponse({
          ok: okCE,
          msg: `Filled contenteditable ${selector}${okCE ? '' : ' (best-effort)'}`,
          value
        });
      } catch (e) {
        return sendResponse({ ok: false, error: `Fill failed for contenteditable: ${e.message || String(e)}`, errorCode: "FILL_FAILED" });
      }
    }

    // Inputs, textareas, selects
    const tag = (element.tagName || "").toUpperCase();
    if (tag === "SELECT") {
      try {
        element.focus?.();
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return sendResponse({ ok: true, msg: `Set select ${selector} to ${value}` });
      } catch (e) {
        return sendResponse({ ok: false, error: `Select fill failed: ${String(e?.message || e)}`, errorCode: "FILL_FAILED" });
      }
    }

    if (tag === "INPUT" || tag === "TEXTAREA") {
      try {
        element.focus?.();
        scrollIntoViewSafe(element);

        // Strategy 1: React-friendly setter + events
        setNativeValue(element, value);
        dispatchInputChange(element, value);
        if (verifyValue(element, value)) {
          try { highlightElement(element); } catch (_) {}
          return sendResponse({ ok: true, msg: `Filled element ${selector} with: ${value}` });
        }

        // Strategy 2: setRangeText (respects selection and may fire input)
        if (trySetRangeText(element, value)) {
          dispatchInputChange(element, value);
          if (verifyValue(element, value)) {
            try { highlightElement(element); } catch (_) {}
            return sendResponse({ ok: true, msg: `Filled element ${selector} with: ${value} (rangeText)` });
          }
        }

        // Strategy 3: clipboard/paste fallback (may be blocked)
        try { await pasteFallback(element, value); } catch (_) {}
        if (verifyValue(element, value)) {
          dispatchInputChange(element, value);
          try { highlightElement(element); } catch (_) {}
          return sendResponse({ ok: true, msg: `Filled element ${selector} with: ${value} (paste)` });
        }

        // Strategy 4: last-resort direct assign + events
        try {
          dispatchBeforeInput(element, value);
          element.value = value;
        } catch (_) {}
        dispatchInputChange(element, value);
        const ok = verifyValue(element, value);
        if (ok) { try { highlightElement(element); } catch (_) {} }
        return sendResponse({
          ok,
          msg: ok ? `Filled element ${selector} with: ${value}` : `Attempted to fill ${selector} but value mismatch`,
          errorCode: ok ? undefined : "VALUE_MISMATCH"
        });
      } catch (e) {
        return sendResponse({ ok: false, error: `Fill failed: ${String(e?.message || e)}`, errorCode: "FILL_FAILED" });
      }
    }

    // Last-resort attempt for non-standard elements
    try {
      element.focus?.();
      if (typeof element.value !== "undefined") {
        setNativeValue(element, value);
      } else if (typeof element.innerText !== "undefined") {
        element.innerText = value;
        try { element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })); } catch (_) {}
      } else {
        element.textContent = value;
        try { element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })); } catch (_) {}
      }
      try { element.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
      const ok = verifyValue(element, value);
      if (ok) { try { highlightElement(element); } catch (_) {} }
      return sendResponse({
        ok,
        msg: ok ? `Filled element ${selector} with: ${value}` : `Attempted to fill ${selector} but value mismatch`,
        errorCode: ok ? undefined : "ELEMENT_NOT_FILLABLE"
      });
    } catch (e) {
      return sendResponse({ ok: false, error: `Element is not fillable: ${selector}`, errorCode: "ELEMENT_NOT_FILLABLE" });
    }

  } catch (error) {
    return sendResponse({ ok: false, error: String(error?.message || error), errorCode: "UNEXPECTED_ERROR" });
  }
}

function handleScrollToSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    const direction = message.direction;

    // Prefer DOMAgent if available
    const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
    if (DA && typeof DA.scrollTo === 'function') {
      (async () => {
        try {
          const amountPx = message.amountPx || 600;
          let res;
          if (selector) {
            res = await DA.scrollTo({ css: selector }, { amountPx });
          } else if (direction) {
            res = await DA.scrollTo(String(direction).toLowerCase(), { amountPx });
          } else {
            return sendResponse({ ok: false, error: "No selector or direction provided" });
          }
          if (res && res.ok !== false) {
            sendResponse({ ok: true, msg: res.observation || "Scrolled" });
          } else {
            sendResponse({ ok: false, error: res?.observation || "Scroll failed" });
          }
        } catch (e) {
          sendResponse({ ok: false, error: `Scroll failed: ${e.message || String(e)}` });
        }
      })();
      return;
    }

    // Fallback legacy path
    if (selector) {
      const element = document.querySelector(selector);
      if (!element) {
        return sendResponse({ ok: false, error: `Element not found: ${selector}` });
      }
      element.scrollIntoView({ behavior: getScrollBehavior(), block: 'center' });
      respondAfterSettle(sendResponse, { ok: true, msg: `Scrolled to element: ${selector}` });
    } else if (direction) {
      const amountPx = message.amountPx || 600;
      switch (direction.toLowerCase()) {
        case 'up':
          window.scrollBy({ top: -amountPx, behavior: getScrollBehavior() });
          if (FAST_MODE) { settleNextFrame().then(() => sendResponse({ ok: true, msg: `Scrolled up by ${amountPx}px` })); } else { sendResponse({ ok: true, msg: `Scrolled up by ${amountPx}px` }); }
          break;
        case 'down':
          window.scrollBy({ top: amountPx, behavior: getScrollBehavior() });
          sendResponse({ ok: true, msg: `Scrolled down by ${amountPx}px` });
          break;
        case 'top':
          window.scrollTo({ top: 0, behavior: getScrollBehavior() });
          sendResponse({ ok: true, msg: "Scrolled to top" });
          break;
        case 'bottom':
          window.scrollTo({ top: document.body.scrollHeight, behavior: getScrollBehavior() });
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

    // Prefer DOMAgent if available - use progressive waiting strategy
    const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
    if (DA && typeof DA.waitForSelector === 'function') {
      (async () => {
        try {
          // Progressive waiting strategy: 
          // 1. First try visible elements (60% of timeout)
          // 2. If that fails, try element existence (40% of timeout)
          const visibleTimeout = Math.floor(timeoutMs * 0.6);
          const existsTimeout = Math.floor(timeoutMs * 0.4);
          
          console.log(`[ContentScript] Waiting for visible "${selector}" (${visibleTimeout}ms timeout)`);
          const visibleRes = await DA.waitForSelector(selector, visibleTimeout, { visibleOnly: true });
          
          if (visibleRes && visibleRes.ok !== false) {
            console.log(`[ContentScript] Found visible element "${selector}"`);
            return sendResponse({ ok: true, msg: visibleRes.observation || `Visible element found: ${selector}` });
          }
          
          // Visible check failed, try element existence
          console.log(`[ContentScript] Visible check failed, trying element existence for "${selector}" (${existsTimeout}ms timeout)`);
          const existsRes = await DA.waitForSelector(selector, existsTimeout, { visibleOnly: false });
          
          if (existsRes && existsRes.ok !== false) {
            console.log(`[ContentScript] Found existing element "${selector}" (may not be visible)`);
            return sendResponse({ ok: true, msg: existsRes.observation || `Element found (may not be visible): ${selector}` });
          }
          
          // Both attempts failed
          const element = document.querySelector(selector);
          if (element) {
            console.log(`[ContentScript] Element "${selector}" exists but visibility/DOMAgent checks failed`);
            return sendResponse({ ok: true, msg: `Element exists but may have visibility issues: ${selector}` });
          }
          
          console.log(`[ContentScript] Element "${selector}" not found after ${timeoutMs}ms`);
          return sendResponse({ ok: false, error: `Timeout waiting for element: ${selector} (tried visible + exists checks)` });
          
        } catch (e) {
          console.error(`[ContentScript] Wait failed for "${selector}":`, e);
          sendResponse({ ok: false, error: `Wait failed: ${e.message || String(e)}` });
        }
      })();
      return;
    }

    // Fallback legacy polling path (rAF-based settle) - enhanced with visibility check
    console.log(`[ContentScript] Using fallback polling for "${selector}" (${timeoutMs}ms timeout)`);
    const start = performance.now();
    let lastElementCheck = null;
    
    function frame() {
      const element = document.querySelector(selector);
      if (element) {
        const isVisible = isElementVisible(element);
        lastElementCheck = { exists: true, visible: isVisible };
        
        if (isVisible) {
          console.log(`[ContentScript] Fallback found visible element "${selector}"`);
          return respondAfterSettle(sendResponse, { ok: true, msg: `Visible element found: ${selector}` });
        }
        
        // Element exists but not visible, continue waiting a bit longer for visibility
        const elapsed = performance.now() - start;
        const remainingTime = timeoutMs - elapsed;
        
        // If we've used 80% of timeout waiting for visibility, accept non-visible element
        if (remainingTime < (timeoutMs * 0.2)) {
          console.log(`[ContentScript] Fallback accepting non-visible element "${selector}" due to timeout`);
          return respondAfterSettle(sendResponse, { ok: true, msg: `Element found (not visible): ${selector}` });
        }
      } else {
        lastElementCheck = { exists: false, visible: false };
      }
      
      if (performance.now() - start > timeoutMs) {
        console.log(`[ContentScript] Fallback timeout for "${selector}". Last check:`, lastElementCheck);
        return sendResponse({ ok: false, error: `Timeout waiting for element: ${selector}` });
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

  } catch (error) {
    console.error(`[ContentScript] handleWaitForSelector error:`, error);
    sendResponse({ ok: false, error: error.message });
  }
}

function handleCheckSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    const visibleOnly = !!message.visibleOnly;
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }
    // Allow current microtasks + next paint to settle
    requestAnimationFrame(() => {
      try {
        const el = document.querySelector(selector);
        if (!el) {
          return sendResponse({ ok: false, exists: false, visible: false, error: `Element not found: ${selector}` });
        }
        const visible = visibleOnly ? isElementVisible(el) : true;
        return respondAfterSettle(sendResponse, {
          ok: true,
          exists: true,
          visible,
          msg: visible ? `Element visible: ${selector}` : `Element found: ${selector}`
        });
      } catch (e) {
        return sendResponse({ ok: false, error: e.message || String(e) });
      }
    });
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

function getElementPurpose(el) {
  try {
    const tag = (el.tagName || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const text = (el.innerText || el.textContent || '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

    // High-confidence purpose from roles
    if (role === 'search' || tag === 'search') return 'Initiates a search operation.';
    if (role === 'navigation' || tag === 'nav') return 'Navigates to a different section or page.';
    if (role === 'link') return `Navigates to the location specified in href: ${el.getAttribute('href') || ''}`;
    if (role === 'tab') return `Switches to the '${text || ariaLabel}' tab panel.`;
    if (role === 'menu' || role === 'menubar') return 'Opens a menu of options.';
    if (role === 'dialog' || role === 'alertdialog') return 'Displays a modal dialog for user interaction.';

    // Button purpose from text/label
    if (tag === 'button' || role === 'button') {
      const content = `${text} ${ariaLabel}`;
      if (content.includes('submit') || content.includes('save') || content.includes('confirm')) return 'Submits form data or confirms an action.';
      if (content.includes('cancel') || content.includes('close')) return 'Closes a dialog or cancels an action.';
      if (content.includes('add') || content.includes('new') || content.includes('create')) return 'Adds a new item or creates a new entry.';
      if (content.includes('delete') || content.includes('remove')) return 'Deletes the selected item.';
      if (content.includes('next') || content.includes('continue')) return 'Proceeds to the next step in a sequence.';
      if (content.includes('back') || content.includes('previous')) return 'Returns to the previous step.';
      if (content.includes('login') || content.includes('sign in')) return 'Initiates a login or authentication process.';
      if (content.includes('logout') || content.includes('sign out')) return 'Logs the user out of the current session.';
      return `Performs the action described by its text: "${(text || ariaLabel).substring(0, 50)}".`;
    }

    // Input purpose
    if (tag === 'input') {
      const inputType = (el.type || '').toLowerCase();
      if (inputType === 'submit') return 'Submits the parent form.';
      if (inputType === 'search') return 'Input for a search query.';
      if (inputType === 'checkbox' || inputType === 'radio') return `Toggles the '${el.name || ariaLabel}' option.`;
      if (inputType === 'email' || inputType === 'password' || inputType === 'text') return `Accepts user input for the field labeled '${el.name || el.placeholder || ariaLabel}'.`;
    }
    
    if (tag === 'textarea') return `Accepts multi-line text input for '${el.name || ariaLabel}'.`;
    if (tag === 'select') return `Allows user to select an option for '${el.name || ariaLabel}'.`;

    return 'Generic interactive element.';
  } catch (_) {
    return 'Purpose could not be determined.';
  }
}

/**
 * Compute an accessible name for an element following a simplified ARIA algorithm:
 * - aria-labelledby text
 * - aria-label
 * - associated <label for=id> text
 * - title attribute
 * - innerText/textContent fallback
 */
function getAccessibleName(el) {
  try {
    if (!el) return '';
    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const txt = ids.map(id => (el.ownerDocument.getElementById(id)?.innerText || '')).join(' ').trim();
      if (txt) return txt;
    }
    // aria-label
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) return ariaLabel.trim();
    // label[for=id]
    const id = el.getAttribute('id');
    if (id) {
      const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      const labTxt = lab && (lab.innerText || lab.textContent || '').trim();
      if (labTxt) return labTxt;
    }
    // <label> ancestor wrapping input
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      if (p.tagName && p.tagName.toLowerCase() === 'label') {
        const t = (p.innerText || p.textContent || '').trim();
        if (t) return t;
      }
    }
    // title attribute
    const title = el.getAttribute('title') || '';
    if (title.trim()) return title.trim();
    // text content
    const fallback = (el.innerText || el.textContent || '').trim();
    return fallback;
  } catch (_) {
    return '';
  }
}

/**
 * Extract nearby text label (adjacent siblings/ancestors) useful for inputs
 */
function getNearbyLabel(el) {
  try {
    // Check previous sibling text
    let sib = el.previousElementSibling;
    for (let i = 0; i < 2 && sib; i++, sib = sib.previousElementSibling) {
      const t = (sib.innerText || sib.textContent || '').trim();
      if (t) return t;
    }
    // Check ancestor small span/strong near input
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const cand = p.querySelector('strong, span, small');
      if (cand) {
        const t = (cand.innerText || cand.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  } catch (_) {
    return '';
  }
}

/**
 * Heuristic scoring for action-likelihood. Boosts "send/submit/confirm" etc.
 */
function computeActionScore(el) {
  try {
    const tag = (el.tagName || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();

    let score = 0;

    // Base scores by type
    if (tag === 'button' || role === 'button' || (tag === 'input' && ['button','submit','image'].includes((el.type||'').toLowerCase()))) score += 20;
    if (tag === 'a' || role === 'link') score += 5;
    if (el.isContentEditable || ['input','textarea','select'].includes(tag)) score += 8;

    // Positive keywords (submit/send/confirm)
    const positive = ['send','submit','confirm','apply','save','post','publish','share','done'];
    positive.forEach(k => { if (text.includes(k)) score += 30; });

    // Email-specific boosts (common for Gmail)
    const emailPositive = ['send now','send mail','send message'];
    emailPositive.forEach(k => { if (text.includes(k)) score += 15; });

    // Negative/avoid keywords
    const negative = ['cancel','close','discard','settings','format','emoji','attach','attachment','insert','font','undo','redo'];
    negative.forEach(k => { if (text.includes(k)) score -= 15; });

    // Submit input inside form
    try {
      if (tag === 'input' && (el.type || '').toLowerCase() === 'submit') score += 15;
      if (el.closest('form')) score += 3;
    } catch (_) {}

    // Visibility area: larger buttons are more prominent
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const area = rect.width * rect.height;
      score += Math.min(20, Math.floor(area / 3000));
    }

    return score;
  } catch (_) {
    return 0;
  }
}

function handleGetInteractiveElements(message, sendResponse) {
  try {
    // Prefer DOMAgent if available
    const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
    if (DA && typeof DA.getInteractiveElements === 'function') {
      try {
        const res = DA.getInteractiveElements(25);
        if (res && res.ok !== false) {
          // Enrich with purpose and accessible names if not already present
          const enriched = (res.elements || []).map(el => {
            const node = el.element || (el.selector ? document.querySelector(el.selector) : null);
            const accessibleName = node ? getAccessibleName(node) : (el.ariaLabel || '');
            const labelText = node ? getNearbyLabel(node) : '';
            const score = node ? computeActionScore(node) : (typeof el.score === 'number' ? el.score : 0);
            return {
              ...el,
              ariaLabel: el.ariaLabel || accessibleName || '',
              accessibleName: accessibleName || '',
              labelText: el.labelText || labelText || '',
              purpose: el.purpose || (node ? getElementPurpose(node) : ''),
              score: typeof el.score === 'number' ? el.score : score
            };
          });
          // Sort by score desc then by y-position asc
          const sorted = enriched.sort((a, b) => {
            const sa = (typeof a.score === 'number') ? a.score : 0;
            const sb = (typeof b.score === 'number') ? b.score : 0;
            if (sb !== sa) return sb - sa;
            const ay = a.position?.y ?? 0, by = b.position?.y ?? 0;
            return ay - by;
          }).slice(0, 25);
          return sendResponse({ ok: true, elements: sorted });
        }
        return sendResponse({ ok: false, error: res?.observation || "Failed to get interactive elements" });
      } catch (e) {
        return sendResponse({ ok: false, error: `Failed to get interactive elements: ${e.message || String(e)}` });
      }
    }

    // Fallback legacy implementation with context-aware scope (dialog/modal-first scanning)
    const elements = [];
    const seenElements = new Set();
    
    // Determine the most relevant scanning root:
    // - Prefer an active modal/dialog if present (e.g., Gmail compose dialog)
    // - Fallback to document.body
    let scanRoot = document.body;
    try {
      const dialogSelectors = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        'dialog[open]',
        '.modal[open]'
      ].join(',');
      const candidates = Array.from(document.querySelectorAll(dialogSelectors)).filter(isElementVisible);
      if (candidates.length > 0) {
        // Pick the top-most visible dialog by z-index, then by area
        const pick = candidates
          .map(el => {
            let z = 0;
            try {
              const zi = el.ownerDocument.defaultView.getComputedStyle(el).zIndex;
              z = Number.isFinite(parseInt(zi, 10)) ? parseInt(zi, 10) : 0;
            } catch (_) {}
            const r = el.getBoundingClientRect();
            const area = (r?.width || 0) * (r?.height || 0);
            return { el, z, area };
          })
          .sort((a, b) => {
            if (b.z !== a.z) return b.z - a.z;
            return b.area - a.area;
          })[0];
        if (pick && pick.el) scanRoot = pick.el;
      }
    } catch (_) { /* ignore context detection errors */ }
    
    function processElement(el, type) {
      if (seenElements.has(el) || elements.length >= 50) return;
    
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { // Only visible elements
        const accessibleName = getAccessibleName(el);
        const labelText = getNearbyLabel(el);
        const role = (el.getAttribute('role') || '').toLowerCase();
        const title = el.getAttribute('title') || '';
        const dataset = { ...el.dataset };
        const buttonType = (el.tagName.toLowerCase() === 'button') ? (el.getAttribute('type') || 'button') : ((el.tagName.toLowerCase() === 'input') ? (el.type || '') : '');
    
        // Heuristic score for prioritization (e.g., "Send")
        const score = computeActionScore(el);
    
        const common = {
          tag: el.tagName.toLowerCase(),
          selector: generateSelector(el),
          text: (el.textContent || el.innerText || "").trim().substring(0, 120),
          ariaLabel: el.getAttribute('aria-label') || '',
          accessibleName,
          labelText,
          role,
          title,
          dataset,
          position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          purpose: getElementPurpose(el),
          score
        };
    
        if (type === 'clickable') {
          elements.push({
            type: 'clickable',
            buttonType,
            ...common,
          });
        } else if (type === 'input') {
          elements.push({
            type: 'input',
            ...common,
            inputType: el.isContentEditable ? 'contenteditable' : (el.type || 'text'),
            placeholder: el.placeholder || '',
            name: el.name || '',
            value: (typeof el.value !== 'undefined') ? el.value : (el.isContentEditable ? (el.innerText || el.textContent || '') : ''),
          });
        }
        seenElements.add(el);
      }
    }
    
    // Get clickable elements first within the chosen context
    const clickableSelectors = 'a, button, [onclick], [role="button"], input[type="submit"], input[type="button"], [tabindex]';
    try { scanRoot.querySelectorAll(clickableSelectors).forEach(el => processElement(el, 'clickable')); } catch (_) {}
    
    // Then get input elements within the chosen context
    const inputSelectors = 'input:not([type="submit"]):not([type="button"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]';
    try { scanRoot.querySelectorAll(inputSelectors).forEach(el => processElement(el, 'input')); } catch (_) {}
    
    // Sort by score desc, then by y asc
    elements.sort((a, b) => {
      const sa = (typeof a.score === 'number') ? a.score : 0;
      const sb = (typeof b.score === 'number') ? b.score : 0;
      if (sb !== sa) return sb - sa;
      const ay = a.position?.y ?? 0, by = b.position?.y ?? 0;
      return ay - by;
    });
    
    sendResponse({ ok: true, elements: elements.slice(0, 25) });

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
        if (matches.length === 1 && matches[0] === element) {
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

// New enhanced handlers for smart URL processing and research

function handleExtractStructuredContent(message, sendResponse) {
  try {
    const content = extractStructuredContent();
    sendResponse({ ok: true, content });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleAnalyzePageUrls(message, sendResponse) {
  try {
    const analysis = analyzePageUrls();
    sendResponse({ ok: true, analysis });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleFetchUrlContent(message, sendResponse) {
  try {
    const { url, maxChars = 5000 } = message;
    if (!url) {
      return sendResponse({ ok: false, error: "No URL provided" });
    }
    
    // Use fetch to get URL content (subject to CORS)
    fetchUrlContent(url, maxChars)
      .then(content => sendResponse({ ok: true, content }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
      
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function handleGetPageLinks(message, sendResponse) {
  try {
    const { includeExternal = true, maxLinks = 50 } = message;
    const links = getPageLinks(includeExternal, maxLinks);
    sendResponse({ ok: true, links });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

function analyzePageUrls() {
  const analysis = {
    currentUrl: window.location.href,
    domain: window.location.hostname,
    urlType: categorizeUrl(window.location.href),
    discoveredUrls: [],
    relevantUrls: [],   // Canonical field expected by background
    relevantLinks: [],  // Back-compat alias
    externalDomains: new Set(),
    urlPatterns: []
  };

  // Extract all URLs from page text
  const allText = document.body.innerText || document.body.textContent || '';
  const urlsInText = extractUrlsFromText(allText);

  // Use scored/categorized link extraction for relevance
  // getPageLinks returns: { text, url, isExternal, context, category, relevanceScore }
  // Enrich with a 'title' alias for downstream code that checks url.title
  const rawRelevant = getPageLinks(true, 50);
  const relevant = rawRelevant.map(l => ({ title: l.text, ...l }));

  // Build discoveredUrls set from text + relevant urls
  analysis.discoveredUrls = [...new Set([...urlsInText, ...relevant.map(l => l.url)])];

  // Populate external domains from relevant urls
  relevant.forEach(link => {
    if (link.isExternal) {
      try { analysis.externalDomains.add(new URL(link.url).hostname); } catch (_) {}
    }
  });

  // Assign canonical and back-compat fields
  analysis.relevantUrls = relevant;
  analysis.relevantLinks = relevant; // keep for backward compatibility

  // Arrayify externalDomains
  analysis.externalDomains = Array.from(analysis.externalDomains);

  // Identify URL patterns for research
  analysis.urlPatterns = identifyUrlPatterns(analysis.discoveredUrls);

  return analysis;
}

function categorizeUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();
    
    // Research-relevant site categories
    if (hostname.includes('wikipedia.org')) return 'encyclopedia';
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'video';
    if (hostname.includes('google.com')) return 'search_engine';
    if (hostname.includes('github.com')) return 'code_repository';
    if (hostname.includes('stackoverflow.com')) return 'qa_forum';
    if (hostname.includes('reddit.com')) return 'social_forum';
    if (hostname.includes('news') || hostname.includes('bbc.com') || hostname.includes('cnn.com')) return 'news';
    if (hostname.includes('edu')) return 'academic';
    if (hostname.includes('gov')) return 'government';
    if (pathname.includes('blog')) return 'blog';
    if (pathname.includes('article')) return 'article';
    
    return 'general';
  } catch (e) {
    return 'unknown';
  }
}

function getUrlContext(linkElement) {
  // Get surrounding text context for the link
  const parent = linkElement.parentElement;
  if (!parent) return '';
  
  const parentText = parent.textContent || '';
  const linkText = linkElement.textContent || '';
  const linkIndex = parentText.indexOf(linkText);
  
  if (linkIndex === -1) return parentText.substring(0, 100);
  
  const start = Math.max(0, linkIndex - 50);
  const end = Math.min(parentText.length, linkIndex + linkText.length + 50);
  
  return parentText.substring(start, end).trim();
}

function identifyUrlPatterns(urls) {
  const patterns = {
    research_sources: [],
    social_media: [],
    documentation: [],
    news_articles: [],
    academic_papers: []
  };
  
  urls.forEach(url => {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      
      if (hostname.includes('wikipedia') || hostname.includes('britannica') || hostname.includes('edu')) {
        patterns.research_sources.push(url);
      } else if (hostname.includes('twitter') || hostname.includes('facebook') || hostname.includes('linkedin')) {
        patterns.social_media.push(url);
      } else if (hostname.includes('docs.') || hostname.includes('documentation') || hostname.includes('api.')) {
        patterns.documentation.push(url);
      } else if (hostname.includes('news') || hostname.includes('article') || hostname.includes('blog')) {
        patterns.news_articles.push(url);
      } else if (hostname.includes('arxiv') || hostname.includes('scholar') || hostname.includes('researchgate')) {
        patterns.academic_papers.push(url);
      }
    } catch (e) {
      // Invalid URL, skip
    }
  });
  
  return patterns;
}

async function fetchUrlContent(url, maxChars = 5000) {
  try {
    // Note: This will be subject to CORS restrictions
    // For a full implementation, you'd need a proxy or background script
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const text = await response.text();
    
    // Parse HTML and extract meaningful content
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    
    // Remove scripts and styles
    const scripts = doc.querySelectorAll('script, style');
    scripts.forEach(el => el.remove());
    
    const content = {
      url: url,
      title: doc.title || '',
      description: '',
      text: (doc.body?.innerText || doc.body?.textContent || '').substring(0, maxChars),
      links: Array.from(doc.querySelectorAll('a[href]')).slice(0, 10).map(a => ({
        text: a.textContent.trim(),
        href: a.href
      }))
    };
    
    // Try to get meta description
    const metaDesc = doc.querySelector('meta[name="description"]');
    if (metaDesc) {
      content.description = metaDesc.getAttribute('content') || '';
    }
    
    return content;
    
  } catch (error) {
    throw new Error(`Failed to fetch URL content: ${error.message}`);
  }
}

function getPageLinks(includeExternal = true, maxLinks = 50) {
  const links = Array.from(document.querySelectorAll('a[href]'))
    .filter(link => {
      const href = link.href;
      const text = link.textContent.trim();
      
      if (!href || !text) return false;
      if (href.startsWith('javascript:') || href.startsWith('#')) return false;
      if (!includeExternal && !href.startsWith(window.location.origin)) return false;
      
      return true;
    })
    .map(link => ({
      text: link.textContent.trim(),
      url: link.href,
      isExternal: !link.href.startsWith(window.location.origin),
      context: getUrlContext(link),
      category: categorizeUrl(link.href),
      relevanceScore: calculateLinkRelevance(link)
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, maxLinks);
    
  return links;
}

function calculateLinkRelevance(linkElement) {
  let score = 0;
  const text = linkElement.textContent.trim().toLowerCase();
  const href = linkElement.href.toLowerCase();
  
  // Higher score for research-relevant keywords
  const researchKeywords = ['research', 'study', 'analysis', 'report', 'data', 'statistics', 'academic', 'paper', 'article', 'documentation', 'guide', 'tutorial'];
  researchKeywords.forEach(keyword => {
    if (text.includes(keyword) || href.includes(keyword)) {
      score += 2;
    }
  });
  
  // Higher score for authoritative domains
  const authoritativeDomains = ['wikipedia.org', 'edu', 'gov', 'scholar.google', 'arxiv.org', 'researchgate.net'];
  authoritativeDomains.forEach(domain => {
    if (href.includes(domain)) {
      score += 3;
    }
  });
  
  // Lower score for social media and ads
  const lowValueDomains = ['facebook.com', 'twitter.com', 'instagram.com', 'ads', 'advertisement'];
  lowValueDomains.forEach(domain => {
    if (href.includes(domain)) {
      score -= 2;
    }
  });
  
  // Higher score for longer, more descriptive text
  if (text.length > 20 && text.length < 100) {
    score += 1;
  }
  
  return Math.max(0, score);
}

function handleScrapeSelector(message, sendResponse) {
  try {
    const selector = message.selector;
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided for scrape" });
    }

    // Prefer DOMAgent if available
    const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
    if (DA && typeof DA.scrape === 'function') {
      try {
        const res = DA.scrape(selector);
        if (res && res.ok !== false) {
          return sendResponse({ ok: true, msg: res.observation || `Scraped ${res.data?.length || 0} element(s)`, data: res.data });
        }
        return sendResponse({ ok: false, error: res?.observation || "Scrape failed" });
      } catch (e) {
        return sendResponse({ ok: false, error: `Scrape failed: ${e.message || String(e)}` });
      }
    }

    // Fallback legacy implementation
    const elements = Array.from(document.querySelectorAll(selector));
    if (elements.length === 0) {
      return sendResponse({ ok: false, error: `No elements found for selector: ${selector}` });
    }

    const scrapedData = elements.map(el => {
      // Return a structured representation of the element
      return {
        tag: el.tagName.toLowerCase(),
        text: el.innerText || el.textContent || '',
        html: el.innerHTML,
        attributes: Array.from(el.attributes).reduce((acc, attr) => {
          acc[attr.name] = attr.value;
          return acc;
        }, {})
      };
    });

    sendResponse({ ok: true, msg: `Scraped ${scrapedData.length} element(s)`, data: scrapedData });

  } catch (error) {
    sendResponse({ ok: false, error: `Scrape failed: ${error.message}` });
  }
}

/**
 * Debug Overlay for Interactive Elements
 * - Renders numbered borders around interactable elements
 * - Index -> selector map, supports click by index
 */
const __OVERLAY_STATE__ = {
  container: null,
  items: [],
  indexMap: new Map(),
  opts: { limit: 50, minScore: 0, colorScheme: 'type', clickableBadges: false },
  observers: { scroll: null, resize: null, mutation: null },
  throttle: null
};

function overlayShow(options = {}) {
  __OVERLAY_STATE__.opts = {
    ...__OVERLAY_STATE__.opts,
    ...options
  };
  if (!__OVERLAY_STATE__.container) {
    __OVERLAY_STATE__.container = document.createElement('div');
    __OVERLAY_STATE__.container.id = '__ai_debug_overlay__';
    Object.assign(__OVERLAY_STATE__.container.style, {
      position: 'fixed',
      left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex: '2147483647'
    });
    document.documentElement.appendChild(__OVERLAY_STATE__.container);
  }
  overlayUpdate(true);
  overlayAttachListeners();
}

function overlayHide() {
  overlayDetachListeners();
  if (__OVERLAY_STATE__.container && __OVERLAY_STATE__.container.parentNode) {
    __OVERLAY_STATE__.container.parentNode.removeChild(__OVERLAY_STATE__.container);
  }
  __OVERLAY_STATE__.container = null;
  __OVERLAY_STATE__.items = [];
  __OVERLAY_STATE__.indexMap.clear();
}

function overlayAttachListeners() {
  overlayDetachListeners();
  const throttled = () => overlayUpdate(false);
  const throttledImmediate = () => overlayUpdate(true);
  __OVERLAY_STATE__.observers.scroll = throttled;
  __OVERLAY_STATE__.observers.resize = throttledImmediate;
  try { window.addEventListener('scroll', throttled, true); } catch(_) {}
  try { window.addEventListener('resize', throttledImmediate, true); } catch(_) {}

  try {
    __OVERLAY_STATE__.observers.mutation = new MutationObserver(() => overlayUpdate(false));
    __OVERLAY_STATE__.observers.mutation.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: false });
  } catch(_) {}
}

function overlayDetachListeners() {
  try { window.removeEventListener('scroll', __OVERLAY_STATE__.observers.scroll, true); } catch(_) {}
  try { window.removeEventListener('resize', __OVERLAY_STATE__.observers.resize, true); } catch(_) {}
  try { __OVERLAY_STATE__.observers.mutation?.disconnect?.(); } catch(_) {}
  __OVERLAY_STATE__.observers = { scroll: null, resize: null, mutation: null };
}

function overlayUpdate(forceRecompute = false) {
  if (!__OVERLAY_STATE__.container) return;

  // Throttle DOM heavy ops
  if (!forceRecompute) {
    if (__OVERLAY_STATE__.throttle) return;
    __OVERLAY_STATE__.throttle = setTimeout(() => {
      __OVERLAY_STATE__.throttle = null;
      overlayUpdate(true);
    }, 120);
    return;
  }

  const items = overlayComputeItems(__OVERLAY_STATE__.opts);
  __OVERLAY_STATE__.items = items;
  __OVERLAY_STATE__.indexMap.clear();

  // Rebuild DOM
  const root = __OVERLAY_STATE__.container;
  root.innerHTML = '';

  items.forEach((it, i) => {
    const idx = i + 1;
    __OVERLAY_STATE__.indexMap.set(idx, it.selector);

    const { x, y, width, height } = it.position;
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      left: `${Math.max(0, x)}px`,
      top: `${Math.max(0, y)}px`,
      width: `${Math.max(0, width)}px`,
      height: `${Math.max(0, height)}px`,
      border: `2px solid ${overlayColorFor(it)}`,
      borderRadius: '4px',
      boxSizing: 'border-box',
      background: 'transparent',
      pointerEvents: 'none'
    });

    const badge = document.createElement('div');
    badge.textContent = String(idx);
    Object.assign(badge.style, {
      position: 'absolute',
      left: '0px',
      top: '-14px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '11px',
      lineHeight: '14px',
      color: '#fff',
      background: overlayColorFor(it, true),
      padding: '0 4px',
      borderRadius: '3px',
      pointerEvents: __OVERLAY_STATE__.opts.clickableBadges ? 'auto' : 'none',
      cursor: __OVERLAY_STATE__.opts.clickableBadges ? 'pointer' : 'default',
      userSelect: 'none'
    });

    if (__OVERLAY_STATE__.opts.clickableBadges) {
      // Allow clicking badge to trigger action
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlayClickIndex(idx);
      }, { passive: true });
    }

    // Info tooltip on hover (non-interactive)
    badge.title = `[${idx}] ${it.type} ${it.inputType ? '(' + it.inputType + ')' : ''}  ${truncate(it.text, 60)}  ${it.selector}`;

    box.appendChild(badge);
    root.appendChild(box);
  });
}

function overlayColorFor(item, forBadge = false) {
  // colorScheme: 'type' | 'score' | 'fixed'
  const scheme = __OVERLAY_STATE__.opts.colorScheme || 'type';
  if (scheme === 'score' && typeof item.score === 'number') {
    // Map score [0..100?] to hue 0..140
    const s = Math.max(0, Math.min(100, item.score));
    const hue = Math.round(0 + (140 * s) / 100);
    const col = `hsl(${hue}, 90%, ${forBadge ? '35%' : '45%'})`;
    return col;
  }
  if (scheme === 'fixed' && typeof __OVERLAY_STATE__.opts.fixedColor === 'string') {
    return __OVERLAY_STATE__.opts.fixedColor;
  }
  // Default by type
  if (item.type === 'input') {
    if (String(item.inputType || '').toLowerCase() === 'contenteditable') return forBadge ? '#6f42c1' : '#bd93f9';
    return forBadge ? '#0b8457' : '#21c78a';
  }
  return forBadge ? '#1f6feb' : '#58a6ff';
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function overlayComputeItems(opts) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0;

  const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
  // Prefer DOMAgent ranked elements
  if (DA && typeof DA.getInteractiveElements === 'function') {
    try {
      const res = DA.getInteractiveElements(limit * 2);
      if (res?.ok) {
        const filtered = (res.elements || []).filter(e => {
          if (!e || !e.position) return false;
          // visible bounding boxes
          return e.position.width > 0 && e.position.height > 0 && (typeof e.score !== 'number' || e.score >= minScore);
        }).slice(0, limit);
        return filtered;
      }
    } catch (_) {}
  }

  // Fallback heuristic with dialog-first context
  // Determine scanning root: prefer active modal/dialog if present, else document.body
  let scanRoot = document.body;
  try {
    const dialogSelectors = [
      '[role="dialog"]',
      '[role="alertdialog"]',
      'dialog[open]',
      '.modal[open]'
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(dialogSelectors)).filter(isElementVisible);
    if (candidates.length > 0) {
      const pick = candidates
        .map(el => {
          let z = 0;
          try {
            const zi = el.ownerDocument.defaultView.getComputedStyle(el).zIndex;
            z = Number.isFinite(parseInt(zi, 10)) ? parseInt(zi, 10) : 0;
          } catch (_) {}
          const r = el.getBoundingClientRect();
          const area = (r?.width || 0) * (r?.height || 0);
          return { el, z, area };
        })
        .sort((a, b) => {
          if (b.z !== a.z) return b.z - a.z;
          return b.area - a.area;
        })[0];
      if (pick && pick.el) scanRoot = pick.el;
    }
  } catch (_) {}

  const sel = [
    'a[href]:not([href^="#"])',
    'button',
    '[role="button"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="combobox"]'
  ].join(',');

  let nodeList = [];
  try {
    nodeList = Array.from(scanRoot.querySelectorAll(sel));
  } catch (_) {
    try { nodeList = Array.from(document.querySelectorAll(sel)); } catch (_) { nodeList = []; }
  }
  const elements = nodeList.filter(isElementVisible);

  const out = [];
  for (const el of elements) {
    const rect = el.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;

    const type = (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.isContentEditable) ? 'input' : 'clickable';
    const score = computeActionScore(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      selector: generateSelector(el),
      text: (el.textContent || el.innerText || '').trim().slice(0, 120),
      ariaLabel: el.getAttribute?.('aria-label') || '',
      role: (el.getAttribute?.('role') || '').toLowerCase(),
      score,
      position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      contentEditable: !!el.isContentEditable,
      tabIndex: typeof el.tabIndex === 'number' ? el.tabIndex : null,
      type,
      inputType: el.isContentEditable ? 'contenteditable' : (el.type || (type === 'input' ? 'text' : undefined)),
      placeholder: el.placeholder || el.getAttribute?.('data-placeholder') || '',
      name: el.name || '',
      value: (el.value != null ? el.value : (el.isContentEditable ? (el.innerText || el.textContent || '') : '')),
      purpose: getElementPurpose(el)
    });
    if (out.length >= limit) break;
  }
  // Sort to prefer higher-score actions (e.g., "Send")
  out.sort((a, b) => {
    const sa = (typeof a.score === 'number') ? a.score : 0;
    const sb = (typeof b.score === 'number') ? b.score : 0;
    if (sb !== sa) return sb - sa;
    const ay = a.position?.y ?? 0, by = b.position?.y ?? 0;
    return ay - by;
  });
  return out;
}

async function overlayClickIndex(index) {
  let selector = __OVERLAY_STATE__.indexMap.get(index);
  
  // If selector not found, try to refresh overlay and get selector
  if (!selector) {
    try {
      console.log(`[CS] Index ${index} not found in overlay map, refreshing...`);
      overlayUpdate(true); // Force refresh the overlay
      selector = __OVERLAY_STATE__.indexMap.get(index);
    } catch (e) {
      console.warn(`[CS] Failed to refresh overlay: ${e.message}`);
    }
  }
  
  // If still no selector, try to get it directly from element list
  if (!selector) {
    try {
      const elementData = getInteractiveElementsInternal();
      if (elementData.elements && elementData.elements[index - 1]) {
        selector = elementData.elements[index - 1].selector;
        console.log(`[CS] Found selector from direct element lookup: ${selector}`);
      }
    } catch (e) {
      console.warn(`[CS] Failed to get selector from element list: ${e.message}`);
    }
  }
  
  if (!selector) {
    return { ok: false, error: `Index ${index} not found after refresh attempts` };
  }

  console.log(`[CS] Attempting to click index ${index} with selector: ${selector}`);

  // Prefer DOMAgent for robust clicking
  const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
  if (DA && typeof DA.click === 'function') {
    try {
      const res = await DA.click({ css: selector }, { ensureVisible: true, scrollBehavior: 'smooth' });
      if (res?.ok !== false) {
        return { ok: true, msg: res?.observation || `Clicked index ${index}` };
      }
      console.warn(`[CS] DOMAgent click failed: ${res?.observation}`);
    } catch (e) {
      console.warn(`[CS] DOMAgent click threw error: ${e.message}`);
    }
  }

  // Enhanced fallback click with multiple strategies
  try {
    const el = document.querySelector(selector);
    if (!el) {
      return { ok: false, error: `Element not found for selector: ${selector}` };
    }

    // Ensure element is visible and in viewport
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause for scroll
    } catch(_) {}

    // Strategy 1: Simple click
    try {
      el.click();
      console.log(`[CS] Simple click succeeded for index ${index}`);
      return { ok: true, msg: `Clicked index ${index}` };
    } catch(_) {
      console.log(`[CS] Simple click failed, trying event dispatch`);
    }

    // Strategy 2: Event dispatch sequence
    try {
      const rect = el.getBoundingClientRect();
      const evtInit = { 
        bubbles: true, 
        cancelable: true, 
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };
      
      el.dispatchEvent(new MouseEvent('pointerdown', evtInit));
      await new Promise(resolve => setTimeout(resolve, 10));
      el.dispatchEvent(new MouseEvent('mousedown', evtInit));
      await new Promise(resolve => setTimeout(resolve, 10));
      el.dispatchEvent(new MouseEvent('mouseup', evtInit));
      await new Promise(resolve => setTimeout(resolve, 10));
      el.dispatchEvent(new MouseEvent('click', evtInit));
      
      console.log(`[CS] Event dispatch click succeeded for index ${index}`);
      return { ok: true, msg: `Clicked index ${index} via events` };
    } catch(e) {
      console.warn(`[CS] Event dispatch failed: ${e.message}`);
    }

    // Strategy 3: Focus and trigger (for buttons/links)
    try {
      if (el.focus) el.focus();
      if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
        el.dispatchEvent(enterEvent);
        console.log(`[CS] Enter key trigger succeeded for index ${index}`);
        return { ok: true, msg: `Clicked index ${index} via Enter key` };
      }
    } catch(e) {
      console.warn(`[CS] Focus/Enter trigger failed: ${e.message}`);
    }

    return { ok: false, error: `All click strategies failed for index ${index}` };
  } catch (e) {
    return { ok: false, error: `Click failed: ${String(e?.message || e)}` };
  }
}

async function overlayFillIndex(index, value) {
  let selector = __OVERLAY_STATE__.indexMap.get(index);
  if (!selector) {
    try { overlayUpdate(true); } catch (_) {}
    selector = __OVERLAY_STATE__.indexMap.get(index);
  }
  if (!selector) return { ok: false, error: `Index ${index} not found` };

  const DA = (typeof window !== 'undefined' ? window.DOMAgent : null);
  if (DA && typeof DA.type === 'function') {
    const res = await DA.type({ css: selector }, String(value || ''), { ensureVisible: true });
    return res?.ok !== false
      ? { ok: true, msg: res?.observation || `Filled index ${index}` }
      : { ok: false, error: res?.observation || `Fill failed for index ${index}` };
  }

  // Fallback to legacy fill handler
  try {
    const result = await new Promise(resolve => handleFillSelector({ selector, value: String(value || '') }, resolve));
    return result;
  } catch (e) {
    return { ok: false, error: `Fill failed: ${String(e?.message || e)}` };
  }
}

/* ---------- Advanced Interaction Handlers ---------- */

// Handle file upload to input[type="file"] elements  
function handleUploadFile(message, sendResponse) {
  try {
    const { selector, fileName, dataUrl, fileType } = message;
    
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }

    const fileInput = document.querySelector(selector);
    if (!fileInput) {
      return sendResponse({ ok: false, error: `File input not found: ${selector}` });
    }

    if (fileInput.type !== 'file') {
      return sendResponse({ ok: false, error: `Element is not a file input: ${selector}` });
    }

    // Convert data URL to File object
    fetch(dataUrl)
      .then(response => response.blob())
      .then(blob => {
        const file = new File([blob], fileName, { type: fileType });
        
        // Create DataTransfer to set files
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;

        // Trigger change event
        const changeEvent = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(changeEvent);

        return respondAfterSettle(sendResponse, { ok: true, msg: `File uploaded: ${fileName}` });
      })
      .catch(error => {
        sendResponse({ ok: false, error: `File upload failed: ${error.message}` });
      });
  } catch (error) {
    sendResponse({ ok: false, error: `Upload error: ${error.message}` });
  }
}

// Handle intelligent form filling
function handleFillForm(message, sendResponse) {
  try {
    const { formData, formSelector, submitAfter } = message;
    
    if (!formData || typeof formData !== 'object') {
      return sendResponse({ ok: false, error: "Invalid form data provided" });
    }

    const formContainer = formSelector ? document.querySelector(formSelector) : document;
    if (!formContainer) {
      return sendResponse({ ok: false, error: `Form container not found: ${formSelector}` });
    }

    let filledCount = 0;
    const fieldResults = [];

    // Process each field in the form data
    for (const [fieldKey, value] of Object.entries(formData)) {
      try {
        // Try multiple selector strategies
        const selectors = [
          `[name="${fieldKey}"]`,
          `[id="${fieldKey}"]`,
          `[placeholder*="${fieldKey}" i]`,
          `[aria-label*="${fieldKey}" i]`,
          `label:has-text("${fieldKey}") input, label:has-text("${fieldKey}") select, label:has-text("${fieldKey}") textarea`
        ];

        let field = null;
        for (const sel of selectors) {
          field = formContainer.querySelector(sel);
          if (field) break;
        }

        if (!field) {
          fieldResults.push({ field: fieldKey, status: 'not_found' });
          continue;
        }

        // Fill the field based on its type
        if (field.type === 'checkbox' || field.type === 'radio') {
          field.checked = Boolean(value);
        } else if (field.tagName === 'SELECT') {
          // Handle select elements
          const option = Array.from(field.options).find(opt => 
            opt.value === value || opt.textContent.includes(value)
          );
          if (option) {
            field.selectedIndex = option.index;
          }
        } else {
          // Text inputs, textareas, etc.
          field.value = String(value);
        }

        // Trigger appropriate events
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        
        filledCount++;
        fieldResults.push({ field: fieldKey, status: 'filled', element: field.tagName });
      } catch (fieldError) {
        fieldResults.push({ field: fieldKey, status: 'error', error: fieldError.message });
      }
    }

    // Submit form if requested
    if (submitAfter) {
      const form = formContainer.tagName === 'FORM' ? formContainer : formContainer.querySelector('form');
      if (form) {
        setTimeout(() => {
          const submitBtn = form.querySelector('[type="submit"], button[type="submit"], .submit, .btn-submit');
          if (submitBtn) {
            submitBtn.click();
          } else {
            form.submit();
          }
        }, 500);
      }
    }

    return respondAfterSettle(sendResponse, { 
      ok: true, 
      msg: `Form filled: ${filledCount}/${Object.keys(formData).length} fields`,
      details: fieldResults
    });
  } catch (error) {
    sendResponse({ ok: false, error: `Form filling error: ${error.message}` });
  }
}

// Handle dropdown/select option selection
function handleSelectOption(message, sendResponse) {
  try {
    const { selector, optionValue, optionText, optionIndex } = message;
    
    if (!selector) {
      return sendResponse({ ok: false, error: "No selector provided" });
    }

    const selectElement = document.querySelector(selector);
    if (!selectElement) {
      return sendResponse({ ok: false, error: `Select element not found: ${selector}` });
    }

    let selectedOption = null;

    // Try different selection methods
    if (typeof optionIndex === 'number') {
      // Select by index
      if (optionIndex >= 0 && optionIndex < selectElement.options.length) {
        selectElement.selectedIndex = optionIndex;
        selectedOption = selectElement.options[optionIndex];
      }
    } else if (optionValue) {
      // Select by value
      selectedOption = Array.from(selectElement.options).find(opt => opt.value === optionValue);
      if (selectedOption) {
        selectElement.value = optionValue;
      }
    } else if (optionText) {
      // Select by text content
      selectedOption = Array.from(selectElement.options).find(opt => 
        opt.textContent.trim() === optionText || opt.textContent.includes(optionText)
      );
      if (selectedOption) {
        selectElement.selectedIndex = selectedOption.index;
      }
    }

    if (!selectedOption) {
      return sendResponse({ ok: false, error: "Option not found in select element" });
    }

    // Trigger change events
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    selectElement.dispatchEvent(new Event('input', { bubbles: true }));

    return respondAfterSettle(sendResponse, { 
      ok: true, 
      msg: `Selected option: ${selectedOption.textContent || selectedOption.value}` 
    });
  } catch (error) {
    sendResponse({ ok: false, error: `Option selection error: ${error.message}` });
  }
}

// Handle drag and drop operations
function handleDragAndDrop(message, sendResponse) {
  try {
    const { sourceSelector, targetSelector, offsetX = 0, offsetY = 0 } = message;
    
    const sourceEl = document.querySelector(sourceSelector);
    const targetEl = document.querySelector(targetSelector);
    
    if (!sourceEl) {
      return sendResponse({ ok: false, error: `Source element not found: ${sourceSelector}` });
    }
    
    if (!targetEl) {
      return sendResponse({ ok: false, error: `Target element not found: ${targetSelector}` });
    }

    // Get element positions
    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const sourceX = sourceRect.left + sourceRect.width / 2;
    const sourceY = sourceRect.top + sourceRect.height / 2;
    const targetX = targetRect.left + targetRect.width / 2 + offsetX;
    const targetY = targetRect.top + targetRect.height / 2 + offsetY;

    // Create and dispatch drag events
    const dragStartEvent = new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      clientX: sourceX,
      clientY: sourceY
    });

    const dragOverEvent = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: targetX,
      clientY: targetY
    });

    const dropEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: targetX,
      clientY: targetY
    });

    const dragEndEvent = new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      clientX: targetX,
      clientY: targetY
    });

    // Execute drag and drop sequence
    sourceEl.dispatchEvent(dragStartEvent);
    targetEl.dispatchEvent(dragOverEvent);
    targetEl.dispatchEvent(dropEvent);
    sourceEl.dispatchEvent(dragEndEvent);

    return respondAfterSettle(sendResponse, { 
      ok: true, 
      msg: `Dragged from ${sourceSelector} to ${targetSelector}` 
    });
  } catch (error) {
    sendResponse({ ok: false, error: `Drag and drop error: ${error.message}` });
  }
}

// Handle DOM state checking for enhanced readiness detection
function handleGetDOMState(_message, sendResponse) {
  try {
    const state = {
      readyState: document.readyState,
      elementCount: document.querySelectorAll('*').length,
      interactiveElementCount: document.querySelectorAll('button, input, select, textarea, a[href], [onclick], [role="button"]').length,
      loadComplete: document.readyState === 'complete',
      hasContent: document.body && document.body.children.length > 0
    };

    sendResponse({ ok: true, state });
  } catch (error) {
    sendResponse({ ok: false, error: `DOM state check error: ${error.message}` });
  }
}

function buildElementName(it) {
  const parts = [];
  const accessibleName = String(it.accessibleName || '').trim();
  const aria = String(it.ariaLabel || '').trim();
  const labelText = String(it.labelText || '').trim();
  if (accessibleName) parts.push(accessibleName);
  if (aria && !parts.join(' ').includes(aria)) parts.push(aria);
  if (it.placeholder) parts.push(it.placeholder);
  if (it.name) parts.push(it.name);
  if (labelText && !parts.join(' ').includes(labelText)) parts.push(labelText);
  const txt = String(it.text || '').trim();
  if (parts.length === 0 && txt) parts.push(txt.slice(0, 80));
  return parts.join(' ').trim();
}

function handleGetElementMap(message, sendResponse) {
  try {
    const now = Date.now();
    const isCacheValid = __ELEMENT_MAP_CACHE__.map && (now - __ELEMENT_MAP_CACHE__.timestamp < __ELEMENT_MAP_CACHE__.ttl);

    if (isCacheValid && !message.forceRefresh) {
      // Return cached data
      sendResponse({ ok: true, ...__ELEMENT_MAP_CACHE__.map, fromCache: true });
      return;
    }

    const limit = Number.isFinite(message.limit) ? message.limit : 50;
    let items = [];
    if (__OVERLAY_STATE__.container) {
      try { overlayUpdate(true); } catch (_) {}
      items = (__OVERLAY_STATE__.items || []).slice(0, limit);
    } else {
      items = overlayComputeItems({ limit });
    }

    const elements = items.slice(0, limit).map((it, i) => ({
      index: i + 1,
      selector: it.selector,
      tag: it.tag,
      role: it.role,
      type: it.type,
      inputType: it.inputType,
      name: buildElementName(it),
      placeholder: it.placeholder || '',
      ariaLabel: it.ariaLabel || '',
      value: (it.value != null ? String(it.value).slice(0, 200) : ''),
      position: it.position,
      score: typeof it.score === 'number' ? it.score : null,
      contentEditable: !!it.contentEditable,
      tabIndex: typeof it.tabIndex === 'number' ? it.tabIndex : null
    }));

    const mapData = {
      map: {
        url: window.location.href,
        title: document.title || '',
        timestamp: now,
        count: elements.length,
        elements
      },
      elements
    };

    // Update cache
    __ELEMENT_MAP_CACHE__.map = mapData;
    __ELEMENT_MAP_CACHE__.timestamp = now;

    sendResponse({ ok: true, ...mapData, fromCache: false });
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message || e) });
  }
}

})(); // End of IIFE guard