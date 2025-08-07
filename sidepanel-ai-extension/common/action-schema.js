// sidepanel-ai-extension/common/action-schema.js

globalThis.ACTION_SCHEMA = {
  "type": "object",
  "properties": {
    "tool": {
      "type": "string",
      "enum": [
        "navigate",
        "click",
        "fill",
        "scroll",
        "waitForSelector",
        "scrape",
        "think",
        "screenshot",
        "tabs.query",
        "tabs.activate",
        "tabs.close",
        "done",
        "generate_report",
        "analyze_urls",
        "get_page_links",
        "read_page_content",
        "extract_structured_content",
        "record_finding",
        "smart_navigate",
        "research_url",
        "multi_search",
        "continue_multi_search",
        "analyze_url_depth"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "url": { "type": "string", "format": "uri" },
        "selector": { "type": "string", "maxLength": 500 },
        "value": { "type": ["string", "object"], "maxLength": 5000 },
        "name": { "type": "string", "maxLength": 500 },
        "key": { "type": "string", "maxLength": 500 },
        "information": { "type": "object" },
        "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
        "timeoutMs": { "type": "integer", "minimum": 100, "maximum": 30000 },
        "timeout": { "type": "integer", "minimum": 100, "maximum": 30000 },
        "thought": { "type": "string", "maxLength": 4000 },
        "titleContains": { "type": "string", "maxLength": 250 },
        "urlContains": { "type": "string", "maxLength": 500 },
        "tabId": { "type": "integer" },
        "format": { "type": "string", "enum": ["markdown", "json", "html"] },
        "includeExternal": { "type": "boolean" },
        "maxLinks": { "type": "integer", "minimum": 1, "maximum": 100 },
        "maxChars": { "type": "integer", "minimum": 100, "maximum": 50000 },
        "finding": { "type": "object" },
        "query": { "type": "string", "maxLength": 500 },
        "depth": { "type": "integer", "minimum": 0, "maximum": 5 },
        "maxDepth": { "type": "integer", "minimum": 1, "maximum": 5 },
        "location": { "type": "string", "maxLength": 100 },
        "maxSearches": { "type": "integer", "minimum": 1, "maximum": 10 },
        "currentDepth": { "type": "integer", "minimum": 0, "maximum": 5 },
        "researchGoal": { "type": "string", "maxLength": 500 }
      }
    },
    "rationale": { "type": "string", "maxLength": 2000 },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "done": { "type": "boolean" }
  },
  "required": ["tool", "params", "rationale"]
};