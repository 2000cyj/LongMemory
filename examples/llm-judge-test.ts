/*
*  file  : examples/llm-judge-test.ts
*  usage : Use an LLM to judge whether each search result is semantically
*          relevant to the query (mem0-style evaluation).
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

const LLM_BASE = process.env.LONGMEMORY_LLM_BASE_URL ?? 'https://api.minimaxi.com/v1';
const EMB_BASE = process.env.LONGMEMORY_OPENAI_BASE_URL
    ?? 'https://ws-j43vcnj1hzb385je.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const memory = new LongMemory({
    db_path: './llm-judge-test.db',
    llm: openai_llm({
        api_key: process.env.LONGMEMORY_LLM_API_KEY!,
        base_url: LLM_BASE,
        model: process.env.LONGMEMORY_MODEL ?? 'MiniMax-M3',
    }),
    embedding: openai_embedding({
        api_key: process.env.LONGMEMORY_OPENAI_API_KEY!,
        base_url: EMB_BASE,
        embedding_model: process.env.LONGMEMORY_EMBEDDING_MODEL ?? 'qwen3.7-text-embedding',
        embedding_dimensions: Number(process.env.LONGMEMORY_EMBEDDING_DIM ?? 1024),
    }),
});

const INPUTS = [
    '用户偏好 TypeScript',
    '项目用 TypeScript + Node.js',
    'TypeScript 是首选语言',
    '生产数据库用 PostgreSQL 15',
    '数据库连接池配 20',
    'Prisma 配 PostgreSQL 做 migration',
    '12 月 15 号交付',
    'Q4 末上线',
    'deadline 这周',
    '今天天气不错',
    '地铁上有人让座',
    '猫主子抓沙发',
];

const QUERIES = [
    '用户喜欢什么编程语言?',
    '数据库怎么配置?',
    '项目什么时候截止?',
];

function safe_json_parse(text: string): Record<string, unknown> | null {
    try { return JSON.parse(text); }
    catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
        return null;
    }
}

async function llm_judge(query: string, candidate: string): Promise<'relevant' | 'irrelevant'> {
    const url = `${LLM_BASE.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env.LONGMEMORY_LLM_API_KEY}`,
        },
        body: JSON.stringify({
            model: process.env.LONGMEMORY_MODEL ?? 'MiniMax-M3',
            messages: [
                {
                    role: 'system',
                    content: `You are a relevance judge. Determine whether the CANDIDATE memory semantically answers or is related to the question QUERY. Reply JSON only (no other text, no markdown, no thinking): {"relevant": bool, "confidence": 0-1}.`,
                },
                { role: 'user', content: JSON.stringify({ query, candidate }) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
        }),
    });
    if (!res.ok) return 'irrelevant';
    const data = await res.json() as any;
    const raw = (data.choices?.[0]?.message?.content ?? '{}').trim();
    const parsed = safe_json_parse(raw);
    return parsed?.relevant ? 'relevant' : 'irrelevant';
}

async function main() {
    console.log('=== LLM-JUDGE EVALUATION ===\n');
    console.log('Inserting 12 items (full LLM pipeline)...\n');
    for (const item of INPUTS) {
        await memory.add(item, { scope: { user_id: 'judge_test' } });
    }
    const all_ids = memory.list({ scope: { user_id: 'judge_test' } });
    console.log(`Stored  ${all_ids.length} memories.\n`);

    console.log('=== 3 queries × top_k=5, judged by LLM ===\n');
    let total_relevant = 0;
    let total_shown = 0;
    for (const query of QUERIES) {
        const r = await memory.search({ query, scope: { user_id: 'judge_test' }, top_k: 5 });
        let hits = 0;
        console.log(`Q: ${query}`);
        for (const x of r) {
            const verdict = await llm_judge(query, x.content);
            if (verdict === 'relevant') hits++;
            console.log(`  ${verdict === 'relevant' ? '✓' : ' '} [${(x.score ?? 0).toFixed(4)}] ${x.content}`);
        }
        console.log(`  → LLM-judged relevant: ${hits}/5\n`);
        total_relevant += hits;
        total_shown += r.length;
    }

    const precision = (total_relevant / total_shown) * 100;
    console.log('=== OVERALL (LLM-judged) ===');
    console.log(`  precision@5: ${precision.toFixed(1)}%`);
    console.log(`  relevant hits: ${total_relevant} / ${total_shown}`);

    memory.close();
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./llm-judge-test.db${ext}`); } catch { /* ignore */ }
    }
    console.log('\n✓ Cleaned up');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });