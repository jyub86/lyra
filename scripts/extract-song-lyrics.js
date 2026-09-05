// 찬양 PPT 폴더 → 곡별·슬라이드별 가사 데이터 (data/source/songs.json)
//
// 왜 필요한가: 악보 PPT를 그만 쓰고 "가사만 + 배경 영상" 구성으로 바꾸면서, 기존 PPT 모음의
// 가사를 Lyra 안에서 검색·재사용할 수 있어야 한다.
//
// 왜 OCR인가 (실측):
//   - 이 모음 474곡 중 .ppt(레거시) 381곡 · .pptx 93곡.
//   - .pptx 93곡 중 가사 텍스트가 제대로 들어 있는 건 11곡뿐. 69곡은 가사가 이미지로 박혀 있다.
//   - .ppt 는 텍스트가 있어도 "홀수 줄만 담긴 목차 텍스트박스"라 실제 표시 가사와 다르다.
//   → 슬라이드를 이미지로 렌더해 화면에 보이는 그대로 읽는 것이 유일하게 일관된 방법.
//
// 이건 "가사 파서"가 아니다(설계 §15의 금지 대상이 아님): 슬라이드 나눔·줄 나눔을 원본 PPT
// 그대로 가져오는 결정적 추출이다. 해석은 하지 않는다.
//
// 파이프라인: LibreOffice(--convert-to pdf) → pdftoppm(PNG) → Vision OCR → 장식 제거
// 장식 제거 규칙(결정적): 작은 글자(높이<5%) · 여러 장에 반복되는 줄(제목/목차/출처) ·
//                        한 글자 · 숫자만 있는 줄.
//
// 실행: bun run scripts/extract-song-lyrics.js [폴더] [--limit N] [--jobs N] [--out 파일]
//   기본 폴더 = settings.library_dir/찬양ppt모음_WIDE 가 있으면 그것, 없으면 인자 필수
// macOS 전용(Vision OCR). 결과 JSON은 사람이 손봐도 되는 원본 → import-songs.js가 DB에 적재.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
// OCR 뒤처리(기호 오인식 제거·제목 박힘 제거)는 적재 쪽과 같은 함수를 쓴다 — 규칙이 갈라지면
// songs.json과 DB의 가사가 달라진다.
import { cleanSongPages } from "../core/db/seed/import-songs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OCR_BIN = join(ROOT, "data/bin/ocr");
const OCR_SRC = join(ROOT, "scripts/ocr-vision.swift");
const WORK_ROOT = join(ROOT, "data/.lyrics-work");

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DIR = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const LIMIT = Number(flag("limit", 0));
const JOBS = Math.max(1, Number(flag("jobs", 4)));
const DPI = Math.max(72, Number(flag("dpi", 200)));
const OUT = flag("out", join(ROOT, "data/source/songs.json"));

async function run(cmd, opts = {}) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...opts });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { out, err, code };
}

function need(bin, hint) {
  if (!Bun.which(bin)) { console.error(`✗ ${bin} 없음 — ${hint}`); process.exit(1); }
}

// Vision OCR 바이너리를 필요할 때 빌드(소스는 저장소에, 산출물은 data/bin).
async function ensureOcr() {
  if (process.platform !== "darwin") {
    console.error("✗ 이 스크립트는 macOS 전용입니다(Vision OCR). 다른 OS에서는 추출된 songs.json을 가져다 쓰세요.");
    process.exit(1);
  }
  const fresh = existsSync(OCR_BIN) && statSync(OCR_BIN).mtimeMs > statSync(OCR_SRC).mtimeMs;
  if (fresh) return;
  need("swiftc", "Xcode 명령줄 도구 필요: xcode-select --install");
  mkdirSync(dirname(OCR_BIN), { recursive: true });
  console.log("· Vision OCR 빌드 중…");
  const r = await run(["swiftc", "-O", "-o", OCR_BIN, OCR_SRC]);
  if (r.code !== 0 || !existsSync(OCR_BIN)) { console.error("✗ OCR 빌드 실패\n" + r.err); process.exit(1); }
}

