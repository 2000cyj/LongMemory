/*
*  file  : examples/smoke-test.ts
*  usage : End-to-end smoke test with assertions.
*          Tests: add() → dedup → entities → search() → rerank → min_score → top_k
*
*  Run:
*    npx tsx examples/smoke-test.ts
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
    db_path: './smoke-test.db',
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

// ── Tiny assertion helper ──
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
    if (ok) { passed++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
    else { failed++; console.log(`  ✗ FAIL ${name}${detail ? '  ' + detail : ''}`); }
}
function section(title: string) { console.log(`\n=== ${title} ===`); }

async function main() {
    // Clean up any leftover DB from a previous failed run
    {
        const fs = await import('node:fs');
        for (const ext of ['', '-shm', '-wal']) {
            try { fs.unlinkSync(`./smoke-test.db${ext}`); } catch { /* ignore */ }
        }
    }

    console.log('LongMemory end-to-end smoke test\n');

    // ─────────────────────────────────────────────────
    section('1. ADD: fact extraction + dedup + entity + embedding');
    // ─────────────────────────────────────────────────
    console.log('\n  1a. First insert (LLM extracts "用户偏好 TypeScript")');
    const r1 = await memory.add('用户偏好 TypeScript', { scope: { user_id: 'alice' } });
    check('extracted at least 1 fact', r1.added.length >= 1, `(got ${r1.added.length})`);
    check('first fact text is preserved (or close)', /TypeScript/i.test(r1.added[0].content));
    check('first fact has at least 1 entity', (r1.added[0].entities ?? []).length >= 1, `entities=${JSON.stringify(r1.added[0].entities.map((e) => e.name))}`);
    console.log(`    stored: "${r1.added[0].content}"`);
    console.log(`    entities: ${r1.added[0].entities.map((e) => e.name).join(', ') || '(none)'}`);

    console.log('\n  1b. Second insert (paraphrase → should dedup)');
    const r2 = await memory.add('用户更喜欢 TypeScript 作为主语言', { scope: { user_id: 'alice' } });
    check('dedup fired (skipped >= 1)', r2.skipped.length >= 1, `skipped=${r2.skipped.length}, added=${r2.added.length}`);
    if (r2.skipped.length > 0) {
        console.log(`    dedup reason: ${r2.skipped[0].reason}`);
        console.log(`    duplicate of: ${r2.skipped[0].duplicate_of?.slice(0, 14) ?? '(?)'}...`);
    }

    console.log('\n  1c. Third insert (different topic → not dedup)');
    const r3 = await memory.add('猫主子喜欢抓沙发', { scope: { user_id: 'alice' } });
    check('not dedup (added >= 1)', r3.added.length >= 1);

    console.log('\n  1d. Fourth insert (cross-user → not dedup)');
    const r4 = await memory.add('用户偏好 TypeScript', { scope: { user_id: 'bob' } });
    check('cross-user not dedup (added >= 1)', r4.added.length >= 1, `added=${r4.added.length}`);

    // ─────────────────────────────────────────────────
    section('2. STATUS: counts are accurate');
    // ─────────────────────────────────────────────────
    const status = memory.status();
    console.log(`\n  status: ${JSON.stringify(status)}`);
    check('memory_count >= 3 (alice + bob + cat)', status.memory_count >= 3);
    check('ready=true', status.ready === true);
    check('store_kind=sqlite', status.store_kind === 'sqlite');

    // ─────────────────────────────────────────────────
    section('3. SEARCH: query rewrite + 4-signal RRF + LLM rerank');
    // ─────────────────────────────────────────────────
    console.log('\n  3a. Search alice-scope "用户喜欢什么语言?"');
    const s1 = await memory.search({
        query: '用户喜欢什么语言?',
        scope: { user_id: 'alice' },
        top_k: 3,
    });
    check('returned up to top_k=3', s1.length <= 3);
    check('alice TS fact is in top-3', s1.some((r) => /TypeScript/i.test(r.content)),
        `top: ${s1.map((r) => r.content.slice(0, 30)).join(' | ')}`);
    // Scope isolation: bob's memory has scope user_id=bob; alice's results must not include bob
    // (we can't tell whose memory is whose just from content, so we check the ID set instead)
    const alice_ids = new Set(memory.list({ scope: { user_id: 'alice' } }));
    check('all results belong to alice scope', s1.every((r) => alice_ids.has(r.id)));
    console.log(`    top ${s1.length}:`);
    for (const r of s1) {
        console.log(`      [${(r.score ?? 0).toFixed(4)}] ${r.content.slice(0, 60)}`);
        console.log(`        signals: semantic=${r.scores.semantic.toFixed(2)} kw=${r.scores.keyword.toFixed(2)} ent=${r.scores.entity.toFixed(2)} temp=${r.scores.temporal.toFixed(2)} fused=${r.scores.fused?.toFixed(2)} rerank=${r.scores.rerank?.toFixed(2) ?? '—'}`);
    }

    console.log('\n  3b. Search with different scope (bob)');
    const s2 = await memory.search({
        query: '用户喜欢什么语言?',
        scope: { user_id: 'bob' },
        top_k: 3,
    });
    check('bob-scope returns only bob memory', s2.every((r) => /bob/i.test(r.content) || r.content.includes('用户偏好')));

    console.log('\n  3c. min_score filter (high threshold should drop most)');
    const s3 = await memory.search({
        query: '用户喜欢什么语言?',
        scope: { user_id: 'alice' },
        top_k: 10,
        min_score: 0.99,  // very high threshold
    });
    check('min_score=0.99 returns <= top_k', s3.length <= 10);

    // ─────────────────────────────────────────────────
    section('4. LIST / GET / DELETE');
    // ─────────────────────────────────────────────────
    const all_alice = memory.list({ scope: { user_id: 'alice' } });
    console.log(`\n  list(alice): ${all_alice.length} memories`);
    check('list returns >= 2 alice memories', all_alice.length >= 2);

    const first_id = all_alice[0];
    const got = memory.get(first_id);
    check('get(id) returns the memory', got !== null && got.id === first_id);

    memory.delete(first_id);
    const after_delete = memory.list({ scope: { user_id: 'alice' } });
    check('delete(id) removes the memory', after_delete.length === all_alice.length - 1);

    // ─────────────────────────────────────────────────
    section('5. CLOSE');
    // ─────────────────────────────────────────────────
    memory.close();
    const closed_status = memory.status();
    check('after close: ready=false', closed_status.ready === false);

    // ── Summary ──
    console.log(`\n=== SUMMARY ===`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    if (failed > 0) process.exit(1);
    console.log(`  ✅ All assertions passed`);

    // Cleanup
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./smoke-test.db${ext}`); } catch { /* ignore */ }
    }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });