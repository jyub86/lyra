// 슬라이드 → 이미지 파일. 렌더는 헤드리스 크롬에 맡긴다(/export 화면을 굽는다).
// 편집·발표와 같은 layer-renderer를 쓰는 화면이라 "보이는 그대로" 나온다.
//
// 두 경로:
//   1) 전장/여러 장 = 크롬 --print-to-pdf 로 한 번에 PDF → pdftoppm 으로 페이지 분할.
//      크롬 실행 1회라 빠르다(145장 ≈ 25초). poppler 필요.
//   2) poppler가 없으면 = 크롬 --screenshot 을 장마다 한 번씩. 느리지만(장당 2~3초)
//      크롬만 있으면 되니 윈도우에서도 바로 된다.
// cwebp가 있으면 WebP로 저장(PNG 대비 7~8배 작음), 없으면 PNG.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { findChrome } from "./chrome.js";
import { findPoppler } from "./poppler.js";
import { pngBuffersToWebp } from "./webp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXPORT_DIR = join(ROOT, "data/exports");
const WIDTH = 1920, HEIGHT = 1080;   // 16:9 기본. 프로젝터 1080p 기준.

function run(cmd, timeoutMs = 120000) {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  return proc.exited.then((code) => { clearTimeout(timer); return code; });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 헤드리스 크롬은 파일을 다 쓴 뒤에도 프로세스가 안 죽는 경우가 있다(종료를 기다리면
// 145장에서 3분 넘게 멈춘다). 다행히 완료 시 stderr에 "N bytes written to file …"을
// 찍어주므로 그 줄을 신호로 삼고 바로 끊는다. 신호를 못 보면 파일 크기가 멎는 것으로 판단.
async function runUntilFile(cmd, outPath, { timeoutMs = 300000, stableMs = 1500 } = {}) {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  let wrote = false;
  (async () => {
    try {
      for await (const chunk of proc.stderr) {
        if (new TextDecoder().decode(chunk).includes("bytes written to file")) { wrote = true; break; }
      }
    } catch {}
  })();
  const t0 = Date.now();
  let lastSize = -1, stableSince = 0;
  try {
    while (Date.now() - t0 < timeoutMs) {
      if (wrote && existsSync(outPath)) return true;
      if (proc.exitCode != null && !existsSync(outPath)) return false;   // 파일도 없이 끝남 = 실패
      if (existsSync(outPath)) {
        const size = statSync(outPath).size;
        if (size > 0 && size === lastSize) {
          if (!stableSince) stableSince = Date.now();
          else if (Date.now() - stableSince >= stableMs) return true;
        } else { lastSize = size; stableSince = 0; }
      }
      await sleep(120);
    }
    return existsSync(outPath) && statSync(outPath).size > 0;
  } finally {
    try { proc.kill(); } catch {}
  }
}

// 크롬 공통 플래그. 프로필을 임시 폴더로 격리해 사용자가 쓰고 있는 크롬과 충돌하지 않게 하고,
// 백그라운드 네트워크(컴포넌트 업데이트·동기화 등)를 끊는다 — 안 끊으면 렌더가 끝나도
// 네트워크가 조용해지지 않아 --virtual-time-budget이 만료되지 않는다.
function chromeArgs(profileDir) {
  return [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-breakpad", "--disable-default-apps", "--metrics-recording-only",
    "--no-pings", "--safebrowsing-disable-auto-update", "--disable-domain-reliability",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    `--user-data-dir=${profileDir}`,
  ];
}

function pageUrl(port, serviceId, { ids, index, includeHidden }) {
  const q = new URLSearchParams({ service_id: serviceId });
  if (ids?.length) q.set("ids", ids.join(","));
  if (index != null) q.set("index", String(index));
  if (includeHidden) q.set("hidden", "1");
  return `http://127.0.0.1:${port}/export/?${q}`;
}

// PDF 페이지 수 (pdfinfo). 병렬 분할 범위를 정하는 데 쓴다.
function pdfPageCount(pdf) {
  const pdfinfo = findPoppler("pdfinfo");
  if (!pdfinfo) return null;
  const p = Bun.spawnSync([pdfinfo, pdf]);
  const m = /Pages:\s+(\d+)/.exec(new TextDecoder().decode(p.stdout || new Uint8Array()));
  return m ? Number(m[1]) : null;
}

// (1) 크롬 1회 → PDF → pdftoppm 분할
async function viaPdf(chrome, port, serviceId, opts, profileDir) {
  const pdftoppm = findPoppler("pdftoppm");
  if (!pdftoppm) return null;
  const dir = mkdtempSync(join(tmpdir(), "lyra-export-"));
  try {
    const pdf = join(dir, "deck.pdf");
    const ok = await runUntilFile([
      chrome, ...chromeArgs(profileDir), "--no-pdf-header-footer",
      `--print-to-pdf=${pdf}`, "--virtual-time-budget=20000",
      pageUrl(port, serviceId, opts),
    ], pdf, { timeoutMs: 300000 });
    if (!ok) return null;
    // pdftoppm은 단일 스레드라 145페이지에 2분 넘게 걸린다 → 페이지 범위로 쪼개 병렬 실행.
    const pages = pdfPageCount(pdf);
    if (!pages) return null;
    const workers = Math.max(1, Math.min(cpus().length - 1 || 1, 6));
    const per = Math.ceil(pages / workers);
    const jobs = [];
    for (let w = 0; w < workers; w++) {
      const first = w * per + 1, last = Math.min(pages, (w + 1) * per);
      if (first > last) break;
      jobs.push(run([pdftoppm, "-png", "-f", String(first), "-l", String(last),
        "-scale-to-x", String(WIDTH), "-scale-to-y", "-1", pdf, join(dir, "p")]));
    }
    if ((await Promise.all(jobs)).some((c) => c !== 0)) return null;
    // pdftoppm이 붙이는 페이지 번호는 자리수가 페이지 수에 따라 달라진다 → 숫자로 정렬.
    const files = readdirSync(dir).filter((f) => /^p-?\d+\.png$/.test(f))
      .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
    if (!files.length) return null;
    return files.map((f) => readFileSync(join(dir, f)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (2) 장마다 크롬 --screenshot (poppler 불필요)
async function viaScreenshots(chrome, port, serviceId, opts, count, profileDir, onProgress) {
  const dir = mkdtempSync(join(tmpdir(), "lyra-shot-"));
  try {
    const out = [];
    for (let i = 0; i < count; i++) {
      const png = join(dir, `s${i}.png`);
      const ok = await runUntilFile([
        chrome, ...chromeArgs(profileDir), `--screenshot=${png}`,
        `--window-size=${WIDTH},${HEIGHT}`, "--virtual-time-budget=8000",
        pageUrl(port, serviceId, { ...opts, index: i }),
      ], png, { timeoutMs: 45000 });
      if (!ok) throw new Error(`${i + 1}번째 장 스크린샷 실패`);
      out.push(readFileSync(png));
      onProgress?.(i + 1, count);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 슬라이드들을 이미지 파일로 저장. 반환: { dir, files, format, method }
export async function exportSlideImages({ serviceId, slideIds, includeHidden = false, count, port = 4321, name, format, onProgress }) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("크롬(또는 엣지·크로미움)을 찾지 못했습니다. 설치하거나 LYRA_CHROME 환경변수로 실행파일 경로를 지정하세요.");
  }
  const opts = { ids: slideIds, includeHidden };
  const profileDir = mkdtempSync(join(tmpdir(), "lyra-chrome-"));
  let png, method;
  try {
    png = await viaPdf(chrome, port, serviceId, opts, profileDir);
    method = "pdf";
    if (!png) {
      // poppler가 없거나 PDF 경로가 실패 → 장마다 스크린샷
      if (!count) throw new Error("슬라이드 수를 알 수 없어 스크린샷 방식으로 진행할 수 없습니다.");
      png = await viaScreenshots(chrome, port, serviceId, opts, count, profileDir, onProgress);
      method = "screenshot";
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }

  // WebP 우선(용량), cwebp 없으면 PNG.
  let buffers = png, ext = ".png";
  if (format !== "png") {
    const webp = await pngBuffersToWebp(png, 92);
    if (webp) { buffers = webp; ext = ".webp"; }
  }

  const dir = join(EXPORT_DIR, (name || serviceId).replace(/[\\/:*?"<>|]/g, "_"));
  rmSync(dir, { recursive: true, force: true });   // 같은 이름으로 다시 뽑으면 옛 파일이 섞이지 않게
  mkdirSync(dir, { recursive: true });
  const files = buffers.map((buf, i) => {
    const file = `${String(i + 1).padStart(3, "0")}${ext}`;
    writeFileSync(join(dir, file), buf);
    return file;
  });
  return { dir, files, format: ext.slice(1), method };
}
