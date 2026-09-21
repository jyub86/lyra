// Seed orchestrator — imports 성경/찬송가/교독문/찬양가사 into the DB.
// Reads from WORSHIP_DATA_DIR (default: data/source), expecting
// bible.json / hymns.json / readings.json (+ songs.json, 있으면).
// Idempotent (clears then inserts).
//
//   bun run core/db/seed/index.js
//   WORSHIP_DATA_DIR=/path/to/data bun run core/db/seed/index.js
//   bun run core/db/seed/index.js --songs   # 찬양 가사만 다시 적재(가사 수정 반영)
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../../lib/paths.js";
import { getDb } from "../index.js";
import { importBible } from "./import-bible.js";
import { importHymns } from "./import-hymns.js";
import { importReadings } from "./import-readings.js";
import { importSongs } from "./import-songs.js";

const DATA_DIR = process.env.WORSHIP_DATA_DIR || dataPath("source");

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

// 첫 실행 자동 적재 — data/source 에 넣어둔 파일 중 **아직 DB에 없는 것만** 채운다.
// 배포판(단일 실행파일)에는 저작권 자료가 들어 있지 않아서, 사용자가 파일을 넣고
// 다시 켜면 알아서 등록되어야 한다. 이미 들어 있으면 건너뛰므로 매번 켜도 느려지지 않는다.
const AUTO = [
  ["bible.json", "bible_verses", importBible],
  ["hymns.json", "hymns", importHymns],
  ["readings.json", "responsive_readings", importReadings],
  ["songs.json", "songs", importSongs],
];

export function autoSeed(db = getDb()) {
  const done = {};
  for (const [file, table, fn] of AUTO) {
    const path = join(DATA_DIR, file);
    if (!existsSync(path)) continue;
    let empty = true;
    try { empty = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get().c === 0; } catch { continue; }
    if (!empty) continue;
    try { done[file] = fn(db, JSON.parse(readFileSync(path, "utf8"))); }
    catch (e) { console.error(`  ⚠️  ${file} 등록 실패: ${e.message}`); }
  }
  return done;
}

if (import.meta.main) {
  // --songs = 찬양 가사만 다시 적재. 가사 오탈자를 songs.json에서 고친 뒤 쓰면
  // 성경/찬송가를 다시 넣는 시간(수십 초)을 아낀다.
  const result = process.argv.includes("--songs") ? { songs: seedSongs(getDb()) } : seed();
  console.log("시드 완료:", JSON.stringify(result));
}
