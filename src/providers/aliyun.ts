/*
*  file  : src/providers/aliyun.ts
*  usage : Alibaba Cloud DashScope (百炼) embedding provider.
*          Body shape: { "model": "...", "input": { "texts": [...] } }
*          Response:   { "output": { "embeddings": [{ "text_index": 0, "embedding": [...] }] } }
*/

import type { embedding_provider } from '../core/engine/types.js';

export type aliyun_embedding_config = {
    api_key: string;
    /**
     * Full endpoint URL ending in `/text-embedding` (or path thereof).
     * Default: Alibaba Bailian dedicated embedding endpoint.
     */
    base_url?: string;
    model?: string;
    /** Output dimension. qwen3-text-embedding defaults to 1024. */
    dimensions?: number;
};

type aliyun_response = {
    output?: {
        embeddings?: Array<{ text_index?: number; embedding?: number[] }>;
    };
};

async function aliyun_embed_one(
    base_url: string,
    api_key: string,
    model: string,
    text: string,
): Promise<number[]> {
    const url = base_url.replace(/\/+$/, '');
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify({
            model,
            input: { texts: [text] },
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Aliyun embedding failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as aliyun_response;
    const vec = data.output?.embeddings?.[0]?.embedding;
    if (!vec) throw new Error('Aliyun embedding response missing output.embeddings[0].embedding');
    return vec;
}

async function aliyun_embed_batch(
    base_url: string,
    api_key: string,
    model: string,
    texts: string[],
): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Aliyun supports batch input natively via the `texts` array
    const url = base_url.replace(/\/+$/, '');
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${api_key}`,
        },
        body: JSON.stringify({
            model,
            input: { texts },
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Aliyun batch embedding failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as aliyun_response;
    const items = data.output?.embeddings ?? [];
    // Sort by text_index to preserve input order
    const sorted = [...items].sort((a, b) => (a.text_index ?? 0) - (b.text_index ?? 0));
    return sorted.map((e) => e.embedding ?? []);
}

export function aliyun_embedding(config: aliyun_embedding_config): embedding_provider {
    const base_url = config.base_url
        ?? 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
    const model = config.model ?? 'text-embedding-v3';
    return {
        async embed(text: string): Promise<number[]> {
            return aliyun_embed_one(base_url, config.api_key, model, text);
        },
        async embedBatch(texts: string[]): Promise<number[][]> {
            return aliyun_embed_batch(base_url, config.api_key, model, texts);
        },
    };
}
