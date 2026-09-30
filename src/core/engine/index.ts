/*
*  file  : src/core/engine/index.ts
*  usage : Public API — LongMemory class
*/

import { Store } from './store.js';
import { Ingest } from './ingest.js';
import { Search } from './search.js';
import type {
    add_options,
    add_result,
    engine_config,
    engine_status,
    search_query,
    search_result,
} from './types.js';

export class LongMemory {
    readonly store: Store;
    readonly ingest: Ingest;
    private readonly searcher: Search;
    private closed = false;

    constructor(config: engine_config) {
        this.store = new Store(config.db_path, { readonly: config.readonly });
        this.ingest = new Ingest(this.store, config.llm, config.embedding);
        this.searcher = new Search(
            this.store,
            config.llm,
            config.embedding,
            {
                rerank_depth: config.rerank_depth,
                max_query_variants: config.max_query_variants,
                min_score: config.min_score,
            },
        );
    }

    /**
     * Add raw text or structured content to memory.
     * 4-step pipeline: extract facts → dedup → embed → store.
     */
    async add(text: string, options: add_options = {}): Promise<add_result> {
        if (this.closed) throw new Error('engine is closed');
        return this.ingest.add(text, options);
    }

    /**
     * Search memories. 4-signal recall (semantic + keyword + entity + temporal),
     * fused via RRF, with optional LLM rerank.
     */
    async search(query: search_query): Promise<search_result[]> {
        if (this.closed) throw new Error('engine is closed');
        return this.searcher.search(query);
    }

    get(id: string) {
        return this.store.get_memory(id);
    }

    delete(id: string): void {
        this.store.delete_memory(id);
    }

    list(scope?: search_query['scope'], limit?: number): string[] {
        return this.store.list_memory_ids(scope, limit);
    }

    status(): engine_status {
        if (this.closed) {
            return { ready: false, memory_count: 0, entity_count: 0, store_kind: 'sqlite' };
        }
        return {
            ready: !this.closed,
            memory_count: this.store.count_memories(),
            entity_count: this.store.count_entities(),
            store_kind: 'sqlite',
        };
    }

    close(): void {
        if (this.closed) return;
        this.store.close();
        this.closed = true;
    }
}

export * from './types.js';
