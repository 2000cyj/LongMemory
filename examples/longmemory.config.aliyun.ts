/*
*  file  : examples/longmemory.config.aliyun.ts
*  usage : Aliyun Cloud Bailian (百炼) — full working example.
*          Uses Aliyun's "compatible-mode" endpoint (OpenAI-shaped API)
*          for both chat (LLM) and embeddings.
*
*  Run:
*    npx tsx examples/longmemory.config.aliyun.ts
*/

import { LongMemory, openai_llm, openai_embedding } from 'longmemory';

// Aliyun "compatible-mode" endpoint exposes BOTH:
//   - /v1/chat/completions  (LLM)
//   - /v1/embeddings        (embeddings)
// using standard OpenAI request/response shapes.
const ALIYUN_BASE = process.env.LONGMEMORY_OPENAI_BASE_URL
    ?? 'https://ws-j43vcnj1hzb385je.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const memory = new LongMemory({
    db_path: './longmemory.db',

    // ── LLM (chat) ──
    llm: openai_llm({
        api_key: process.env.LONGMEMORY_OPENAI_API_KEY!,
        base_url: ALIYUN_BASE,
        model: process.env.LONGMEMORY_MODEL ?? 'qwen-plus',
    }),

    // ── Embedding (uses the same OpenAI-compatible endpoint) ──
    embedding: openai_embedding({
        api_key: process.env.LONGMEMORY_OPENAI_API_KEY!,
        base_url: ALIYUN_BASE,
        embedding_model: process.env.LONGMEMORY_EMBEDDING_MODEL ?? 'qwen3.7-text-embedding',
        embedding_dimensions: process.env.LONGMEMORY_EMBEDDING_DIM
            ? Number(process.env.LONGMEMORY_EMBEDDING_DIM)
            : 1024,
    }),
});

// ── Smoke test ──
async function main() {
    console.log('=== LongMemory × Aliyun Bailian ===\n');
    console.log('Adding memory: "用户喜欢 TypeScript 和 qwen embedding"');
    const r = await memory.add('用户喜欢 TypeScript 和 qwen embedding');
    console.log('Added:', r.added.length, 'facts');

    console.log('\nSearching: "用户喜欢什么?"');
    const s = await memory.search({ query: '用户喜欢什么?', top_k: 3 });
    console.log('Found:', s.length, 'hits');
    for (const hit of s) {
        console.log(`  [${hit.score.toFixed(4)}] ${hit.content}`);
        console.log(`         signals: semantic=${hit.scores.semantic.toFixed(3)} keyword=${hit.scores.keyword.toFixed(3)} entity=${hit.scores.entity.toFixed(3)} temporal=${hit.scores.temporal.toFixed(3)}`);
    }

    console.log('\nStatus:', memory.status());
    memory.close();
    console.log('\n✅ Done');
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
