/*
*  file  : src/mcp/server.ts
*  usage : MCP Streamable HTTP server — exposes LongMemory engine to AI agents over HTTP.
*
*  Endpoints exposed as MCP tools:
*    - longmemory_add     : extract facts → dedup → embed → store
*    - longmemory_search  : query rewrite → 4-signal RRF → optional rerank
*    - longmemory_get     : fetch a single memory by id
*    - longmemory_list    : list memory ids in a scope
*    - longmemory_delete  : delete a memory by id
*
*  Run:
*    npx longmemory-mcp                          # uses env config (OpenAI-compatible)
*    LONGMEMORY_OPENAI_API_KEY=... \
*    LONGMEMORY_OPENAI_BASE_URL=https://api.openai.com/v1 \
*    LONGMEMORY_DB_PATH=./memory.db \
*    npx longmemory-mcp
*/

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { LongMemory } from '../core/engine/index.js';
import { openai_llm, openai_embedding } from '../providers/openai.js';
import type { engine_config, llm_providers, embedding_provider, scope } from '../core/engine/types.js';

export type mcp_server_options = {
    /** Pre-built LongMemory engine (caller manages lifecycle) */
    engine?: LongMemory;
    /** Build the engine from this config (LLM/embedding providers required) */
    config?: engine_config;
    /** HTTP port (default 7331) */
    port?: number;
    /** HTTP host (default 127.0.0.1) */
    host?: string;
};

/**
 * Build the MCP server wrapping a LongMemory engine instance.
 */
