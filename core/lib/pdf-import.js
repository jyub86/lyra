// Import existing slides as images. Office docs (.pptx/.ppt/.odp/.key-exported/
// .docx) → PDF via LibreOffice `soffice`; PDF → per-page PNGs via `pdftoppm`;
// single images pass through. Each page/image becomes a slide with one full-bleed
// image element on a black background. Shared by /api/import and import_pdf tool.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveUpload } from "./uploads.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const OFFICE_EXT = new Set([".pptx", ".ppt", ".odp", ".key", ".pdfx"]); // presentation docs LibreOffice can read

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
    // -env:UserInstallation isolates the LibreOffice profile per-run (avoids lock
    // clashes) in an OS-independent way (works on Windows, unlike HOME).
    const profileUrl = "file://" + (process.platform === "win32" ? "/" + dir.replace(/\\/g, "/") : dir);
    const proc = Bun.spawnSync([soffice, `-env:UserInstallation=${profileUrl}`,
      "--headless", "--convert-to", "pdf", "--outdir", dir, inPath]);
    const pdf = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".pdf"));
    if (proc.exitCode !== 0 || !pdf) {
      throw new Error("LibreOffice 변환 실패: " + (proc.stderr ? new TextDecoder().decode(proc.stderr).slice(0, 200) : "unknown"));
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

async function pdfToImageUrls(bytes) {
  if (!Bun.which("pdftoppm")) {
    throw new Error("PDF→이미지 변환 도구(poppler)가 없습니다. macOS: brew install poppler · Windows: poppler 설치 후 PATH 등록 · Linux: apt install poppler-utils");
  }
  const dir = mkdtempSync(join(tmpdir(), "lyra-pdf-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, Buffer.from(bytes));
    const proc = Bun.spawnSync(["pdftoppm", "-png", "-r", "150", pdfPath, join(dir, "page")]);
    if (proc.exitCode !== 0) {
      throw new Error("pdftoppm 변환 실패 (poppler 확인). PPT는 LibreOffice로 자동 변환됩니다.");
    }
    const pages = readdirSync(dir).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
    const urls = [];
    for (const f of pages) {
      const { url } = await saveUpload(f.replace(/^page/, "slide") , readFileSync(join(dir, f)));
      urls.push(url);
    }
    return urls;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Returns an array of slide objects ({ background, elements }) for the file.
export async function fileToSlides(filename, bytes) {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();
  if (OFFICE_EXT.has(ext)) { // .pptx/.ppt/… → PDF via LibreOffice → images
    const pdf = await officeToPdf(filename, bytes);
    return (await pdfToImageUrls(pdf)).map(imageSlide);
  }
  if (ext === ".pdf") {
    return (await pdfToImageUrls(bytes)).map(imageSlide);
  }
  if (IMAGE_EXT.has(ext)) {
    const { url } = await saveUpload(filename, bytes);
    return [imageSlide(url)];
  }
  throw new Error(`지원하지 않는 형식: ${ext} (PPT/PDF/이미지). LibreOffice 미설치 시 PPT는 PDF로 내보내세요.`);
}
