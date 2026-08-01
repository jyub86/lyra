#!/usr/bin/env bun
// 다른 PC(윈도우 등)로 옮길 데이터를 한 폴더에 모은다 — DB·uploads·렌더캐시·PPT 라이브러리.
//
//   bun run scripts/export-bundle.js --out /Volumes/USB/lyra-bundle
//   bun run scripts/export-bundle.js --out ~/Desktop/lyra-bundle --dry-run
//
// 옵션: --no-cache(렌더캐시 제외) --no-library(PPT 라이브러리 제외)
//       --with-env(.env 포함 — 자격증명이라 기본 제외) --dry-run
//
// 왜 그냥 복사하면 안 되나:
//   1) DB의 settings.library_dir·library_index.path 가 맥 절대경로다.
//   2) 렌더캐시 폴더명 = sha1(파일 절대경로 + mtime + 렌더너비) 라서 경로가 바뀌면 전부 미스가 난다.
// 그래서 여기서 "라이브러리 파일 ↔ 캐시 키" 대응표를 manifest.json에 적어두고,
// 받는 쪽(scripts/import-bundle.js)이 새 경로 기준으로 키를 다시 계산해 폴더명을 바꾼다.
// 슬라이드가 실제로 참조하는 이미지는 전부 /uploads/ 상대경로라 이관해도 안전하다.
//
// 재실행 가능(증분): 크기+mtime이 같은 파일은 건너뛴다.

import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFor } from "../core/lib/render-cache.js";
import { RENDER_WIDTH } from "../core/lib/pdf-import.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.WORSHIP_DB || join(ROOT, "data/worship.db");
const CACHE_DIR = join(ROOT, "data/render-cache");
const DONE = ".done";

// ── args ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
const OUT = opt("--out");
const DRY = flag("--dry-run");
if (!OUT) {
  console.error("사용법: bun run scripts/export-bundle.js --out <번들 폴더> [--no-cache] [--no-library] [--with-env] [--dry-run]");
  process.exit(1);
}
const WITH_CACHE = !flag("--no-cache");
const WITH_LIBRARY = !flag("--no-library");

// ── helpers ───────────────────────────────────────────────────────
const fmt = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + "GB" : b > 1e6 ? (b / 1e6).toFixed(0) + "MB" : (b / 1e3).toFixed(0) + "KB";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".DS_Store") continue;
    const p = join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

