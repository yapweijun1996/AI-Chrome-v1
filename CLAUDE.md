# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

This repository contains multiple Chrome extension projects:

### Main Project: Chrome MCP Server (`Example/mcp-chrome-master/`)
A sophisticated Chrome extension that exposes browser functionality to AI assistants via the Model Context Protocol (MCP). This is a monorepo with two main applications:

- **Chrome Extension** (`app/chrome-extension/`): Browser automation with AI-powered content analysis
- **Native Server** (`app/native-server/`): MCP protocol implementation and native messaging bridge
- **Shared Packages** (`packages/`): Common types and WASM-optimized math functions

### Secondary Project: AI Side Panel Extension (`sidepanel-ai-extension/`)
A simpler Chrome extension with AI-driven side panel for task management using Gemini API.

## Development Commands

### Chrome MCP Server (Primary Focus)
Navigate to `Example/mcp-chrome-master/` for all commands:

```bash
# Install dependencies
pnpm install

# Development (runs all components in parallel)
pnpm dev

# Build all components
pnpm build

# Individual component commands
pnpm dev:extension    # Chrome extension only
pnpm dev:native      # Native server only
pnpm build:extension # Chrome extension build
pnpm build:native    # Native server build
pnpm build:wasm      # Build WASM SIMD components

# Code quality
pnpm lint
pnpm lint:fix
pnpm format
pnpm typecheck

# Testing (native server)
cd app/native-server && npm test
```

### Chrome Extension Specific Commands
In `Example/mcp-chrome-master/app/chrome-extension/`:

```bash
# Development with WXT framework
npm run dev
npm run build
npm run zip          # Package for distribution

# Code quality
npm run lint
npm run compile      # TypeScript compilation check
```

## High-Level Architecture

### Chrome MCP Server Architecture
- **MCP Protocol Layer**: HTTP/SSE transport with Fastify server
- **Native Messaging**: Bridges AI assistants with Chrome extension
- **Browser APIs Integration**: Comprehensive Chrome API access (tabs, bookmarks, network, etc.)
- **AI Processing Layer**: SIMD-optimized semantic similarity engine with vector database
- **Workflow Orchestration**: Advanced multi-step automation with dependencies, retries, and error handling
- **Multi-Component System**: Extension + native server + shared packages

#### New Workflow Features (Added)
- **Complex Task Automation**: Multi-step workflows with step dependencies and parallel execution
- **Enhanced Error Handling**: Retry policies, rollback mechanisms, and graceful degradation
- **Template System**: Save, load, and share reusable workflow templates
- **Condition-Based Logic**: Wait for elements, network idle, custom JavaScript conditions
- **State Management**: Variable substitution and context passing between steps
- **Monitoring**: Real-time execution tracking and workflow management

### Key Technologies
- **Frontend**: WXT framework + Vue 3 + TypeScript
- **Backend**: Fastify + Native Messaging + MCP SDK
- **AI/ML**: Transformers.js, ONNX Runtime, WASM SIMD optimization
- **Build System**: pnpm workspaces, TypeScript, ESLint + Prettier
- **Vector Database**: hnswlib-wasm for semantic search

### SIMD Performance Optimization
The project includes custom Rust-based WASM SIMD modules for 4-8x faster vector operations in AI processing. WASM files are built separately and copied to the extension workers directory.

## Key Files and Directories

- `pnpm-workspace.yaml`: Monorepo workspace configuration
- `app/chrome-extension/wxt.config.ts`: Chrome extension build configuration
- `app/native-server/src/mcp/`: MCP protocol implementation
- `packages/shared/`: Common types and tool definitions
- `packages/wasm-simd/`: Rust SIMD optimizations
- `docs/ARCHITECTURE.md`: Detailed technical architecture
- `docs/TOOLS.md`: Complete tool API documentation

### Workflow Orchestration Files
- `app/chrome-extension/utils/workflow-engine.ts`: Core workflow execution engine
- `app/chrome-extension/utils/workflow-templates.ts`: Pre-built workflow templates
- `app/chrome-extension/entrypoints/background/tools/browser/workflow.ts`: Workflow tools
- `app/chrome-extension/entrypoints/background/tools/browser/workflow-monitor.ts`: Monitoring tools
- `app/chrome-extension/inject-scripts/workflow-helper.js`: Enhanced content script for workflows

## Installation and Setup

1. Install dependencies: `pnpm install` (from monorepo root)
2. Build WASM components: `pnpm build:wasm`
3. Build all components: `pnpm build`
4. Install native bridge globally: `npm install -g mcp-chrome-bridge`
5. Load Chrome extension from `app/chrome-extension/dist/`

## Testing Strategy

- Native server has Jest test suite in `app/native-server/`
- Extension testing is manual via Chrome developer tools
- AI components tested via semantic similarity benchmarks
- Use `npm run test` in native-server directory for backend tests