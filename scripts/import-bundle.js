#!/usr/bin/env bun
// export-bundle.js가 만든 번들을 이 PC에 적용한다(윈도우/맥/리눅스 공통).
//
//   bun run scripts/import-bundle.js --bundle D:\lyra-bundle --library C:\lyra\ppt
//   bun run scripts/import-bundle.js --bundle /Volumes/USB/lyra-bundle --library ~/church/ppt --dry-run
//
// 옵션: --target <lyra 폴더>(기본=이 스크립트의 저장소) --dry-run --keep-db(DB는 그대로 두고 경로만 재정렬)
//
// 하는 일:
//   1) 번들의 파일들을 이 PC로 복사 (증분 — 같은 크기+mtime이면 건너뜀)
//   2) DB의 맥 절대경로를 이 PC 경로로 교체 (settings.library_dir, library_index.path/mtime)
//   3) 렌더캐시 폴더명 = sha1(파일경로+mtime+너비) 를 새 경로 기준으로 다시 계산해 그 이름으로 넣음
//      → 1.7GB짜리 변환 캐시가 그대로 살아난다(안 하면 전부 미스).
// 여러 번 실행해도 안전하다(같은 결과).

import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFor } from "../core/lib/render-cache.js";
import { RENDER_WIDTH } from "../core/lib/pdf-import.js";

const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DONE = ".done";

// ── args ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const BUNDLE = opt("--bundle") && resolve(opt("--bundle"));
const LIBRARY = opt("--library") && resolve(opt("--library"));   // 이 PC에 PPT 라이브러리를 놓을 폴더
const TARGET = resolve(opt("--target") || SCRIPT_ROOT);
const DRY = flag("--dry-run");
if (!BUNDLE || !LIBRARY) {
  console.error("사용법: bun run scripts/import-bundle.js --bundle <번들 폴더> --library <PPT 폴더> [--target <lyra 폴더>] [--dry-run] [--keep-db]");
  process.exit(1);
}
if (!existsSync(join(BUNDLE, "manifest.json"))) { console.error(`번들이 아닙니다(manifest.json 없음): ${BUNDLE}`); process.exit(1); }
const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));
if (manifest.format !== "lyra-bundle/v1") { console.error(`모르는 번들 형식: ${manifest.format}`); process.exit(1); }

const fmt = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + "GB" : b > 1e6 ? (b / 1e6).toFixed(0) + "MB" : (b / 1e3).toFixed(0) + "KB";
const toPosix = (p) => p.split(sep).join("/");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const p = join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

// 반환: 실제로 복사했으면 true (같은 크기+mtime이면 건너뜀).
function copyFile(src, dst, stats) {
  const st = stats || statSync(src);
  if (existsSync(dst)) {
    const d = statSync(dst);
    if (d.size === st.size && Math.floor(d.mtimeMs) === Math.floor(st.mtimeMs)) return false;
  }
  if (DRY) return true;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  utimesSync(dst, st.atime, st.mtime);   // mtime 보존 — 캐시 키·증분 판정의 핵심
  return true;
}

// 진행률은 터미널에서만(파이프로 넘길 땐 \r가 지저분하게 남는다).
function progress(label, i, total, every) {
  if (process.stdout.isTTY && i % every === every - 1) process.stdout.write(`\r  ${label}: ${i + 1}/${total}`);
}
function progressEnd(total, every) {
  if (process.stdout.isTTY && total >= every) process.stdout.write("\r".padEnd(48) + "\r");
}

function copyTree(srcDir, dstDir, label) {
  const files = walk(srcDir);
  if (!files.length) return { files: 0, bytes: 0 };
  let copied = 0, bytes = 0;
  files.forEach((f, i) => {
    const st = statSync(f);
    bytes += st.size;
    if (copyFile(f, join(dstDir, relative(srcDir, f)), st)) copied++;
    progress(label, i, files.length, 200);
  });
  progressEnd(files.length, 200);
  console.log(`  ${label}: ${files.length}개 (${fmt(bytes)}) — 복사 ${copied} / 그대로 ${files.length - copied}`);
  return { files: files.length, bytes, copied };
}

