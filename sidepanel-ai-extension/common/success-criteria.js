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
 * Internal helper to validate any value against a (subset of) JSON schema.
 * Supports: type (object, array, string, number, integer), required, properties, items,
 * and minimal format checks for "uri" and "date-time".
 * @param {*} value
 * @param {object} schema
 * @param {string} path - dotted path for error messages
 * @param {string[]} errors - accumulator
 */
function validateValueAgainstSchema(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  const type = schema.type;

  // Arrays
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path || 'value'} has incorrect type. Expected array, got ${Array.isArray(value) ? 'array' : typeof value}.`);
      return;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`Property '${path || 'array'}' must have at least ${schema.minItems} items.`);
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateValueAgainstSchema(value[i], schema.items, `${path}[${i}]`, errors);
      }
    }
    return;
  }

  // Objects
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path || 'value'} has incorrect type. Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}.`);
      return;
    }
    if (Array.isArray(schema.required)) {
      for (const prop of schema.required) {
        if (!(prop in value)) {
          errors.push(`Missing required property: '${path ? path + '.' : ''}${prop}'.`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [prop, propSchema] of Object.entries(schema.properties)) {
        if (prop in value) {
          validateValueAgainstSchema(value[prop], propSchema, path ? `${path}.${prop}` : prop, errors);
        }
      }
    }
    return;
  }

  // Strings
  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path || 'value'} has incorrect type. Expected string, got ${typeof value}.`);
      return;
    }
    if (schema.format === 'uri') {
      try { new URL(value); } catch { errors.push(`${path || 'value'} is not a valid uri.`); }
    } else if (schema.format === 'date-time') {
      const t = Date.parse(value);
      if (Number.isNaN(t)) {
        errors.push(`${path || 'value'} is not a valid date-time.`);
      }
    }
    return;
  }

  // Numbers
  if (type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`${path || 'value'} has incorrect type. Expected number, got ${typeof value}.`);
    }
    return;
  }

  // Integers (not used in current schemas but supported)
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${path || 'value'} has incorrect type. Expected integer, got ${typeof value}.`);
    }
    return;
  }

  // If schema.type is not provided or unrecognized, skip strict type checks.
}

/**
 * @description Validates a set of findings against a given JSON schema.
 * @param {object} findings - The collected data to validate.
 * @param {object} schema - The JSON schema to validate against.
 * @returns {{isValid: boolean, errors: string[]}} - The result of the validation.
 */
globalThis.validateFindings = (findings, schema) => {
  const errors = [];

  // Root must be an object for our findings structure
  if (typeof findings !== 'object' || findings === null || Array.isArray(findings)) {
    return { isValid: false, errors: ["Findings must be a non-null object."] };
  }

  // Validate the full object against the schema
  validateValueAgainstSchema(findings, { type: 'object', ...schema }, '', errors);

  return {
    isValid: errors.length === 0,
    errors
  };
};