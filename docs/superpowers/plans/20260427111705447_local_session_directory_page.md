# Local Session Directory Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated local Codex session directory page that groups sessions by project and date, and renders only the meaningful chat content from `.jsonl` files.

**Architecture:** Extend the local session scanner with on-demand file parsing and a session detail endpoint. Add a standalone frontend route with a three-column layout: project/date tree, session title list, and chat-style message viewer. Keep filtering and normalization in the backend so the UI only consumes curated conversation data.

**Tech Stack:** TypeScript, Fastify, vanilla DOM rendering, SQLite-backed app state, JSONL parsing.

---

### Task 1: Add local session detail parsing

**Files:**
- Modify: `src/modules/codex/codex-local-session-service.ts`
- Modify: `src/modules/codex/codex-query-service.ts`
- Modify: `src/routes/codex.ts`
- Test: `tests/codex/codex-local-sessions-api.test.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the test and confirm it fails**
- [ ] **Step 3: Implement session parsing and detail endpoint**
- [ ] **Step 4: Run the test again and confirm it passes**

### Task 2: Build the dedicated session directory page

**Files:**
- Modify: `public/app.js`
- Modify: `public/app.css`
- Modify: `public/index.html`

- [ ] **Step 1: Add route and layout test by manual browser check**
- [ ] **Step 2: Implement project/date/session/chat panes**
- [ ] **Step 3: Wire click handlers for date and session navigation**
- [ ] **Step 4: Verify responsive rendering in the browser**

### Task 3: Add integration coverage for chat-only rendering

**Files:**
- Modify: `tests/codex/codex-local-sessions-api.test.ts`
- Modify: `tests/sessions/session-detail-api.test.ts`

- [ ] **Step 1: Assert project grouping and normalized message output**
- [ ] **Step 2: Assert non-chat JSONL noise is excluded**
- [ ] **Step 3: Run the affected test files**

### Task 4: Polish homepage entry and smoke test

**Files:**
- Modify: `public/app.js`
- Modify: `tests/dashboard/dashboard-api.test.ts`

- [ ] **Step 1: Replace the homepage local sessions block with a page entry**
- [ ] **Step 2: Add a smoke assertion for the new navigation path**
- [ ] **Step 3: Run the full test suite**
