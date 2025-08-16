/**
 * @file This file defines a suite of browser automation tools.
 * Each tool is designed to be a self-contained, robust, and predictable
 * unit of browser interaction. They handle input validation, smart defaults,
 * and return structured results.
 */

/**
 * Navigates to a specified URL.
 * @param {string} url - The URL to navigate to.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function navigateTo(url) {
  console.log(`[Tool: navigateTo] Attempting to navigate to URL: ${url}`);
  if (!url || !url.startsWith('http')) {
    console.error(`[Tool: navigateTo] Invalid URL provided: ${url}`);
    return { ok: false, error: 'Invalid URL provided.' };
  }
  try {
    await chrome.tabs.update({ url });
    console.log(`[Tool: navigateTo] Successfully navigated to URL: ${url}`);
    return { ok: true };
  } catch (error) {
    console.error(`[Tool: navigateTo] Error navigating to ${url}:`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Clicks a DOM element.
 * @param {number} tabId - The ID of the tab where the element exists.
 * @param {string} selector - The CSS selector for the element.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function click(tabId, selector) {
  console.log(`[Tool: click] Attempting to click element with selector: "${selector}" on tab ${tabId}`);
  if (!selector) {
    console.error('[Tool: click] No selector provided.');
    return { ok: false, error: 'No selector provided for click operation.' };
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'click',
      selector,
    });
    if (response.ok) {
      console.log(`[Tool: click] Successfully clicked element: "${selector}"`);
    } else {
      console.error(`[Tool: click] Failed to click element: "${selector}". Reason: ${response.error}`);
    }
    return response;
  } catch (error) {
    console.error(`[Tool: click] Error clicking element "${selector}":`, error);
    return { ok: false, error: error.message };
  }
}

/**
 * Types text into a DOM element.
 * @param {number} tabId - The ID of the tab where the element exists.
 * @param {string} selector - The CSS selector for the element.
 * @param {string} text - The text to type.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function type(tabId, selector, text) {
  console.log(`[Tool: type] Attempting to type "${text}" into element with selector: "${selector}" on tab ${tabId}`);
  if (!selector || text === undefined) {
    console.error('[Tool: type] Selector or text not provided.');
    return { ok: false, error: 'Selector or text not provided for type operation.' };
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'type',
      selector,
      text,
    });
    if (response.ok) {
      console.log(`[Tool: type] Successfully typed into element: "${selector}"`);
    } else {
      console.error(`[Tool: type] Failed to type into element: "${selector}". Reason: ${response.error}`);
    }
    return response;
  } catch (error) {
    console.error(`[Tool: type] Error typing into element "${selector}":`, error);
    return { ok: false, error: error.message };
  }
}
/**
 * Scrapes text content from a DOM element.
 * @param {number} tabId - The ID of the tab where the element exists.
 * @param {string} selector - The CSS selector for the element. Defaults to 'body'.
 * @returns {Promise<{ok: boolean, data?: string, error?: string}>}
 */
async function scrape(tabId, selector) {
  // Default to scraping the body if no selector is provided.
  const targetSelector = selector || 'body';
  console.log(`[Tool: scrape] Attempting to scrape element with selector: "${targetSelector}" on tab ${tabId}`);
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'scrape',
      selector: targetSelector,
    });
    if (response.ok) {
      console.log(`[Tool: scrape] Successfully scraped element: "${targetSelector}". Length: ${response.data?.length}`);
    } else {
      console.error(`[Tool: scrape] Failed to scrape element: "${targetSelector}". Reason: ${response.error}`);
    }
    return response;
  } catch (error) {
    console.error(`[Tool: scrape] Error scraping element "${targetSelector}":`, error);
    return { ok: false, error: error.message };
  }
}
// Assign tools to a global object to be accessible in the classic service worker script.
globalThis.navigateTo = navigateTo;
globalThis.click = click;
globalThis.type = type;
globalThis.scrape = scrape;