// ---- 한 곡 추출 ----
// worker마다 LibreOffice 프로필을 따로 줘야 병렬 실행이 서로 안 막는다.
async function renderPages(src, work, worker) {
  mkdirSync(work, { recursive: true });
  const profile = `file://${join(WORK_ROOT, `lo-${worker}`)}`;
  // 원본 파일명을 그대로 쓰면 길거나 특수문자(쉼표·괄호·한글 NFD)가 섞인 이름에서 LibreOffice가
  // PDF 쓰기에 실패한다(Io/Write). 짧은 ASCII 이름으로 복사해 변환한다.
  const tmp = join(work, `src${extname(src).toLowerCase()}`);
  await Bun.write(tmp, Bun.file(src));
  const r = await run(["soffice", "--headless", `-env:UserInstallation=${profile}`,
    "--convert-to", "pdf", "--outdir", work, tmp]);
  const pdf = join(work, "src.pdf");
  if (!existsSync(pdf)) return { error: `PDF 변환 실패: ${r.err.trim().split("\n").pop() || `code ${r.code}`}` };
  // 렌더 해상도. 200dpi가 110dpi보다 OCR 정확도가 좋다(글자 외곽선이 살아 기호·받침 오인식이 줄어든다).
  // 대신 변환·OCR 시간이 약 2배. --dpi 로 조절.
  await run(["pdftoppm", "-png", "-r", String(DPI), pdf, join(work, "pg")]);
  const pages = readdirSync(work).filter((f) => /^pg-?\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]))
    .map((f) => join(work, f));
  return pages.length ? { pages } : { error: "페이지 이미지가 생성되지 않음" };
}

// NFC 정규화가 여기서 중요하다: macOS 파일명은 한글을 NFD(자모 분리)로 준다. 그대로 두면
// songs.json과 그걸 쓰는 모든 곳(검색·내보내기)에 자모 분리 문자열이 퍼진다.
// OCR 결과도 함께 맞춰 둔다 — 검색어와 같은 표기여야 찾을 수 있다.
const norm = (s) => String(s).normalize("NFC").replace(/\s+/g, " ").trim();
const bare = (s) => norm(s).replace(/[^가-힣a-zA-Z0-9]/g, "");

// 장식을 걸러 페이지별 가사 줄만 남긴다. pages = OCR 결과(페이지별 lines).
export function lyricLines(pages, { minHeight = 0.05, repeatRatio = 0.6, bigRatio = 0.85 } = {}) {
  const n = pages.length || 1;
  // 같은 문장이 여러 장에 반복되면 장식(제목·목차·출처)일 가능성이 크다.
  const count = new Map();
  for (const p of pages) {
    const seen = new Set();
    for (const l of p.lines) {
      const k = bare(l.t);
      if (k && !seen.has(k)) { seen.add(k); count.set(k, (count.get(k) || 0) + 1); }
    }
  }
  const repeatCut = Math.max(2, Math.ceil(n * repeatRatio));
  // "반복"만으로 지우면 후렴이 날아간다 — 후렴은 여러 장에 반복되는 게 정상이다.
  // (실측: 텍스트 반복만으로 지웠을 때 제목 17곡을 잡으려다 후렴 50곡을 훼손했다)
  // 화면에 표시되는 가사는 그 장에서 가장 큰 글자다 → 반복이라도 큰 글자면 남긴다.
  // 제목·목차·출처는 표시 가사보다 작다(실측: 제목 h≈7% vs 가사 h≈10~12%) → 이 비율로 갈린다.
  // bigRatio를 0.85로 둔 이유: 0.7이면 제목(0.67배)이 간신히 살아남았다.
  return pages.map((p) => {
    const bigCut = p.lines.reduce((m, l) => Math.max(m, l.h), 0) * bigRatio;
    const kept = p.lines.filter((l) => {
      const t = norm(l.t);
      if (!t) return false;
      if (l.h < minHeight) return false;                       // 작게 박힌 목차·출처
      if (bare(t).length <= 1) return false;                    // 한 글자·기호
      if (/^[\d\s.\-—·]+$/.test(t)) return false;               // 페이지 번호·구분선
      // 반복 + 그 장에서 작은 글자 = 장식. 반복 + 큰 글자 = 후렴이므로 남긴다.
      if ((count.get(bare(t)) || 0) >= repeatCut && l.h < bigCut) return false;
      return true;
    });
    kept.sort((a, b) => (Math.abs(a.y - b.y) > 0.02 ? a.y - b.y : a.x - b.x));
    return {
      lines: kept.map((l) => norm(l.t)),
      conf: kept.length ? kept.reduce((s, l) => s + l.c, 0) / kept.length : 0,
    };
  });
}

