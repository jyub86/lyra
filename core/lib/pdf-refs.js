// Extract Bible references from a PDF (설교 개요/주보). References are printed in
// red; verse-only refs (2절, 26절 …) belong to the sermon's main passage. Ports the
// pdf_to_pptx tool's logic to pdf.js:
//   1) walk each page's operator list, tracking fill color (red vs not) → colored
//      runs in reading order, plus the full text;
//   2) find the global context (main book/chapter) from the whole text (e.g. the
//      title "요6:1-15");
//   3) parse red runs with that context, and RESET context to global whenever black
//      Korean prose appears — so cross-refs (신18:15) don't capture later verse-only
//      refs, which fall back to the main passage. Pure JS (no external binary).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseParts, extractGlobalContext } from "./bible-ref.js";
import { findPoppler } from "./poppler.js";

// 주 본문(책·장) 감지는 "읽기 순서" 텍스트가 필요하다. pdf.js의 그리기 순서 텍스트는
// 복잡한 레이아웃(CJK 주보)에서 뒤섞이므로, 있으면 poppler pdftotext -layout 로 정확히
// 읽는다(없으면 호출자가 pdf.js 텍스트로 폴백).
async function pdftotextLayout(bytes) {
  const pdftotext = findPoppler("pdftotext");
  if (!pdftotext) return null;
  const dir = mkdtempSync(join(tmpdir(), "lyra-ref-"));
  try {
    const inPath = join(dir, "in.pdf");
    writeFileSync(inPath, Buffer.from(bytes));
    const proc = Bun.spawn([pdftotext, "-layout", inPath, "-"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch { return null; } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

// 한 번의 pdf.js 패스로 색깔별 런(읽기 순서, 같은 색 병합)과 전체 텍스트를 추출.
async function extractRuns(bytes) {
  const lib = await pdfjs();
  const data = new Uint8Array(bytes);   // 사본 — getDocument가 버퍼를 detach하므로 원본 보존
  const task = lib.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const OPS = lib.OPS;
  const runs = [];   // { red, text }
  let allText = "";
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      let fill = "#000000", curRed = null, buf = "";
      const flush = () => { if (buf) { runs.push({ red: curRed, text: buf }); buf = ""; } };
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], a = ops.argsArray[i];
        if (fn === OPS.setFillRGBColor) { if (typeof a[0] === "string") fill = a[0]; }
        else if (fn === OPS.showText) {
          const s = (a[0] || []).map((g) => (g && typeof g === "object" && g.unicode != null) ? g.unicode : "").join("");
          if (!s) continue;
          const red = isRed(fill);
          if (curRed === null) curRed = red;
          if (red !== curRed) { flush(); curRed = red; }
          buf += s; allText += s;
        }
      }
      flush();
      runs.push({ red: false, text: "\n" }); allText += "\n"; // 페이지 경계(검정)
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { runs, allText };
}

// PDF 바이트 → { text(빨강 원문), refs(구조화 참조), global(주 본문 책·장) }.
export async function extractRefsFromPdf(bytes) {
  // 주 본문(예: 요6) — 절만 있는 참조의 기본 문맥. pdftotext(읽기순서) 우선, 없으면 pdf.js 텍스트.
  // pdf.js가 버퍼를 detach하므로 pdftotext를 먼저 실행한다.
  const layout = await pdftotextLayout(bytes);
  const { runs, allText } = await extractRuns(bytes);
  const global = extractGlobalContext(layout || allText);
  const refs = [];
  const ctx = { book: global.book, chapter: global.chapter };
  for (const run of runs) {
    if (run.red) {
      parseParts(run.text.split(/[,;]/), ctx, refs); // 빨강 참조 파싱(문맥 유지)
    } else if (/[가-힣]/.test(run.text)) {
      ctx.book = global.book; ctx.chapter = global.chapter; // 검정 한글 → 문맥을 주 본문으로 리셋
    }
  }
  const text = runs.filter((r) => r.red).map((r) => r.text).join(" ").replace(/\s+/g, " ").trim();
  return { text, refs, global };
}
