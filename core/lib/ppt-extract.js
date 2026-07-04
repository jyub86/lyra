// Extract searchable text + page count from a presentation/PDF file.
//   .pptx/.odp → read the zip in pure JS (fflate) → pull run text. OS-independent.
//   .pdf       → `pdftotext` (poppler; still native).
//   .ppt       → filename-only (no bundled extractor); text = "".
// Failures degrade to text:"" so the file is still indexed/searchable by name.
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

function runText(cmd) {
  try {
    const p = Bun.spawnSync(cmd);
    if (p.exitCode !== 0) return "";
    return new TextDecoder().decode(p.stdout || new Uint8Array());
  } catch { return ""; }
}

// Read specific entries from a zip (pptx/odp) as text, cross-platform.
// `match(name)` selects entries; returns array of decoded strings.
function zipEntries(path, match) {
  try {
    const files = unzipSync(readFileSync(path), { filter: (f) => match(f.name) });
    return Object.keys(files).sort().map((k) => strFromU8(files[k]));
  } catch { return []; }
}

function decodeXml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
// Split into <tag>…</tag> blocks (paragraphs).
function blocks(xml, tag) {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g")) || [];
}
// Paragraph text: concat <a:t> runs with no separator (avoids fake mid-word
// spaces from formatting splits like "시편 3 2 편"); <a:br/> line breaks → space.
function paraText(p) {
  let out = "";
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(p)) !== null) out += m[1] !== undefined ? decodeXml(m[1]) : " ";
  return out.trim();
}

function extractPptx(path) {
  const slides = zipEntries(path, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)); // one xml per slide
  const xml = slides.join("\n");
  const paras = blocks(xml, "a:p").map(paraText).filter(Boolean);
  return { text: paras.join(" "), pages: slides.length || null };
}

function extractOdp(path) {
  const [xml = ""] = zipEntries(path, (n) => n === "content.xml");
  const paras = blocks(xml, "text:p").map((p) => decodeXml(p).trim()).filter(Boolean);
  const pages = (xml.match(/draw:page /g) || []).length || null;
  return { text: paras.join(" "), pages };
}

function extractPdf(path) {
  const text = runText(["pdftotext", "-layout", path, "-"]);
  const info = runText(["pdfinfo", path]);
  const m = info.match(/Pages:\s+(\d+)/);
  const pages = m ? Number(m[1]) : ((text.match(/\f/g) || []).length + 1 || null);
  return { text: text.replace(/\f/g, " ").replace(/\s+/g, " ").trim(), pages };
}

export function extractText(path) {
  const ext = "." + (path.split(".").pop() || "").toLowerCase();
  try {
    if (ext === ".pptx") return extractPptx(path);
    if (ext === ".odp") return extractOdp(path);
    if (ext === ".pdf") return extractPdf(path);
  } catch { /* fall through */ }
  return { text: "", pages: null }; // .ppt or extraction failure → name-only
}

export const SUPPORTED_EXT = new Set([".pptx", ".ppt", ".odp", ".pdf"]);