// 같은 크기+mtime이면 건너뛴다(증분). APFS 같은 볼륨이면 FICLONE으로 즉시 복사.
// 반환: 실제로 복사했으면 true.
function copyFile(src, dst, stats) {
  const st = stats || statSync(src);
  if (existsSync(dst)) {
    const d = statSync(dst);
    if (d.size === st.size && Math.floor(d.mtimeMs) === Math.floor(st.mtimeMs)) return false;
  }
  if (DRY) return true;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  utimesSync(dst, st.atime, st.mtime);   // mtime 보존 — 증분 판정·재색인 최소화에 필요
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

// ── DB 읽기 ───────────────────────────────────────────────────────
if (!existsSync(DB_PATH)) { console.error(`DB 없음: ${DB_PATH}`); process.exit(1); }
const db = new Database(DB_PATH, { readonly: true });
const libraryDir = db.query("SELECT value FROM settings WHERE key = 'library_dir'").get()?.value || null;
const libRows = db.query("SELECT path, relpath, size, mtime FROM library_index").all();
const counts = {
  services: db.query("SELECT COUNT(*) n FROM services").get().n,
  slides: db.query("SELECT COUNT(*) n FROM slides").get().n,
  library_rows: libRows.length,
};

console.log(`Lyra 이관 번들${DRY ? " (dry-run — 실제 복사 안 함)" : ""}`);
console.log(`  원본: ${ROOT}`);
console.log(`  대상: ${OUT}`);
console.log(`  DB: 예배 ${counts.services}개 · 슬라이드 ${counts.slides}장 · 라이브러리 색인 ${counts.library_rows}개`);
console.log(`  라이브러리 폴더: ${libraryDir || "(설정 안 됨)"}\n`);

if (!DRY) mkdirSync(OUT, { recursive: true });

// ── 1) DB — VACUUM INTO로 일관된 사본(WAL 반영 + 조각모음) ────────
const dbOut = join(OUT, "data/worship.db");
if (!DRY) {
  mkdirSync(dirname(dbOut), { recursive: true });
  rmSync(dbOut, { force: true });
  db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
}
console.log(`  worship.db: ${DRY ? "(건너뜀)" : fmt(statSync(dbOut).size)}`);

// ── 2) 라이브러리 파일 목록 + 캐시 키 대응표 ──────────────────────
// 주의: 캐시 키는 "app이 만든 경로 문자열"로 계산돼 있다. app은 settings.library_dir을
// 루트로 walk하므로, 여기서도 반드시 같은 문자열을 루트로 써야 키가 맞는다
// (맥 파일명은 NFD라 루트 문자열의 정규화 형태가 다르면 키가 어긋난다).
const cacheDirs = WITH_CACHE && existsSync(CACHE_DIR)
  ? new Set(readdirSync(CACHE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
  : new Set();

const library = [];
const usedCacheKeys = new Set();
if (WITH_LIBRARY && libraryDir && existsSync(libraryDir)) {
  const rowByPath = new Map(libRows.map((r) => [r.path, r]));
  for (const f of walk(libraryDir)) {
    const st = statSync(f);
    const mtime = Math.floor(st.mtimeMs);
    const rawRel = relative(libraryDir, f);
    const row = rowByPath.get(f);
    // 색인된 파일은 DB의 mtime으로 키를 계산해야 실제 캐시와 맞는다(색인 후 파일이 바뀌었을 수 있음).
    const key = row ? keyFor(row.path, row.mtime, RENDER_WIDTH) : keyFor(f, mtime, RENDER_WIDTH);
    const cached = cacheDirs.has(key) && existsSync(join(CACHE_DIR, key, DONE));
    if (cached) usedCacheKeys.add(key);
    library.push({
      rel: rawRel.split(sep).join("/"),               // 번들 안에서의 상대경로(원형 유지)
      rel_nfc: rawRel.split(sep).join("/").normalize("NFC"), // 매칭용(맥 NFD ↔ 윈도우 대비)
      size: st.size,
      mtime,
      indexed: !!row,
      cache_key: cached ? key : null,
    });
  }
} else if (WITH_LIBRARY) {
  console.log(`  ⚠ 라이브러리 폴더를 찾을 수 없어 건너뜁니다: ${libraryDir}`);
}
const orphanCache = [...cacheDirs].filter((k) => !usedCacheKeys.has(k));

// ── 3) 파일 복사 ──────────────────────────────────────────────────
console.log("\n복사:");
const parts = {};
parts.uploads = copyTree(join(ROOT, "data/uploads"), join(OUT, "data/uploads"), "uploads");
parts.fonts = copyTree(join(ROOT, "data/fonts"), join(OUT, "data/fonts"), "fonts");
parts.source = copyTree(join(ROOT, "data/source"), join(OUT, "data/source"), "source(성경·찬송·교독)");
parts.base_backups = copyTree(join(ROOT, "data/base-backups"), join(OUT, "data/base-backups"), "base-backups");

if (WITH_CACHE) {
  // 라이브러리와 대응되는 캐시만 옮긴다(고아 캐시는 새 PC에서 어차피 못 맞춘다).
  let files = 0, bytes = 0, copied = 0;
  const keys = [...usedCacheKeys];
  keys.forEach((k, i) => {
    for (const f of walk(join(CACHE_DIR, k))) {
      const st = statSync(f);
      files++; bytes += st.size;
      if (copyFile(f, join(OUT, "data/render-cache", k, relative(join(CACHE_DIR, k), f)), st)) copied++;
    }
    progress("render-cache", i, keys.length, 50);
  });
  progressEnd(keys.length, 50);
  console.log(`  render-cache: ${keys.length}건 / 파일 ${files}개 (${fmt(bytes)}) — 복사 ${copied}`);
  if (orphanCache.length) console.log(`    (라이브러리와 대응 안 되는 캐시 ${orphanCache.length}건은 제외)`);
  parts.render_cache = { entries: keys.length, files, bytes, copied };
}

if (WITH_LIBRARY && libraryDir && existsSync(libraryDir)) {
  let copied = 0, bytes = 0;
  library.forEach((e, i) => {
    const src = join(libraryDir, ...e.rel.split("/"));
    bytes += e.size;
    if (copyFile(src, join(OUT, "library", ...e.rel.split("/")))) copied++;
    progress("library", i, library.length, 100);
  });
  progressEnd(library.length, 100);
  console.log(`  library: ${library.length}개 (${fmt(bytes)}) — 복사 ${copied}`);
  parts.library = { files: library.length, bytes, copied, cached: usedCacheKeys.size };
}

if (flag("--with-env") && existsSync(join(ROOT, ".env"))) {
  copyFile(join(ROOT, ".env"), join(OUT, "env.txt"));
  console.log("  .env → env.txt (⚠ 자격증명 포함 — 클라우드 업로드 시 주의)");
}

// ── 4) manifest + 안내문 ──────────────────────────────────────────
const manifest = {
  format: "lyra-bundle/v1",
  created: new Date().toISOString(),
  source: { platform: process.platform, repo: ROOT, library_dir: libraryDir, sep: "/" },
  render_width: RENDER_WIDTH,
  db: { file: "data/worship.db", ...counts },
  parts,
  library,
  cache_orphans: orphanCache.length,
};
if (!DRY) {
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
  writeFileSync(join(OUT, "READ-ME-먼저.md"), readme(manifest));
}

const total = Object.values(parts).reduce((s, p) => s + (p.bytes || 0), 0);
console.log(`\n완료. 번들 총 ${fmt(total)} · 캐시 재사용 대상 ${usedCacheKeys.size}건`);
console.log(`받는 PC에서: bun run scripts/import-bundle.js --bundle <번들경로> --library <PPT 폴더 경로>`);

function readme(m) {
  return `# Lyra 이관 번들 (${m.created.slice(0, 10)})

맥에서 만든 데이터 묶음입니다. 윈도우 PC에서 아래 순서대로 하세요.

## 담긴 것
- \`data/worship.db\` — 예배 ${m.db.services}개 · 슬라이드 ${m.db.slides}장 + 성경/찬송/교독 + 라이브러리 색인 ${m.db.library_rows}개
- \`data/uploads/\` — 슬라이드가 실제로 쓰는 이미지·영상 (${fmt(m.parts.uploads?.bytes || 0)})
- \`data/render-cache/\` — PPT→이미지 변환 캐시 ${m.parts.render_cache?.entries || 0}건 (${fmt(m.parts.render_cache?.bytes || 0)})
- \`data/fonts/\`, \`data/source/\`, \`data/base-backups/\`
- \`library/\` — PPT 라이브러리 ${m.parts.library?.files || 0}개 (${fmt(m.parts.library?.bytes || 0)})
- \`manifest.json\` — 경로·캐시 키 대응표 (이 파일이 있어야 캐시를 살릴 수 있습니다)

## 옮기는 방법 (클라우드/네트워크)

파일이 12,000개쯤 되어 폴더째 업로드하면 느립니다. **한 덩어리로 묶어서** 옮기세요.

\`\`\`bash
# 맥에서 (묶기 — 압축 안 함. 이미 압축된 이미지·PPT라 압축해도 안 줄고 느리기만 합니다)
tar -C "<번들 폴더>" -cf ~/Desktop/lyra-bundle.tar .
\`\`\`
\`\`\`powershell
# 윈도우에서 (풀기 — Windows 10 이상은 tar가 기본 내장)
mkdir D:\\lyra-bundle
tar -C D:\\lyra-bundle -xf D:\\lyra-bundle.tar
\`\`\`

## 윈도우에서 할 일

1. **Bun 설치** (PowerShell): \`powershell -c "irm bun.sh/install.ps1 | iex"\`
2. **소스 받기**: \`git clone https://github.com/jyub86/lyra.git C:\\lyra\` → \`cd C:\\lyra\` → \`bun install\`
   (node_modules는 맥 전용 바이너리가 섞여 있어 옮기지 않습니다. 반드시 새로 설치하세요.)
3. **LibreOffice 설치** — PPT 가져오기에 필요. <https://www.libreoffice.org/download>
4. **poppler 넣기** — PDF 처리용. <https://github.com/oschwartz10612/poppler-windows/releases> 에서
   받아 압축을 풀고 폴더째 \`C:\\lyra\\tools\\\` 안에 넣으면 자동 인식됩니다(자세한 건 \`tools/README.md\`).
5. **번들 적용** (서버가 떠 있다면 먼저 끄세요):
   \`\`\`
   bun run scripts/import-bundle.js --bundle D:\\lyra-bundle --library C:\\lyra\\ppt
   \`\`\`
   \`--library\`는 PPT 라이브러리를 놓을 폴더입니다(없으면 만들어집니다).
   이 단계에서 DB의 경로를 윈도우 기준으로 고치고, **렌더캐시 폴더 이름을 새 경로 기준으로 다시 계산해 살립니다.**
   먼저 \`--dry-run\`을 붙여 무엇이 바뀌는지 확인할 수 있습니다.
6. **실행**: \`bun run server/index.js\` → 브라우저에서 <http://localhost:4321>

## 주의
- 이 번들은 **맥 → 윈도우 단방향**입니다. 윈도우에서 편집한 뒤 다시 import하면 윈도우 쪽 변경이 덮어써집니다
  (덮어쓰기 전 기존 DB는 \`worship.db.bak-…\`로 백업됩니다).
- 설치 경로는 \`C:\\lyra\` 처럼 **짧게** 잡으세요. PPT 파일명이 길어서 깊은 폴더에 두면 윈도우 260자 경로 제한에 걸립니다.
- \`data/source/\`(개역개정·새찬송가·교독문)는 저작물이라 외부에 공유하지 마세요. 클라우드에 올린다면 공유 링크를 열어두지 마세요.
- 주보 자동화(\`scripts/fetch-bulletin.js\`)를 윈도우에서도 쓰려면 맥의 \`.env\`를 따로 옮기고, launchd 대신 작업 스케줄러에 등록해야 합니다.
`;
}
