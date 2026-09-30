/*
*  file  : src/core/engine/search.ts
*  usage : 4-signal recall pipeline
*          1. Query expansion (cheap abbreviation lookup) + LLM rewrite
*          2. 4 parallel signals: semantic / keyword / entity / temporal
*          3. Reciprocal Rank Fusion (RRF, K=20 — sharper ranking)
*          4. Entity bonus + hard keyword boost (mem0-style evidence)
*          5. Optional LLM rerank
*/

import type {
    embedding_provider,
    llm_providers,
    search_query,
    search_result,
    signal_scores,
} from './types.js';
import type { Store } from './store.js';
import { expand_abbreviations, extract_known_tokens } from '../recall/expansion.js';

const RRF_K = 20; // sharper ranking (was 60 — too flat)
const POPULARITY_WEIGHT = 0.05; // per log-scale access step
const POPULARITY_CAP = 0.3;    // max popularity boost (capped)
const day_ms = 86_400_000;

type candidate_hit = { id: string; signal: keyof signal_scores; score: number };

export class Search {
    constructor(
        private readonly store: Store,
        private readonly llm: llm_providers,
        private readonly embedding: embedding_provider,
        private readonly opts: { rerank_depth?: number; max_query_variants?: number; min_score?: number } = {},
    ) {}

    async search(query: search_query): Promise<search_result[]> {
        const top_k = query.top_k ?? 3;  // default tightened: only top-3, not top-10
        const rerank_depth = this.opts.rerank_depth ?? 100;
        const max_variants = this.opts.max_query_variants ?? 4;
        const scope = query.scope;

        // ── Step 1: Build query variants (cheap expansion + LLM rewrite) ─
        // First, cheap abbreviation expansion (TS → typescript, k8s → kubernetes)
        // Then LLM rewrite for semantic variants
        let variants: string[] = expand_abbreviations(query.query);
        try {
            const llm_variants = await this.llm.query_rewriter.rewrite(query.query, scope);
            for (const v of llm_variants) {
                if (v !== query.query && !variants.includes(v)) variants.push(v);
            }
        } catch { /* ignore LLM failure */ }
        variants = variants.slice(0, Math.max(1, max_variants));

        // Extract hard keywords for boosting (exact-match bonus)
        const hard_keywords = extract_known_keywords(query.query);

        // ── Step 2: 4-signal parallel search across variants ─────────
        const all_hits: candidate_hit[] = [];
        for (const variant of variants) {
            const variant_hits = await this.search_variant(variant, scope, query.filters);
            for (const hit of variant_hits) {
                all_hits.push(hit);
            }
        }

        // ── Step 3: Reciprocal Rank Fusion (RRF, sharper K=20) ─────────
        let fused = this.rrf_fuse(all_hits, rerank_depth);

        // ── Step 3.5: Popularity signal (frequently-returned boost) ────
        // Log-scaled: max count 10 → ~0.12 boost; capped at POPULARITY_CAP.
        // Applied BEFORE rerank so the LLM reranker also sees it.
        const fused_ids_for_pop = fused.map((f) => f.id);
        const access_map = this.store.load_access_counts(fused_ids_for_pop);
        fused = fused.map((f) => {
            const meta = access_map.get(f.id);
            const count = meta?.count ?? 0;
            const pop_boost = count > 0
                ? Math.min(POPULARITY_CAP, Math.log1p(count) * POPULARITY_WEIGHT)
                : 0;
            return {
                ...f,
                signals: {
                    ...f.signals,
                    popularity: count > 0 ? Math.min(1, Math.log1p(count) / Math.log1p(100)) : 0,
                },
                score: f.score + pop_boost,
            };
        });
        fused.sort((a, b) => b.score - a.score);

        // ── Step 4: Entity bonus + hard keyword boost ────────────────
        // (both pre-rerank — give LLM reranker a better starting point)
        fused = this.apply_post_fusion_boosts(fused, hard_keywords);

        if (fused.length === 0) return [];

        // ── Step 5: LLM rerank (optional) ────────────────────────────
        const fused_memories = this.store.load_memories(fused.map((f) => f.id));
        const memory_map = new Map(fused_memories.map((m) => [m.id, m]));

        let final_ranking: Array<{ id: string; score: number; reason?: string }>;
        if (this.llm.rerank_provider) {
            try {
                final_ranking = await this.llm.rerank_provider.rerank(
                    query.query,
                    fused_memories.map((m) => ({ id: m.id, content: m.content })),
                    top_k,
                );
            } catch {
                // Rerank failure → fall back to RRF + boosts order
                final_ranking = fused.slice(0, top_k).map((f) => ({
                    id: f.id,
                    score: f.score,
                }));
            }
        } else {
            final_ranking = fused.slice(0, top_k).map((f) => ({ id: f.id, score: f.score }));
        }

        // ── Step 5.5: Track access (popularity signal for next time) ───
        // Only count returned items (top_k), not the full candidate set.
        if (final_ranking.length > 0) {
            this.store.increment_access(final_ranking.map((r) => r.id));
        }

        // ── Step 6: Apply min_score filter ─────────────────────────────
        const min_score = query.min_score ?? this.opts.min_score ?? 0;
        final_ranking = final_ranking.filter((r) => r.score >= min_score);

        // ── Step 7: Build search_result objects ──────────────────────
        const results: search_result[] = [];
        for (const r of final_ranking) {
            const memory = memory_map.get(r.id);
            if (!memory) continue;
            const fused_hit = fused.find((f) => f.id === r.id);
            results.push({
                id: memory.id,
                content: memory.content,
                category: memory.category,
                entities: memory.entities,
                score: r.score,
                reason: r.reason,
                scores: {
                    semantic: fused_hit?.signals.semantic ?? 0,
                    keyword: fused_hit?.signals.keyword ?? 0,
                    entity: fused_hit?.signals.entity ?? 0,
                    temporal: fused_hit?.signals.temporal ?? 0,
                    popularity: fused_hit?.signals.popularity ?? 0,
                    fused: fused_hit?.score,
                    rerank: this.llm.rerank_provider ? r.score : undefined,
                },
                created_at: memory.created_at,
                metadata: memory.metadata,
            });
        }
        return results;
    }

