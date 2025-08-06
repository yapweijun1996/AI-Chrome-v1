import { type Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    SEARCH_TABS_CONTENT: 'search_tabs_content',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    GO_BACK_OR_FORWARD: 'chrome_go_back_or_forward',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    GET_INTERACTIVE_ELEMENTS: 'chrome_get_interactive_elements',
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    NETWORK_DEBUGGER_START: 'chrome_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'chrome_network_debugger_stop',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    INJECT_SCRIPT: 'chrome_inject_script',
    SEND_COMMAND_TO_INJECT_SCRIPT: 'chrome_send_command_to_inject_script',
    CONSOLE: 'chrome_console',
    // Workflow orchestration tools
    WORKFLOW_EXECUTE: 'chrome_workflow_execute',
    WORKFLOW_TEMPLATE_SAVE: 'chrome_workflow_template_save',
    WORKFLOW_TEMPLATE_LOAD: 'chrome_workflow_template_load',
    WORKFLOW_TEMPLATE_LIST: 'chrome_workflow_template_list',
    WORKFLOW_TEMPLATE_DELETE: 'chrome_workflow_template_delete',
    WORKFLOW_MONITOR: 'chrome_workflow_monitor',
    WAIT_FOR_CONDITION: 'chrome_wait_for_condition',
  },
};

export const TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    description: 'Get all currently open browser windows and tabs',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    description: 'Navigate to a URL or refresh the current tab',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to the website specified' },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window to navigate to the URL or not. Defaults to false',
        },
        width: { type: 'number', description: 'Viewport width in pixels (default: 1280)' },
        height: { type: 'number', description: 'Viewport height in pixels (default: 720)' },
        refresh: {
          type: 'boolean',
          description:
            'Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    description:
      'Take a screenshot of the current page or a specific element(if you want to see the page, recommend to use chrome_get_web_content first)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the screenshot, if saving as PNG' },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        storeBase64: {
          type: 'boolean',
          description:
            'return screenshot in base64 format (default: false) if you want to see the page, recommend set this to be true',
        },
        fullPage: {
          type: 'boolean',
          description: 'Store screenshot of the entire page (default: true)',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save screenshot as PNG file (default: true)，if you want to see the page, recommend set this to be false, and set storeBase64 to be true',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    description: 'Close one or more browser tabs',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of tab IDs to close. If not provided, will close the active tab.',
        },
        url: {
          type: 'string',
          description: 'Close tabs matching this URL. Can be used instead of tabIds.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GO_BACK_OR_FORWARD,
    description: 'Navigate back or forward in browser history',
    inputSchema: {
      type: 'object',
      properties: {
        isForward: {
          type: 'boolean',
          description: 'Go forward in history if true, go back if false (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch content from. If not provided, uses the current active tab',
        },
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLICK,
    description: 'Click on an element in the current page or at specific coordinates',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector for the element to click. Either selector or coordinates must be provided. if coordinates are not provided, the selector must be provided.',
        },
        coordinates: {
          type: 'object',
          description:
            'Coordinates to click at (relative to viewport). If provided, takes precedence over selector.',
          properties: {
            x: {
              type: 'number',
              description: 'X coordinate relative to the viewport',
            },
            y: {
              type: 'number',
              description: 'Y coordinate relative to the viewport',
            },
          },
          required: ['x', 'y'],
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait for page navigation to complete after click (default: false)',
        },
        timeout: {
          type: 'number',
          description:
            'Timeout in milliseconds for waiting for the element or navigation (default: 5000)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL,
    description: 'Fill a form element or select an option with the specified value',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input element to fill or select',
        },
        value: {
          type: 'string',
          description: 'Value to fill or select into the element',
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS,
    description: 'Get interactive elements from the current page',
    inputSchema: {
      type: 'object',
      properties: {
        textQuery: {
          type: 'string',
          description: 'Text to search for within interactive elements (fuzzy search)',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector to filter interactive elements. Takes precedence over textQuery if both are provided.',
        },
        includeCoordinates: {
          type: 'boolean',
          description: 'Include element coordinates in the response (default: true)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
    description:
      'Start capturing network requests from a web page using Chrome Debugger API（with responseBody）',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. If not provided, uses the current active tab',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
    description:
      'Stop capturing network requests using Chrome Debugger API and return the captured data',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
    description:
      'Start capturing network requests from a web page using Chrome webRequest API(without responseBody)',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. If not provided, uses the current active tab',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE_STOP,
    description:
      'Stop capturing network requests using webRequest API and return the captured data',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    description: 'Simulate keyboard events in the browser',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description: 'Keys to simulate (e.g., "Enter", "Ctrl+C", "A,B,C" for sequence)',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector for the element to send keyboard events to (optional, defaults to active element)',
        },
        delay: {
          type: 'number',
          description: 'Delay between key sequences in milliseconds (optional, default: 0)',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description: 'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
    description:
      'search for related content from the currently open tab and return the corresponding web pages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'the query to search for related content.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
    description:
      'inject the user-specified content script into the webpage. By default, inject into the currently active tab',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'If a URL is specified, inject the script into the webpage corresponding to the URL.',
        },
        type: {
          type: 'string',
          description:
            'the javaScript world for a script to execute within. must be ISOLATED or MAIN',
        },
        jsScript: {
          type: 'string',
          description: 'the content script to inject',
        },
      },
      required: ['type', 'jsScript'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
    description:
      'if the script injected using chrome_inject_script listens for user-defined events, this tool can be used to trigger those events',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'the tab where you previously injected the script(if not provided,  use the currently active tab)',
        },
        eventName: {
          type: 'string',
          description: 'the eventName your injected content script listen for',
        },
        payload: {
          type: 'string',
          description: 'the payload passed to event, must be a json string',
        },
      },
      required: ['eventName'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    description:
      'Capture and retrieve all console output from the current active browser tab/page. This captures console messages that existed before the tool was called.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description: 'Maximum number of console messages to capture (default: 100)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WORKFLOW_EXECUTE,
    description: 'Execute a complex workflow with multiple steps, dependencies, and error handling',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'object',
          description: 'Workflow definition with steps, dependencies, and error handling',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the workflow for identification and logging'
            },
            description: {
              type: 'string',
              description: 'Optional description of what the workflow does'
            },
            steps: {
              type: 'array',
              description: 'Array of workflow steps to execute',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Unique identifier for this step'
                  },
                  tool: {
                    type: 'string',
                    description: 'Name of the tool to execute for this step'
                  },
                  args: {
                    type: 'object',
                    description: 'Arguments to pass to the tool (supports variable substitution with {{variable}})'
                  },
                  depends: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of step IDs that must complete before this step'
                  },
                  condition: {
                    type: 'string',
                    description: 'Optional condition to evaluate before executing step (supports {{variable}} syntax)'
                  },
                  onError: {
                    type: 'string',
                    enum: ['fail', 'retry', 'continue', 'rollback'],
                    description: 'Action to take if step fails (default: fail)'
                  },
                  retryCount: {
                    type: 'number',
                    description: 'Number of retries for this step if onError is retry (default: 0)'
                  },
                  retryDelay: {
                    type: 'number',
                    description: 'Delay in milliseconds between retries (default: 1000)'
                  },
                  timeout: {
                    type: 'number',
                    description: 'Timeout in milliseconds for this step (default: 30000)'
                  },
                  waitFor: {
                    type: 'object',
                    description: 'Condition to wait for after step execution',
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['element', 'network_idle', 'navigation', 'custom'],
                        description: 'Type of condition to wait for'
                      },
                      selector: {
                        type: 'string',
                        description: 'CSS selector for element-based waits'
                      },
                      state: {
                        type: 'string',
                        enum: ['visible', 'hidden', 'clickable', 'text_matches'],
                        description: 'Element state to wait for'
                      },
                      timeout: {
                        type: 'number',
                        description: 'Wait timeout in milliseconds (default: 10000)'
                      }
                    }
                  }
                },
                required: ['id', 'tool', 'args']
              }
            },
            variables: {
              type: 'object',
              description: 'Initial variables for the workflow (can be updated during execution)'
            },
            errorHandling: {
              type: 'object',
              description: 'Global error handling configuration',
              properties: {
                strategy: {
                  type: 'string',
                  enum: ['fail_fast', 'continue_on_error', 'rollback_on_error'],
                  description: 'Global error handling strategy (default: fail_fast)'
                },
                rollbackSteps: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Step IDs to execute for rollback'
                }
              }
            }
          },
          required: ['name', 'steps']
        }
      },
      required: ['workflow']
    }
  },
  {
    name: TOOL_NAMES.BROWSER.WORKFLOW_TEMPLATE_SAVE,
    description: 'Save a workflow as a reusable template',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the template'
        },
        description: {
          type: 'string',
          description: 'Description of what the template does'
        },
        workflow: {
          type: 'object',
          description: 'Workflow definition to save as template'
        },
        category: {
          type: 'string',
          description: 'Category for organizing templates (e.g., ecommerce, testing, data_collection)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for template discoverability'
        }
      },
      required: ['name', 'workflow']
    }
  },
  {
    name: TOOL_NAMES.BROWSER.WORKFLOW_TEMPLATE_LOAD,
    description: 'Load a saved workflow template',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the template to load'
        },
        variables: {
          type: 'object',
          description: 'Variables to override in the loaded template'
        }
      },
      required: ['name']
    }
  },
  {
    name: TOOL_NAMES.BROWSER.WAIT_FOR_CONDITION,
    description: 'Wait for specific conditions to be met before proceeding',
    inputSchema: {
      type: 'object',
      properties: {
        condition: {
          type: 'object',
          description: 'Condition to wait for',
          properties: {
            type: {
              type: 'string',
              enum: ['element_state', 'network_idle', 'navigation', 'page_load', 'custom_js'],
              description: 'Type of condition to wait for'
            },
            selector: {
              type: 'string',
              description: 'CSS selector for element-based conditions'
            },
            state: {
              type: 'string',
              enum: ['visible', 'hidden', 'clickable', 'text_matches', 'exists', 'not_exists'],
              description: 'Element state to wait for'
            },
            text: {
              type: 'string',
              description: 'Text to match when using text_matches state'
            },
            url: {
              type: 'string',
              description: 'URL pattern to wait for (for navigation conditions)'
            },
            javascript: {
              type: 'string',
              description: 'JavaScript expression to evaluate (for custom_js conditions)'
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 30000)'
            },
            interval: {
              type: 'number',
              description: 'Check interval in milliseconds (default: 500)'
            }
          },
          required: ['type']
        }
      },
      required: ['condition']
    }
  },
  {
    name: TOOL_NAMES.BROWSER.WORKFLOW_TEMPLATE_LIST,
    description: 'List available workflow templates with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter templates by category (e.g., ecommerce, testing, data_collection)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter templates by tags'
        }
      },
      required: []
    }
  },
  {
    name: TOOL_NAMES.BROWSER.WORKFLOW_TEMPLATE_DELETE,
    description: 'Delete a saved workflow template',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the template to delete'
        }
      },
      required: ['name']
    }
  },
  {
    name: TOOL_NAMES.BROWSER.WORKFLOW_MONITOR,
    description: 'Monitor and manage workflow executions',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'cancel', 'clear'],
          description: 'Action to perform: status (get execution status), list (list all executions), cancel (cancel execution), clear (clear completed executions)'
        },
        executionId: {
          type: 'string',
          description: 'Execution ID for status or cancel actions'
        }
      },
      required: ['action']
    }
  }
];
