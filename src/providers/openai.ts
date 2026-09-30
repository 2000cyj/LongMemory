/*
*  file  : src/providers/openai.ts
*  usage : Default OpenAI-compatible LLM + embedding providers.
*          Works with OpenAI, Ollama, vLLM, any OpenAI-compatible endpoint.
*/

import type {
    embedding_provider,
    llm_providers,
    memory_fact,
} from '../core/engine/types.js';

export type openai_provider_config = {
    base_url?: string;
    api_key: string;
    model?: string;
    embedding_model?: string;
    embedding_dimensions?: number;
};

type chat_message = { role: 'system' | 'user' | 'assistant'; content: string };

type chat_response = {
    choices?: Array<{ message?: { content?: string } }>;
};

type embedding_response = {
    data?: Array<{ embedding?: number[]; index?: number }>;
};

async function chat_complete(
    base_url: string,
    api_key: string,
    model: string,
    messages: chat_message[],
    response_format?: { type: string },
): Promise<string> {
    const url = `${base_url.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0,
        // Generous max_tokens: thinking models (MiniMax, deepseek-r1, o1, etc.)
        // consume tokens for reasoning before producing JSON. Default limit is
        // often too low and the model returns only the <think>...</think> block.
        max_tokens: 4000,
    };
    if (response_format) body.response_format = response_format;
    const auth_str = `Bearer ${api_key}`;
    if (process.env['LONGMEMORY_DEBUG_LLM']) {
        // eslint-disable-next-line no-console
        console.error('[longmemory-debug] LLM request', {
            url,
            model,
            auth: `Bearer ${api_key.slice(0, 8)}…(${api_key.length} chars)`,
            body_keys: Object.keys(body),
        });
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: auth_str,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`LLM call failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as chat_response;
    return data.choices?.[0]?.message?.content ?? '';
}

async function embed_one(
    base_url: string,
    api_key: string,
    model: string,
    text: string,
    dimensions?: number,
): Promise<number[]> {
    const url = `${base_url.replace(/\/+$/, '')}/embeddings`;
    const body: Record<string, unknown> = { model, input: text };
    if (dimensions) body.dimensions = dimensions;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Embedding failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as embedding_response;
    return data.data?.[0]?.embedding ?? [];
}

function safe_json_parse(text: string): Record<string, unknown> | null {
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]) as Record<string, unknown>;
            } catch {
                return null;
            }
        }
        return null;
    }
}

