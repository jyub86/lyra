// Seed orchestrator — imports 성경/찬송가/교독문 into the DB.
// Reads from WORSHIP_DATA_DIR (default: data/source), expecting
// bible.json / hymns.json / readings.json. Idempotent (clears then inserts).
//
//   bun run core/db/seed/index.js
//   WORSHIP_DATA_DIR=/path/to/data bun run core/db/seed/index.js
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { getDb } from "../index.js";
import { importBible } from "./import-bible.js";
import { importHymns } from "./import-hymns.js";
import { importReadings } from "./import-readings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WORSHIP_DATA_DIR || join(__dirname, "../../../data/source");

function load(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) {
    throw new Error(`원본 파일 없음: ${p}\n  WORSHIP_DATA_DIR 환경변수로 경로를 지정하거나 data/source/에 두세요.`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function seed(db = getDb()) {
  console.log("데이터 경로:", DATA_DIR);
  const bible = importBible(db, load("bible.json"));
  const hymns = importHymns(db, load("hymns.json"));
  const readings = importReadings(db, load("readings.json"));
  return { bible, hymns, readings };
}

if (import.meta.main) {
  const result = seed();
  console.log("시드 완료:", JSON.stringify(result));
}