console.log(`Lyra 번들 적용${DRY ? " (dry-run — 실제 변경 없음)" : ""}`);
console.log(`  번들: ${BUNDLE} (${manifest.created.slice(0, 16).replace("T", " ")} 생성, ${manifest.source.platform})`);
console.log(`  설치 위치: ${TARGET}`);
console.log(`  PPT 라이브러리: ${LIBRARY}`);
console.log(`  원본 라이브러리 경로: ${manifest.source.library_dir}\n`);

// ── 1) PPT 라이브러리 복사 ────────────────────────────────────────
console.log("복사:");
if (!DRY) mkdirSync(LIBRARY, { recursive: true });
copyTree(join(BUNDLE, "library"), LIBRARY, "library");

// ── 2) 이 PC의 라이브러리 실제 파일 목록 (NFC 상대경로 → 실제 경로) ──
// 맥 파일명은 NFD라 압축/전송 과정에서 형태가 달라질 수 있어, 매칭은 NFC로 통일한다.
// 단 캐시 키에 넣을 경로는 "이 PC에서 실제로 읽히는 문자열"이어야 하므로 walk 결과를 그대로 쓴다.
const disk = new Map();
for (const f of walk(LIBRARY)) {
  disk.set(toPosix(relative(LIBRARY, f)).normalize("NFC"), { abs: f, mtime: Math.floor(statSync(f).mtimeMs) });
}
// dry-run은 복사를 안 했으니, 번들에 있는 파일이 "들어왔다면" 어떤 경로·mtime이 될지로 예측한다
// (실제 복사도 mtime을 보존하므로 예측 키가 실제와 일치한다).
if (DRY) {
  const bl = join(BUNDLE, "library");
  for (const f of walk(bl)) {
    const rel = toPosix(relative(bl, f)).normalize("NFC");
    if (!disk.has(rel)) disk.set(rel, { abs: join(LIBRARY, ...relative(bl, f).split(sep)), mtime: Math.floor(statSync(f).mtimeMs) });
  }
}
console.log(`  → 라이브러리 파일 ${disk.size}개 확인${DRY ? " (번들 기준 예측 포함)" : ""}`);

// ── 3) DB 배치 ────────────────────────────────────────────────────
const dbPath = join(TARGET, "data/worship.db");
const STAMP = `${manifest.created}|${LIBRARY}`;   // 이 번들을 이 경로로 적용했다는 표시(settings에 기록)

// 이미 같은 번들을 같은 라이브러리 경로로 적용했는지. 적용 후에는 DB가 커져서
// 파일 크기·mtime 비교로는 판정할 수 없어, DB 안에 표시를 남겨 확인한다.
function alreadyApplied() {
  if (!existsSync(dbPath)) return false;
  try {
    const t = new Database(dbPath, { readonly: true });
    const v = t.query("SELECT value FROM settings WHERE key = 'bundle_applied'").get()?.value;
    t.close();
    return v === STAMP;
  } catch { return false; }
}

