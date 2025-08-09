# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains **AI Side Panel Extension** - a sophisticated Chrome extension with autonomous browser control capabilities using the Gemini API for intelligent task automation.

## Development Commands

### Main Project (`sidepanel-ai-extension/`)

**No build system required** - this is a vanilla JavaScript Chrome extension that runs directly:

```bash
# E2E Testing
cd sidepanel-ai-extension
npm test  # Runs Playwright tests

# Extension Development
# 1. Load unpacked extension in Chrome from `sidepanel-ai-extension/` directory
# 2. Make changes to files directly (JS, CSS, HTML)
# 3. Reload extension in Chrome extensions page

# Manual Testing
# - Open Chrome DevTools for background script debugging
# - Use extension's side panel for UI testing
# - Monitor console logs in both background script and content script contexts
```

### Testing Strategy

```bash
# E2E Tests (Playwright)
npm test                    # Run all E2E tests
npx playwright test --headed  # Run with browser UI
npx playwright test typeText.test.js  # Run specific test

# Manual Testing Workflow
# 1. Open extension side panel in Chrome
# 2. Test autonomous automation workflows
# 3. Monitor background.js logs in Chrome DevTools > Extensions
# 4. Check content script logs in page DevTools > Console
```

## Architecture Overview

### High-Level System Design

**Multi-Layer Autonomous Browser Automation**
- **Service Worker Background** (`background/background.js`): Agent orchestration, tool registry, session management
- **Content Script Injection** (`content/content.js`): DOM manipulation, page interaction, element detection  
- **Side Panel UI** (`sidepanel/`): User interface, chat-based interaction, template selection
- **AI Integration**: Gemini API for autonomous decision-making and natural language processing

### Core Components

#### **1. Agent System Architecture**
```
background.js (Service Worker)
├── AgentSession Management → Persistent state across page navigation
├── Tool Registry → 25+ tools for browser automation  
├── Template System → Pre-built workflows for common tasks
├── Connection Manager → BFCache-resistant communication
└── Performance Optimization → Caching, throttling, retry coordination
```

#### **2. Autonomous Decision Making**
- **Template-Guided Planning** (`common/automation-templates.js`): 15+ pre-built workflows across 5 categories
- **Enhanced Prompt Engineering** (`common/prompts.js`): Context-aware AI decision making  
- **Smart Site Selection**: AI chooses appropriate websites automatically
- **Multi-Source Strategy**: Research across multiple authoritative sources

#### **3. Advanced Interaction Capabilities**
**Core Tools** (`background/background.js` + `content/content.js`):
- `clickElement`, `typeText`, `waitForSelector` - Basic interactions
- `uploadFile` - File input handling with automatic test file creation
- `fillForm` - Multi-field form completion with intelligent field detection
- `selectOption` - Enhanced dropdown/select handling
- `dragAndDrop` - Drag and drop operations
- `scrapeSelector`, `readPageContent` - Data extraction
- `navigateToUrl`, `scrollTo` - Navigation and positioning

#### **4. Communication Layer**
```
background.js ←→ content.js (via chrome.runtime messaging)
├── BFCache Recovery → Automatic reconnection on page restoration
├── Element Refresh Strategy → Always-fresh DOM references  
├── Performance Optimization → 70-80% reduction in redundant operations
└── Error Handling → Progressive timeout strategies, retry policies
```

### Key Files and Architecture

#### **Background Service Worker**
- `background/background.js` - Main orchestrator (6000+ lines)
  - Agent session management and state persistence
  - Tool registry with 25+ automation tools
  - Template-guided autonomous decision making
  - BFCache-resistant communication layer
  - Performance optimizations and error handling

#### **Content Script System**
- `content/content.js` - DOM interaction layer (3000+ lines)
  - Advanced DOM manipulation and element detection
  - File upload, form filling, drag & drop capabilities
  - Element visibility detection and timing coordination
  - Enhanced selector strategies and fuzzy matching

#### **AI Integration Layer**
- `common/prompts.js` - AI prompt engineering for autonomous behavior
- `common/automation-templates.js` - 15+ pre-built automation workflows
- `common/api.js` - Gemini API integration and response processing

#### **User Interface**
- `sidepanel/sidepanel.js` - Main UI controller with template cards
- `sidepanel/sidepanel.html` - Side panel interface with automation templates
- `sidepanel/components/activity-timeline.js` - Real-time execution monitoring

#### **Session & State Management**
- `background/session-manager.js` - Persistent agent sessions across navigation
- `background/observer.js` - Agent execution timeline and event tracking
- `common/storage.js` - IndexedDB integration for complex data persistence

## Autonomous Capabilities

### **Template Categories**
1. **🛒 E-commerce**: Product research, price tracking, cart management
2. **📱 Social Media**: Cross-platform posting, social listening  
3. **🔍 Research**: Academic research, market analysis, news aggregation
4. **⚡ Productivity**: Email management, data collection, form filling
5. **🎵 Media**: Playlist management, video curation

### **Advanced Interactions**
- **File Operations**: Automatic file upload with data URL conversion
- **Complex Forms**: Multi-step wizard navigation and field mapping  
- **Dynamic Content**: Enhanced SPA and React application support
- **Smart Field Detection**: Multiple strategies for form field identification

### **Performance & Reliability**
- **BFCache Resistance**: Robust communication across page navigation
- **Progressive Timeouts**: Multi-layered selector waiting strategies
- **Element Refresh**: Always-fresh DOM references prevent stale interactions  
- **Error Recovery**: Intelligent retry policies and fallback mechanisms

## Development Patterns

### **Tool Development**
New tools are registered in `background/background.js` using:
```javascript
globalThis.ToolsRegistry.registerTool({
  id: "toolName",
  title: "Tool Display Name", 
  description: "Tool description",
  capabilities: { requiresContentScript: true, ... },
  inputSchema: { type: "object", properties: {...} },
  run: async (ctx, input) => { /* implementation */ }
});
```

### **Content Script Handlers**
Add new message handlers in `content/content.js`:
```javascript
case MSG.NEW_ACTION: {
  handleNewAction(message, sendResponse);
  break;
}
```

### **Template Creation**
Add new automation workflows in `common/automation-templates.js`:
```javascript
static getNewCategoryTemplates() {
  return {
    'template-id': {
      id: 'template-id',
      name: 'Template Name',
      description: 'Template description',
      settings: { maxSteps: 20, autoScreenshots: false },
      workflow: ['Step 1', 'Step 2', 'Step 3']
    }
  };
}
```

## Architecture Notes

### **Service Worker Limitations**
- No DOM access (requires content script communication)
- Limited storage (uses chrome.storage and IndexedDB via content scripts)
- Import scripts via `importScripts()` in dependency order

### **Cross-Context Communication**  
- **Background ↔ Content**: `chrome.runtime.sendMessage` + `AgentPortManager`
- **Background ↔ Sidepanel**: `chrome.runtime.sendMessage` + event listeners
- **Template Access**: Both `window.AutomationTemplates` (browser) and `globalThis.AutomationTemplates` (service worker)

### **BFCache Handling**
Critical for reliable automation across page navigation:
- Connection health monitoring with 500ms cache TTL  
- Element cache invalidation on navigation events
- Automatic content script re-injection on page restore
- Progressive timeout strategies for dynamic content

### **Performance Optimization**
- Element fetch caching with adaptive TTL (1-3 seconds based on operation)
- Connection health caching to prevent redundant checks
- Retry coordination to prevent excessive refresh cycles  
- DOM readiness checking for better timing synchronization