// common/utils.js

(function(global) {
  const Utils = {
    // Extracts the first valid JSON object from a string, with retries.
    extractJSONWithRetry: (text, context = 'general') => {
      if (typeof text !== 'string' || !text.includes('{')) {
        return { success: false, error: 'No JSON object found.', data: null };
      }

      const attempts = [
        // Standard JSON from start to end
        (t) => t.substring(t.indexOf('{'), t.lastIndexOf('}') + 1),
        // JSON within markdown code blocks
        (t) => {
          const match = t.match(/```json\s*([\s\S]+?)\s*```/);
          return match ? match[1] : null;
        },
        // JSON that might be incomplete
        (t) => {
          const start = t.indexOf('{');
          let openBraces = 0;
          for (let i = start; i < t.length; i++) {
            if (t[i] === '{') openBraces++;
            if (t[i] === '}') openBraces--;
            if (openBraces === 0) return t.substring(start, i + 1);
          }
          return null;
        }
      ];

      for (const attempt of attempts) {
        const jsonStr = attempt(text);
        if (jsonStr) {
          try {
            const data = JSON.parse(jsonStr);
            return { success: true, data: data };
          } catch (e) {
            // Continue to next attempt if parsing fails
          }
        }
      }

      return { success: false, error: 'Failed to parse JSON after multiple attempts.', data: null };
    },

    // Wraps a promise with a timeout.
    withTimeout: (promise, ms, context = 'operation') => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timeout after ${ms}ms for ${context}`));
        }, ms);

        promise.then(
          (res) => {
            clearTimeout(timer);
            resolve(res);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          }
        );
      });
    },

    // Deeply merges objects, concatenating arrays.
    deepMerge: (target, source) => {
      const output = { ...target };
      if (target && typeof target === 'object' && source && typeof source === 'object') {
        Object.keys(source).forEach(key => {
          if (source[key] && typeof source[key] === 'object') {
            if (!(key in target)) {
              Object.assign(output, { [key]: source[key] });
            } else {
              if (Array.isArray(source[key])) {
                output[key] = (target[key] || []).concat(source[key]);
              } else {
                output[key] = Utils.deepMerge(target[key], source[key]);
              }
            }
          } else {
            Object.assign(output, { [key]: source[key] });
          }
        });
      }
      return output;
    },

    // Performs a deep equality check between two objects.
    deepEqual: (obj1, obj2) => {
      if (obj1 === obj2) return true;

      if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
        return false;
      }

      const keys1 = Object.keys(obj1);
      const keys2 = Object.keys(obj2);

      if (keys1.length !== keys2.length) return false;

      for (const key of keys1) {
        if (!keys2.includes(key) || !Utils.deepEqual(obj1[key], obj2[key])) {
          return false;
        }
      }

      return true;
    }
  };

  global.Utils = Utils;
})(typeof self !== 'undefined' ? self : window);