/*
*  file  : examples/popularity-test.ts
*  usage : Insert N memories, query 3 times to boost access_count of returned items,
*          then query again and show ranking changed.
*
*  Run:
*    npx tsx examples/popularity-test.ts
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
    db_path: './popularity-test.db',
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
    // Most relevant to "用户喜欢什么编程语言?"
    '用户偏好 TypeScript',                              // golden 1
    '团队项目用 TypeScript + Node.js',                  // golden 2
    'Alice 学过 Python',                                  // off-topic but related
    '项目用 Rust 写 CLI',                                // off-topic
    '今天天气不错',                                       // noise
];

async function main() {
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./popularity-test.db${ext}`); } catch { /* ignore */ }
    }

    console.log('=== POPULARITY RANKING TEST ===\n');

    // ── Insert all ──
    console.log('Insert 5 memories (full LLM pipeline)...');
    for (const item of INPUTS) {
        await memory.add(item, { scope: { user_id: 'test' } });
    }
    console.log('  done\n');

    // ── First query: no access counts yet ──
    console.log('─── Query #1 (cold cache, no popularity boost) ───');
    const r1 = await memory.search({ query: '用户喜欢什么编程语言?', scope: { user_id: 'test' } });
    for (const x of r1) {
        console.log(`  [score=${x.score.toFixed(3)} pop=${x.scores.popularity.toFixed(2)}] "${x.content.slice(0, 40)}"`);
    }

    // ── Query 2 and 3 to boost "用户偏好 TypeScript" access count ──
    console.log('\n─── Query #2-#3 (same query, will boost access_count of returned items) ───');
    for (let i = 0; i < 2; i++) {
        await memory.search({ query: '用户喜欢什么编程语言?', scope: { user_id: 'test' } });
    }

    // ── Query 4: now "用户偏好 TypeScript" should be boosted ──
    console.log('\n─── Query #4 (after 3 retrievals, popularity boost kicks in) ───');
    const r4 = await memory.search({ query: '用户喜欢什么编程语言?', scope: { user_id: 'test' } });
    for (const x of r4) {
        console.log(`  [score=${x.score.toFixed(3)} pop=${x.scores.popularity.toFixed(2)}] "${x.content.slice(0, 40)}"`);
    }

    // ── Compare rankings ──
    console.log('\n─── Ranking comparison ───');
    console.log('Query #1 top 5:', r1.map((x) => x.content.slice(0, 20)));
    console.log('Query #4 top 5:', r4.map((x) => x.content.slice(0, 20)));

    // Show the moved item
    const r1set = new Set(r1.map((x) => x.content));
    const movedUp = r4.find((x) => !r1set.has(x.content) || r4.indexOf(x) < r1.findIndex((y) => y.content === x.content));
    if (movedUp) {
        console.log('\n🎯 Popularity boost demonstration:');
        console.log(`  "${movedUp.content.slice(0, 40)}" gained ranking boost from frequent returns`);
    }

    memory.close();
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./popularity-test.db${ext}`); } catch { /* ignore */ }
    }
    console.log('\n✓ Cleaned up');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });