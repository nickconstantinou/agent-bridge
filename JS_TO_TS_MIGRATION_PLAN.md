# Agent Bridge: JavaScript → TypeScript Migration Plan

## Overview

Migrate the agent-bridge project from JavaScript to TypeScript using an incremental approach that maintains production stability throughout the process.

---

## Current State Analysis

### Project Metrics

| Metric | Value |
|--------|-------|
| Source Files | 11 |
| Test Files | 16 |
| Total Lines | 1,903 |
| Build Tool | Vite (via Vitest) |
| Test Runner | Vitest 4.x |

### File Inventory

```
src/
├── bridge.js      (6KB)  - CLI invocation builders
├── cli.js         (15KB) - Process spawn/runners
├── commands.js    (1.5KB) - Bot commands
├── index.js       (14KB) - Main bridge class
├── messageDelivery.js (6KB) - Telegram delivery
├── outbox.js     (2KB)  - Message queue
├── render.js     (5KB)  - Telegram formatting
├── state.js       (3KB)  - State management
├── store.js      (2KB)  - Persistence
├── telegram.js    (5KB)  - Telegram API client
└── updateLifecycle.js (0.4KB) - Update processing
```

---

## Migration Strategy

### Core Principle: Incremental, Not Big Bang

1. **Keep .js files working** throughout the migration
2. **Use `allowJs: true`** in TypeScript config
3. **Add types file-by-file** by priority
4. **Rename when confident** (~80% type coverage)

### Why This Approach?

- Zero production downtime
- Can rollback at any phase
- Type safety improves incrementally
- Tests continue passing throughout

---

## Phase-by-Phase Plan

### Phase 0: TypeScript Setup (30 min)

**Goal:** Valid TypeScript build without code changes.

```bash
# Install TypeScript
npm install -D typescript @types/node

# Create tsconfig.json
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "allowJs": true,
    "checkJs": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

# Run type check to see baseline errors
npx tsc --noEmit
```