if (!flag("--keep-db") && alreadyApplied() && !flag("--force-db")) {
  console.log("  worship.db: 이 번들이 이미 적용돼 있어 그대로 둡니다 (--force-db로 강제 교체)");
} else if (!flag("--keep-db")) {
  const src = join(BUNDLE, "data/worship.db");
  if (!existsSync(src)) { console.error(`번들에 DB가 없습니다: ${src}`); process.exit(1); }
  const ss = statSync(src);
  if (existsSync(dbPath) && !DRY) {
    const bak = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    renameSync(dbPath, bak);
    console.log(`  기존 DB 백업 → ${bak}`);
  }
  copyFile(src, dbPath, ss);
  // 이전 실행/서버가 남긴 WAL은 새 DB와 짝이 맞지 않는다. 반드시 제거.
  if (!DRY) for (const ext of ["-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
  console.log(`  worship.db 배치${DRY ? " (건너뜀)" : ` (${fmt(statSync(dbPath).size)})`}`);
}
// ── 4) DB 경로 교체 + 캐시 키 재계산 ──────────────────────────────
// dry-run은 "번들 DB를 넣었다면 어떻게 되는가"를 보여줘야 하므로 번들 쪽을 읽는다
// (대상 DB는 이미 이관됐거나 다른 내용일 수 있다).
const db = new Database(DRY ? join(BUNDLE, "data/worship.db") : dbPath, DRY ? { readonly: true } : { readwrite: true });
const oldRoot = manifest.source.library_dir || "";
const rows = db.query("SELECT path, relpath, mtime FROM library_index").all();

const keymap = [];        // { oldKey, newKey }
let matched = 0, missing = 0, mtimeChanged = 0;
const update = DRY ? null : db.query("UPDATE library_index SET path = ?, mtime = ? WHERE path = ?");
if (!DRY) db.exec("BEGIN");
for (const r of rows) {
  // DB에 든 옛 경로에서 상대경로를 뽑아 이 PC의 실제 파일을 찾는다.
  const rel = (r.path.startsWith(oldRoot) ? r.path.slice(oldRoot.length).replace(/^[/\\]+/, "") : r.relpath);
  const hit = disk.get(toPosix(rel).normalize("NFC")) || disk.get(toPosix(r.relpath).normalize("NFC"));
  if (!hit) { missing++; continue; }
  matched++;
  if (hit.mtime !== r.mtime) mtimeChanged++;
  keymap.push({ oldKey: keyFor(r.path, r.mtime, RENDER_WIDTH), newKey: keyFor(hit.abs, hit.mtime, RENDER_WIDTH) });
  if (!DRY && (hit.abs !== r.path || hit.mtime !== r.mtime)) update.run(hit.abs, hit.mtime, r.path);
}
if (!DRY) {
  const set = db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  set.run("library_dir", LIBRARY);
  set.run("bundle_applied", STAMP);   // 재실행 시 DB를 다시 덮어쓰지 않게 하는 표시
  db.exec("COMMIT");
}
console.log(`\nDB 경로 교체: 색인 ${rows.length}개 중 ${matched}개 연결 · 못 찾음 ${missing}개${mtimeChanged ? ` · mtime 달라진 파일 ${mtimeChanged}개` : ""}`);
console.log(`  settings.library_dir → ${LIBRARY}`);
const extra = disk.size - matched;
if (extra > 0) console.log(`  (색인에 없는 파일 ${extra}개 — 나중에 index_library 실행하면 잡힙니다)`);

// ── 5) 렌더캐시를 새 키 이름으로 배치 ─────────────────────────────
const bundleCache = join(BUNDLE, "data/render-cache");
const targetCache = join(TARGET, "data/render-cache");
let restored = 0, already = 0, absent = 0, cacheBytes = 0;
if (existsSync(bundleCache)) {
  keymap.forEach(({ oldKey, newKey }, i) => {
    const from = join(bundleCache, oldKey);
    if (existsSync(join(targetCache, newKey, DONE))) { already++; return; }   // 이미 이 PC 기준으로 들어와 있음
    if (!existsSync(join(from, DONE))) { absent++; return; }
    for (const f of walk(from)) {
      const st = statSync(f);
      cacheBytes += st.size;
      copyFile(f, join(targetCache, newKey, relative(from, f)), st);
    }
    restored++;
    progress("render-cache", i, keymap.length, 50);
  });
  progressEnd(keymap.length, 50);
  console.log(`\n렌더캐시: ${restored}건 복원 (${fmt(cacheBytes)})${already ? ` · 이미 있음 ${already}` : ""}${absent ? ` · 번들에 없음 ${absent}` : ""}`);
}

// ── 6) 나머지 데이터 ──────────────────────────────────────────────
console.log("\n나머지 데이터:");
copyTree(join(BUNDLE, "data/uploads"), join(TARGET, "data/uploads"), "uploads");
copyTree(join(BUNDLE, "data/fonts"), join(TARGET, "data/fonts"), "fonts");
copyTree(join(BUNDLE, "data/source"), join(TARGET, "data/source"), "source");
copyTree(join(BUNDLE, "data/base-backups"), join(TARGET, "data/base-backups"), "base-backups");

console.log(`\n완료${DRY ? " (dry-run)" : ""}. 실행: bun run server/index.js → http://localhost:4321`);
if (missing) console.log(`⚠ 라이브러리 파일 ${missing}개를 못 찾았습니다. 전송이 끝났는지 확인 후 다시 실행하거나, 편집기에서 라이브러리 재색인을 하세요.`);
