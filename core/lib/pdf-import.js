// Import existing slides as images. Office docs (.pptx/.ppt/.odp/.key-exported/
// .docx) → PDF via LibreOffice `soffice`; PDF → per-page PNGs via `pdftoppm`;
// single images pass through. Each page/image becomes a slide with one full-bleed
// image element on a black background. Shared by /api/import and import_pdf tool.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { saveUpload } from "./uploads.js";
import { findPoppler } from "./poppler.js";
import { getCachedBuffers, putCachedBuffers, isCached } from "./render-cache.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const OFFICE_EXT = new Set([".pptx", ".ppt", ".odp", ".key", ".pdfx"]); // presentation docs LibreOffice can read

// PDF→이미지 렌더 목표 너비(px). DPI 대신 너비로 고정하면 슬라이드의 물리적 크기와
// 무관하게 항상 이 해상도로 렌더된다(선명·일관). 2560=1440p, 1080p 프로젝터엔 넉넉하고
// 4K에서도 무난. 높이면 더 선명·용량↑.
const RENDER_WIDTH = 2560;

// Persistent LibreOffice profile dir. Reusing it (instead of a fresh tmp profile
// per import) skips the ~1.8s cold profile regeneration on every conversion.
const LO_PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/.lo-profile");

// Run a subprocess async (doesn't block the server like spawnSync did), returning
// { code, stderr }. stderr captured for error messages.
async function run(cmd) {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

// Locate the LibreOffice CLI across macOS / Windows / Linux (PATH or known locations).
function findSoffice() {
  const paths = [
    // macOS
    "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    // Windows
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    // Linux
    "/usr/bin/soffice", "/usr/bin/libreoffice", "/snap/bin/libreoffice",
  ];
  for (const p of paths) if (existsSync(p)) return p;
  return Bun.which("soffice") || Bun.which("libreoffice") || null;
}
export function officeImportAvailable() { return !!findSoffice(); }

// Convert an office presentation file (bytes) → PDF bytes via soffice headless.
async function officeToPdf(filename, bytes) {
  const soffice = findSoffice();
  if (!soffice) throw new Error("LibreOffice(soffice) 미설치 — .pptx 변환 불가. PDF로 내보내거나 LibreOffice를 설치하세요.");
  const dir = mkdtempSync(join(tmpdir(), "lyra-office-"));
  try {
    const inPath = join(dir, filename.replace(/[^\w.\-가-힣]/g, "_"));
    writeFileSync(inPath, Buffer.from(bytes));
    // -env:UserInstallation points LibreOffice at a persistent profile (reused
    // across imports → no ~1.8s cold profile rebuild). OS-independent (works on
    // Windows, unlike HOME). A stale .lock from a prior crash is cleared first.
    mkdirSync(LO_PROFILE_DIR, { recursive: true });
    const lock = join(LO_PROFILE_DIR, ".lock");
    if (existsSync(lock)) { try { rmSync(lock, { force: true }); } catch { /* ignore */ } }
    const profileUrl = "file://" + (process.platform === "win32" ? "/" + LO_PROFILE_DIR.replace(/\\/g, "/") : LO_PROFILE_DIR);
    const { code, stderr } = await run([soffice, `-env:UserInstallation=${profileUrl}`,
      "--headless", "--convert-to", "pdf", "--outdir", dir, inPath]);
    const pdf = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".pdf"));
    if (code !== 0 || !pdf) {
      throw new Error("LibreOffice 변환 실패: " + (stderr ? stderr.slice(0, 200) : "unknown"));
    }
    return readFileSync(join(dir, pdf));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function imageSlide(url) {
  return {
    background: { type: "color", value: "#000000" },
    elements: [{ type: "image", x: 0, y: 0, w: 1, h: 1, fit: "contain", url }],
  };
}

// PDF 바이트 → 페이지별 PNG 버퍼 배열(순서대로). 저장/캐시 결정은 호출자 몫.
async function pdfBytesToPngBuffers(bytes) {
  const pdftoppm = findPoppler("pdftoppm");
  if (!pdftoppm) {
    throw new Error("PDF→이미지 변환 도구(poppler)가 없습니다. macOS: brew install poppler · Windows: poppler 압축본을 tools/ 폴더에 풀거나 LYRA_POPPLER로 지정(PATH 등록도 가능) · Linux: apt install poppler-utils");
  }
  const dir = mkdtempSync(join(tmpdir(), "lyra-pdf-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, Buffer.from(bytes));
    // -scale-to-x W -scale-to-y -1 = 너비를 W로 고정, 높이는 비율 유지(-1).
    const { code } = await run([pdftoppm, "-png", "-scale-to-x", String(RENDER_WIDTH), "-scale-to-y", "-1", pdfPath, join(dir, "page")]);
    if (code !== 0) {
      throw new Error("pdftoppm 변환 실패 (poppler 확인). PPT는 LibreOffice로 자동 변환됩니다.");
    }
    const pages = readdirSync(dir).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
    return pages.map((f) => readFileSync(join(dir, f)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 업로드(경로 없음, 캐시 불가) 경로 — 페이지 버퍼를 uploads에 저장하고 URL 배열 반환.
async function buffersToUploadUrls(buffers) {
  return await Promise.all(buffers.map((buf) => saveUpload("slide.png", buf).then((r) => r.url)));
}

// 파일(office/pdf) → 페이지 PNG 버퍼. office는 먼저 PDF로 변환.
async function renderFileToBuffers(filename, bytes) {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();
  if (OFFICE_EXT.has(ext)) return await pdfBytesToPngBuffers(await officeToPdf(filename, bytes));
  if (ext === ".pdf") return await pdfBytesToPngBuffers(bytes);
  return null; // 이미지 등은 렌더 대상 아님
}

// 업로드 바이트 → 슬라이드 배열(캐시 없음). /api/import(브라우저 업로드)용.
export async function fileToSlides(filename, bytes) {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();
  if (OFFICE_EXT.has(ext) || ext === ".pdf") {
    return (await buffersToUploadUrls(await renderFileToBuffers(filename, bytes))).map(imageSlide);
  }
  if (IMAGE_EXT.has(ext)) {
    const { url } = await saveUpload(filename, bytes);
    return [imageSlide(url)];
  }
  throw new Error(`지원하지 않는 형식: ${ext} (PPT/PDF/이미지). LibreOffice 미설치 시 PPT는 PDF로 내보내세요.`);
}

// 서버 경로 파일 → 슬라이드 배열. 렌더 캐시로 "변환"만 건너뛰고, 이미지는 항상
// uploads(영구)에 저장해 /uploads/ 를 참조한다 → 슬라이드는 캐시 삭제와 무관하게 안전하고
// 내보내기(export) 시 그대로 번들된다. 라이브러리·import_pdf(자주 쓰는 PPT)용.
export async function fileToSlidesFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) { // 이미지는 변환 불필요 — 그대로 업로드
    const { url } = await saveUpload(basename(path), readFileSync(path));
    return [imageSlide(url)];
  }
  if (!OFFICE_EXT.has(ext) && ext !== ".pdf") {
    throw new Error(`지원하지 않는 형식: ${ext} (PPT/PDF/이미지). LibreOffice 미설치 시 PPT는 PDF로 내보내세요.`);
  }
  let buffers = getCachedBuffers(path, RENDER_WIDTH);       // 캐시 히트 → 변환 생략
  if (!buffers) {
    buffers = await renderFileToBuffers(basename(path), readFileSync(path));
    putCachedBuffers(path, RENDER_WIDTH, buffers);          // 다음을 위해 캐시
  }
  return (await buffersToUploadUrls(buffers)).map(imageSlide);   // 항상 uploads에 영구 저장
}

// 캐시만 채운다(가져오지 않음). 미리 변환(prerender)용. 이미 신선하면 렌더 생략.
// 반환: { pages, cached(true=이번에 렌더), skipped(true=이미 캐시) }
export async function prerenderPath(path, force = false) {
  const ext = extname(path).toLowerCase();
  if (!OFFICE_EXT.has(ext) && ext !== ".pdf") return { pages: 0, skipped: true }; // 이미지 등은 대상 아님
  if (!force && isCached(path, RENDER_WIDTH)) return { pages: (getCachedBuffers(path, RENDER_WIDTH) || []).length, skipped: true };
  const buffers = await renderFileToBuffers(basename(path), readFileSync(path));
  putCachedBuffers(path, RENDER_WIDTH, buffers);
  return { pages: buffers.length, cached: true };
}

export { RENDER_WIDTH };