async function extractSong(src, worker) {
  const work = join(WORK_ROOT, `w${worker}`);
  try {
    rmSync(work, { recursive: true, force: true });
    const { pages, error } = await renderPages(src, work, worker);
    if (error) return { error };
    const r = await run([OCR_BIN, ...pages]);
    const ocr = r.out.trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { lines: [] }; }
    });
    const per = lyricLines(ocr);
    const rawTitle = basename(src).replace(/\.[^.]+$/, "").normalize("NFC");
    // 기호 오인식(♪→"F 3 5 J") 제거 + 모든 장에 박힌 제목 제거 + 앞뒤 빈 장 정돈.
    const lyricPages = cleanSongPages(per.map((p) => p.lines), rawTitle);
    // conf는 글자가 남아 있는 장들의 평균으로 (빈 장은 신뢰도가 없다)
    const withText = per.filter((p) => p.lines.length);
    return {
      // 제목·경로도 NFC로 — macOS 파일명은 NFD라서 그대로 두면 JSON 전체에 자모 분리가 퍼진다.
      title: rawTitle,
      source: src.normalize("NFC"),
      ext: extname(src).toLowerCase(),
      slides: pages.length,
      pages: lyricPages,
      lines: lyricPages.reduce((a, p) => a + p.length, 0),
      chars: lyricPages.flat().reduce((a, l) => a + l.length, 0),
      conf: withText.length ? +(withText.reduce((s, p) => s + p.conf, 0) / withText.length).toFixed(3) : 0,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- 실행 ----
async function main() {
  if (!DIR || !existsSync(DIR)) {
    console.error("사용: bun run scripts/extract-song-lyrics.js <PPT폴더> [--limit N] [--jobs N] [--out 파일]");
    process.exit(1);
  }
  need("soffice", "LibreOffice 설치 필요");
  need("pdftoppm", "poppler 설치 필요 (brew install poppler)");
  await ensureOcr();

  const files = readdirSync(DIR)
    .filter((f) => [".ppt", ".pptx", ".odp"].includes(extname(f).toLowerCase()))
    .sort();
  const todo = LIMIT ? files.slice(0, LIMIT) : files;
  console.log(`· ${DIR}\n· ${todo.length}곡 추출 (동시 ${JOBS}개)\n`);

  mkdirSync(WORK_ROOT, { recursive: true });
  const results = [];
  const failed = [];
  let idx = 0, done = 0;
  const t0 = Date.now();
  const workers = Array.from({ length: Math.min(JOBS, todo.length) }, async (_, w) => {
    while (idx < todo.length) {
      const f = todo[idx++];
      const r = await extractSong(join(DIR, f), w);
      done++;
      if (r.error) { failed.push({ file: f, error: r.error }); }
      else if (!r.lines) { failed.push({ file: f, error: "가사를 찾지 못함(빈 결과)" }); }
      else results.push(r);
      if (done % 10 === 0 || done === todo.length) {
        const el = (Date.now() - t0) / 1000;
        const eta = (el / done) * (todo.length - done);
        process.stdout.write(`\r  ${done}/${todo.length}곡 · 성공 ${results.length} · 실패 ${failed.length} · ${el.toFixed(0)}초 경과 · 남은 ${eta.toFixed(0)}초   `);
      }
    }
  });
  await Promise.all(workers);
  rmSync(WORK_ROOT, { recursive: true, force: true });

  results.sort((a, b) => a.title.localeCompare(b.title, "ko"));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    format: "lyra-songs/v1",
    source_dir: DIR,
    extracted_at: new Date().toISOString(),
    note: "PPT 슬라이드를 렌더해 OCR(macOS Vision)로 읽은 가사. 오탈자는 이 파일을 직접 고쳐도 된다.",
    songs: results,
    failed,
  }, null, 2));

  const totalLines = results.reduce((a, s) => a + s.lines, 0);
  const lowConf = results.filter((s) => s.conf < 0.4).length;
  console.log(`\n\n결과 → ${OUT}`);
  console.log(`  성공 ${results.length}곡 · 실패 ${failed.length}곡 · 가사줄 ${totalLines}개`);
  console.log(`  신뢰도 낮은 곡(0.4 미만): ${lowConf}곡  ← 우선 검토 대상`);
  console.log(`  소요 ${((Date.now() - t0) / 1000 / 60).toFixed(1)}분`);
  if (failed.length) {
    console.log("\n실패 목록(앞 10개):");
    for (const f of failed.slice(0, 10)) console.log(`  ${f.file.slice(0, 50)} — ${f.error}`);
  }
}

if (import.meta.main) await main();
