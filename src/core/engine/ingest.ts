/*
*  file  : src/core/engine/ingest.ts
*  usage : mem0-style 4-step ingest pipeline (LLM is ALWAYS invoked)
*          1. LLM fact extraction
*          2. LLM semantic deduplication
*          3. Embedding generation
*          4. Storage + entity linking
*/

import type {
    add_options,
    add_result,
    memory_fact,
    embedding_provider,
    llm_providers,
    stored_memory,
} from './types.js';
import type { Store } from './store.js';

export class Ingest {
    constructor(
        private readonly store: Store,
        private readonly llm: llm_providers,
        private readonly embedding: embedding_provider,
    ) {}

    /**
     * Add raw text to memory. mem0 4-step pipeline — LLM is ALWAYS invoked.
     */
    async add(raw_text: string, options: add_options = {}): Promise<add_result> {
        const scope = options.scope ?? {};
        const added: stored_memory[] = [];
        const skipped: add_result['skipped'] = [];

        // ── Step 1: Fact Extraction (LLM, mandatory) ────────────────
        let facts = await this.llm.fact_extractor.extract(raw_text, { scope });
        if (facts.length === 0) {
            facts = [{ text: raw_text.trim() }];
        }

        // ── Step 2: Semantic Deduplication (LLM, mandatory) ─────────
        // Pre-load scope-local candidates; LLM only compares against the
        // most recent N items, not the whole DB.
        const existing_ids = this.store.list_memory_ids(scope, 200);
        const existing = this.store.load_memories(existing_ids).map((m) => ({
            id: m.id,
            content: m.content,
        }));
        const deduped_facts: memory_fact[] = [];
        for (const fact of facts) {
            if (existing.length === 0) {
                deduped_facts.push(fact);
                continue;
            }
            const verdict = await this.llm.deduplicator.isDuplicate(fact, existing);
            if (verdict.isDuplicate) {
                skipped.push({
                    text: fact.text,
                    reason: verdict.reason ?? 'duplicate of existing memory',
                    duplicate_of: verdict.duplicateOf,
                });
            } else {
                deduped_facts.push(fact);
            }
        }

        // ── Step 3: Embedding ────────────────────────────────────────
        const texts_to_embed = deduped_facts.map((f) => f.text);
        const embeddings = this.embedding.embedBatch && texts_to_embed.length > 1
            ? await this.embedding.embedBatch(texts_to_embed)
            : await Promise.all(texts_to_embed.map((t) => this.embedding.embed(t)));

        // ── Step 4: Storage + Entity Linking (LLM entity extraction) ──
        for (let i = 0; i < deduped_facts.length; i++) {
            const fact = deduped_facts[i];
            const embedding_vec = embeddings[i];

            // LLM entity extraction (mandatory)
            const entity_ids: string[] = [];
            const entity_names = await this.llm.entity_extractor.extract(fact.text);
            for (const entity_name of entity_names) {
                const cleaned = entity_name.trim();
                if (!cleaned) continue;
                const entity = this.store.upsert_entity(cleaned);
                entity_ids.push(entity.id);
            }

            const memory = this.store.insert_memory({
                scope,
                content: fact.text,
                category: fact.category,
                embedding: embedding_vec.length > 0 ? embedding_vec : undefined,
                metadata: options.metadata,
                source: options.source,
            });

            for (const eid of entity_ids) {
                this.store.link_entity(memory.id, eid);
            }

            added.push({
                ...memory,
                entities: this.store.get_memory_entities(memory.id),
            });
        }

        return { added, skipped };
    }
}
