// Import existing slides as images. PDF → per-page PNGs via `pdftoppm`; single
// images pass through. Each page/image becomes a slide with one full-bleed image
// element on a black background. Real .pptx must be exported to PDF/images first
// (no LibreOffice here). Shared by the /api/import endpoint and import_pdf tool.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveUpload } from "./uploads.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function imageSlide(url) {
  return {
    background: { type: "color", value: "#000000" },
    elements: [{ type: "image", x: 0, y: 0, w: 1, h: 1, fit: "contain", url }],
  };
}

async function pdfToImageUrls(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "ryre-pdf-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, Buffer.from(bytes));
    const proc = Bun.spawnSync(["pdftoppm", "-png", "-r", "150", pdfPath, join(dir, "page")]);
    if (proc.exitCode !== 0) {
      throw new Error("pdftoppm 변환 실패 (poppler 설치 필요). PPT는 PDF로 내보내 시도하세요.");
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
  if (ext === ".pdf") {
    const urls = await pdfToImageUrls(bytes);
    return urls.map(imageSlide);
  }
  if (IMAGE_EXT.has(ext)) {
    const { url } = await saveUpload(filename, bytes);
    return [imageSlide(url)];
  }
  throw new Error(`지원하지 않는 형식: ${ext} (PDF 또는 이미지 파일). PPT는 PDF로 내보내세요.`);
}
