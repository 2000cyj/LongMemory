/*
*  file  : examples/accuracy-demo.ts
*  usage : Concrete accuracy demo. Shows actual stored data + actual retrieved
*          data + LLM-judge verdict per hit.
*
*  Run:
*    npx tsx examples/accuracy-demo.ts
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
    db_path: './accuracy-demo.db',
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

function safe_json_parse(text: string): Record<string, unknown> | null {
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
        return null;
    }
}

async function llm_judge(query: string, candidate: string): Promise<{relevant: boolean; reason: string}> {
    const url = `${LLM_BASE.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LONGMEMORY_LLM_API_KEY}` },
        body: JSON.stringify({
            model: process.env.LONGMEMORY_MODEL ?? 'MiniMax-M3',
            messages: [
                { role: 'system', content: `You are a relevance judge. Does the CANDIDATE memory directly answer or strongly relate to the question QUERY? Reply JSON only (no thinking): {"relevant": bool, "reason": "short reason"}` },
                { role: 'user', content: JSON.stringify({ query, candidate }) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 500,
        }),
    });
    if (!res.ok) return { relevant: false, reason: 'judge failed' };
    const data = await res.json() as any;
    const parsed = safe_json_parse((data.choices?.[0]?.message?.content ?? '{}').trim());
    return { relevant: Boolean(parsed?.['relevant']), reason: String(parsed?.['reason'] ?? '') };
}

const INPUTS = [
    // User preferences
    '用户偏好 TypeScript',
    '项目用 TypeScript + Node.js',
    'TypeScript 是首选语言',
    // Database config
    '生产数据库用 PostgreSQL 15',
    '数据库连接池配 20',
    'Prisma 配 PostgreSQL 做 migration',
    // Project deadline
    '12 月 15 号交付',
    'Q4 末上线',
    'deadline 这周',
    // Noise (unrelated)
    '今天天气不错',
    '地铁上有人让座',
    '猫主子抓沙发',
];

const QUERIES: Array<{ q: string; topic: string }> = [
    { q: '用户喜欢什么编程语言?', topic: 'TypeScript preference' },
    { q: '数据库怎么配置?', topic: 'Database config' },
    { q: '项目什么时候截止?', topic: 'Project deadline' },
];

async function main() {
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./accuracy-demo.db${ext}`); } catch { /* ignore */ }
    }

    console.log('================================================================');
    console.log('  LongMemory accuracy demo — concrete stored & retrieved data');
    console.log('================================================================\n');

    // ── Step 1: Insert 12 memories (full LLM pipeline) ──
    console.log('STEP 1: Insert 12 raw inputs via full LLM pipeline\n');
    const insert_t0 = Date.now();
    for (let i = 0; i < INPUTS.length; i++) {
        const r = await memory.add(INPUTS[i], { scope: { user_id: 'demo' } });
        const status = r.added.length > 0 ? `+${r.added.length}` : `(${r.skipped.length} skipped)`;
        console.log(`  [${String(i + 1).padStart(2)}] ${status.padEnd(12)} "${INPUTS[i]}"`);
    }
    console.log(`  (insert done in ${((Date.now() - insert_t0) / 1000).toFixed(1)}s)\n`);

    // ── Step 2: Show what's actually in the DB ──
    console.log('STEP 2: What got stored in SQLite (LLM-extracted facts)\n');
    const all_ids = memory.list({ scope: { user_id: 'demo' } });
    const stored: Array<{ id: string; content: string; entities: { name: string }[] }> = [];
    for (const id of all_ids) {
        const m = memory.get(id);
        if (m) stored.push({ id: m.id, content: m.content, entities: m.entities });
    }
    console.log(`  DB has ${stored.length} memories:\n`);
    stored.forEach((m, i) => {
        const ent = m.entities.map((e) => e.name).join(', ');
        const preview = m.content.length > 50 ? m.content.slice(0, 50) + '...' : m.content;
        console.log(`  [${String(i + 1).padStart(2)}] id=${m.id.slice(0, 12)}...  "${preview}"`);
        if (ent) console.log(`      entities: [${ent}]`);
    });
    console.log();

    // ── Step 3: Query 3 questions, show top_k + LLM judge verdict ──
    console.log('STEP 3: Query & judge (default top_k=3, min_score=0.7)\n');
    let total_relevant = 0;
    let total_shown = 0;
    for (const { q, topic } of QUERIES) {
        console.log(`┌─ QUERY: ${q}  (${topic})`);
        const results = await memory.search({ query: q, scope: { user_id: 'demo' }, min_score: 0.7 });
        let hits = 0;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const judge = await llm_judge(q, r.content);
            const mark = judge.relevant ? '✓' : '✗';
            if (judge.relevant) hits++;
            console.log(`│  ${mark} [${i + 1}] score=${(r.score ?? 0).toFixed(3)}  id=${r.id.slice(0, 12)}...`);
            console.log(`│      "${r.content}"`);
            console.log(`│      LLM judge: ${judge.relevant ? 'RELEVANT' : 'NOT RELEVANT'} — ${judge.reason}`);
        }
        const p = (hits / results.length) * 100;
        console.log(`└─ Result: ${hits}/${results.length} relevant → precision@5 = ${p.toFixed(0)}%\n`);
        total_relevant += hits;
        total_shown += results.length;
    }

    console.log('================================================================');
    console.log(`  OVERALL: ${total_relevant}/${total_shown} relevant hits`);
    console.log(`  precision@5: ${((total_relevant / total_shown) * 100).toFixed(1)}%`);
    console.log('================================================================');

    memory.close();
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./accuracy-demo.db${ext}`); } catch { /* ignore */ }
    }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });