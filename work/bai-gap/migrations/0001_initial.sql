PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('Admin','Assessor','Viewer')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS gaps (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, domain TEXT NOT NULL,
 actual REAL NOT NULL CHECK(actual>=1 AND actual<=5), target REAL NOT NULL CHECK(target>=1 AND target<=5),
 priority TEXT NOT NULL CHECK(priority IN ('Kritis','Tinggi','Sedang','Rendah')),
 owner TEXT NOT NULL, due TEXT NOT NULL, action TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('Belum dimulai','Dalam proses','Selesai')),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT(datetime('now')), updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id), username TEXT NOT NULL,
 action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, details TEXT,
 created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps(status);