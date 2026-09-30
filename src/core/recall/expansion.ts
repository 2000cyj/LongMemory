/*
*  file  : src/core/recall/expansion.ts
*  usage : Common abbreviation → full-form expansion for query rewriting.
*          Applied BEFORE LLM query_rewrite to expand short queries cheaply.
*/

const ABBREVIATIONS: Record<string, string[]> = {
    // languages / frameworks
    ts: ['typescript'],
    js: ['javascript'],
    py: ['python'],
    kt: ['kotlin'],
    cpp: ['c++'],
    cs: ['c#'],
    rb: ['ruby'],
    rs: ['rust'],
    go: ['golang'],

    // runtimes / tools
    k8s: ['kubernetes'],
    k9s: ['kubernetes'],
    node: ['nodejs', 'node.js'],
    npm: ['node package manager'],
    yarn: ['yarn package manager'],
    pnpm: ['package manager'],
    pyenv: ['python version manager'],

    // databases
    db: ['database'],
    pg: ['postgresql'],
    postgres: ['postgresql'],
    mongo: ['mongodb'],
    mysql: ['mysql'],
    redis: ['redis'],
    sqlite: ['sqlite'],
    es: ['elasticsearch'],
    cassandra: ['cassandra'],

    // infra
    aws: ['amazon web services'],
    gcp: ['google cloud platform'],
    k8: ['kubernetes'],

    // dev terms
    api: ['application programming interface'],
    sdk: ['software development kit'],
    ui: ['user interface'],
    ux: ['user experience'],
    dbms: ['database management system'],
    sql: ['structured query language'],
    orm: ['object relational mapper'],
    mvc: ['model view controller'],
    jwt: ['json web token'],
    oauth: ['open authorization'],
    csrf: ['cross site request forgery'],
    xss: ['cross site scripting'],
    ci: ['continuous integration'],
    cd: ['continuous deployment'],
    pr: ['pull request'],
    repo: ['repository'],
    cfg: ['configuration'],
    config: ['configuration'],
    env: ['environment', 'environment variable'],
    var: ['variable'],
    fn: ['function'],
    util: ['utility', 'utilities'],
    lib: ['library'],
    pkg: ['package'],
    doc: ['document', 'documentation'],
    docs: ['documentation'],
    msg: ['message'],
    req: ['request', 'requirement'],
    resp: ['response'],
    svc: ['service'],
    auth: ['authentication', 'authorization'],
    authn: ['authentication'],
    authz: ['authorization'],
    passwd: ['password'],
    pwd: ['password'],
    url: ['uniform resource locator'],
    uri: ['uniform resource identifier'],
    uuid: ['universally unique identifier'],
    id: ['identifier'],
    q: ['question', 'query'],
};

/**
 * Expand an abbreviation in text to its full forms.
 * Only matches whole words (case-insensitive). Preserves original casing.
 *
 * Example: "ts 偏好" → "ts 偏好 typescript"
 *          "k8s 部署" → "k8s 部署 kubernetes 部署"
 */
export function expand_abbreviations(text: string): string[] {
    const variants = [text];
    const lower = text.toLowerCase();
    for (const [abbr, fulls] of Object.entries(ABBREVIATIONS)) {
        const re = new RegExp(`\\b${abbr}\\b`, 'i');
        if (!re.test(lower)) continue;
        for (const full of fulls) {
            const expanded = text.replace(re, full);
            if (!variants.includes(expanded)) variants.push(expanded);
        }
    }
    return variants;
}

/**
 * Extract all known abbreviation tokens from text (for entity matching).
 */
export function extract_known_tokens(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();
    for (const [abbr, fulls] of Object.entries(ABBREVIATIONS)) {
        const re = new RegExp(`\\b${abbr}\\b`, 'i');
        if (re.test(lower)) {
            tokens.push(abbr);
            tokens.push(...fulls);
        }
    }
    return [...new Set(tokens)];
}