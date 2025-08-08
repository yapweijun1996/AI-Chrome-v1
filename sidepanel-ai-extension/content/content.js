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
    GET_INTERACTIVE_ELEMENTS: "GET_INTERACTIVE_ELEMENTS",
    EXTRACT_STRUCTURED_CONTENT: "EXTRACT_STRUCTURED_CONTENT",
    ANALYZE_PAGE_URLS: "ANALYZE_PAGE_URLS",
    FETCH_URL_CONTENT: "FETCH_URL_CONTENT",
    GET_PAGE_LINKS: "GET_PAGE_LINKS",
    SCRAPE_SELECTOR: "SCRAPE_SELECTOR"
  };

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
    // Validate message shape early to avoid "undefined" type logs
    if (!message || typeof message.type === 'undefined') {
      console.warn("[ContentScript] Received message without type:", JSON.stringify(message || {}));
      sendResponse({ ok: false, error: "Unknown message type in content script: undefined" });
      return;
    }

    switch (message.type) {
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
      case "READ_PAGE_CONTENT": {
        const text = getPageText(message.maxChars);
        sendResponse({ ok: true, text });
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
    relevantLinks: [],
    externalDomains: new Set(),
    urlPatterns: []
  };

  // Extract all URLs from page content
  const allText = document.body.innerText || document.body.textContent || '';
  const urlsInText = extractUrlsFromText(allText);
  
  // Get all links from the page
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map(link => ({
      url: link.href,
      text: link.textContent.trim(),
      isExternal: !link.href.startsWith(window.location.origin),
      context: getUrlContext(link)
    }))
    .filter(link => link.url && link.text);

  analysis.discoveredUrls = [...new Set([...urlsInText, ...links.map(l => l.url)])];
  analysis.relevantLinks = links.slice(0, 20);
  
  // Analyze external domains
  links.forEach(link => {
    if (link.isExternal) {
      try {
        const domain = new URL(link.url).hostname;
        analysis.externalDomains.add(domain);
      } catch (e) {
        // Invalid URL, skip
      }
    }
  });
  
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

})(); // End of IIFE guard