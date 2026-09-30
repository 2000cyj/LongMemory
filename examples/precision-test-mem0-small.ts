/*
*  file  : examples/precision-test-mem0-small.ts
*  usage : mem0-faithful LLM-driven test.
*          LLM extracts facts (may rephrase) → tracks ACTUAL stored text
*          → measures true recall using stored content not original input.
*
*  Run:
*    npx tsx examples/precision-test-mem0-small.ts
*/

import { readFileSync } from 'node:fs';

function load_env(path = '.env'): void {
    try {
        const text = readFileSync(path, 'utf-8');
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m && !line.trim().startsWith('#')) {
                const key = m[1];
                let val = m[2];
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (process.env[key] === undefined) process.env[key] = val;
            }
        }
    } catch { /* no .env */ }
}
load_env();

import { LongMemory, openai_llm, openai_embedding } from '../dist/index.js';

const memory = new LongMemory({
    db_path: './precision-test-mem0-small.db',
    llm: openai_llm({
        api_key: process.env.LONGMEMORY_LLM_API_KEY!,
        base_url: process.env.LONGMEMORY_LLM_BASE_URL ?? 'https://api.minimaxi.com/v1',
        model: process.env.LONGMEMORY_MODEL ?? 'MiniMax-M3',
    }),
    embedding: openai_embedding({
        api_key: process.env.LONGMEMORY_OPENAI_API_KEY!,
        base_url: process.env.LONGMEMORY_OPENAI_BASE_URL
            ?? 'https://ws-j43vcnj1hzb385je.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        embedding_model: process.env.LONGMEMORY_EMBEDDING_MODEL ?? 'qwen3.7-text-embedding',
        embedding_dimensions: Number(process.env.LONGMEMORY_EMBEDDING_DIM ?? 1024),
    }),
});

// Input text (what user provides) → what LLM extracts
// Each query has ANCHOR KEYWORDS that should appear in relevant stored facts.
const QUERIES_AND_INPUTS: Record<string, { inputs: string[]; anchor_keywords: string[] }> = {
    '用户喜欢什么编程语言?': {
        inputs: [
            '用户偏好 TypeScript',
            '项目用 TypeScript + Node.js',
            'TypeScript 是首选语言',
        ],
        anchor_keywords: ['typescript'],
    },
    '数据库怎么配置?': {
        inputs: [
            '生产数据库用 PostgreSQL 15',
            '数据库连接池配 20',
            'Prisma 配 PostgreSQL 做 migration',
        ],
        anchor_keywords: ['postgresql', 'prisma', '数据库'],
    },
    '项目什么时候截止?': {
        inputs: [
            '12 月 15 号交付',
            'Q4 末上线',
            'deadline 这周',
        ],
        anchor_keywords: ['deadline', '交付', '12月', 'q4', '上线'],
    },
};

const NOISE = [
    '今天天气不错,买了晚饭吃饺子',
    '地铁上让座,窗外下着雨',
    '猫主子抓沙发,我喝了咖啡',
];

// Check if stored text contains any of the query's anchor keywords
function is_relevant(query: string, text: string): boolean {
    const cfg = QUERIES_AND_INPUTS[query];
    if (!cfg) return false;
    const lower = text.toLowerCase();
    return cfg.anchor_keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

async function main() {
    const all_input = Object.values(QUERIES_AND_INPUTS).flatMap((cfg) => cfg.inputs);
    const all = [...NOISE, ...all_input];

    console.log('=== mem0-style LLM-driven test (correct membership check) ===\n');
    console.log(`Relevant: ${all_input.length} (3 topics × 3 each)`);
    console.log(`Noise:    ${NOISE.length}`);
    console.log(`Total:    ${all.length}\n`);

    // Insert — full mem0 pipeline, every call hits LLM
    console.log('Inserting (each add: LLM extract + LLM dedup + LLM entity + embed)...');
    const t0 = Date.now();
    let added = 0, skipped = 0;
    for (let i = 0; i < all.length; i++) {
        const t_item = Date.now();
        const r = await memory.add(all[i], { scope: { user_id: 'test' } });
        added += r.added.length;
        skipped += r.skipped.length;
        const sec = ((Date.now() - t_item) / 1000).toFixed(1);
        if (r.added.length > 0) {
            console.log(`  [${i + 1}] ${sec}s  added: "${r.added[0].content.slice(0, 50)}..."`);
        } else {
            console.log(`  [${i + 1}] ${sec}s  SKIPPED (dedup): "${r.skipped[0]?.text.slice(0, 50)}..."`);
        }
    }
    console.log(`\nInsert: ${added} added, ${skipped} skipped in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    // Search — anchor keyword match (handles LLM rewording)
    console.log('=== 3 queries, top_k=5 (LLM query_rewrite always runs) ===\n');
    let total_hits = 0;
    let total_relevant = 0;
    const TOP_K = 5;
    for (const [query, cfg] of Object.entries(QUERIES_AND_INPUTS)) {
        const r = await memory.search({ query, scope: { user_id: 'test' }, top_k: TOP_K });
        let hits = 0;
        console.log(`Q: ${query}  (anchor: ${cfg.anchor_keywords.join('|')})`);
        for (const x of r) {
            const ok = is_relevant(query, x.content);
            if (ok) hits++;
            console.log(`  ${ok ? '✓' : ' '} [${(x.score ?? 0).toFixed(4)}] ${x.content.slice(0, 80)}`);
        }
        const p = (hits / r.length) * 100;
        const r2 = (hits / cfg.inputs.length) * 100;
        total_hits += hits;
        total_relevant += cfg.inputs.length;
        console.log(`  → precision@5 = ${p.toFixed(0)}%, recall@5 = ${r2.toFixed(0)}% (${hits}/${cfg.inputs.length})\n`);
    }

    console.log('=== Overall ===');
    const overall_p = (total_hits / (Object.keys(QUERIES_AND_INPUTS).length * TOP_K)) * 100;
    const overall_r = (total_relevant > 0 ? (total_hits / total_relevant) * 100 : 0);
    console.log(`  precision@5: ${overall_p.toFixed(1)}%`);
    console.log(`  recall@5:    ${overall_r.toFixed(1)}%`);
    console.log(`  total hits:  ${total_hits} / ${total_relevant} relevant items`);

    memory.close();
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./precision-test-mem0-small.db${ext}`); } catch { /* ignore */ }
    }
    console.log('\n✓ Cleaned up');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
