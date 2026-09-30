/*
*  file  : examples/precision-test.ts
*  usage : Insert 200 noise + 10 relevant memories, then query 3 times.
*          Verify that the 10 relevant items are retrievable despite 200 noise.
*
*  Run:
*    npx tsx examples/precision-test.ts
*/

import { readFileSync } from 'node:fs';

// Minimal .env loader (avoids needing the dotenv package)
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
    } catch {
        // .env not present — env vars may already be set
    }
}
load_env();

import {
    LongMemory,
    openai_llm,
    openai_embedding,
} from '../dist/index.js';

const LLM_BASE = process.env.LONGMEMORY_LLM_BASE_URL
    ?? 'https://api.minimaxi.com/v1';
const EMB_BASE = process.env.LONGMEMORY_OPENAI_BASE_URL
    ?? 'https://ws-j43vcnj1hzb385je.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const memory = new LongMemory({
    db_path: './precision-test.db',  // fresh DB
    llm: openai_llm({
        api_key: process.env.LONGMEMORY_LLM_API_KEY!,
        base_url: LLM_BASE,
        model: process.env.LONGMEMORY_LLM_MODEL ?? 'MiniMax-M3',
    }),
    embedding: openai_embedding({
        api_key: process.env.LONGMEMORY_OPENAI_API_KEY!,
        base_url: EMB_BASE,
        embedding_model: process.env.LONGMEMORY_EMBEDDING_MODEL ?? 'qwen3.7-text-embedding',
        embedding_dimensions: Number(process.env.LONGMEMORY_EMBEDDING_DIM ?? 1024),
    }),
});

// ── 10 "relevant" entries distributed across 3 query topics ──────
const RELEVANT_ENTRIES = [
    // Query 1: programming language preference (4 entries)
    '用户偏好使用 TypeScript 写后端代码',
    '项目主要用 TypeScript 和 Node.js 开发',
    '前端技术栈是 React 加 TypeScript',
    '所有新代码都用 TypeScript 风格',

    // Query 2: database config (3 entries)
    '生产数据库用的是 PostgreSQL 15',
    '数据库连接池大小配置为 20',
    'Prisma ORM 配 PostgreSQL 做 migration',

    // Query 3: project deadline (3 entries)
    '项目交付截止日期是 12 月 15 号',
    '客户要求 Q4 末必须上线',
    'deadline 临近,这周需要交付',
];

// ── 200 noise entries (random unrelated short texts) ─────────────
function make_noise(n: number): string[] {
    const topics = [
        '今天天气不错', '晚饭吃饺子', '地铁上让座', '隔壁在装修',
        '股票跌了', '猫主子抓沙发', '看了一部电影', '周末去爬山',
        '买了几本书', '冰箱里没菜了', '窗户忘关了', '楼下开了咖啡店',
        '邻居养了只狗', '手机屏幕碎了', '洗衣机坏了', '停车位不好找',
        '蚊子咬了好几个包', '空调制冷不给力', '快递一直没到', '约了朋友吃饭',
        '加班到很晚', '出差去上海', '酒店退房', '飞机延误了',
        '高铁票买好了', '签证下来了', '汇率又跌了', '基金亏了',
        '买了新耳机', '耳机线断了', '电脑蓝屏了', '硬盘数据丢了',
        '密码忘了', '被钓鱼邮件骗了', '装了新系统', '键盘进水了',
        '鼠标左键不灵', '显示器烧了', '打印机卡纸', 'U盘丢了',
        '手机充电慢', '电池不耐用', '屏幕划了', '摄像头模糊',
        '耳机有杂音', '麦克风没声', '音响破音', '路由器死机',
        'WiFi 信号差', '宽带断了', '网速太慢', '下载不动',
        '外卖到了', '奶茶凉了', '咖啡洒了', '披萨难吃',
        '面条坨了', '米饭夹生', '汤洒了', '菜太咸',
        '水果烂了', '牛奶过期', '面包发霉', '咖啡豆没了',
        '茶叶喝完了', '糖用完了', '盐用完了', '酱油用完了',
    ];
    const verbs = ['发现', '买', '修', '看', '吃', '试', '做', '整理'];
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        const t1 = topics[Math.floor(Math.random() * topics.length)];
        const t2 = topics[Math.floor(Math.random() * topics.length)];
        const v = verbs[Math.floor(Math.random() * verbs.length)];
        const ts = `${t1},${v}了${t2},第 ${i + 1} 条`;
        out.push(ts);
    }
    return out;
}

