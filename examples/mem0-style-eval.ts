/*
*  file  : examples/mem0-style-eval.ts
*  usage : Larger-scale eval (60 memories) using LLM as judge.
*          Mirrors how mem0 themselves evaluate recall quality.
*
*  Pipeline (every search invokes LLM at query_rewrite + rerank):
*    add → LLM extract → LLM dedup → LLM entity → embed → store
*    search → LLM rewrite → embed × 4 → 4-signal RRF → LLM rerank → top_k
*
*  Run:
*    npx tsx examples/mem0-style-eval.ts
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
    db_path: './mem0-style-eval.db',
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

// 3 query topics × 10 relevant = 30 relevant
const RELEVANT: Record<string, string[]> = {
    '用户喜欢什么编程语言?': [
        '用户偏好 TypeScript', '项目用 TypeScript + Node.js', 'TypeScript 是首选语言',
        '所有新代码都用 TypeScript 风格', '团队统一使用 TypeScript',
        'TypeScript 是首选语言', '代码用 TypeScript 写',
        'TypeScript 静态类型检查帮助很大', '新项目用 TypeScript 启动',
        '用户对 TypeScript 接受度很高',
    ],
    '数据库怎么配置?': [
        '生产数据库用 PostgreSQL 15', '数据库连接池配 20', 'Prisma 配 PostgreSQL 做 migration',
        '数据库连接字符串配在 .env 里', 'PostgreSQL 默认端口是 5432',
        '数据库备份每天一次', 'DB 主从复制配置好了',
        '数据库索引要加在常用查询字段', '数据库慢查询日志要打开',
        'DB schema 用 Prisma 管理',
    ],
    '项目什么时候截止?': [
        '12 月 15 号交付', 'Q4 末上线', 'deadline 这周',
        '项目要在月底完成', '最终发布日期定在 12 月 31',
        '本周五要演示给客户', '上线时间不能拖',
        '进度紧张,还有 2 周要交付', '客户催得紧,deadline 不能变',
        '项目验收会议定在月底',
    ],
};

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
        '被钓鱼邮件骗了', '装了新系统', '键盘进水了',
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
        out.push(`${t1},${v}了${t2},第 ${i + 1} 条`);
    }
    return out;
}

function safe_json_parse(text: string): Record<string, unknown> | null {
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
        return null;
    }
}

async function llm_judge(query: string, candidate: string): Promise<'relevant' | 'irrelevant'> {
    const url = `${LLM_BASE.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LONGMEMORY_LLM_API_KEY}` },
        body: JSON.stringify({
            model: process.env.LONGMEMORY_MODEL ?? 'MiniMax-M3',
            messages: [
                { role: 'system', content: `You are a relevance judge. Determine whether the CANDIDATE memory directly answers or is strongly related to the QUERY. Reply JSON only (no thinking, no markdown): {"relevant": bool}.` },
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
    return parsed?.['relevant'] ? 'relevant' : 'irrelevant';
}

async function main() {
    const all_relevant = Object.values(RELEVANT).flat();
    const noise = make_noise(30);
    const all = [...noise, ...all_relevant];

    console.log('=== mem0-style evaluation (60 items, LLM-judge) ===\n');
    console.log(`Inserting ${all.length} memories (full LLM pipeline, with dedup)...`);
    const t0 = Date.now();
    let added = 0, skipped = 0;
    for (const item of all) {
        const r = await memory.add(item, { scope: { user_id: 'eval' } });
        added += r.added.length;
        skipped += r.skipped.length;
    }
    console.log(`Insert done in ${((Date.now() - t0) / 1000).toFixed(0)}s  added=${added} skipped=${skipped}\n`);

    const total_stored = memory.list({ scope: { user_id: 'eval' } }).length;
    console.log(`Total memories in DB: ${total_stored}\n`);

    const TOP_K = 5;
    let total_relevant = 0;
    let total_shown = 0;
    for (const [query, expected] of Object.entries(RELEVANT)) {
        const expected_set = new Set(expected);
        const r = await memory.search({ query, scope: { user_id: 'eval' }, top_k: TOP_K });
        let hits = 0;
        console.log(`Q: ${query}  (expected ${expected.length} relevant)`);
        for (const x of r) {
            const verdict = await llm_judge(query, x.content);
            const exact = expected_set.has(x.content);
            const mark = verdict === 'relevant' ? '✓' : ' ';
            console.log(`  ${mark} [${(x.score ?? 0).toFixed(4)}] ${x.content.slice(0, 70)}${exact ? ' (exact)' : ''}`);
            if (verdict === 'relevant') hits++;
        }
        const p = (hits / r.length) * 100;
        const r2 = (hits / expected.length) * 100;
        total_relevant += hits;
        total_shown += r.length;
        console.log(`  → precision@${TOP_K} = ${p.toFixed(0)}%, recall@${TOP_K} = ${r2.toFixed(0)}% (LLM-judged relevant: ${hits}/${expected.length})\n`);
    }

    console.log('=== OVERALL (LLM-judged) ===');
    const overall_p = (total_relevant / total_shown) * 100;
    const overall_r = (total_relevant / (Object.keys(RELEVANT).length * 10)) * 100;
    console.log(`  precision@${TOP_K}: ${overall_p.toFixed(1)}%`);
    console.log(`  recall@${TOP_K}:    ${overall_r.toFixed(1)}%  (30 expected relevant)`);
    console.log(`  total LLM-judged relevant: ${total_relevant}/${total_shown}`);

    memory.close();
    const fs = await import('node:fs');
    for (const ext of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`./mem0-style-eval.db${ext}`); } catch { /* ignore */ }
    }
    console.log('\n✓ Cleaned up');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });