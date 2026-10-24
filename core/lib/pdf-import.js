// Import existing slides as images. Office docs (.pptx/.ppt/.odp/.key-exported/
// .docx) → PDF via LibreOffice `soffice`; PDF → per-page PNGs via `pdftoppm`;
// single images pass through. Each page/image becomes a slide with one full-bleed
// image element on a black background. Shared by /api/import and import_pdf tool.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { saveUpload } from "./uploads.js";
import { findPoppler } from "./poppler.js";
import { getCachedImages, putCachedImages, isCached } from "./render-cache.js";
import { pngBuffersToWebp } from "./webp.js";
import { dataPath } from "./paths.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const OFFICE_EXT = new Set([".pptx", ".ppt", ".odp", ".key", ".pdfx"]); // presentation docs LibreOffice can read

// PDF→이미지 렌더 목표 너비(px). DPI 대신 너비로 고정하면 슬라이드의 물리적 크기와
// 무관하게 항상 이 해상도로 렌더된다(선명·일관). 2560=1440p, 1080p 프로젝터엔 넉넉하고
// 4K에서도 무난. 높이면 더 선명·용량↑.
const RENDER_WIDTH = 2560;
// WebP 변환 품질(cwebp 있을 때). 90=악보·글씨 안전하면서 PNG 대비 7~8배 작음.
const WEBP_QUALITY = 90;

// Persistent LibreOffice profile dir. Reusing it (instead of a fresh tmp profile
// per import) skips the ~1.8s cold profile regeneration on every conversion.
const LO_PROFILE_DIR = dataPath(".lo-profile");

// Run a subprocess async (doesn't block the server like spawnSync did), returning
// { code, stderr }. stderr captured for error messages.
async function run(cmd, env) {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) });
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

// 한국 PPT가 쓰는 Windows 전용 글꼴 → 이 컴퓨터에 있는 한글 글꼴로 대체.
//
// 왜 필요한가(실측): 교회 PPT는 거의 다 **맑은 고딕**을 쓴다. 맥·리눅스에는 그 글꼴이 없고,
// fontconfig은 이름만 보고 `Malgun Gothic` → **Verdana**로 떨어뜨린다. Verdana엔 한글
// 글리프가 없으므로 가사가 통째로 **빈칸·검은 네모**로 변환된다
// (변환된 PDF의 임베드 글꼴이 `LiberationSans` + WinAnsi 하나뿐인 것으로 확인).
// 악보·도형은 멀쩡히 나오고 글자만 사라져서 원인을 짐작하기 어렵다.
//
// 글리프 폴백에 기대지 않고 **요청 단계에서 이름을 바꿔** 확실히 한글 글꼴을 쓰게 한다.
const WIN_KO_FONTS = {
  // 고딕 계열
  sans: ["Malgun Gothic", "맑은 고딕", "Gulim", "굴림", "Dotum", "돋움",
    "GulimChe", "굴림체", "DotumChe", "돋움체", "HY중고딕", "HY견고딕", "HCR Dotum"],
  // 명조 계열
  serif: ["Batang", "바탕", "BatangChe", "바탕체", "Gungsuh", "궁서", "GungsuhChe", "궁서체",
    "HY신명조", "HY중명조", "HCR Batang"],
};

// 이 컴퓨터에서 실제로 쓸 수 있는 한글 글꼴을 고른다(설치 여부를 파일로 확인).
function pickKoreanFonts() {
  const candidates = {
    sans: [
      ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "Apple SD Gothic Neo"],
      ["/System/Library/Fonts/Supplemental/AppleGothic.ttf", "AppleGothic"],
      ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK KR"],
      ["/usr/share/fonts/truetype/nanum/NanumGothic.ttf", "NanumGothic"],
    ],
    serif: [
      ["/System/Library/Fonts/Supplemental/AppleMyungjo.ttf", "AppleMyungjo"],
      ["/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", "Noto Serif CJK KR"],
      ["/usr/share/fonts/truetype/nanum/NanumMyeongjo.ttf", "NanumMyeongjo"],
    ],
  };
  const out = {};
  for (const [kind, list] of Object.entries(candidates)) {
    const hit = list.find(([path]) => existsSync(path));
    if (hit) out[kind] = hit[1];
  }
  return out;
}