async function main() {
    const noise = make_noise(200);
    const all = [...noise, ...RELEVANT_ENTRIES];

    console.log('=== Inserting 200 noise + 10 relevant = 210 memories ===\n');
    const start = Date.now();

    // Use skip_extract + skip_dedup for speed (raw text storage).
    // In production you'd let the LLM extract facts — for benchmarking volume
    // we bypass it so 210 LLM calls don't dominate runtime.
    let added = 0;
    for (let i = 0; i < all.length; i++) {
        try {
            const r = await memory.add(all[i], {
                scope: { user_id: 'test' },
                skip_extract: true,
                skip_dedup: true,
            });
            added += r.added.length;
        } catch (err) {
            console.error(`  [${i + 1}] insert failed:`, (err as Error).message);
        }
        if ((i + 1) % 50 === 0) {
            console.log(`  inserted ${i + 1}/${all.length}...`);
        }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\nInserted ${added} memories in ${elapsed}s\n`);

    // ── 3 queries, each with their relevant entries ──────────────
    const queries = [
        { q: '用户喜欢什么编程语言?', relevant_set: new Set(RELEVANT_ENTRIES.slice(0, 4)) },
        { q: '数据库怎么配置?', relevant_set: new Set(RELEVANT_ENTRIES.slice(4, 7)) },
        { q: '项目什么时候截止?', relevant_set: new Set(RELEVANT_ENTRIES.slice(7, 10)) },
    ];

    console.log('=== Recall quality (top 5 per query) ===\n');
    let total_relevant = 0;
    let total_hits = 0;
    for (const { q, relevant_set } of queries) {
        console.log(`Q: ${q}`);
        const results = await memory.search({
            query: q,
            scope: { user_id: 'test' },
            top_k: 5,
        });
        console.log(`  top ${results.length}:`);
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const is_relevant = relevant_set.has(r.content);
            const mark = is_relevant ? '✓' : ' ';
            console.log(`    ${mark} [${(r.score ?? 0).toFixed(4)}] ${r.content}`);
        }
        const hits_in_top5 = results.filter((r) => relevant_set.has(r.content)).length;
        const relevant_in_top5 = Math.min(5, relevant_set.size);
        total_relevant += relevant_in_top5;
        total_hits += hits_in_top5;
        const p = (hits_in_top5 / results.length) * 100;
        const r2 = (hits_in_top5 / relevant_set.size) * 100;
        console.log(`  → precision@5 = ${p.toFixed(0)}%, recall@5 = ${r2.toFixed(0)}% (${hits_in_top5}/${relevant_set.size} relevant found)\n`);
    }

    console.log('=== Overall ===');
    const overall_p = (total_hits / (queries.length * 5)) * 100;
    const overall_r = (total_relevant > 0 ? (total_hits / total_relevant) * 100 : 0);
    console.log(`  precision@5: ${overall_p.toFixed(1)}%`);
    console.log(`  recall@5:    ${overall_r.toFixed(1)}%`);
    console.log(`  total hits:  ${total_hits} / ${total_relevant} relevant items`);

    memory.close();

    // Clean up test DB
    try {
        const fs = await import('node:fs');
        for (const ext of ['', '-shm', '-wal']) {
            try { fs.unlinkSync(`./precision-test.db${ext}`); } catch { /* ignore */ }
        }
        console.log('\n✓ Cleaned up test database');
    } catch { /* ignore */ }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
