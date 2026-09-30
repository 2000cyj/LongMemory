/*
*  file  : src/mcp/cli.ts
*  usage : CLI entry — `npx longmemory-mcp` starts the MCP HTTP server
*                  `npx longmemory-mcp config` prints effective config
*/

import { start_mcp_http_server, build_default_config_from_env } from './server.js';

function print_config(): void {
    const mask = (s: string | undefined): string => (s ? `${s.slice(0, 4)}…(${s.length} chars)` : '(not set)');

    const cfg = {
        llm: {
            api_key: mask(process.env.LONGMEMORY_LLM_API_KEY
                ?? process.env.LONGMEMORY_OPENAI_API_KEY),
            base_url: process.env.LONGMEMORY_LLM_BASE_URL
                ?? process.env.LONGMEMORY_OPENAI_BASE_URL
                ?? 'https://api.openai.com/v1',
            model: process.env.LONGMEMORY_LLM_MODEL
                ?? process.env.LONGMEMORY_MODEL
                ?? 'gpt-4.1-mini',
        },
        embedding: {
            model: process.env.LONGMEMORY_EMBEDDING_MODEL ?? 'text-embedding-3-small',
            dimensions: process.env.LONGMEMORY_EMBEDDING_DIM
                ? Number(process.env.LONGMEMORY_EMBEDDING_DIM)
                : 1536,
        },
        storage: {
            db_path: process.env.LONGMEMORY_DB_PATH ?? './longmemory.db',
        },
        server: {
            host: process.env.LONGMEMORY_MCP_HOST ?? '127.0.0.1',
            port: Number(process.env.LONGMEMORY_MCP_PORT ?? 7331),
        },
        engine: {
            rerank_depth: process.env.LONGMEMORY_RERANK_DEPTH
                ? Number(process.env.LONGMEMORY_RERANK_DEPTH)
                : 100,
            max_query_variants: process.env.LONGMEMORY_MAX_QUERY_VARIANTS
                ? Number(process.env.LONGMEMORY_MAX_QUERY_VARIANTS)
                : 4,
            min_score: process.env.LONGMEMORY_MIN_SCORE
                ? Number(process.env.LONGMEMORY_MIN_SCORE)
                : 0,
        },
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(cfg, null, 2));
}

async function main(): Promise<void> {
    const sub = process.argv[2];

    // `npx longmemory-mcp config` → print effective config
    if (sub === 'config' || sub === '--config' || sub === '-c') {
        print_config();
        return;
    }

    // `npx longmemory-mcp` (no args) → start MCP server
    if (sub === '--help' || sub === '-h') {
        // eslint-disable-next-line no-console
        console.log('Usage:');
        // eslint-disable-next-line no-console
        console.log('  longmemory-mcp              Start the MCP HTTP server');
        // eslint-disable-next-line no-console
        console.log('  longmemory-mcp config       Print effective configuration');
        // eslint-disable-next-line no-console
        console.log('  longmemory-mcp --help       Show this help');
        return;
    }

    // Validate config early so users get a clear error before the server starts
    try {
        build_default_config_from_env();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[longmemory-mcp] config error:', err instanceof Error ? err.message : err);
        // eslint-disable-next-line no-console
        console.error('Hint: copy .env to your project root and set LONGMEMORY_OPENAI_API_KEY');
        process.exit(1);
    }

    const { close } = await start_mcp_http_server();

    const shutdown = async (signal: string): Promise<void> => {
        // eslint-disable-next-line no-console
        console.log(`[longmemory-mcp] received ${signal}, shutting down`);
        await close();
        process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[longmemory-mcp] fatal:', err);
    process.exit(1);
});
