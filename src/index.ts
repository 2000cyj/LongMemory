/*
*  longmemory — memory engine for Node.js + SQLite
*
*  Public API:
*    - Library:  import { LongMemory } from 'longmemory'
*    - MCP HTTP: import { start_mcp_http_server } from 'longmemory/mcp'
*    - Providers: import { openai_llm, openai_embedding } from 'longmemory/providers'
*/

export {
    LongMemory,
} from './core/engine/index.js';

export type {
    engine_config,
    engine_status,
    llm_providers,
    embedding_provider,
    memory_fact,
    stored_memory,
    add_options,
    add_result,
    search_query,
    search_result,
    signal_scores,
    scope,
} from './core/engine/types.js';

// Re-export MCP server utilities
export {
    start_mcp_http_server,
    build_mcp_server,
    build_default_config_from_env,
} from './mcp/server.js';

export type { mcp_server_options } from './mcp/server.js';

// Re-export OpenAI-compatible providers
export {
    openai_llm,
    openai_embedding,
} from './providers/openai.js';

export type { openai_provider_config } from './providers/openai.js';

// Re-export Alibaba DashScope (百炼) provider
export {
    aliyun_embedding,
} from './providers/aliyun.js';

export type { aliyun_embedding_config } from './providers/aliyun.js';
