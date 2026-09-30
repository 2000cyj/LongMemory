/*
*  file  : examples/roundtrip-test.ts
*  usage : Insert data → export all → re-insert via LLM (real mem0 path)
*          → query & measure recall accuracy.
*
*  Run:
*    npx tsx examples/roundtrip-test.ts
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
    db_path: './roundtrip-test.db',
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

// ── 12 items (9 relevant + 3 noise) ─────────────────────────────
// Real-world noise = single simple statements (not compound sentences).
// Compound sentences like "今天天气不错,买了晚饭吃饺子" will legitimately
// be split by the LLM into multiple facts — that's correct mem0 behavior.
const INPUTS: string[] = [
    // Topic 1: TypeScript preference
    '用户偏好 TypeScript',
    '项目用 TypeScript + Node.js',
    'TypeScript 是首选语言',
    // Topic 2: Database config
    '生产数据库用 PostgreSQL 15',
    '数据库连接池配 20',
    'Prisma 配 PostgreSQL 做 migration',
    // Topic 3: Project deadline
    '12 月 15 号交付',
    'Q4 末上线',
    'deadline 这周',
    // Noise (each = ONE simple fact, LLM won't further split)
    '今天天气不错',
    '地铁上有人让座',
    '猫主子抓沙发',
];

const QUERIES = [
    { q: '用户喜欢什么编程语言?', anchor: ['typescript'] },
    { q: '数据库怎么配置?', anchor: ['postgresql', 'prisma', '数据库'] },
    { q: '项目什么时候截止?', anchor: ['deadline', '交付', '12月', 'q4', '上线'] },
];

function is_relevant(query: { anchor: string[] }, text: string): boolean {
    const lower = text.toLowerCase();
    return query.anchor.some((kw) => lower.includes(kw.toLowerCase()));
}

async function main() {
    console.log('=== ROUND-TRIP TEST ===\n');
    console.log(`Step 1: Insert ${INPUTS.length} items via full LLM pipeline (extract+dedup+entity+embed)\n`);

    // ── Step 1: First insertion (real LLM) ──
    const t1 = Date.now();
    for (let i = 0; i < INPUTS.length; i++) {
        const t = Date.now();
        const r = await memory.add(INPUTS[i], { scope: { user_id: 'roundtrip' } });
        const sec = ((Date.now() - t) / 1000).toFixed(1);
        const action = r.added.length > 0
            ? `added: "${r.added[0].content.slice(0, 50)}"`
            : `SKIPPED (dedup): "${r.skipped[0]?.text.slice(0, 50)}"`;
        console.log(`  [${i + 1}/${INPUTS.length}] ${sec}s  ${action}`);
    }
    console.log(`  → ${((Date.now() - t1) / 1000).toFixed(1)}s total\n`);

    // ── Step 2: Export all data from DB ──
    console.log('Step 2: Export ALL data from DB\n');
    const all_ids = memory.list({ scope: { user_id: 'roundtrip' } });
    const exported = all_ids.map((id) => memory.get(id)).filter((m) => m !== null) as Array<{
        id: string; content: string; category?: string; entities: { id: string; name: string }[];
    }>;
    console.log(`  Exported ${exported.length} memories:\n`);
    for (const m of exported) {
        const ents = m.entities.map((e) => e.name).join(',');
        console.log(`  [${m.id.slice(0, 14)}...] "${m.content.slice(0, 60)}"  entities=[${ents}]`);
    }
    console.log();

    // ── Step 3: Re-insert each (full LLM re-extracts + dedups) ──
    console.log('Step 3: Re-insert each via full LLM (should dedup most)\n');
    const t2 = Date.now();
    let re_added = 0, re_skipped = 0;
    for (let i = 0; i < exported.length; i++) {
        const m = exported[i];
        const r = await memory.add(m.content, { scope: { user_id: 'roundtrip_v2' } });
        if (r.added.length > 0) re_added++;
        else re_skipped++;
        if (i < 3 || r.added.length > 0) {
            const sec = ((Date.now() - t2) / 1000).toFixed(1);
            const action = r.added.length > 0
                ? `added: "${r.added[0].content.slice(0, 50)}"`
                : `DEDUPED: "${r.skipped[0]?.text.slice(0, 50)}"`;
            console.log(`  [${i + 1}/${exported.length}]  ${action}`);
        }
    }
    console.log(`  → re_added=${re_added}, re_skipped=${re_skipped} in ${((Date.now() - t2) / 1000).toFixed(1)}s\n`);

    // ── Step 4: Search on the re-inserted DB ──
    console.log('Step 4: Search the v2 (re-inserted) DB\n');
    let total_hits = 0;
    let total_relevant = 0;
    for (const query of QUERIES) {
        const r = await memory.search({ query: query.q, scope: { user_id: 'roundtrip_v2' }, top_k: 5 });
        let hits = 0;
        console.log(`Q: ${query.q}`);
        for (const x of r) {
            const ok = is_relevant(query, x.content);
            if (ok) hits++;
            console.log(`  ${ok ? '✓' : ' '} [${(x.score ?? 0).toFixed(4)}] ${x.content.slice(0, 70)}`);
        }
        // For "v2" we should have fewer items (LLM dedup), so 5 of total
        // We need to know how many relevant items are in scope
        const scope_ids = memory.list({ scope: { user_id: 'roundtrip_v2' } });
        const scope_mems = scope_ids.map((id) => memory.get(id)).filter(Boolean) as Array<{ content: string }>;
        const relevant_in_scope = scope_mems.filter((m) => is_relevant(query, m.content)).length;
        const p = r.length > 0 ? (hits / r.length) * 100 : 0;
        const r2 = relevant_in_scope > 0 ? (hits / relevant_in_scope) * 100 : 0;
        total_hits += hits;
        total_relevant += relevant_in_scope;
        console.log(`  → precision@5 = ${p.toFixed(0)}%, recall@5 = ${r2.toFixed(0)}% (${hits}/${relevant_in_scope} relevant in scope)\n`);
    }

    console.log('=== Overall ===');
    const total_p = total_hits > 0 ? (total_hits / (QUERIES.length * 5)) * 100 : 0;
    const total_r = total_relevant > 0 ? (total_hits / total_relevant) * 100 : 0;
    console.log(`  precision@5: ${total_p.toFixed(1)}%`);
    console.log(`  recall@5:    ${total_r.toFixed(1)}%`);
    console.log(`  total: ${total_hits} relevant found in v2 DB`);

    memory.close();
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./roundtrip-test.db${ext}`); } catch { /* ignore */ }
    }
    console.log('\n✓ Cleaned up');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