    // ── 4 signals for one variant ─────────────────────────────────

    private async search_variant(
        query_text: string,
        scope: any,
        filters: search_query['filters'],
    ): Promise<candidate_hit[]> {
        const hits: candidate_hit[] = [];
        const tokens = this.tokenize(query_text);

        // Signal 1: Semantic (cosine similarity)
        try {
            const query_vec = await this.embedding.embed(query_text);
            const stored = this.store.load_embeddings(scope);
            const semantic_scored: Array<{ id: string; score: number }> = [];
            for (const { id, embedding } of stored) {
                if (embedding.length !== query_vec.length) continue;
                const sim = this.cosine(query_vec, embedding);
                if (sim > 0) semantic_scored.push({ id, score: sim });
            }
            semantic_scored.sort((a, b) => b.score - a.score);
            for (const { id, score } of semantic_scored.slice(0, 50)) {
                hits.push({ id, signal: 'semantic', score });
            }
        } catch { /* skip */ }

        // Signal 2: Keyword (BM25 via FTS5)
        try {
            const bm25_results = this.store.bm25_search(query_text, scope, 50);
            for (const { id, score } of bm25_results) {
                hits.push({ id, signal: 'keyword', score });
            }
        } catch { /* skip */ }

        // Signal 3: Entity (matched by token overlap with entity names)
        if (tokens.length > 0) {
            try {
                const entity_ids = this.store.entity_search(tokens, scope, 50);
                for (const id of entity_ids) {
                    hits.push({ id, signal: 'entity', score: 1.0 });
                }
            } catch { /* skip */ }
        }

        // Signal 4: Temporal (recency)
        try {
            const all_ids = this.store.list_memory_ids(scope, 200);
            const all_mems = this.store.load_memories(all_ids);
            const now = Date.now();
            for (const m of all_mems) {
                if (filters?.after && m.created_at < filters.after) continue;
                if (filters?.before && m.created_at > filters.before) continue;
                const age_days = Math.max(0, (now - m.created_at) / day_ms);
                const t = Math.exp(-age_days / 90);
                if (t > 0.05) hits.push({ id: m.id, signal: 'temporal', score: t });
                // BUG-FIX: also push if hits contain it from previous signals
                else if (hits.some((h) => h.id === m.id && h.signal !== 'temporal')) {
                    hits.push({ id: m.id, signal: 'temporal', score: t });
                }
            }
        } catch { /* skip */ }

        return hits;
    }

