// Extract searchable text + page count from a presentation/PDF file.
//   .pptx/.odp → `unzip -p` the slide/content XML, pull the run text.
//   .pdf       → `pdftotext`.
//   .ppt       → filename-only (no bundled extractor); text = "".
// Uses shell tools already present (unzip, pdftotext). Failures degrade to
// text:"" so the file is still indexed/searchable by name.

function runText(cmd) {
  try {
    const p = Bun.spawnSync(cmd);
    if (p.exitCode !== 0) return "";
    return new TextDecoder().decode(p.stdout || new Uint8Array());
  } catch { return ""; }
}

// Collect inner text of all <tag ...>text</tag> occurrences (e.g. a:t / text:p).
function pullTags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (t) out.push(t);
  }
  return out;
}

function extractPptx(path) {
  // slide XML → <a:t> text runs; page count = number of slide files
  const xml = runText(["unzip", "-p", path, "ppt/slides/slide*.xml"]);
  const text = pullTags(xml, "a:t").join(" ");
  const listing = runText(["unzip", "-Z1", path]);
  const pages = (listing.match(/ppt\/slides\/slide\d+\.xml/g) || []).length || null;
  return { text, pages };
}

function extractOdp(path) {
  const xml = runText(["unzip", "-p", path, "content.xml"]);
  const text = [...pullTags(xml, "text:p"), ...pullTags(xml, "text:span")].join(" ");
  const pages = (xml.match(/draw:page /g) || []).length || null;
  return { text, pages };
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
