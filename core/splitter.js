// Deterministic content → slide-page splitting (design §3, step 5).
// No "intelligence" here: structured input → predictable pages. Ambiguous
// parsing (e.g. messy praise lyrics) is the external LLM's job (design §15).

// Tunables for bible "auto" layout.
const BIBLE_AUTO_MAX_CHARS = 180;
const BIBLE_AUTO_MAX_VERSES = 4;

function refString(shortName, chapter, vStart, vEnd) {
  const range = vStart === vEnd ? `${vStart}` : `${vStart}-${vEnd}`;
  return `${shortName ?? ""} ${chapter}:${range}`.trim();
}

// verses: [{verse, text}] → array of bible-slide `data` objects.
export function splitBible(verses, layout, meta = {}) {
  const { book_name, short_name, chapter } = meta;
  if (verses.length === 0) return [];

  let groups;
  if (layout === "all-in-one") {
    groups = [verses];
  } else if (layout === "one-per-verse") {
    groups = verses.map((v) => [v]);
  } else {
    // auto: pack by char budget / verse count.
    groups = [];
    let cur = [];
    let chars = 0;
    for (const v of verses) {
      const len = v.text.length;
      if (cur.length > 0 && (chars + len > BIBLE_AUTO_MAX_CHARS || cur.length >= BIBLE_AUTO_MAX_VERSES)) {
        groups.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(v);
      chars += len;
    }
    if (cur.length) groups.push(cur);
  }

  return groups.map((g) => ({
    book_name,
    chapter,
    ref: refString(short_name ?? book_name, chapter, g[0].verse, g[g.length - 1].verse),
    verses: g,
  }));
}

// Split a list of text lines into chunks of `perSlide`.
function chunkLines(lines, perSlide) {
  const out = [];
  for (let i = 0; i < lines.length; i += perSlide) out.push(lines.slice(i, i + perSlide));
  return out;
}

// hymn: verses [{verse_no, label, lines}] → hymn-slide `data` objects.
export function splitHymn(hymn, verseNos, linesPerSlide = 4) {
  const wanted = verseNos && verseNos.length
    ? hymn.verses.filter((v) => verseNos.includes(v.verse_no))
    : hymn.verses;
  const pages = [];
  for (const v of wanted) {
    for (const chunk of chunkLines(v.lines, linesPerSlide)) {
      pages.push({ number: hymn.number, title: hymn.title, label: v.label ?? `${v.verse_no}절`, lines: chunk });
    }
  }
  return pages;
}

// praise: sections [{label, lines}] → praise-slide `data` objects.
export function splitPraise(title, sections, linesPerSlide = 2) {
  const pages = [];
  for (const sec of sections) {
    for (const chunk of chunkLines(sec.lines, linesPerSlide)) {
      pages.push({ title, label: sec.label ?? "", lines: chunk });
    }
  }
  return pages;
}

// reading: segments [{role, text}] → reading-slide `data` objects.
// Default grouping: a leader/congregation call-response pair per slide; a
// "unison" segment stands alone. `perSlide` caps segments per slide.
export function splitReading(reading, perSlide = 2) {
  const pages = [];
  let cur = [];
  const flush = () => { if (cur.length) { pages.push({ number: reading.number, title: reading.title, segments: cur }); cur = []; } };
  for (const seg of reading.segments) {
    if (seg.role === "unison") { flush(); pages.push({ number: reading.number, title: reading.title, segments: [seg] }); continue; }
    cur.push({ role: seg.role, text: seg.text });
    if (cur.length >= perSlide) flush();
  }
  flush();
  return pages;
}
