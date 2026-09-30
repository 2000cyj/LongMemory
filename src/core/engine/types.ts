/*
*  file  : src/core/engine/types.ts
*  usage : Public types for the memory engine
*/

/** Scope identifier (user_id / agent_id / run_id / app_id) */
export type scope = {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    app_id?: string;
};

/** A fact extracted from raw text by LLM */
export type memory_fact = {
    text: string;
    category?: string;
    entities?: string[];
    confidence?: number;
};

/** Persisted memory record */
export type stored_memory = {
    id: string;
    scope: scope;
    content: string;
    category?: string;
    entities: { id: string; name: string; type?: string }[];
    embedding_dim?: number;
    metadata?: Record<string, unknown>;
    source?: string;
    created_at: number;
    updated_at: number;
};

/** Search query input */
export type search_query = {
    query: string;
    scope?: scope;
    /** Max results to return. Default 3 (tightened to avoid noise beyond top-relevant items). */
    top_k?: number;
    min_score?: number;
    filters?: {
        category?: string;
        entity_name?: string;
        after?: number;
        before?: number;
    };
};

/** Per-signal score breakdown for a search result */
export type signal_scores = {
    semantic: number;
    keyword: number;
    entity: number;
    temporal: number;
    /** Fused RRF score before rerank */
    fused?: number;
    /** Final score after LLM rerank (if rerank enabled) */
    rerank?: number;
};

/** Single search hit */
export type search_result = {
    id: string;
    content: string;
    category?: string;
    entities: { id: string; name: string }[];
    scores: signal_scores;
    /** Final score (max of fused/rerank) */
    score: number;
    reason?: string;
    created_at: number;
    metadata?: Record<string, unknown>;
};

/** Options for memory.add() — mem0-style: LLM is ALWAYS invoked */
export type add_options = {
    scope?: scope;
    metadata?: Record<string, unknown>;
    source?: string;
};

/** Returned by memory.add() */
export type add_result = {
    added: stored_memory[];
    skipped: Array<{ text: string; reason: string; duplicate_of?: string }>;
};

/** LLM provider bundle */
export type llm_providers = {
    /** Required: extract atomic facts from raw text */
    fact_extractor: {
        extract(text: string, context?: { scope?: scope; locale?: string }): Promise<memory_fact[]>;
    };
    /** Required: semantic deduplication against existing memories */
    deduplicator: {
        isDuplicate(
            candidate: memory_fact,
            existing: Array<{ id: string; content: string }>,
        ): Promise<{ isDuplicate: boolean; duplicateOf?: string; reason?: string }>;
    };
    /** Required: rewrite query into semantic variants */
    query_rewriter: {
        rewrite(query: string, scope?: scope): Promise<string[]>;
    };
    /** Optional: end-to-end rerank of top candidates */
    rerank_provider?: {
        rerank(
            query: string,
            candidates: Array<{ id: string; content: string }>,
            topK: number,
        ): Promise<Array<{ id: string; score: number; reason?: string }>>;
    };
    /** Required: extract entity names from fact text */
    entity_extractor: {
        extract(text: string): Promise<string[]>;
    };
};

/** Embedding provider */
export type embedding_provider = {
    embed(text: string): Promise<number[]>;
    /** Optional: batch embed for efficiency */
    embedBatch?(texts: string[]): Promise<number[][]>;
};

/** Engine configuration */
export type engine_config = {
    /** SQLite database file path */
    db_path: string;
    readonly?: boolean;
    /** LLM providers — REQUIRED */
    llm: llm_providers;
    /** Embedding provider — REQUIRED */
    embedding: embedding_provider;
    /** Default scope applied when caller doesn't specify */
    default_scope?: scope;
    /** Number of candidates forwarded to LLM rerank (default 100) */
    rerank_depth?: number;
    /** Maximum number of query rewrite variants (default 4) */
    max_query_variants?: number;
    /** Default minimum score threshold (0..1) — results below this are filtered */
    min_score?: number;
};

/** Engine status */
export type engine_status = {
    ready: boolean;
    memory_count: number;
    entity_count: number;
    store_kind: 'sqlite';
};
