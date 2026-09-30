/*
*  file  : src/core/engine/store.ts
*  usage : SQLite store — tables, FTS5, vector blobs, CRUD
*/

import BetterSqlite3 from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { scope, stored_memory } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

function pack_embedding(vec: number[]): Buffer {
    const buf = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
    return buf;
}

function unpack_embedding(buf: Buffer | null): number[] | null {
    if (!buf) return null;
    const arr = new Float32Array(buf.length / 4);
    for (let i = 0; i < arr.length; i++) arr[i] = buf.readFloatLE(i * 4);
    return Array.from(arr);
}

function now_ms(): number {
    return Date.now();
}

function gen_id(): string {
    return 'mem_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export class Store {
    private db: BetterSqlite3.Database;
    private readonly: boolean;

    constructor(db_path: string, opts: { readonly?: boolean } = {}) {
        this.readonly = opts.readonly ?? false;
        this.db = new BetterSqlite3(db_path);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        if (!this.readonly) this.init_schema();
    }

    private init_schema(): void {
        const sql = readFileSync(SCHEMA_PATH, 'utf-8');
        this.db.exec(sql);
        // Backfill columns for DBs created by an earlier version of the schema.
        this.add_column_if_missing('memories', 'access_count', 'INTEGER NOT NULL DEFAULT 0');
        this.add_column_if_missing('memories', 'last_accessed_at', 'INTEGER');
    }

    private add_column_if_missing(table: string, column: string, definition: string): void {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (cols.some((c) => c.name === column)) return;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }

    close(): void {
        this.db.close();
    }

    // ── Memory CRUD ────────────────────────────────────────────────

    insert_memory(input: {
        id?: string;
        scope: scope;
        content: string;
        category?: string;
        embedding?: number[];
        embedding_model?: string;
        metadata?: Record<string, unknown>;
        source?: string;
    }): stored_memory {
        const id = input.id ?? gen_id();
        const ts = now_ms();
        this.db.prepare(`
            INSERT INTO memories
            (id, scope_user_id, scope_agent_id, scope_run_id, scope_app_id,
             content, category, embedding, embedding_model, embedding_dim,
             metadata, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            input.scope.user_id ?? null,
            input.scope.agent_id ?? null,
            input.scope.run_id ?? null,
            input.scope.app_id ?? null,
            input.content,
            input.category ?? null,
            input.embedding ? pack_embedding(input.embedding) : null,
            input.embedding_model ?? null,
            input.embedding?.length ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
            input.source ?? 'user',
            ts,
            ts,
        );
        return {
            id,
            scope: input.scope,
            content: input.content,
            category: input.category,
            entities: [],
            embedding_dim: input.embedding?.length,
            metadata: input.metadata,
            source: input.source ?? 'user',
            created_at: ts,
            updated_at: ts,
        };
    }

    get_memory(id: string): stored_memory | null {
        const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as any;
        if (!row) return null;
        return this.row_to_memory(row);
    }

    delete_memory(id: string): void {
        this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    }

    private row_to_memory(row: any): stored_memory {
        return {
            id: row.id,
            scope: {
                user_id: row.scope_user_id ?? undefined,
                agent_id: row.scope_agent_id ?? undefined,
                run_id: row.scope_run_id ?? undefined,
                app_id: row.scope_app_id ?? undefined,
            },
            content: row.content,
            category: row.category ?? undefined,
            entities: this.get_memory_entities(row.id),
            embedding_dim: row.embedding_dim ?? undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            source: row.source ?? undefined,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    // ── Scope queries ──────────────────────────────────────────────

    private scope_clause(scope: scope | undefined): { sql: string; params: any[] } {
        if (!scope) return { sql: '1=1', params: [] };
        const parts: string[] = [];
        const params: any[] = [];
        if (scope.user_id !== undefined) { parts.push('scope_user_id = ?'); params.push(scope.user_id); }
        if (scope.agent_id !== undefined) { parts.push('scope_agent_id = ?'); params.push(scope.agent_id); }
        if (scope.run_id !== undefined) { parts.push('scope_run_id = ?'); params.push(scope.run_id); }
        if (scope.app_id !== undefined) { parts.push('scope_app_id = ?'); params.push(scope.app_id); }
        return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
    }

    list_memory_ids(scope: scope | undefined, limit = 5000): string[] {
        const { sql: where, params } = this.scope_clause(scope);
        const rows = this.db.prepare(
            `SELECT id FROM memories WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
        ).all(...params, limit) as any[];
        return rows.map((r) => r.id);
    }

    count_memories(scope?: scope): number {
        const { sql: where, params } = this.scope_clause(scope);
        const row = this.db.prepare(`SELECT COUNT(*) as n FROM memories WHERE ${where}`).get(...params) as any;
        return row.n;
    }

    load_memories(ids: string[]): stored_memory[] {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as any[];
        return rows.map((r) => this.row_to_memory(r));
    }

    load_embeddings(scope: scope | undefined): Array<{ id: string; embedding: number[] }> {
        const { sql: where, params } = this.scope_clause(scope);
        const rows = this.db.prepare(
            `SELECT id, embedding FROM memories WHERE ${where} AND embedding IS NOT NULL`,
        ).all(...params) as any[];
        return rows
            .map((r) => ({ id: r.id, embedding: unpack_embedding(r.embedding)! }))
            .filter((r) => r.embedding.length > 0);
    }

    // ── BM25 keyword search via FTS5 ───────────────────────────────

    bm25_search(query_text: string, scope: scope | undefined, limit = 50): Array<{ id: string; score: number }> {
        const { sql: where, params } = this.scope_clause(scope);
        const rows = this.db.prepare(`
            SELECT m.id, bm25(memories_fts) as bm
            FROM memories_fts
            JOIN memories m ON m.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ? AND ${where}
            ORDER BY bm
            LIMIT ?
        `).all(this.build_fts_query(query_text), ...params, limit) as any[];
        const max_neg = Math.min(...rows.map((r) => r.bm));
        return rows.map((r) => ({
            id: r.id,
            score: max_neg === 0 ? 0 : Math.max(0, 1 + r.bm / Math.abs(max_neg)),
        }));
    }

    private build_fts_query(text: string): string {
        const tokens = text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter((t) => t.length >= 2)
            .slice(0, 12);
        if (tokens.length === 0) return '""';
        return tokens.map((t) => `"${t}"*`).join(' OR ');
    }

    // ── Entity CRUD ────────────────────────────────────────────────

    upsert_entity(name: string, type?: string, embedding?: number[]): { id: string; name: string; type?: string } {
        const existing = this.db.prepare(`SELECT id, type FROM entities WHERE name = ?`).get(name) as any;
        if (existing) {
            if (type && type !== existing.type) {
                this.db.prepare(`UPDATE entities SET type = ? WHERE id = ?`).run(type, existing.id);
            }
            return { id: existing.id, name, type: type ?? existing.type ?? undefined };
        }
        const id = 'ent_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
        this.db.prepare(`
            INSERT INTO entities (id, name, type, embedding, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, name, type ?? null, embedding ? pack_embedding(embedding) : null, now_ms());
        return { id, name, type };
    }

    link_entity(memory_id: string, entity_id: string): void {
        this.db.prepare(`INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)`).run(memory_id, entity_id);
    }

    get_memory_entities(memory_id: string): { id: string; name: string; type?: string }[] {
        const rows = this.db.prepare(`
            SELECT e.id, e.name, e.type FROM entities e
            JOIN memory_entities me ON me.entity_id = e.id
            WHERE me.memory_id = ?
        `).all(memory_id) as any[];
        return rows.map((r) => ({ id: r.id, name: r.name, type: r.type ?? undefined }));
    }

    entity_search(query_terms: string[], scope: scope | undefined, limit = 50): string[] {
        if (query_terms.length === 0) return [];
        const { sql: where, params } = this.scope_clause(scope);
        const name_likes = query_terms.map(() => 'LOWER(e.name) LIKE ?').join(' OR ');
        const like_params = query_terms.map((t) => `%${t.toLowerCase()}%`);
        const rows = this.db.prepare(`
            SELECT DISTINCT me.memory_id as id
            FROM memory_entities me
            JOIN entities e ON e.id = me.entity_id
            JOIN memories m ON m.id = me.memory_id
            WHERE (${name_likes}) AND ${where}
            LIMIT ?
        `).all(...like_params, ...params, limit) as any[];
        return rows.map((r) => r.id);
    }

    count_entities(): number {
        const row = this.db.prepare(`SELECT COUNT(*) as n FROM entities`).get() as any;
        return row.n;
    }

    // ── Popularity / access tracking ──────────────────────────────

    /** Increment access_count for the given memory ids. Atomic batch. */
    increment_access(ids: string[], at_ms: number = Date.now()): void {
        if (ids.length === 0) return;
        const stmt = this.db.prepare(
            `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
        );
        const tx = this.db.transaction((id_list: string[]) => {
            for (const id of id_list) stmt.run(at_ms, id);
        });
        tx(ids);
    }

    /** Load access_count for a list of memory ids. Returns id → count map. */
    load_access_counts(ids: string[]): Map<string, { count: number; last_accessed_at: number | null }> {
        const map = new Map<string, { count: number; last_accessed_at: number | null }>();
        if (ids.length === 0) return map;
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT id, access_count, last_accessed_at FROM memories WHERE id IN (${placeholders})`,
        ).all(...ids) as Array<{ id: string; access_count: number; last_accessed_at: number | null }>;
        for (const r of rows) {
            map.set(r.id, { count: r.access_count, last_accessed_at: r.last_accessed_at });
        }
        return map;
    }
}
