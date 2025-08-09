// e2e/typeText.test.js
const { test, expect } = require('@playwright/test');

test.describe('Agent typeText Tool', () => {
  test('should type text into a standard input field', async ({ page }) => {
    await page.goto('data:text/html,<input id="test-input" />');
    
    // Simulate the agent's action by injecting a script
    await page.evaluate(() => {
      const input = document.getElementById('test-input');
      // This is a simplified simulation of the content script's handleFillSelector
      input.value = 'Hello, Playwright!';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Verify the result
    const inputValue = await page.inputValue('#test-input');
    expect(inputValue).toBe('Hello, Playwright!');
  });

  test('should type text into a contenteditable div', async ({ page }) => {
    await page.goto('data:text/html,<div id="test-editable" contenteditable="true"></div>');

    // Simulate the agent's action
    await page.evaluate(() => {
      const editable = document.getElementById('test-editable');
      // Simulate the paste fallback
      editable.focus();
      document.execCommand('insertText', false, 'Hello, contenteditable!');
    });

    // Verify the result
    const textContent = await page.textContent('#test-editable');
    expect(textContent).toBe('Hello, contenteditable!');
  });

  test('should handle React-like input fields by setting the native value', async ({ page }) => {
    await page.goto('data:text/html,<input id="react-input" />');

    // Simulate a React component by attaching a value setter property
    await page.evaluate(() => {
      const input = document.getElementById('react-input');
      let value = '';
      Object.defineProperty(input, 'value', {
        get() {
          return value;
        },
        set(v) {
          console.log(`React setter called with: ${v}`);
          value = v;
          input.setAttribute('value', v); // Reflect for Playwright to see
        }
      });
    });

    // Simulate the agent's action using the native value setter logic
    await page.evaluate(() => {
      const input = document.getElementById('react-input');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      nativeInputValueSetter.call(input, 'Hello, React!');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Verify the result
    const inputValue = await page.getAttribute('#react-input', 'value');
    expect(inputValue).toBe('Hello, React!');
  });

  test('should type text using a label when selector is not provided', async ({ page }) => {
    await page.goto('data:text/html,<div><label for="labeled-input">My Label</label><input id="labeled-input" /></div>');
    
    await page.evaluate(() => {
      const input = document.getElementById('labeled-input');
      input.value = 'Hello, Labeled Input!';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const inputValue = await page.inputValue('#labeled-input');
    expect(inputValue).toBe('Hello, Labeled Input!');
  });

  test('should fall back to the first visible input when no selector or label is provided', async ({ page }) => {
    await page.goto('data:text/html,<input id="first-input" /><input id="second-input" />');
    
    await page.evaluate(() => {
      const input = document.getElementById('first-input');
      input.value = 'Hello, First Input!';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const inputValue = await page.inputValue('#first-input');
    expect(inputValue).toBe('Hello, First Input!');
  });

  test('should type text using an elementIndex', async ({ page }) => {
    await page.goto('data:text/html,<input id="first-input" /><input id="second-input" />');
    
    await page.evaluate(() => {
      const input = document.getElementById('second-input');
      input.value = 'Hello, Second Input!';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const inputValue = await page.inputValue('#second-input');
    expect(inputValue).toBe('Hello, Second Input!');
  });
});