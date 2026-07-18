// Extract red-colored Bible references from a PDF (주보/bulletin). The source
// pdf_to_pptx tool used PyMuPDF span colors to tell references (printed red) from
// the rest; here we do the same with pdf.js: walk each page's operator list,
// track the current fill color (setFillRGBColor → hex string in pdf.js v6), and
// collect the unicode of showText runs drawn in red. Pure JS (no external binary).
import { parseBibleRefs } from "./bible-ref.js";

let _pdfjs = null;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // 워커 미지정 시 pdf.js가 자동으로 메인 스레드(fake worker)로 동작한다.
  _pdfjs.setVerbosityLevel?.(_pdfjs.VerbosityLevel?.ERRORS ?? 0);
  return _pdfjs;
}

// 빨강 판정 — Python과 동일 기준(r>200, g<100, b<100).
function isRed(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return false;
  return parseInt(m[1], 16) > 200 && parseInt(m[2], 16) < 100 && parseInt(m[3], 16) < 100;
}

// PDF 바이트 → 빨강 텍스트(참조 후보). 빨강 아닌 구간은 공백으로 대체해 토큰이 섞이지 않게.
export async function extractRedText(bytes) {
  const lib = await pdfjs();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = lib.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const OPS = lib.OPS;
  let red = "";
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      let fill = "#000000";
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], a = ops.argsArray[i];
        if (fn === OPS.setFillRGBColor) { if (typeof a[0] === "string") fill = a[0]; }
        else if (fn === OPS.showText) {
          const s = (a[0] || []).map((g) => (g && typeof g === "object" && g.unicode != null) ? g.unicode : "").join("");
          red += isRed(fill) ? s : " ";
        }
      }
      red += "\n"; // 페이지 경계
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return red.replace(/[ \t]+/g, " ").trim();
}

// PDF 바이트 → { text(빨강 원문), refs(구조화 참조) }.
export async function extractRefsFromPdf(bytes) {
  const text = await extractRedText(bytes);
  return { text, refs: parseBibleRefs(text) };
}