**Expected Errors:** 50-100 (we'll fix these in Phase 1)

---

### Phase 1: Core Type Definitions (1 hour)

**Goal:** Define all interfaces used across the codebase.

```typescript
// src/types/index.ts

// Configuration
interface BridgeConfig {
  allowedUserId: string;
  serviceEnvFile: string;
  serviceKind: 'codex' | 'gemini' | 'minimax' | 'qwen';
  pollIntervalMs: number;
  executionMode: 'safe' | 'trusted';
  cliTimeoutMs: number;
  asyncEnabled: boolean;
}

interface BotConfig {
  token: string;
  command: string;
  defaultModel: string | null;
}

// CLI Execution
interface CliOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number | null;
  killGraceMs?: number;
  onProgress?: (text: string) => void;
  onCancel?: () => void;
}

interface Invocation {
  command: string;
  args: string[];
}

interface CliResult {
  text: string;
  sessionId: string | null;
}

// Telegram Types
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallback;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; first_name: string; last_name?: string };
  text?: string;
}

interface TelegramCallback {
  id: string;
  message?: TelegramMessage;
  from: { id: number };
  data?: string;
}

// Bridge State
interface ProcessedUpdateId {
  value: number;
  updatedAtMs: number;
}

// Session
interface Session {
  id: string;
}
```

---

### Phase 2: High-Impact Files (Priority Order)

These files have the most external dependencies and benefit most from types.

#### 2a. src/index.ts - Main Entry (45 min)

**Current:** BridgeBot class, handleUpdate, executePrompt*

**Tasks:**
- Define BridgeBot interface with full generic types
- Type handleUpdate input/output
- Type executePrompt results

```typescript
class BridgeBot {
  kind: 'codex' | 'gemini';
  config: BotConfig;
  client: TelegramClient;
  
  async run(): Promise<void>;
  async handleUpdate(update: TelegramUpdate): Promise<void>;
  async executePrompt(prompt: string, sessionId: string | null, chatId: number): Promise<CliResult>;
  async executePromptAsync(prompt: string, sessionId: string | null, chatId: number): Promise<CliResult>;
}
```

#### 2b. src/telegram.ts - API Client (30 min)

**Current:** TelegramClient wraps HTTP calls

**Tasks:**
- Type all Telegram API responses
- Type update parsing
- Add type guards

```typescript
interface TelegramClient {
  constructor(token: string);
  getUpdates(params: GetUpdatesParams): Promise<GetUpdatesResponse>;
  sendMessage(params: SendMessageParams): Promise<Message>;
  editMessageText(params: EditMessageTextParams): Promise<Message>;
  // ... all methods
}
```

#### 2c. src/cli.js → cli.ts (30 min)

**Current:** runCli, runCliAsync, buildCliInvocation

**Tasks:**
- Type CliOptions interface
- Type spawn process events
- Type parse results

---

### Phase 3: Supporting Files (2 hours)

| File | Size | Tasks |
|------|------|-------|
| messageDelivery.ts | 6KB | Type sendMessage options |
| render.ts | 5KB | Type Telegram formatting |
| state.ts | 3KB | Type state persistence |
| outbox.ts | 2KB | Type queue operations |
| store.ts | 2KB | Type storage interface |
| commands.ts | 1.5KB | Type command handlers |
| updateLifecycle.ts | 0.4KB | Type update flow |

---

### Phase 4: Testing (1 hour)

**Rename tests from .js to .ts:**

```bash
# Example
mv test/bridge.test.js test/bridge.test.ts
mv test/cli.test.js test/cli.test.ts
# ... all 16 test files
```

**Add type-safe mocks:**

```typescript
// test/__mocks__/telegram.ts
export const mockTelegramClient = {
  getUpdates: vi.fn<Promise<TelegramUpdate[]>>(),
  sendMessage: vi.fn<Promise<TelegramMessage>>(),
  editMessageText: vi.fn<Promise<TelegramMessage>>(),
  // Add return types for all methods
};
```

---

## Timeline Summary

| Phase | Duration | Cumulative |
|-------|----------|-----------|
| Phase 0: Setup | 30 min | 30 min |
| Phase 1: Types | 1 hour | 1.5 hours |
| Phase 2: Core Files | 2 hours | 3.5 hours |
| Phase 3: Supporting | 2 hours | 5.5 hours |
| Phase 4: Tests | 1 hour | 6.5 hours |
| **Buffer/Padding** | 3.5 hours | **~10 hours** |

---

## Configuration Files to Update

```json
// package.json - Add build script
{
  "scripts": {
    "build": "tsc",
    "build:watch": "tsc --watch",
    "type-check": "tsc --noEmit"
  }
}

// vitest.config.js - Already supports TS
// No changes needed!
```

---

## Rollback Plan

If anything goes wrong:

```bash
# Revert to JavaScript
git checkout HEAD~1 -- src/

# Keep TypeScript types for future
# Just don't commit tsconfig.json changes
```

---

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Build works | `npm run build` produces dist/ |
| Tests pass | `npm test` exits 0 |
| No implicit any | `npx tsc --noEmit` reports 0 |
| IDE support | VS Code autocomplete works |

---

## Recommended Step Order

1. **Phase 0** - Run `npm install -D typescript @types/node`
2. **Create tsconfig.json** with allowJs + checkJs
3. **Run type check** - See baseline errors
4. **Create src/types/index.ts** - Define interfaces
5. **Phase 2** - Index, telegram, cli (priority order)
6. **Phase 3** - Supporting files
7. **Phase 4** - Rename tests

---

## Notes

- **Vitest already supports .ts** - No config changes needed
- **Existing imports work** - ES modules via Vite
- **No runtime changes** - Unless you introduce breaking changes
- **Incremental is safe** - Can stop at any phase