export function openai_llm(config: openai_provider_config): llm_providers {
    const base = config.base_url ?? 'https://api.openai.com/v1';
    const model = config.model ?? 'gpt-4.1-mini';
    const api_key = config.api_key;

    return {
        fact_extractor: {
            async extract(text: string, context?: { scope?: { user_id?: string; agent_id?: string }; locale?: string }): Promise<memory_fact[]> {
                const locale = context?.locale ?? 'auto';
                const content = await chat_complete(
                    base, api_key, model,
                    [
                        {
                            role: 'system',
                            content: `Extract atomic, self-contained facts from the user's text. Each fact must be a complete statement understandable without context.

CRITICAL RULES (apply in this exact order):
1. PRESERVE THE ORIGINAL LANGUAGE — do NOT translate. Chinese → Chinese, English → English, mixed → keep each phrase in its language.
2. EXTRACT EVERY ATOMIC FACT — one input can contain multiple facts. Each comma-separated or semicolon-separated clause is usually a separate fact.
3. SKIP trivial non-memorable input — only keep facts that will be searched for later. Drop these entirely (return {"facts": []}):
   - Weather ("今天天气不错", "下雨了")
   - Mood/emotion ("心情不错", "累了")
   - Small talk, greetings, ephemeral observations
   - Keep: preferences, decisions, code, technical facts, deadlines, project info, people, tools, configs
4. ENTITIES field — for EVERY fact you keep, this is MANDATORY:
   - Extract EVERY named entity: people, places, organizations, technologies, products, frameworks, languages, databases, tools, libraries
   - For Chinese text, extract Chinese entity names
   - For "用户偏好 TypeScript" → entities MUST include ["TypeScript"]
   - For "Prisma 配 PostgreSQL" → entities MUST include ["Prisma", "PostgreSQL"]
   - If a kept fact truly has no entities (very rare), return []
   - IMPORTANT: do NOT skip entities just because the topic seems technical — extract them even for seemingly trivial ones
5. NEVER paraphrase or rewrite — keep the user's original words.

Reply with JSON: {"facts": [{"text": "...", "category": "...", "entities": ["..."]}]}. Locale hint: ${locale}`,
                        },
                        { role: 'user', content: text },
                    ],
                    { type: 'json_object' },
                );
                const parsed = safe_json_parse(content);
                if (process.env['LONGMEMORY_DEBUG_LLM']) {
                    // eslint-disable-next-line no-console
                    console.error('[longmemory-debug] fact_extractor raw response:', content.slice(0, 500));
                    // eslint-disable-next-line no-console
                    console.error('[longmemory-debug] fact_extractor parsed:', JSON.stringify(parsed));
                }
                const facts = parsed?.['facts'];
                if (!Array.isArray(facts)) return [{ text: text.trim() }];
                return facts
                    .filter((f: unknown): f is Record<string, unknown> => !!f && typeof (f as any).text === 'string')
                    .map((f): memory_fact => ({
                        text: String(f['text']).trim(),
                        category: f['category'] ? String(f['category']) : undefined,
                        entities: Array.isArray(f['entities'])
                            ? (f['entities'] as unknown[]).filter((e): e is string => typeof e === 'string')
                            : undefined,
                        confidence: typeof f['confidence'] === 'number' ? (f['confidence'] as number) : undefined,
                    }));
            },
        },

        deduplicator: {
            async isDuplicate(
                candidate: memory_fact,
                existing: Array<{ id: string; content: string }>,
            ) {
                if (existing.length === 0) return { isDuplicate: false };
                const content = await chat_complete(
                    base, api_key, model,
                    [
                        {
                            role: 'system',
                            content: `Determine if CANDIDATE fact is a duplicate of any EXISTING memory.

Mark as duplicate (isDuplicate: true) when:
- Same subject + same predicate (e.g., "user prefers TypeScript" vs "user likes TypeScript" → DUPLICATE)
- Same information in different words (e.g., "12月15号交付" vs "deadline 12月15" → DUPLICATE)
- "X 偏好 Y" vs "Y 是 X 的首选" → DUPLICATE (paraphrase)

Mark as NOT duplicate when:
- Different subject, related topic (e.g., "user likes TS" vs "team uses TS" → DIFFERENT subjects, keep)
- Different time/aspect (e.g., "project starts Q1" vs "project ends Q4" → DIFFERENT)

Reply JSON only: {"isDuplicate": bool, "duplicateOf"?: existing_id, "reason": "..."}`,
                        },
                        {
                            role: 'user',
                            content: JSON.stringify({ candidate, existing: existing.slice(0, 30) }),
                        },
                    ],
                    { type: 'json_object' },
                );
                const parsed = safe_json_parse(content);
                return {
                    isDuplicate: Boolean(parsed?.['isDuplicate']),
                    duplicateOf: parsed?.['duplicateOf'] as string | undefined,
                    reason: parsed?.['reason'] as string | undefined,
                };
            },
        },

        query_rewriter: {
            async rewrite(query: string): Promise<string[]> {
                const content = await chat_complete(
                    base, api_key, model,
                    [
                        {
                            role: 'system',
                            content: `Rewrite the user's query into AT MOST 1 alternative that is CLOSER in meaning (not broader). The alternative should resolve abbreviations OR fix typos. Do not expand the topic. If the original is already precise, return only the original. Reply JSON only: {"variants": ["..."]}.`,
                        },
                        { role: 'user', content: query },
                    ],
                    { type: 'json_object' },
                );
                const parsed = safe_json_parse(content);
                const variants = parsed?.['variants'];
                if (!Array.isArray(variants)) return [query];
                const extras = (variants as unknown[])
                    .filter((v): v is string => typeof v === 'string' && v !== query)
                    .slice(0, 1);
                return [query, ...extras];
            },
        },

        rerank_provider: {
            async rerank(query: string, candidates: Array<{ id: string; content: string }>, topK: number) {
                if (candidates.length === 0) return [];
                const content = await chat_complete(
                    base, api_key, model,
                    [
                        {
                            role: 'system',
                            content: `You are a relevance ranker. Given a QUERY and candidate memories, return the ${topK} most relevant in order.

Relevance scoring guidance:
- Score 0.9-1.0: DIRECTLY answers the query (states the answer explicitly)
- Score 0.7-0.9: STRONGLY relevant — provides context that is essentially the answer
  - "用户偏好 TypeScript" for query "用户喜欢什么语言?" → 1.0
  - "项目用 TypeScript + Node.js" for query "用户喜欢什么语言?" → 0.85 (shows what user uses)
  - "PostgreSQL 连接池 = 20" for query "数据库怎么配置?" → 0.95
  - "deadline 这周" for query "项目什么时候截止?" → 0.95
- Score 0.4-0.7: TANGENTIALLY relevant — same domain, different aspect
  - "PostgreSQL 15" for query "用户喜欢什么语言?" → 0.3 (DB version, not language)
- Score 0.0-0.4: NOT relevant — different domain
  - "今天天气不错" for any technical query → 0.0
  - unrelated tech ("Prisma" for "deadline" query) → 0.0

Return JSON: {"results": [{"id": "...", "score": 0.0-1.0, "reason": "short"}]}`,
                        },
                        {
                            role: 'user',
                            content: `Query: ${query}\n\nCandidates:\n${candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.content}`).join('\n')}`,
                        },
                    ],
                    { type: 'json_object' },
                );
                const parsed = safe_json_parse(content);
                const results = parsed?.['results'];
                if (!Array.isArray(results)) {
                    return candidates.slice(0, topK).map((c) => ({ id: c.id, score: 0.5 }));
                }
                return (results as unknown[])
                    .filter((r): r is Record<string, unknown> => !!r && typeof (r as any).id === 'string')
                    .slice(0, topK)
                    .map((r) => ({
                        id: r['id'] as string,
                        score: typeof r['score'] === 'number' ? (r['score'] as number) : 0.5,
                        reason: r['reason'] as string | undefined,
                    }));
            },
        },

        entity_extractor: {
            async extract(text: string): Promise<string[]> {
                const content = await chat_complete(
                    base, api_key, model,
                    [
                        {
                            role: 'system',
                            content: `Extract EVERY named entity from the text — people, places, organizations, technologies, products, frameworks, languages, databases, tools, libraries.

For Chinese text, return Chinese entity names. Examples:
- "用户偏好 TypeScript" → ["TypeScript"]
- "项目用 TypeScript + Node.js" → ["TypeScript", "Node.js"]
- "Prisma 配 PostgreSQL 做 migration" → ["Prisma", "PostgreSQL"]
- "12 月 15 号交付" → []  (no entities)

Reply ONLY JSON: {"entities": ["name1", "name2"]}`,
                        },
                        { role: 'user', content: text },
                    ],
                    { type: 'json_object' },
                );
                const parsed = safe_json_parse(content);
                const entities = parsed?.['entities'];
                if (!Array.isArray(entities)) return [];
                return (entities as unknown[]).filter((e): e is string => typeof e === 'string');
            },
        },
    };
}

export function openai_embedding(config: openai_provider_config): embedding_provider {
    const base = config.base_url ?? 'https://api.openai.com/v1';
    const model = config.embedding_model ?? 'text-embedding-3-small';
    const dimensions = config.embedding_dimensions;
    const api_key = config.api_key;

    async function call_embed(input: string | string[]): Promise<number[][]> {
        const url = `${base.replace(/\/+$/, '')}/embeddings`;
        const body: Record<string, unknown> = { model, input };
        if (dimensions) body.dimensions = dimensions;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${api_key}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Embedding failed: ${res.status} ${err}`);
        }
        const data = (await res.json()) as embedding_response;
        const arr = data.data ?? [];
        const sorted = [...arr].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return sorted.map((d) => d.embedding ?? []);
    }

    return {
        async embed(text: string): Promise<number[]> {
            const [vec] = await call_embed(text);
            return vec ?? [];
        },
        async embedBatch(texts: string[]): Promise<number[][]> {
            if (texts.length === 0) return [];
            return call_embed(texts);
        },
    };
}
