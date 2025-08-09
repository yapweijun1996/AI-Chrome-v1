/**
 * @file This file contains the logic for ranking and selecting the best interactive element on a page.
 * It assigns an "interactability score" to each element to help the agent make better decisions.
 */

/**
 * Checks if an element is visible to the user (best-effort).
 * Uses layout box and key computed styles.
 */
function isElementVisible(element) {
  if (!element || !(element instanceof Element)) return false;

  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;

  let style;
  try { style = window.getComputedStyle(element); } catch (_) { style = null; }

  if (!style) return true; // assume visible if cannot compute
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (parseFloat(style.opacity || '1') === 0) return false;
  if (style.pointerEvents === 'none') return false;

  return true;
}

/**
 * Assigns a score to an element based on how likely it is to be interactive.
 */
function getInteractabilityScore(element) {
  if (!element || !isElementVisible(element)) return 0;

  let score = 0;
  const tag = element.tagName.toLowerCase();
  const role = (element.getAttribute('role') || '').toLowerCase();
  const cs = (() => { try { return window.getComputedStyle(element); } catch (_) { return null; } })();

  // Exclusions and penalties
  if (tag === 'input' && (element.type || '').toLowerCase() === 'hidden') return 0;
  if (element.hasAttribute('disabled') || (element.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return 0;
  if (cs && cs.pointerEvents === 'none') return 0;

  const hasHref = element.hasAttribute('href');
  const hasOnClick = element.hasAttribute('onclick');
  const tabIndex = element.tabIndex;

  const isContentEditable = !!element.isContentEditable || (element.getAttribute('contenteditable') || '').toLowerCase() === 'true';

  // Strong interactive signals
  if (['button'].includes(tag)) score += 18;
  if (['a'].includes(tag)) score += hasHref ? 16 : 8;
  if (['input', 'textarea', 'select'].includes(tag)) score += 16;
  if (hasOnClick) score += 10;
  if (typeof tabIndex === 'number' && tabIndex >= 0) score += 6;
  if (isContentEditable) score += 18;

  // ARIA roles that indicate interactability
  if (['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'textbox', 'combobox', 'searchbox', 'menuitem'].includes(role)) {
    score += 14;
  }

  // Visual affordances
  if (cs && cs.cursor === 'pointer') score += 6;

  // Text presence (user-facing)
  const textLen = (element.innerText || element.textContent || '').trim().length;
  if (textLen > 0) score += Math.min(8, Math.ceil(textLen / 20)); // up to +8

  // Minor baseline for generic containers that are likely interactive
  if (['div', 'span', 'li', 'p', 'label', 'summary'].includes(tag)) score += 3;

  // DevTools-only API guard (adds bonus if available)
  if (typeof getEventListeners === 'function') {
    try {
      const listeners = getEventListeners(element);
      if (listeners && Object.keys(listeners).length > 0) score += 10;
    } catch (_) {}
  }

  return score;
}

/**
 * Finds and ranks all interactive elements on the page.
 * @returns {Array<{element: Element, score: number, text: string, tagName: string, role: string, contentEditable: boolean, tabIndex: number|null}>}
 */
function getRankedInteractiveElements() {
  const elements = document.querySelectorAll('body *');
  const rankedElements = [];

  elements.forEach(element => {
    const tagName = element.tagName.toLowerCase();

    // Skip hidden inputs
    if (tagName === 'input' && (element.type || '').toLowerCase() === 'hidden') return;

    // Skip non-interactive via pointer-events
    let cs = null;
    try { cs = window.getComputedStyle(element); } catch (_) { cs = null; }
    if (cs && cs.pointerEvents === 'none') return;

    const score = getInteractabilityScore(element);
    if (score > 0) {
      rankedElements.push({
        element,
        score,
        text: (element.innerText || element.textContent || '').trim(),
        tagName,
        role: (element.getAttribute('role') || '').toLowerCase(),
        contentEditable: !!element.isContentEditable || (element.getAttribute('contenteditable') || '').toLowerCase() === 'true',
        tabIndex: typeof element.tabIndex === 'number' ? element.tabIndex : null
      });
    }
  });

  // Sort by score in descending order
  return rankedElements.sort((a, b) => b.score - a.score);
}

// Expose globally (outside of loops)
try { window.getRankedInteractiveElements = getRankedInteractiveElements; } catch (_) {}