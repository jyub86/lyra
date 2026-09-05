// Seed orchestrator — imports 성경/찬송가/교독문/찬양가사 into the DB.
// Reads from WORSHIP_DATA_DIR (default: data/source), expecting
// bible.json / hymns.json / readings.json (+ songs.json, 있으면).
// Idempotent (clears then inserts).
//
//   bun run core/db/seed/index.js
//   WORSHIP_DATA_DIR=/path/to/data bun run core/db/seed/index.js
//   bun run core/db/seed/index.js --songs   # 찬양 가사만 다시 적재(가사 수정 반영)
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { getDb } from "../index.js";
import { importBible } from "./import-bible.js";
import { importHymns } from "./import-hymns.js";
import { importReadings } from "./import-readings.js";
import { importSongs } from "./import-songs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WORSHIP_DATA_DIR || join(__dirname, "../../../data/source");

function load(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) {
    throw new Error(`원본 파일 없음: ${p}\n  WORSHIP_DATA_DIR 환경변수로 경로를 지정하거나 data/source/에 두세요.`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

// songs.json은 선택 — 찬양 PPT 모음에서 추출했을 때만 있다(없으면 조용히 건너뛴다).
function seedSongs(db) {
  const p = join(DATA_DIR, "songs.json");
  if (!existsSync(p)) return null;
  return importSongs(db, JSON.parse(readFileSync(p, "utf8")));
}

export function seed(db = getDb()) {
  console.log("데이터 경로:", DATA_DIR);
  const bible = importBible(db, load("bible.json"));
  const hymns = importHymns(db, load("hymns.json"));
  const readings = importReadings(db, load("readings.json"));
  const songs = seedSongs(db);
  return { bible, hymns, readings, songs };
}

if (import.meta.main) {
  // --songs = 찬양 가사만 다시 적재. 가사 오탈자를 songs.json에서 고친 뒤 쓰면
  // 성경/찬송가를 다시 넣는 시간(수십 초)을 아낀다.
  const result = process.argv.includes("--songs") ? { songs: seedSongs(getDb()) } : seed();
  console.log("시드 완료:", JSON.stringify(result));
}
