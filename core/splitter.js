// Deterministic content → slide-page splitting (design §3, step 5).
// No "intelligence" here: structured input → predictable pages. Ambiguous
// parsing (e.g. messy praise lyrics) is the external LLM's job (design §15).

// Tunables for bible "auto" layout (요소 크기를 모를 때 쓰는 기본값).
const BIBLE_AUTO_MAX_CHARS = 180;
const BIBLE_AUTO_MAX_VERSES = 6;

// 한글 본문의 **평균 글자 폭**(em). 한글 낱글자는 1em이지만 문장에는 어절마다 공백이 있고
// 공백은 훨씬 좁다(≈0.3em). "1글자 = 1em"으로 잡으면 용량을 크게 낮잡아 한 장에 들어갈
// 본문을 두 장으로 나눈다.
// 실측(브라우저에서 같은 CSS로 렌더): size 4.3cqw · 박스폭 0.82 → 한 줄 25자.
//   1049.6px ÷ 25자 ÷ 55.04px(=4.3cqw) = 0.763em/글자.
// 성경·찬송 본문 모두 어절 구성이 비슷해 0.78을 쓴다(실측보다 조금 보수적).
const KO_ADVANCE = 0.78;

// 성경 본문 요소의 박스·글자 크기로 "한 슬라이드에 들어가는 글자 수"를 추정한다.
// 슬라이드는 16:9이고 크기 단위가 cqw(=가로 1%)라 세로는 56.25cqw.
// 템플릿 글꼴을 키우면 auto 분할이 그만큼 잘게 나뉘어 본문이 잘리지 않는다.
export function bibleAutoCapacity(el) {
  if (!el) return { maxChars: BIBLE_AUTO_MAX_CHARS, maxVerses: BIBLE_AUTO_MAX_VERSES };
  const size = Number(el.size) > 0 ? Number(el.size) : 3.2;          // cqw
  const w = Number(el.w) > 0 ? Number(el.w) : 0.84;                  // 0~1
  const h = Number(el.h) > 0 ? Number(el.h) : 0.56;
  const lh = Number(el.line_height) > 0 ? Number(el.line_height) : 1.5;
  const perLine = Math.max(4, Math.floor((w * 100) / (size * KO_ADVANCE)));   // 한 줄 글자 수
  const field = el.field || "all";
  // field가 "all"이면 참조(ce-ref, 0.5em + 여백)가 본문 위 한 줄을 차지한다.
  let lines = Math.floor((h * 56.25) / (size * lh)) - (field === "text" ? 0 : 1);
  lines = Math.max(1, lines);
  // 여기에 별도 안전계수를 곱하지 않는다 — 이미 두 군데서 보수적으로 잡고 있어 이중 차감이 된다:
  //   ① perLine·lines의 floor() ② splitBible이 절마다 더하는 +3(절 번호·절 사이 공백)
  // 실측(실제 렌더러로 넘치는 지점): 1절 123자 · 2절 120 · 3절 120 · 4절 112.
  // perLine×lines = 120이고 +3×절수를 빼면 1절 117 / 2절 114 / 3절 111 / 4절 108 → 모두 안전.
  return { maxChars: Math.max(20, perLine * lines), maxVerses: BIBLE_AUTO_MAX_VERSES };
}

function refString(shortName, chapter, vStart, vEnd) {
  const range = vStart === vEnd ? `${vStart}` : `${vStart}-${vEnd}`;
  return `${shortName ?? ""} ${chapter}:${range}`.trim();
}

// 한 장에 담기지 않는 긴 절을 어절 단위로 나눈다. 이어지는 조각은 cont=true(절 번호 반복 X).
// 절 번호 자리(+3)는 빼지 않는다 — 혼자 있는 절은 번호가 아예 안 그려지므로(show_numbers
// auto), 그 자리를 미리 빼면 85자짜리가 87자 예산을 2자 차이로 넘겨 쓸데없이 쪼개진다.
function splitLongVerse(v, maxChars) {
  if (v.text.length <= maxChars) return [v];
  const budget = Math.max(10, maxChars);
  const words = v.text.split(/\s+/).filter(Boolean);
  const wrap = (width) => {
    const parts = [];
    let cur = "";
    for (const w of words) {
      if (cur && cur.length + 1 + w.length > width) { parts.push(cur); cur = w; }
      else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) parts.push(cur);
    return parts;
  };
  // 앞장을 가득 채우면 마지막 장에 "행하느니라"처럼 몇 글자만 남아 보기 나쁘다.
  // 그래서 필요한 최소 장 수(n)를 먼저 구하고, n장을 유지하는 선에서 가장 고르게
  // 나뉘는 폭을 찾는다(어절 경계 때문에 이상적인 폭으로는 n장에 안 담길 수 있다).
  const n = Math.ceil(v.text.length / budget);
  let parts = null;
  for (let width = Math.ceil(v.text.length / n); width <= budget; width++) {
    const p = wrap(width);
    if (p.length <= n) { parts = p; break; }
  }
  if (!parts) parts = wrap(budget);
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
    // 한 절에 한 장. 단 한 장에 안 들어가는 긴 절(예: 렘 32:3 = 287자)은 이어지는
    // 장으로 나눈다 — 안 그러면 박스를 넘겨 뒷부분이 잘린 채 발표된다.
    groups = verses.flatMap((v) => splitLongVerse(v, maxChars).map((part) => [part]));
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