export function build_mcp_server(engine: LongMemory): McpServer {
    const server = new McpServer({
        name: 'longmemory',
        version: '2.0.0',
    });

    // ── Tool: longmemory_add ────────────────────────────────────────
    server.tool(
        'longmemory_add',
        'Add text to memory. Internally: LLM extracts atomic facts, LLM dedups, embed, store in SQLite.',
        {
            text: z.string().describe('Raw text to remember'),
            user_id: z.string().optional().describe('Scope: user id'),
            agent_id: z.string().optional().describe('Scope: agent id'),
            run_id: z.string().optional().describe('Scope: run/session id'),
            app_id: z.string().optional().describe('Scope: app id'),
            source: z.string().optional().describe('Provenance tag (e.g. "chat", "tool:browser")'),
        },
        async (args) => {
            const scope: scope = {
                user_id: args.user_id,
                agent_id: args.agent_id,
                run_id: args.run_id,
                app_id: args.app_id,
            };
            const result = await engine.add(args.text, {
                scope,
                source: args.source,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            added_count: result.added.length,
                            skipped_count: result.skipped.length,
                            added: result.added.map((m) => ({ id: m.id, content: m.content, category: m.category })),
                            skipped: result.skipped,
                        }, null, 2),
                    },
                ],
            };
        },
    );

    // ── Tool: longmemory_search ─────────────────────────────────────
    server.tool(
        'longmemory_search',
        'Search memory by semantic query. Internally: LLM query rewrite, 4-signal recall (semantic + BM25 keyword + entity + temporal), RRF fusion, optional LLM rerank.',
        {
            query: z.string().describe('Natural language query'),
            user_id: z.string().optional().describe('Scope: user id'),
            agent_id: z.string().optional().describe('Scope: agent id'),
            run_id: z.string().optional().describe('Scope: run/session id'),
            app_id: z.string().optional().describe('Scope: app id'),
            top_k: z.number().optional().describe('Number of results (default 10)'),
            min_score: z.number().optional().describe('Minimum score threshold (0-1)'),
            category: z.string().optional().describe('Filter by category'),
            entity_name: z.string().optional().describe('Filter by entity name'),
        },
        async (args) => {
            const scope: scope = {
                user_id: args.user_id,
                agent_id: args.agent_id,
                run_id: args.run_id,
                app_id: args.app_id,
            };
            const results = await engine.search({
                query: args.query,
                scope,
                top_k: args.top_k,
                min_score: args.min_score,
                filters: {
                    category: args.category,
                    entity_name: args.entity_name,
                },
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            count: results.length,
                            hits: results.map((r) => ({
                                id: r.id,
                                score: r.score,
                                content: r.content,
                                category: r.category,
                                entities: r.entities.map((e) => e.name),
                                reason: r.reason,
                                signals: {
                                    semantic: r.scores.semantic,
                                    keyword: r.scores.keyword,
                                    entity: r.scores.entity,
                                    temporal: r.scores.temporal,
                                    fused: r.scores.fused,
                                    rerank: r.scores.rerank,
                                },
                            })),
                        }, null, 2),
                    },
                ],
            };
        },
    );

    // ── Tool: longmemory_get ────────────────────────────────────────
    server.tool(
        'longmemory_get',
        'Fetch a single memory by id.',
        {
            id: z.string().describe('Memory id'),
        },
        async (args) => {
            const memory = engine.get(args.id);
            if (!memory) {
                return { content: [{ type: 'text', text: JSON.stringify({ found: false }) }] };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            found: true,
                            id: memory.id,
                            content: memory.content,
                            category: memory.category,
                            entities: memory.entities.map((e) => e.name),
                            scope: memory.scope,
                            created_at: memory.created_at,
                            metadata: memory.metadata,
                        }, null, 2),
                    },
                ],
            };
        },
    );

    // ── Tool: longmemory_list ───────────────────────────────────────
    server.tool(
        'longmemory_list',
        'List memory ids in a scope (latest first).',
        {
            user_id: z.string().optional().describe('Scope: user id'),
            agent_id: z.string().optional().describe('Scope: agent id'),
            run_id: z.string().optional().describe('Scope: run/session id'),
            app_id: z.string().optional().describe('Scope: app id'),
            limit: z.number().optional().describe('Max number of ids (default 100)'),
        },
        async (args) => {
            const scope: scope = {
                user_id: args.user_id,
                agent_id: args.agent_id,
                run_id: args.run_id,
                app_id: args.app_id,
            };
            const ids = engine.list(scope, args.limit ?? 100);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ count: ids.length, ids }, null, 2),
                    },
                ],
            };
        },
    );

    // ── Tool: longmemory_delete ─────────────────────────────────────
    server.tool(
        'longmemory_delete',
        'Delete a memory by id.',
        {
            id: z.string().describe('Memory id'),
        },
        async (args) => {
            engine.delete(args.id);
            return {
                content: [{ type: 'text', text: JSON.stringify({ deleted: true, id: args.id }) }],
            };
        },
    );

    // ── Resource: server status ─────────────────────────────────────
    server.resource('status', 'longmemory://status', async () => {
        const s = engine.status();
        return {
            contents: [
                {
                    uri: 'longmemory://status',
                    mimeType: 'application/json',
                    text: JSON.stringify(s, null, 2),
                },
            ],
        };
    });

    return server;
}

/**
 * Start an HTTP server exposing the MCP Streamable transport at POST /mcp.
 *
 * If `config` is provided (no engine), this helper also builds a default
 * OpenAI-compatible LLM + embedding provider from env vars:
 *   LONGMEMORY_OPENAI_API_KEY    (required)
 *   LONGMEMORY_OPENAI_BASE_URL   (default: https://api.openai.com/v1)
 *   LONGMEMORY_MODEL             (default: gpt-4.1-mini)
 *   LONGMEMORY_EMBEDDING_MODEL   (default: text-embedding-3-small)
 *   LONGMEMORY_EMBEDDING_DIM     (default: 1536)
 *   LONGMEMORY_DB_PATH           (default: ./longmemory.db)
 */
