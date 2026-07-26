// Deterministic content → slide-page splitting (design §3, step 5).
// No "intelligence" here: structured input → predictable pages. Ambiguous
// parsing (e.g. messy praise lyrics) is the external LLM's job (design §15).

// Tunables for bible "auto" layout (요소 크기를 모를 때 쓰는 기본값).
const BIBLE_AUTO_MAX_CHARS = 180;
const BIBLE_AUTO_MAX_VERSES = 4;

// 성경 본문 요소의 박스·글자 크기로 "한 슬라이드에 들어가는 글자 수"를 추정한다.
// 슬라이드는 16:9이고 크기 단위가 cqw(=가로 1%)라 세로는 56.25cqw. 한글은 한 글자 ≈ 1em.
// 템플릿 글꼴을 키우면 auto 분할이 그만큼 잘게 나뉘어 본문이 잘리지 않는다.
export function bibleAutoCapacity(el) {
  if (!el) return { maxChars: BIBLE_AUTO_MAX_CHARS, maxVerses: BIBLE_AUTO_MAX_VERSES };
  const size = Number(el.size) > 0 ? Number(el.size) : 3.2;          // cqw
  const w = Number(el.w) > 0 ? Number(el.w) : 0.84;                  // 0~1
  const h = Number(el.h) > 0 ? Number(el.h) : 0.56;
  const lh = Number(el.line_height) > 0 ? Number(el.line_height) : 1.5;
  const perLine = Math.max(4, Math.floor((w * 100) / size));         // 한 줄 글자 수
  const field = el.field || "all";
  // field가 "all"이면 참조(ce-ref, 0.5em + 여백)가 본문 위 한 줄을 차지한다.
  let lines = Math.floor((h * 56.25) / (size * lh)) - (field === "text" ? 0 : 1);
  lines = Math.max(1, lines);
  // 0.92 = 어절 단위 줄바꿈으로 생기는 줄 끝 여백 감안(넘치는 것보다 조금 덜 채우는 쪽).
  return { maxChars: Math.max(20, Math.round(perLine * lines * 0.92)), maxVerses: BIBLE_AUTO_MAX_VERSES };
}

function refString(shortName, chapter, vStart, vEnd) {
  const range = vStart === vEnd ? `${vStart}` : `${vStart}-${vEnd}`;
  return `${shortName ?? ""} ${chapter}:${range}`.trim();
}

// 한 장에 담기지 않는 긴 절을 어절 단위로 나눈다. 이어지는 조각은 cont=true(절 번호 반복 X).
function splitLongVerse(v, maxChars) {
  if (v.text.length + 3 <= maxChars) return [v];
  const budget = Math.max(10, maxChars - 3);
  const parts = [];
  let cur = "";
  for (const w of v.text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > budget) { parts.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) parts.push(cur);
  return parts.map((text, i) => (i === 0 ? { ...v, text } : { ...v, text, cont: true }));
}

// verses: [{verse, text}] → array of bible-slide `data` objects.
// capacity = { maxChars, maxVerses } — 보통 bibleAutoCapacity(본문 요소)로 계산해 넘긴다.
export function splitBible(verses, layout, meta = {}, capacity = {}) {
  const { book_name, short_name, chapter } = meta;
  const maxChars = capacity.maxChars || BIBLE_AUTO_MAX_CHARS;
  const maxVerses = capacity.maxVerses || BIBLE_AUTO_MAX_VERSES;
  if (verses.length === 0) return [];

  let groups;
  if (layout === "all-in-one") {
    groups = [verses];
  } else if (layout === "one-per-verse") {
    groups = verses.map((v) => [v]);
  } else {
    // auto: pack by char budget / verse count.
    // 한 절이 한 장보다 길면(글꼴이 클 때) 절 안에서도 어절 단위로 나눈다 → 잘리지 않는다.
    const units = verses.flatMap((v) => splitLongVerse(v, maxChars));
    groups = [];
    let cur = [];
    let chars = 0;
    for (const v of units) {
      const len = v.text.length + 3;   // 절 번호(위첨자)와 절 사이 공백 몫
      if (cur.length > 0 && (chars + len > maxChars || cur.length >= maxVerses)) {
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

// hymn: verses [{verse_no, label, lines}] (+ refrain[]) → hymn-slide `data` objects.
// 후렴(refrain)이 있으면 각 절 슬라이드 뒤에 후렴 슬라이드를 넣는다(찬송 부르는 순서대로).
export function splitHymn(hymn, verseNos, linesPerSlide = 4) {
  const wanted = verseNos && verseNos.length
    ? hymn.verses.filter((v) => verseNos.includes(v.verse_no))
    : hymn.verses;
  const refrain = hymn.refrain && hymn.refrain.length ? hymn.refrain : null;
  const pages = [];
  // verse_no는 슬라이드가 어느 절(0=후렴)을 담고 있는지 기억해 둔다 → 편집기에서 "다시
  // 가져오기"를 해도 그 절/후렴 그대로 다시 채워진다.
  const add = (lines, label, verseNo) => {
    for (const chunk of chunkLines(lines, linesPerSlide)) {
      pages.push({ number: hymn.number, title: hymn.title, label, verse_no: verseNo, lines: chunk });
    }
  };
  for (const v of wanted) {
    add(v.lines, v.label ?? `${v.verse_no}절`, v.verse_no);
    if (refrain) add(refrain, "후렴", 0);   // 각 절 뒤에 후렴
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
