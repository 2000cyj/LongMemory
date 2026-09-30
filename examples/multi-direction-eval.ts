/*
*  file  : examples/multi-direction-eval.ts
*  usage : Compact multi-direction accuracy evaluation.
*          3 topics × ~5 items = ~15 memories, 3 queries.
*
*  Run:
*    npx tsx examples/multi-direction-eval.ts
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
    db_path: './multi-direction-eval.db',
    llm: openai_llm({
        api_key: process.env.LONGMEMORY_OPENAI_API_KEY!,
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

async function llm_judge(query: string, candidate: string): Promise<boolean> {
    const url = `${LLM_BASE.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LONGMEMORY_LLM_API_KEY}` },
        body: JSON.stringify({
            model: process.env.LONGMEMORY_MODEL ?? 'MiniMax-M3',
            messages: [
                { role: 'system', content: `Does the CANDIDATE help answer the QUESTION? Reply JSON only: {"relevant": bool}` },
                { role: 'user', content: JSON.stringify({ query, candidate }) },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 200,
        }),
    });
    if (!res.ok) return false;
    const data = await res.json() as any;
    const parsed = safe_json_parse((data.choices?.[0]?.message?.content ?? '{}').trim());
    return Boolean(parsed?.['relevant']);
}

type TestCase = {
    topic: string;
    query: string;
    keywords: string[];
    items: string[];
};

const TEST_CASES: TestCase[] = [
    {
        topic: 'User preference',
        query: '用户偏好什么编程语言?',
        keywords: ['typescript', 'javascript', 'python'],
        items: [
            '用户偏好 TypeScript 做后端开发',
            '前端项目用 TypeScript + React',
            'Alice 学过 JavaScript 和 Python',
            '团队刚试过 Rust',
        ],
    },
    {
        topic: 'Database config',
        query: '数据库连接池怎么配?',
        keywords: ['postgres', '连接池', 'prisma'],
        items: [
            'PostgreSQL 连接池设 20 个',
            'Prisma 配 PostgreSQL 做 ORM',
            '数据库索引建在常用查询字段',
        ],
    },
    {
        topic: 'Project deadline',
        query: '项目什么时候交付?',
        keywords: ['截止', 'deadline', '12 月', 'q4'],
        items: [
            '项目截止日期是 12 月 15 号',
            'Q4 末必须上线',
            '客户要 1 月初验收',
        ],
    },
];

async function main() {
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./multi-direction-eval.db${ext}`); } catch { /* ignore */ }
    }

    console.log('================================================================');
    console.log('  Multi-direction eval (3 topics, ~13 items)');
    console.log('================================================================\n');

    // ── Step 1: Insert all items ──
    console.log('STEP 1: Insert (full LLM pipeline)\n');
    const t0 = Date.now();
    for (const tc of TEST_CASES) {
        for (const item of tc.items) {
            await memory.add(item, { scope: { user_id: 'eval' } });
        }
    }
    console.log(`  Insert done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    // ── Step 2: Search per topic ──
    console.log('STEP 2: Search & judge\n');
    let total_hits = 0, total_shown = 0;
    for (const tc of TEST_CASES) {
        console.log(`┌─ ${tc.topic}`);
        console.log(`│  Q: ${tc.query}`);
        const r = await memory.search({ query: tc.query, scope: { user_id: 'eval' }, top_k: 3 });
        let hits = 0;
        for (let i = 0; i < r.length; i++) {
            const x = r[i];
            const relevant = await llm_judge(tc.query, x.content);
            const is_topic = tc.keywords.some((kw) => x.content.toLowerCase().includes(kw.toLowerCase()));
            const mark = relevant ? '✓' : (is_topic ? '~' : ' ');
            if (relevant) hits++;
            console.log(`│  ${mark} [${i + 1}] "${x.content.slice(0, 60)}"`);
        }
        const p = r.length > 0 ? (hits / r.length) * 100 : 0;
        console.log(`│  precision@3 = ${p.toFixed(0)}%  (LLM-judged ${hits}/${r.length})\n`);
        total_hits += hits;
        total_shown += r.length;
    }

    console.log('================================================================');
    const overall = total_shown > 0 ? (total_hits / total_shown) * 100 : 0;
    console.log(`  OVERALL precision@3: ${overall.toFixed(1)}%  (${total_hits}/${total_shown})`);
    console.log('================================================================');

    memory.close();
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./multi-direction-eval.db${ext}`); } catch { /* ignore */ }
    }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });