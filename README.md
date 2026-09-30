# longmemory

> **Memory engine for Node.js + SQLite.** LLM-driven fact extraction, semantic deduplication, multi-signal recall with optional rerank. Ships with built-in **MCP HTTP server** so any AI agent can use it as a memory tool.

A lightweight memory layer for AI agents and applications. Single SQLite file, no external vector database.

## Install

```bash
npm install longmemory
```

Requires Node.js ≥ 20.

---

## Option 1 — Use as a library (in-process)

Best when your agent runs in the same Node process.

```ts
import { LongMemory } from 'longmemory';

const engine = new LongMemory({
  db_path: './memory.db',
  llm: yourLLMProviders,        // see "Bring your own LLM"
  embedding: yourEmbedding,     // see "Bring your own embedding"
  default_scope: { user_id: 'alice' },
});

// Add memories (4-step pipeline runs automatically)
await engine.add('Alice prefers TypeScript for backend work.', {
  scope: { user_id: 'alice' },
});

// Search (4-signal RRF + optional LLM rerank)
const results = await engine.search({
  query: 'What does Alice like for backend?',
  scope: { user_id: 'alice' },
  top_k: 5,
});

engine.close();
```

---

## Option 2 — Run as MCP HTTP server (for external agents)

Best when your agent is in another process / language (Claude Desktop, Cline, Cursor, custom Python agent, etc.).

### Start the server

```bash
# Install LLM API key
export LONGMEMORY_OPENAI_API_KEY=sk-...
export LONGMEMORY_OPENAI_BASE_URL=https://api.openai.com/v1   # or Ollama, etc.

# Optional: customize
export LONGMEMORY_DB_PATH=./memory.db
export LONGMEMORY_MODEL=gpt-4.1-mini
export LONGMEMORY_EMBEDDING_MODEL=text-embedding-3-small
export LONGMEMORY_EMBEDDING_DIM=1536
export LONGMEMORY_MCP_PORT=7331
export LONGMEMORY_MCP_HOST=127.0.0.1

# Launch
npx longmemory-mcp
# Output: [longmemory-mcp] listening on http://127.0.0.1:7331/mcp
```

### 5 MCP tools exposed

| Tool | Description |
|------|-------------|
| `longmemory_add` | Extract facts (LLM) → dedup (LLM) → embed → store |
| `longmemory_search` | Query rewrite (LLM) → 4-signal RRF → optional rerank (LLM) |
| `longmemory_get` | Fetch a single memory by id |
| `longmemory_list` | List memory ids in a scope |
| `longmemory_delete` | Delete a memory by id |

Plus 1 resource: `longmemory://status`

### Configure your MCP client

```json
{
  "mcpServers": {
    "longmemory": {
      "url": "http://127.0.0.1:7331/mcp",
      "transport": "http"
    }
  }
}
```

Or for stdio-based clients, run `npx longmemory-mcp` as a subprocess.

---

## Bring your own LLM

The engine needs 5 LLM methods. Default provider works with any OpenAI-compatible endpoint:

```ts
import { openai_llm } from 'longmemory/providers/openai';

const llm = openai_llm({
  api_key: process.env.OPENAI_API_KEY!,
  base_url: 'https://api.openai.com/v1',  // or http://localhost:11434/v1 (Ollama)
  model: 'gpt-4.1-mini',
});
```

Works with OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, etc.

## Bring your own embedding

```ts
import { openai_embedding } from 'longmemory/providers/openai';

const embedding = openai_embedding({
  api_key: process.env.OPENAI_API_KEY!,
  base_url: 'https://api.openai.com/v1',
  embedding_model: 'text-embedding-3-small',
  embedding_dimensions: 1536,
});
```

Any function with `embed(text): number[]` works — wrap your own provider as needed.

---

## Architecture

### Storage (3-table SQLite schema)

```sql
memories       -- content + embedding BLOB + scope columns + timestamps
entities       -- named entities extracted from memories
memory_entities -- many-to-many link
memories_fts   -- FTS5 virtual table for BM25 keyword search
```

### Ingest pipeline (4 steps)

```
raw text
  → LLM Fact Extraction     -- turn text into atomic facts
  → LLM Semantic Deduplication  -- skip semantically-duplicate facts vs scope
  → Embedding              -- generate vector per fact
  → Storage                -- insert into memories + link entities
```

### Search pipeline (4 signals)

```
query
  → LLM Query Rewriting     -- multiple semantic variants
  → Parallel 4 signals per variant:
       semantic   (cosine similarity over stored embeddings)
       keyword    (BM25 via FTS5)
       entity     (entity name overlap)
       temporal   (recency decay)
  → Reciprocal Rank Fusion (RRF)
  → Optional LLM rerank     -- end-to-end semantic rerank of top candidates
  → top-k results
```

## API

### `LongMemory` (library)

```ts
class LongMemory {
  add(text: string, options?: { scope?, metadata?, source?, skip_dedup?, skip_extract? }): Promise<{ added, skipped }>
  search(query: { query, scope?, top_k?, min_score?, filters? }): Promise<search_result[]>
  get(id: string): stored_memory | null
  delete(id: string): void
  list(scope?: scope, limit?: number): string[]
  status(): { ready, memory_count, entity_count, store_kind }
  close(): void
}
```

### `start_mcp_http_server(options)`

```ts
import { start_mcp_http_server } from 'longmemory/mcp/server';

const { engine, close } = await start_mcp_http_server({
  config: { db_path, llm, embedding },
  port: 7331,
  host: '127.0.0.1',
});
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `LONGMEMORY_OPENAI_API_KEY` | (required) | OpenAI-compatible API key |
| `LONGMEMORY_OPENAI_BASE_URL` | `https://api.openai.com/v1` | API base URL |
| `LONGMEMORY_MODEL` | `gpt-4.1-mini` | LLM model |
| `LONGMEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `LONGMEMORY_EMBEDDING_DIM` | `1536` | Embedding dimensions |
| `LONGMEMORY_DB_PATH` | `./longmemory.db` | SQLite file |
| `LONGMEMORY_MCP_PORT` | `7331` | MCP HTTP port |
| `LONGMEMORY_MCP_HOST` | `127.0.0.1` | MCP HTTP host |

## License

Apache-2.0