    // ── Post-fusion boosts (entity_count + hard keyword) ────────────

    private apply_post_fusion_boosts(
        fused: Array<{ id: string; score: number; signals: signal_scores }>,
        hard_keywords: string[],
    ): Array<{ id: string; score: number; signals: signal_scores }> {
        if (fused.length === 0) return fused;
        const ids = fused.map((f) => f.id);
        const mems = this.store.load_memories(ids);
        const mem_map = new Map(mems.map((m) => [m.id, m]));

        return fused.map((f) => {
            const m = mem_map.get(f.id);
            if (!m) return f;
            let bonus = 0;

            // Entity count bonus: memories that have actual entities are more queryable
            const entity_count = m.entities.length;
            if (entity_count > 0) {
                bonus += 0.05 * Math.min(entity_count, 3);  // up to +0.15
            }

            // Hard keyword boost: query contains a known entity name → boost matching memories
            if (hard_keywords.length > 0) {
                const content_lower = m.content.toLowerCase();
                const entity_names_lower = m.entities.map((e) => e.name.toLowerCase());
                let hard_hits = 0;
                for (const kw of hard_keywords) {
                    if (content_lower.includes(kw)) hard_hits++;
                    for (const en of entity_names_lower) {
                        if (en.includes(kw)) hard_hits++;
                    }
                }
                if (hard_hits > 0) {
                    bonus += 0.1 * Math.min(hard_hits, 3);  // up to +0.3
                }
            }

            return {
                ...f,
                score: f.score + bonus,
                signals: f.signals,
            };
        });
    }

    // ── Reciprocal Rank Fusion (RRF) ────────────────────────────────

    private rrf_fuse(hits: candidate_hit[], top_n: number): Array<{ id: string; score: number; signals: signal_scores }> {
        const by_id = new Map<string, { rrf: number; signals: signal_scores }>();
        const signals: Array<keyof signal_scores> = ['semantic', 'keyword', 'entity', 'temporal'];
        for (const signal of signals) {
            const signal_hits = hits.filter((h) => h.signal === signal).sort((a, b) => b.score - a.score);
            for (let rank = 0; rank < signal_hits.length; rank++) {
                const hit = signal_hits[rank];
                const contribution = 1 / (RRF_K + rank + 1);
                const entry = by_id.get(hit.id) ?? { rrf: 0, signals: { semantic: 0, keyword: 0, entity: 0, temporal: 0, popularity: 0 } };
                entry.rrf += contribution;
                const current = entry.signals[signal] ?? 0;
                entry.signals[signal] = Math.max(current, hit.score);
                by_id.set(hit.id, entry);
            }
        }
        return Array.from(by_id.entries())
            .map(([id, v]) => ({ id, score: v.rrf, signals: { ...v.signals, fused: v.rrf } }))
            .sort((a, b) => b.score - a.score)
            .slice(0, top_n);
    }

    // ── Math helpers ──────────────────────────────────────────────

    private cosine(a: number[], b: number[]): number {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom === 0 ? 0 : dot / denom;
    }

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter((t) => t.length >= 2)
            .slice(0, 12);
    }
}

/**
 * Extract hard keywords from query for exact-match boost.
 * Uses the known abbreviations table for cheap keyword detection.
 */
function extract_known_keywords(text: string): string[] {
    const tokens = extract_known_tokens(text);
    const lower = text.toLowerCase();
    const result: string[] = [];
    for (const tok of tokens) {
        if (lower.includes(tok.toLowerCase())) result.push(tok);
    }
    return result;
}