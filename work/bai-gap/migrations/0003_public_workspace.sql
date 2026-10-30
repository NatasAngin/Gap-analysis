-- Remove the users-table foreign key from gaps.created_by.
-- Existing assessment data and condition fields are preserved.
CREATE TABLE gaps_new (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 domain TEXT NOT NULL,
 actual REAL NOT NULL CHECK(actual>=1 AND actual<=5),
 target REAL NOT NULL CHECK(target>=1 AND target<=5),
 priority TEXT NOT NULL CHECK(priority IN ('Kritis','Tinggi','Sedang','Rendah')),
 owner TEXT NOT NULL,
 due TEXT NOT NULL,
 action TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('Belum dimulai','Dalam proses','Selesai')),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(datetime('now')),
 updated_at TEXT NOT NULL DEFAULT(datetime('now')),
 actual_condition TEXT NOT NULL DEFAULT '',
 ideal_condition TEXT NOT NULL DEFAULT ''
);
INSERT INTO gaps_new (
 id,title,domain,actual,target,priority,owner,due,action,status,created_by,
 created_at,updated_at,actual_condition,ideal_condition
)
SELECT
 id,title,domain,actual,target,priority,owner,due,action,status,created_by,
 created_at,updated_at,actual_condition,ideal_condition
FROM gaps;
DROP TABLE gaps;
ALTER TABLE gaps_new RENAME TO gaps;
CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps(status);
