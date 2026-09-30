/*
*  file  : examples/precision-test-mem0.ts
*  usage : mem0-faithful test — LLM is ALWAYS invoked (no skip flags).
*          Smaller scale (60 items) to keep LLM cost reasonable.
*
*  Pipeline (every call goes through LLM):
*    add → LLM extract → LLM dedup → LLM entity → embed → store
*    search → LLM rewrite → embed (×variants) → 4-signal RRF → return
*
*  Run:
*    npx tsx examples/precision-test-mem0.ts
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
    db_path: './precision-test-mem0.db',
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

// 3 topics × 10 relevant = 30 relevant
const RELEVANT: Record<string, string[]> = {
    '用户喜欢什么编程语言?': [
        '用户偏好使用 TypeScript 写后端代码',
        '项目主要用 TypeScript 和 Node.js 开发',
        '前端技术栈是 React 加 TypeScript',
        '所有新代码都用 TypeScript 风格',
        '团队统一使用 TypeScript',
        'TypeScript 是首选语言',
        '代码用 TypeScript 写,避免用 JavaScript',
        'TypeScript 静态类型检查帮助很大',
        '新项目用 TypeScript 启动',
        '用户对 TypeScript 接受度很高',
    ],
    '数据库怎么配置?': [
        '生产数据库用的是 PostgreSQL 15',
        '数据库连接池大小配置为 20',
        'Prisma ORM 配 PostgreSQL 做 migration',
        '数据库连接字符串配在 .env 里',
        'PostgreSQL 默认端口是 5432',
        '数据库备份每天一次',
        'DB 主从复制配置好了',
        '数据库索引要加在常用查询字段',
        '数据库慢查询日志要打开',
        'DB schema 用 Prisma 管理',
    ],
    '项目什么时候截止?': [
        '项目交付截止日期是 12 月 15 号',
        '客户要求 Q4 末必须上线',
        'deadline 临近,这周需要交付',
        '项目要在月底完成',
        '最终发布日期定在 12 月 31',
        '本周五要演示给客户',
        '上线时间不能拖',
        '进度紧张,还有 2 周要交付',
        '客户催得紧,deadline 不能变',
        '项目验收会议定在月底',
    ],
};

// 30 noise (vs 200 before — LLM calls scale with item count)
function make_noise(n: number): string[] {
    const topics = [
        '今天天气不错', '晚饭吃饺子', '地铁上让座', '隔壁在装修',
        '股票跌了', '猫主子抓沙发', '看了一部电影', '周末去爬山',
        '买了几本书', '冰箱里没菜了', '窗户忘关了', '楼下开了咖啡店',
        '邻居养了只狗', '手机屏幕碎了', '洗衣机坏了', '停车位不好找',
        '蚊子咬了好几个包', '空调制冷不给力', '快递一直没到', '约了朋友吃饭',
    ];
    const verbs = ['发现', '买', '修', '看', '吃', '试', '做', '整理'];
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        const t1 = topics[Math.floor(Math.random() * topics.length)];
        const t2 = topics[Math.floor(Math.random() * topics.length)];
        const v = verbs[Math.floor(Math.random() * verbs.length)];
        out.push(`${t1},${v}了${t2},第 ${i + 1} 条`);
    }
    return out;
}

async function main() {
    const all_relevant = Object.values(RELEVANT).flat();
    const noise = make_noise(30);
    const all = [...noise, ...all_relevant];

    console.log('=== mem0-style LLM-driven test (no skip flags) ===\n');
    console.log(`Relevant: ${all_relevant.length} (3 topics × 10 each)`);
    console.log(`Noise:    ${noise.length}`);
    console.log(`Total:    ${all.length}\n`);

    // Insert — FULL mem0 pipeline, every call invokes LLM
    console.log('Inserting (each add() calls LLM 3+ times: extract, dedup, entity)...');
    const t0 = Date.now();
    let total_added = 0;
    let total_skipped = 0;
    for (let i = 0; i < all.length; i++) {
        try {
            const r = await memory.add(all[i], { scope: { user_id: 'test' } });
            total_added += r.added.length;
            total_skipped += r.skipped.length;
        } catch (err) {
            console.error(`  [${i + 1}] failed:`, (err as Error).message);
        }
        if ((i + 1) % 10 === 0) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(`  ${i + 1}/${all.length}  (${elapsed}s elapsed, added=${total_added}, skipped=${total_skipped})`);
        }
    }
    const elapsed_total = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nTotal: added ${total_added}, skipped ${total_skipped} (dedup), in ${elapsed_total}s\n`);

    // 3 queries, top_k=10, FULL mem0 search (LLM query_rewrite always runs)
    console.log('=== Recall quality (top 10 per query, LLM rewrite always runs) ===\n');
    let total_relevant = 0;
    let total_hits = 0;
    const TOP_K = 10;

    for (const [query, relevant] of Object.entries(RELEVANT)) {
        const relevant_set = new Set(relevant);
        const results = await memory.search({ query, scope: { user_id: 'test' }, top_k: TOP_K });
        let hits = 0;
        console.log(`Q: ${query}`);
        for (const r of results) {
            const is_relevant = relevant_set.has(r.content);
            if (is_relevant) hits++;
            const mark = is_relevant ? '✓' : ' ';
            console.log(`  ${mark} [${(r.score ?? 0).toFixed(4)}] ${r.content}`);
        }
        const p = (hits / results.length) * 100;
        const r2 = (hits / relevant.length) * 100;
        total_relevant += relevant.length;
        total_hits += hits;
        console.log(`  → precision@${TOP_K} = ${p.toFixed(0)}%, recall@${TOP_K} = ${r2.toFixed(0)}% (${hits}/${relevant.length})\n`);
    }

    console.log('=== Overall ===');
    const overall_p = (total_hits / (Object.keys(RELEVANT).length * TOP_K)) * 100;
    const overall_r = (total_relevant > 0 ? (total_hits / total_relevant) * 100 : 0);
    console.log(`  precision@${TOP_K}: ${overall_p.toFixed(1)}%`);
    console.log(`  recall@${TOP_K}:    ${overall_r.toFixed(1)}%`);
    console.log(`  total hits:  ${total_hits} / ${total_relevant} relevant items`);

    memory.close();

    // Cleanup
    try {
        const fs = await import('node:fs');
        for (const ext of ['', '-shm', '-wal']) {
            try { fs.unlinkSync(`./precision-test-mem0.db${ext}`); } catch { /* ignore */ }
        }
        console.log('\n✓ Cleaned up test database');
    } catch { /* ignore */ }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
