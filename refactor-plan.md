# Code Refactoring and Efficiency Improvement Plan

This document outlines a plan to refactor the codebase for improved efficiency, maintainability, and performance.

### 1. Modularize `background.js`

The `background.js` file is a major bottleneck due to its size and complexity. It should be broken down into smaller, more focused modules.

**Proposed Modules:**

*   **`session-manager.js`**: Handle all aspects of agent session management, including creation, storage, and retrieval.
*   **`message-handler.js`**: Centralize all `chrome.runtime.onMessage` listeners and delegate to other modules.
*   **`agent-loop.js`**: Contain the core agentic loop logic, including context gathering, reasoning, and action execution.
*   **`action-dispatcher.js`**: A simplified dispatcher that primarily relies on the `ToolsRegistry`.
*   **`permission-manager.js`**: The existing `PermissionManager` class can be moved to its own file.
*   **`utils.js`**: A collection of utility functions like `extractJSONWithRetry`, `deepMerge`, and `sanitizeModelJson`.

### 2. Consolidate Tool Handling with `ToolsRegistry`

The `dispatchAgentAction` function in `background.js` should be deprecated in favor of the `ToolsRegistry`.

**Steps:**

1.  Migrate all tool implementations from the `switch` statement in `dispatchAgentAction` to the `ToolsRegistry`.
2.  Update the agent loop to call `runRegisteredTool` for all actions.
3.  Remove the legacy `dispatchAgentAction` function.

### 3. Refactor `api-key-manager.js`

The `ApiKeyManager` can be streamlined for better efficiency.

**Improvements:**

*   Remove the logic for migrating from a single legacy API key.
*   Simplify the `validateKey` and `validateAllKeys` methods to reduce redundancy.
*   Ensure all key validation respects the health check interval to avoid unnecessary API calls.

### 4. Centralize Configuration

Create a single source of truth for all configuration settings.

**Action:**

*   Create a `common/config.js` file to store constants such as `TIMEOUTS`, `ERROR_TYPES`, `LOG_LEVELS`, and `API_KEY_ROTATION`.
*   Import this configuration file wherever needed, removing scattered constant declarations.

### 5. Improve Session Management

Refactor the session object to be more organized and efficient.

**Suggestions:**

*   Separate session state (e.g., `running`, `step`) from configuration (e.g., `settings`) and logs.
*   Implement a more structured logging system within the session to avoid storing excessively large log arrays.
*   Consider a more lightweight session object for general operations, with detailed context loaded only when needed.

This plan provides a clear path to a more robust and maintainable codebase.

### 6. Advanced Element Discovery

To improve the agent's ability to interact with web pages, we will implement an advanced element discovery system.

**Action:**

*   Create a `content/element-ranker.js` script that assigns an "interactability score" to each element on the page.
*   The scoring system will consider factors such as element type, attributes, visibility, and event listeners.
*   The `content/dom-agent.js` script will be updated to use this new ranking system, replacing the existing `getInteractiveElements` function.
*   This will provide the agent with a more accurate and reliable way to identify and interact with clickable and input elements.