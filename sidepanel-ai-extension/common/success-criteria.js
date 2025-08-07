// common/success-criteria.js

/**
 * @description Defines the JSON schemas for validating the successful completion of various agent tasks.
 * This provides a generic, data-driven way to ensure the agent has collected all necessary information
 * before it considers a task complete.
 */
globalThis.SUCCESS_CRITERIA_SCHEMAS = {
  /**
   * @description Default schema for when no specific task type matches.
   * Requires a basic summary of what was found.
   */
  default: {
    type: "object",
    properties: {
      summary: { type: "string", description: "A summary of the findings." },
      source_urls: { type: "array", items: { type: "string", format: "uri" } }
    },
    required: ["summary", "source_urls"]
  },

  /**
   * @description Schema for financial queries, like stock prices.
   * Requires specific financial data points.
   */
  finance: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "The stock symbol, e.g., 'TSLA'." },
      price: { type: "number", description: "The current stock price." },
      currency: { type: "string", description: "The currency of the price, e.g., 'USD'." },
      timestamp: { type: "string", format: "date-time", description: "The ISO 8601 timestamp for when the price was quoted." },
      source: { type: "string", format: "uri", description: "The URL of the data source." }
    },
    required: ["symbol", "price", "currency", "timestamp", "source"]
  },

  /**
   * @description Schema for news gathering tasks.
   * Requires a list of articles with specific metadata.
   */
  news: {
    type: "object",
    properties: {
      articles: {
        type: "array",
        minItems: 3,
        items: {
          type: "object",
          properties: {
            headline: { type: "string" },
            source: { type: "string", format: "uri" },
            timestamp: { type: "string", format: "date-time" },
            summary: { type: "string" }
          },
          required: ["headline", "source", "timestamp"]
        }
      }
    },
    required: ["articles"]
  },
  
  /**
   * @description Schema for general research tasks.
   * Requires a detailed summary and a list of cited sources.
   */
  research: {
    type: "object",
    properties: {
      summary: { type: "string", description: "A detailed summary of the research findings." },
      key_points: { 
        type: "array", 
        items: { type: "string" },
        description: "A list of key takeaways." 
      },
      sources: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            title: { type: "string" },
            relevance: { type: "string", description: "Why this source is relevant." }
          },
          required: ["url", "title"]
        }
      }
    },
    required: ["summary", "key_points", "sources"]
  }
};

/**
 * @description Validates a set of findings against a given JSON schema.
 * @param {object} findings - The collected data to validate.
 * @param {object} schema - The JSON schema to validate against.
 * @returns {{isValid: boolean, errors: string[]}} - The result of the validation.
 */
globalThis.validateFindings = (findings, schema) => {
  const errors = [];
  
  if (typeof findings !== 'object' || findings === null) {
    return { isValid: false, errors: ["Findings must be a non-null object."] };
  }

  // Check required properties
  if (schema.required) {
    for (const prop of schema.required) {
      if (!(prop in findings)) {
        errors.push(`Missing required property: '${prop}'.`);
      }
    }
  }

  // Check property types and constraints
  if (schema.properties) {
    for (const [prop, rule] of Object.entries(schema.properties)) {
      if (prop in findings) {
        const value = findings[prop];
        
        // Type checking
        if (typeof value !== rule.type && !(rule.type === 'number' && typeof value === 'number')) {
            errors.push(`Property '${prop}' has incorrect type. Expected ${rule.type}, got ${typeof value}.`);
            continue;
        }

        // Array checks
        if (rule.type === 'array') {
          if (rule.minItems && value.length < rule.minItems) {
            errors.push(`Property '${prop}' must have at least ${rule.minItems} items.`);
          }
          // Recursively validate items in array if item schema is provided
          if (rule.items) {
            for (let i = 0; i < value.length; i++) {
              const itemErrors = validateFindings(value[i], rule.items).errors;
              if (itemErrors.length > 0) {
                errors.push(`Item ${i} in '${prop}' is invalid: ${itemErrors.join(', ')}`);
              }
            }
          }
        }
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors: errors
  };
};