// fontconfig 설정 파일을 만들고 경로를 돌려준다(없으면 null → 평소대로 동작).
// 시스템 설정을 **include 해야 한다** — 안 하면 글꼴 경로 자체가 비어 더 나빠진다(실측).
let _fcFile = null;
function koreanFontconfig() {
  if (_fcFile !== null) return _fcFile || null;
  _fcFile = "";
  if (process.platform === "win32") return null;   // 윈도우엔 원래 글꼴이 있다
  const picked = pickKoreanFonts();
  if (!picked.sans && !picked.serif) return null;  // 대체할 글꼴이 없으면 손대지 않는다

  const rule = (from, to) =>
    `  <match target="pattern">\n` +
    `    <test name="family"><string>${from}</string></test>\n` +
    `    <edit name="family" mode="prepend" binding="strong"><string>${to}</string></edit>\n` +
    `  </match>`;
  const rules = [];
  for (const [kind, names] of Object.entries(WIN_KO_FONTS)) {
    const to = picked[kind] || picked.sans || picked.serif;
    for (const from of names) rules.push(rule(from, to));
  }
  const xml = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n` +
    ["/opt/homebrew/etc/fonts/fonts.conf", "/usr/local/etc/fonts/fonts.conf", "/etc/fonts/fonts.conf"]
      .map((p) => `  <include ignore_missing="yes">${p}</include>`).join("\n") + "\n" +
    rules.join("\n") + "\n</fontconfig>\n";

  const path = dataPath("lo-fonts.conf");
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, xml); _fcFile = path; }
  catch { return null; }
  return _fcFile;
}

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
    // 한글 글꼴 대체 규칙을 걸고 변환한다(맑은 고딕 등 → 이 컴퓨터의 한글 글꼴).
    const fcFile = koreanFontconfig();
    const { code, stderr } = await run([soffice, `-env:UserInstallation=${profileUrl}`,
      "--headless", "--convert-to", "pdf", "--outdir", dir, inPath],
      fcFile ? { FONTCONFIG_FILE: fcFile } : null);
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

// 페이지 이미지 버퍼들을 uploads에 저장(ext=".png"|".webp")하고 URL 배열 반환.
async function saveImages(buffers, ext) {
  return await Promise.all(buffers.map((buf) => saveUpload("slide" + ext, buf).then((r) => r.url)));
}

// 파일(office/pdf) → 페이지 이미지 { ext, buffers }. office는 먼저 PDF로 변환하고,
// cwebp가 있으면 PNG를 WebP로 바꿔 용량을 7~8배 줄인다(없으면 PNG 그대로).
async function renderFileToImages(filename, bytes) {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();
  let png;
  if (OFFICE_EXT.has(ext)) png = await pdfBytesToPngBuffers(await officeToPdf(filename, bytes));
  else if (ext === ".pdf") png = await pdfBytesToPngBuffers(bytes);
  else return null; // 이미지 등은 렌더 대상 아님
  const webp = await pngBuffersToWebp(png, WEBP_QUALITY);   // cwebp 없으면 null
  return webp ? { ext: ".webp", buffers: webp } : { ext: ".png", buffers: png };
}

// 업로드 바이트 → 슬라이드 배열(캐시 없음). /api/import(브라우저 업로드)용.
export async function fileToSlides(filename, bytes) {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();
  if (OFFICE_EXT.has(ext) || ext === ".pdf") {
    const img = await renderFileToImages(filename, bytes);
    return (await saveImages(img.buffers, img.ext)).map(imageSlide);
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
  let img = getCachedImages(path, RENDER_WIDTH);           // 캐시 히트 → 변환 생략
  if (!img) {
    img = await renderFileToImages(basename(path), readFileSync(path));
    putCachedImages(path, RENDER_WIDTH, img.buffers, img.ext);   // 다음을 위해 캐시
  }
  return (await saveImages(img.buffers, img.ext)).map(imageSlide);   // 항상 uploads에 영구 저장
}

// 캐시만 채운다(가져오지 않음). 미리 변환(prerender)용. 이미 신선하면 렌더 생략.
// 반환: { pages, cached(true=이번에 렌더), skipped(true=이미 캐시) }
export async function prerenderPath(path, force = false) {
  const ext = extname(path).toLowerCase();
  if (!OFFICE_EXT.has(ext) && ext !== ".pdf") return { pages: 0, skipped: true }; // 이미지 등은 대상 아님
  if (!force && isCached(path, RENDER_WIDTH)) return { pages: (getCachedImages(path, RENDER_WIDTH)?.buffers || []).length, skipped: true };
  const img = await renderFileToImages(basename(path), readFileSync(path));
  putCachedImages(path, RENDER_WIDTH, img.buffers, img.ext);
  return { pages: img.buffers.length, cached: true };
}

export { RENDER_WIDTH };