export async function start_mcp_http_server(options: mcp_server_options = {}): Promise<{ engine: LongMemory; close: () => Promise<void> }> {
    let engine: LongMemory;
    if (options.engine) {
        engine = options.engine;
    } else {
        const config = options.config ?? build_default_config_from_env();
        engine = new LongMemory(config);
    }

    const server = build_mcp_server(engine);

    const read_body = (req: IncomingMessage): Promise<unknown> => {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!raw) return resolve(undefined);
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    resolve(raw);
                }
            });
            req.on('error', reject);
        });
    };

    const handle_request = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            const parsed_body = await read_body(req);
            // Stateless mode: create a fresh transport + connect for each request
            // (avoids SDK reusing a single transport's internal state across calls)
            const per_request_transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await server.connect(per_request_transport);
            try {
                await per_request_transport.handleRequest(req, res, parsed_body);
            } finally {
                try { await per_request_transport.close(); } catch { /* ignore */ }
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[longmemory-mcp] request error:', err);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
                    id: null,
                }));
            } else {
                try { res.end(); } catch { /* already closed */ }
            }
        }
    };

    const http_server = createServer((req, res) => {
        if (req.url === '/mcp' && req.method === 'POST') {
            handle_request(req, res);
            return;
        }
        if (req.url === '/health' && req.method === 'GET') {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, status: engine.status() }));
            return;
        }
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found', path: req.url }));
    });

    const port = options.port ?? Number(process.env.LONGMEMORY_MCP_PORT ?? 7331);
    const host = options.host ?? process.env.LONGMEMORY_MCP_HOST ?? '127.0.0.1';

    http_server.listen(port, host, () => {
        // eslint-disable-next-line no-console
        console.log(`[longmemory-mcp] listening on http://${host}:${port}/mcp`);
    });

    return {
        engine,
        close: async () => {
            await new Promise<void>((resolve) => http_server.close(() => resolve()));
            await server.close();
            engine.close();
        },
    };
}

/**
 * Build a default engine config from environment variables.
 * Uses OpenAI-compatible API for both LLM and embeddings.
 */
export function build_default_config_from_env(): engine_config {
    const api_key = process.env.LONGMEMORY_OPENAI_API_KEY;
    if (!api_key) {
        throw new Error(
            'LONGMEMORY_OPENAI_API_KEY is required when no engine is provided. ' +
            'Set it in .env or as an environment variable.'
        );
    }
    const base_url = process.env.LONGMEMORY_OPENAI_BASE_URL;
    // LLM config: can override the LLM-specific key/url/model; otherwise
    // fall back to the shared LONGMEMORY_OPENAI_* vars.
    const llm_api_key = process.env.LONGMEMORY_LLM_API_KEY
        ?? process.env.LONGMEMORY_OPENAI_API_KEY;
    const llm_base_url = process.env.LONGMEMORY_LLM_BASE_URL
        ?? process.env.LONGMEMORY_OPENAI_BASE_URL;
    const llm_model = process.env.LONGMEMORY_LLM_MODEL
        ?? process.env.LONGMEMORY_MODEL;
    const llm: llm_providers = openai_llm({
        api_key: llm_api_key!,
        base_url: llm_base_url,
        model: llm_model,
    });
    // Embedding config: same pattern with LONGMEMORY_EMBEDDING_* override.
    const embedding: embedding_provider = openai_embedding({
        api_key,
        base_url,
        embedding_model: process.env.LONGMEMORY_EMBEDDING_MODEL,
        embedding_dimensions: process.env.LONGMEMORY_EMBEDDING_DIM
            ? Number(process.env.LONGMEMORY_EMBEDDING_DIM)
            : undefined,
    });
    const default_scope: scope | undefined = (() => {
        const u = process.env.LONGMEMORY_DEFAULT_SCOPE_USER_ID;
        const a = process.env.LONGMEMORY_DEFAULT_SCOPE_AGENT_ID;
        if (!u && !a) return undefined;
        return { user_id: u, agent_id: a };
    })();
    return {
        db_path: process.env.LONGMEMORY_DB_PATH ?? './longmemory.db',
        llm,
        embedding,
        default_scope,
        rerank_depth: process.env.LONGMEMORY_RERANK_DEPTH
            ? Number(process.env.LONGMEMORY_RERANK_DEPTH)
            : undefined,
        max_query_variants: process.env.LONGMEMORY_MAX_QUERY_VARIANTS
            ? Number(process.env.LONGMEMORY_MAX_QUERY_VARIANTS)
            : undefined,
    };
}
