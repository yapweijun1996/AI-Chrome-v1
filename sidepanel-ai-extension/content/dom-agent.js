/**
 * content/dom-agent.js
 * DOM Agent for robust element discovery and interaction across Shadow DOM and same-origin iframes.
 * Classic script, safe to load multiple times. Exposes globalThis.DOMAgent.
 */
(function initDOMAgent(global) {
  if (global.DOMAgent && global.DOMAgent.__LOCKED__) {
    return;
  }

  // ---------- Utilities ----------
  function toArray(nodeList) {
    return Array.prototype.slice.call(nodeList || []);
  }

  function safeGetComputedStyle(el) {
    try { return el.ownerDocument.defaultView.getComputedStyle(el); } catch (_) { return null; }
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return false;

    const style = safeGetComputedStyle(el);
    if (!style) return true; // best-effort
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return false;
    }
    return true;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---------- Deep DOM traversal (Shadow DOM + same-origin iframes) ----------
  function* walkNodeDeep(root) {
    if (!root) return;

    // If it's a Document/ShadowRoot/Element
    let walker;
    try {
      walker = (root.ownerDocument || root).createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        null,
        false
      );
    } catch {
      return;
    }

    let node = root;
    // Include the root itself if it is an Element
    if (root.nodeType === Node.ELEMENT_NODE) {
      yield root;
    }

    while (walker && (node = walker.nextNode())) {
      yield node;
      // Shadow DOM
      try {
        if (node.shadowRoot) {
          yield* walkNodeDeep(node.shadowRoot);
        }
      } catch(_) {}
      // Same-origin iframes
      if (node.tagName === 'IFRAME') {
        try {
          const doc = node.contentDocument;
          if (doc) {
            yield* walkNodeDeep(doc);
          }
        } catch (_) {}
      }
    }
  }

  function deepQuerySelectorAll(selector, rootDoc) {
    const results = [];
    const docs = [];

    // Collect top-level document first
    if (rootDoc && rootDoc.nodeType === Node.DOCUMENT_NODE) {
      docs.push(rootDoc);
    } else {
      docs.push(document);
    }

    // Also attempt to gather same-origin iframes (shallow, recursion handled by walkNodeDeep)
    for (const doc of docs) {
      // Standard matches in this document
      try {
        results.push(...toArray(doc.querySelectorAll(selector)));
      } catch(_) {}

      // Shadow DOM + nested iframes via walking
      try {
        for (const node of walkNodeDeep(doc)) {
          // Search within shadow roots explicitly (walkNodeDeep already yields shadow roots)
          if (node instanceof ShadowRoot) {
            try {
              results.push(...toArray(node.querySelectorAll(selector)));
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // De-duplicate (same element might be found via multiple paths)
    return Array.from(new Set(results));
  }

  function deepQuerySelector(selector, rootDoc) {
    const all = deepQuerySelectorAll(selector, rootDoc);
    return all.length ? all[0] : null;
  }

  // ---------- Stable selector generation ----------
  function stableSelector(el) {
    if (!el || !(el instanceof Element)) return "";

    // 1) Prefer ID if unique and reasonable
    if (el.id && !/^\d+$/.test(el.id)) {
      const idSelector = `#${CSS.escape(el.id)}`;
      try {
        const owner = el.ownerDocument || document;
        if (owner.querySelector(idSelector) === el) {
          return idSelector;
        }
      } catch(_) {}
    }

    // 2) Use unique attributes
    const uniqueAttrs = ['data-testid', 'data-cy', 'name', 'aria-label', 'placeholder'];
    for (const attr of uniqueAttrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const cand = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
        try {
          const owner = el.ownerDocument || document;
          if (owner.querySelector(cand) === el) {
            return cand;
          }
        } catch(_) {}
      }
    }

    // 3) Use stable classes
    if (el.className && typeof el.className === 'string') {
      const stableClasses = el.className.split(' ')
        .map(c => c.trim())
        .filter(c => c && isNaN(c) && !/^(is-|has-|js-)/.test(c));
      if (stableClasses.length) {
        const cls = `.${stableClasses.map(c => CSS.escape(c)).join('.')}`;
        const cand = `${el.tagName.toLowerCase()}${cls}`;
        try {
          const owner = el.ownerDocument || document;
          const matches = owner.querySelectorAll(cand);
          if (matches.length === 1 && matches[0] === el) {
            return cand;
          }
        } catch(_) {}
      }
    }

    // 4) Fallback: DOM path with nth-of-type
    const segments = [];
    let cur = el;

    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur.tagName !== 'BODY') {
      let segment = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;

      const siblings = toArray(parent.children).filter(ch => ch.tagName === cur.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(cur) + 1;
        segment += `:nth-of-type(${index})`;
      }
      segments.unshift(segment);
      cur = parent;
      // Safety cap
      if (segments.length > 12) break;
    }

    return segments.join(' > ') || el.tagName.toLowerCase();
  }

  // ---------- Locator resolution ----------
  function resolveLocator(locator, opts) {
    const options = opts || {};
    if (!locator) return null;

    // String treated as CSS selector
    if (typeof locator === 'string') {
      const el = options.visibleOnly ? findVisibleByCss(locator) : deepQuerySelector(locator);
      return el || null;
    }

    // Object locators: { css }, { text }, { role, name }, etc.
    if (locator.css) {
      return options.visibleOnly ? findVisibleByCss(locator.css) : deepQuerySelector(locator.css);
    }
    if (locator.text) {
      const normalized = String(locator.text).trim().toLowerCase();
      const candidates = deepQuerySelectorAll('*');
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (txt && txt.includes(normalized)) {
          if (!options.visibleOnly || isElementVisible(el)) return el;
        }
      }
      return null;
    }
    if (locator.role) {
      const roleSel = `[role="${CSS.escape(locator.role)}"]`;
      const elements = options.visibleOnly ? findAllVisibleByCss(roleSel) : deepQuerySelectorAll(roleSel);
      if (!locator.name) return elements[0] || null;

      const nameNorm = String(locator.name).trim().toLowerCase();
      for (const el of elements) {
        const name = (el.getAttribute('aria-label') || el.getAttribute('name') || el.textContent || '').trim().toLowerCase();
        if (name && name.includes(nameNorm)) return el;
      }
      return null;
    }

    return null;
  }

  function findVisibleByCss(css) {
    const all = deepQuerySelectorAll(css);
    for (const el of all) {
      if (isElementVisible(el)) return el;
    }
    return null;
  }

  function findAllVisibleByCss(css, limit = 50) {
    const all = deepQuerySelectorAll(css);
    const out = [];
    for (const el of all) {
      if (isElementVisible(el)) {
        out.push(el);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // ---------- Actions ----------

  // Helpers for determining and resolving fillable targets
  function isAriaTextLike(el) {
    if (!el) return false;
    const role = (el.getAttribute('role') || '').toLowerCase();
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  }

  function isContentEditableEl(el) {
    if (!el) return false;
    const ce = (el.getAttribute('contenteditable') || '').toLowerCase();
    return !!el.isContentEditable || ce === '' || ce === 'true';
  }

  function isNativeFill(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  // Given a wrapper (e.g., role=combobox), find the actual editable/input descendant
  function resolveFillTarget(el) {
    if (!el) return null;

    if (isNativeFill(el) || isContentEditableEl(el) || isAriaTextLike(el)) {
      return el;
    }

    // Common patterns: inner input, contenteditable, or aria textbox within containers
    const candidates = el.querySelectorAll([
      'input',
      'textarea',
      '[contenteditable=""]',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[role="searchbox"]',
      // combobox containers frequently contain an input or an editable div/span
      '[role="combobox"] input',
      '[role="combobox"] [contenteditable="true"]',
      '[role="combobox"] [role="textbox"]'
    ].join(','));

    for (const c of candidates) {
      if (isNativeFill(c) || isContentEditableEl(c) || isAriaTextLike(c)) {
        return c;
      }
    }

    return null;
  }
  async function click(locator, opts) {
    const options = Object.assign({ ensureVisible: true, scrollBehavior: 'auto' }, opts);
    const el = resolveLocator(locator, { visibleOnly: options.ensureVisible });
    if (!el) return { ok: false, observation: 'Element not found or not visible' };

    try {
      if (options.ensureVisible) {
        el.scrollIntoView({ behavior: options.scrollBehavior, block: 'center', inline: 'center' });
        await sleep(100);
      }
      el.click();
      return { ok: true, observation: `Clicked ${stableSelector(el)}`, selector: stableSelector(el) };
    } catch (e) {
      return { ok: false, observation: `Click failed: ${String(e.message || e)}` };
    }
  }

  async function type(locator, value, opts) {
    const options = Object.assign({ ensureVisible: true }, opts);
    const el = resolveLocator(locator, { visibleOnly: options.ensureVisible });
    if (!el) return { ok: false, observation: 'Element not found or not visible' };

    try {
      // Resolve to the real fillable target (handles wrappers like role=combobox)
      const target = resolveFillTarget(el);
      if (!target) {
        return { ok: false, observation: 'Element is not fillable' };
      }

      const tag = target.tagName;
      const roleAttr = (target.getAttribute('role') || '').toLowerCase();
      const isNativeInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const isContentEditable = !!target.isContentEditable || (target.getAttribute('contenteditable') || '').toLowerCase() === 'true';
      const isAriaTextLike = roleAttr === 'textbox' || roleAttr === 'combobox' || roleAttr === 'searchbox';

      if (!(isNativeInput || isContentEditable || isAriaTextLike)) {
        return { ok: false, observation: 'Element is not fillable' };
      }

      if (options.ensureVisible) {
        target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await sleep(50);
      }

      // Focus element
      try { target.focus(); } catch (_) {}

      // Native input/select/textarea
      if (isNativeInput) {
        // Clear existing
        try { target.value = ''; } catch (_) {}
        // Set new
        target.value = String(value || '');
        // Dispatch events commonly listened to by frameworks
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
        target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
        return { ok: true, observation: `Typed into ${stableSelector(target)}` };
      }

      // Contenteditable / ARIA text-like widgets (e.g., Gmail compose body, chips inputs)
      const text = String(value || '');

      // Select all existing content
      const doc = target.ownerDocument || document;
      const sel = doc.getSelection ? doc.getSelection() : window.getSelection();
      if (sel && doc.createRange) {
        const range = doc.createRange();
        range.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // Try execCommand insertText first (still works in Gmail and many apps)
      let inserted = false;
      try {
        inserted = doc.execCommand && doc.execCommand('insertText', false, text);
      } catch (_) {}

      // Fallback: replace textContent/innerText
      if (!inserted) {
        try {
          // Clear existing child nodes for cleaner state
          while (target.firstChild) target.removeChild(target.firstChild);
          target.appendChild(doc.createTextNode(text));
        } catch (_) {
          // last resort
          try { target.textContent = text; } catch (_) {}
        }
      }

      // Dispatch events to notify frameworks (React, Gmail, etc.)
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));

      return { ok: true, observation: `Typed into ${stableSelector(target)} (contenteditable/aria)` };
    } catch (e) {
      return { ok: false, observation: `Type failed: ${String(e.message || e)}` };
    }
  }

  async function scrollTo(locatorOrDirection, opts) {
    const options = Object.assign({ amountPx: 600 }, opts);
    if (typeof locatorOrDirection === 'string' && ['up', 'down', 'top', 'bottom'].includes(locatorOrDirection.toLowerCase())) {
      const dir = locatorOrDirection.toLowerCase();
      switch (dir) {
        case 'up':
          window.scrollBy({ top: -options.amountPx, behavior: 'smooth' });
          return { ok: true, observation: `Scrolled up by ${options.amountPx}px` };
        case 'down':
          window.scrollBy({ top: options.amountPx, behavior: 'smooth' });
          return { ok: true, observation: `Scrolled down by ${options.amountPx}px` };
        case 'top':
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return { ok: true, observation: 'Scrolled to top' };
        case 'bottom':
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          return { ok: true, observation: 'Scrolled to bottom' };
      }
    }

    // Treat as locator
    const el = resolveLocator(locatorOrDirection, { visibleOnly: true });
    if (!el) return { ok: false, observation: 'Element not found for scrolling' };
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      return { ok: true, observation: `Scrolled to ${stableSelector(el)}` };
    } catch (e) {
      return { ok: false, observation: `Scroll failed: ${String(e.message || e)}` };
    }
  }

  async function waitForSelector(selector, timeoutMs = 5000, opts) {
    const options = Object.assign({ visibleOnly: true, pollMs: 100 }, opts);
    const start = Date.now();

    while (Date.now() - start <= timeoutMs) {
      const el = resolveLocator({ css: selector }, { visibleOnly: options.visibleOnly });
      if (el) return { ok: true, observation: `Element found: ${selector}` };
      await sleep(options.pollMs);
    }
    return { ok: false, observation: `Timeout waiting for selector: ${selector}` };
  }

  function scrape(selector) {
    try {
      const nodes = deepQuerySelectorAll(selector);
      if (!nodes.length) {
        return { ok: false, observation: `No elements found for selector: ${selector}` };
      }
      const data = nodes.map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.innerText || el.textContent || '',
        html: el.innerHTML,
        selector: stableSelector(el),
        attributes: toArray(el.attributes).reduce((acc, attr) => { acc[attr.name] = attr.value; return acc; }, {})
      }));
      return { ok: true, observation: `Scraped ${data.length} element(s)`, data };
    } catch (e) {
      return { ok: false, observation: `Scrape failed: ${String(e.message || e)}` };
    }
  }

  function getInteractiveElements(limit = 50) {
    if (typeof global.getRankedInteractiveElements !== 'function') {
      return { ok: false, elements: [], observation: 'Element ranker not available.' };
    }

    const rankedElements = global.getRankedInteractiveElements();
    const out = rankedElements.slice(0, limit).map(item => {
      const el = item.element;
      const rect = el.getBoundingClientRect();

      // If the item is a wrapper (e.g., role=combobox), point to inner fillable descendant
      const fillTarget = resolveFillTarget(el);
      const target = fillTarget || el;

      const entry = {
        tag: target.tagName.toLowerCase(),
        selector: stableSelector(target),
        text: item.text.substring(0, 120),
        ariaLabel: target.getAttribute('aria-label') || el.getAttribute('aria-label') || '',
        role: ((target.getAttribute('role') || item.role || el.getAttribute('role') || '')).toLowerCase(),
        score: item.score,
        position: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        contentEditable: !!target.isContentEditable || (target.getAttribute('contenteditable') || '').toLowerCase() === 'true',
        tabIndex: typeof target.tabIndex === 'number' ? target.tabIndex : null,
        originalSelector: target === el ? undefined : stableSelector(el)
      };

      const isInput = !!fillTarget ||
        ['input', 'textarea', 'select'].includes(entry.tag) ||
        entry.contentEditable ||
        ['textbox', 'combobox', 'searchbox'].includes(entry.role);

      entry.type = isInput ? 'input' : 'clickable';

      if (isInput) {
        entry.inputType = target.type || (entry.contentEditable ? 'contenteditable' : 'text');
        entry.placeholder = target.placeholder || target.getAttribute('data-placeholder') || '';
        entry.name = target.name || '';
        entry.value = (target.value != null ? target.value : (entry.contentEditable ? (target.innerText || target.textContent || '') : ''));
      }

      return entry;
    });

    return { ok: true, elements: out };
  }

  // ---------- Public API ----------
  const DOMAgent = {
    version: '0.1.0',
    find: resolveLocator,
    findVisible(locator) { return resolveLocator(locator, { visibleOnly: true }); },
    click,
    type,
    scrollTo,
    waitForSelector,
    scrape,
    getInteractiveElements,
    getRankedInteractiveElements: global.getRankedInteractiveElements,
    stableSelector,
    __LOCKED__: true
  };

  global.DOMAgent = DOMAgent;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));