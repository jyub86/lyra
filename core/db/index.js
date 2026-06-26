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

// Applies schema.sql (idempotent — all CREATE ... IF NOT EXISTS).
export function migrate(db) {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql); // exec runs multiple statements; run() would stop after the first.
  return db;
}

export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
  console.log("Schema applied:", DB_PATH);
}
