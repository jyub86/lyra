// SQLite connection + schema migration (design §3, §4).
// Single local DB file. bun:sqlite bundles SQLite with FTS5.

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.WORSHIP_DB || join(__dirname, "../../data/worship.db");
const SCHEMA_PATH = join(__dirname, "schema.sql");

let _db = null;

// Add a column if the table lacks it (non-destructive migration for existing DBs).
function ensureColumn(db, table, col, decl) {
  const cols = db.query(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

// Applies schema.sql (idempotent — all CREATE ... IF NOT EXISTS) + column migrations.
export function migrate(db) {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql); // exec runs multiple statements; run() would stop after the first.
  // v4.1: additive columns on services (kept for DBs created before v4.1)
  ensureColumn(db, "services", "theme_overrides", "TEXT");
  ensureColumn(db, "services", "transition", "TEXT DEFAULT 'none'");
  // v4.5: 슬라이드 숨기기(발표에서 건너뜀)
  ensureColumn(db, "slides", "hidden", "INTEGER NOT NULL DEFAULT 0");
  return db;
}

export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { create: true });
  // DELETE 저널 모드: WAL 사이드카(-wal/-shm)를 두지 않아 항상 단일 파일(worship.db)로 유지된다.
  // (WAL이었던 기존 DB는 여기서 자동으로 본 파일에 합쳐지고 사이드카가 삭제됨.)
  // busy_timeout: server + MCP 등 다중 프로세스의 짧은 쓰기 경합을 재시도로 흡수.
  _db.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(_db);
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

// `bun run core/db/index.js --reset` → drop the file-backed DB and re-create.
if (import.meta.main) {
  if (process.argv.includes("--reset")) {
    closeDb();
    const { rmSync } = await import("node:fs");
    for (const ext of ["", "-shm", "-wal"]) {
      try { rmSync(DB_PATH + ext); } catch {}
    }
    console.log("Reset DB:", DB_PATH);
  }
  getDb();
  // 기본 슬라이드 종류(builtin 템플릿)까지 시드해 리셋 직후에도 바로 추가할 수 있게 한다.
  const { loadTools } = await import("../tools/registry.js");
  await loadTools();
  console.log("Schema applied + builtins seeded:", DB_PATH);
}
