# LongMemory

> **Durable, temporal, governed project-level memory for Node.js agents. Local-first. Immutable by design.**

A governed memory layer that lets your Node.js agents carry durable state across sessions without surrendering ownership, auditability, or temporal truth.

- Immutable content with recorded-time and valid-time history
- Executable typed edges, entities, worlds, grounding, contradiction, and provenance
- Strict, historical, associative, world-grounded, and multilingual recall
- Deterministic decay and explicit reinforcement without rewriting source truth
- Local-first SQLite store; in-memory mode for embedded use
- One TypeScript package: library import, CLI, HTTP server, MCP transports

Your model stays stateless. **Your agent stops being amnesiac.**

---

## 1. Install

```bash
npm install longmemory
# or
pnpm add longmemory
```

Requires Node.js >= 20. Native dependencies (`better-sqlite3`) compile on install.

---

## 2. Use as a library

```ts
import { createMemory } from 'longmemory';

// In-process, no external service
const memory = createMemory({
  store: 'memory',                  // 'memory' | 'sqlite'
  db_path: './project-memory.db',   // only when store='sqlite'
  tenant_id: 'my-project',
  user_id: 'agent-runtime',
  default_world: 'project-knowledge',
  max_context_tokens: 4096,
});

// Write
await memory.ingest({
  text: 'User prefers TypeScript for backend services',
  world: 'project-knowledge',
  source: { id: 'chat', kind: 'manual', reliability: 0.9 },
});

// Recall (4 modes)
const strict = await memory.recall({
  text: 'What language does the user prefer?',
  mode: 'strict',
  k: 10,
  token_budget: 2048,
});

// Maintenance
await memory.runDecay({ limit: 256 });
await memory.reinforce(ingest.node.id, { amount: 0.3 });

await memory.close();
```

The same instance is safe to share across multiple agent calls — all state lives in memory and optional SQLite.

---

## 3. Project-level pattern

For agent projects, scope memory to the project and let multiple agents share it:

```ts
import { createMemory } from 'longmemory';

export const projectMemory = createMemory({
  store: 'sqlite',
  db_path: './.longmemory/project.db',
  tenant_id: 'my-agent-project',
  user_id: 'system',
  default_world: 'project-knowledge',
  enable_consolidation: true,
});

export async function remember(text: string, source: string) {
  return projectMemory.ingest({
    text,
    source: { id: source, kind: 'api', reliability: 0.8 },
  });
}

export async function recallContext(query: string, budget = 2048) {
  const result = await projectMemory.recall({
    text: query,
    mode: 'strict',
    token_budget: budget,
  });
  // adapt to your agent's context shape
  return result;
}
```

---

## 4. Run as a local HTTP server (optional)

Useful when multiple processes need to share memory:

```ts
// In your project
import { createServer } from 'node:http';
import { create_long_memory_server } from 'longmemory/server';

const server = create_long_memory_server({
  memory: createMemory({ store: 'sqlite', db_path: './shared.db' }),
});
server.listen(7331, '127.0.0.1');
```

Or run the bundled binary:

```bash
npx longmemory serve
# or after build:
node node_modules/longmemory/dist/server/index.js
```

REST routes are documented in [`docs/api.md`](docs/api.md).

---

## 5. Run as a local MCP server (optional)

For agents that speak the Model Context Protocol:

```bash
npx longmemory mcp
# or after build:
node node_modules/longmemory/dist/cli/index.js mcp
```

See [`docs/mcp.md`](docs/mcp.md).

---

## 6. Recall modes

| Mode | Purpose | When to use |
|------|---------|-------------|
| `strict` | High-confidence direct recall | Default; "what is true now" |
| `historical` | Time-travel through versions | "what was the API endpoint in March?" |
| `associative` | Graph-walk across related entities | "incidents related to the migration" |
| `world_grounded` | Requires external source citations | "which endpoint is live, with proof?" |

All modes return explainable evidence with token-bounded context. See [`docs/strict-recall.md`](docs/strict-recall.md), [`docs/historical-recall.md`](docs/historical-recall.md), [`docs/associative-recall.md`](docs/associative-recall.md), [`docs/world-grounded-recall.md`](docs/world-grounded-recall.md).

---

## 7. Core invariants

1. Memory content and provenance are immutable; mutable lifecycle state is stored separately.
2. Recorded time and valid time are distinct.
3. Project, tenant, user, agent, and framework identity are enforced by the runtime.
4. Recall is read-only and token bounded.
5. Deny rules override grants for governed assets.
6. SQLite is the local durable store; in-memory storage is available for embedded use.

See [`docs/invariants.md`](docs/invariants.md).

---

## 8. Configuration

LongMemory reads `LONGMEMORY_*` environment variables (see [`.env.example`](.env.example)). Library use only needs the engine options passed to `createMemory()` — env vars are only used by the bundled server/CLI.

Embedding providers (`openai`, `gemini`, `aws`, `ollama`, `local`, `siray`, `synthetic`) are pluggable; the default `synthetic` is deterministic and dependency-free.

---

## 9. Reference

- [`Why.md`](Why.md) — design rationale
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — subsystem overview
- [`docs/`](docs/) — 30+ topic documents (recall modes, edges, grounding, ingestion, etc.)

---

## 10. License

Apache-2.0. See [`LICENSE`](LICENSE).
