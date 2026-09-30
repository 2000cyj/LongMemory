-- mem0-style schema for LongMemory
-- Single SQLite file, 3 main tables + 1 FTS5 virtual table + triggers
-- All scope filters via indexed columns (user_id / agent_id / run_id / app_id)

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    scope_user_id TEXT,
    scope_agent_id TEXT,
    scope_run_id TEXT,
    scope_app_id TEXT,
    content TEXT NOT NULL,
    category TEXT,
    embedding BLOB,
    embedding_model TEXT,
    embedding_dim INTEGER,
    metadata TEXT,
    source TEXT DEFAULT 'user',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(scope_user_id);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(scope_agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_run ON memories(scope_run_id);
CREATE INDEX IF NOT EXISTS idx_memories_app ON memories(scope_app_id);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT,
    embedding BLOB,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, entity_id),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);

-- Full-text search for BM25 keyword search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
