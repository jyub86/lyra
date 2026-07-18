// Bible reference parser — ports the logic from the standalone pdf_to_pptx tool.
// Turns free-form Korean references ("요 3:16-18, 롬 8:1", "출1:2,5", "16절") into
// structured { book, chapter, verse_start, verse_end } ranges, tracking context
// (active book/chapter) across a list so partial refs resolve. Book resolution
// (abbr/full/alias → DB) is done later by add_bible_slides; here we only need to
// recognize book tokens, so the 66-book abbr→full map is embedded (static).

const BIBLE_VOL_DICT = {
  "창": "창세기", "출": "출애굽기", "레": "레위기", "민": "민수기", "신": "신명기",
  "수": "여호수아", "삿": "사사기", "룻": "룻기", "삼상": "사무엘상", "삼하": "사무엘하",
  "왕상": "열왕기상", "왕하": "열왕기하", "대상": "역대상", "대하": "역대하", "스": "에스라",
  "느": "느헤미야", "에": "에스더", "욥": "욥기", "시": "시편", "잠": "잠언",
  "전": "전도서", "아": "아가", "사": "이사야", "렘": "예레미야", "애": "예레미야애가",
  "겔": "에스겔", "단": "다니엘", "호": "호세아", "욜": "요엘", "암": "아모스",
  "옵": "오바댜", "욘": "요나", "미": "미가", "나": "나훔", "합": "하박국",
  "습": "스바냐", "학": "학개", "슥": "스가랴", "말": "말라기",
  "마": "마태복음", "막": "마가복음", "눅": "누가복음", "요": "요한복음", "행": "사도행전",
  "롬": "로마서", "고전": "고린도전서", "고후": "고린도후서", "갈": "갈라디아서", "엡": "에베소서",
  "빌": "빌립보서", "골": "골로새서", "살전": "데살로니가전서", "살후": "데살로니가후서",
  "딤전": "디모데전서", "딤후": "디모데후서", "딛": "디도서", "몬": "빌레몬서", "히": "히브리서",
  "약": "야고보서", "벧전": "베드로전서", "벧후": "베드로후서", "요일": "요한일서",
  "요이": "요한이서", "요삼": "요한삼서", "유": "유다서", "계": "요한계시록",
};

// token(약칭 또는 정식명) → 약칭. 정식명·약칭 모두 매핑.
const TOKEN_TO_ABBR = {};
for (const [abbr, full] of Object.entries(BIBLE_VOL_DICT)) { TOKEN_TO_ABBR[abbr] = abbr; TOKEN_TO_ABBR[full] = abbr; }
// 접미사 매칭용: 긴 이름 우선(예: "출애굽기"가 "출"보다 먼저)
const TOKENS_BY_LEN = Object.keys(TOKEN_TO_ABBR).sort((a, b) => b.length - a.length);

// 붙어있는 한글 덩어리에서 책 이름을 뽑는다. 정확히 일치하면 그걸, 아니면 알려진
// 책 이름으로 끝나는 최장 접미사(예: "성경봉독요" → "요").
function matchBook(chunk) {
  if (TOKEN_TO_ABBR[chunk]) return TOKEN_TO_ABBR[chunk];
  for (const t of TOKENS_BY_LEN) if (chunk.endsWith(t)) return TOKEN_TO_ABBR[t];
  return null;
}

function pushRef(out, book, chapter, vs, ve) {
  if (!book || !chapter || !vs) return;
  const s = Math.min(vs, ve || vs), e = Math.max(vs, ve || vs);
  const abbr = TOKEN_TO_ABBR[book] || book;
  out.push({ book: abbr, chapter, verse_start: s, verse_end: e, ref: `${abbr} ${chapter}:${s}${e > s ? "-" + e : ""}` });
}

const normalize = (s) => String(s || "").replace(/[~∼〜]/g, "-").replace(/[：]/g, ":");

// 조각(쉼표/세미콜론으로 나눈 하나) 리스트를 순서대로 파싱하며 문맥(ctx={book,chapter})을
// 유지한다. 결과 참조를 out에 push. 절만 있는 조각은 ctx의 책·장으로 해석.
export function parseParts(parts, ctx, out) {
  for (let seg of parts) {
    seg = normalize(seg).replace(/\s+/g, "");         // 조각 내부 공백 제거
    if (!seg) continue;
    seg = seg.replace(/([가-힣]+):(?=\d)/, "$1");      // "출:2" → "출2" (책 뒤 콜론만)

    // 1) 책+장:절(범위) — 붙어있어도 전역 매칭으로 여러 개 인식
    const reFull = /([가-힣]+)(\d+):(\d+)(?:-(\d+))?/g;
    let m, matched = false;
    while ((m = reFull.exec(seg))) {
      const book = matchBook(m[1]);
      if (!book) continue;
      ctx.book = book; ctx.chapter = parseInt(m[2], 10);
      pushRef(out, book, ctx.chapter, parseInt(m[3], 10), m[4] ? parseInt(m[4], 10) : undefined);
      matched = true;
    }
    if (matched) continue;

    // 2) 장:절(범위) — 직전 책 문맥 사용
    m = /(\d+):(\d+)(?:-(\d+))?/.exec(seg);
    if (m && ctx.book) {
      ctx.chapter = parseInt(m[1], 10);
      pushRef(out, ctx.book, ctx.chapter, parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : undefined);
      continue;
    }

    // 3) 절(범위)만 — 직전 책+장 문맥 사용. "16절", "16-18", "절16"(절이 앞에 오는 형태도 허용).
    m = /절?(\d+)(?:-(\d+))?절?/.exec(seg);
    if (m && ctx.book && ctx.chapter) {
      pushRef(out, ctx.book, ctx.chapter, parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : undefined);
      continue;
    }
  }
  return out;
}

// 자유 텍스트 → 구조화된 성경 참조 배열(문맥 추적). 직접 입력용.
export function parseBibleRefs(raw) {
  const out = [];
  const ctx = { book: null, chapter: null };
  // 쉼표/세미콜론/줄바꿈/가운뎃점을 하드 구분자로
  parseParts(String(raw || "").replace(/[·∙‧]/g, " ").split(/[,;\n、]/), ctx, out);
  return out;
}

// 문서 전체 텍스트에서 주 본문의 책·장을 추정(주보 제목의 "요6:1-15" 같은 첫 참조).
// 절만 있는 참조(2절, 26절 …)의 기본 문맥으로 쓴다. 없으면 {book:null, chapter:null}.
export function extractGlobalContext(allText) {
  const text = normalize(allText);
  const re = /([가-힣]{1,4})\s*(\d+)\s*:\s*\d+/g;   // 첫 "책 장:절"
  let m;
  while ((m = re.exec(text))) {
    const book = matchBook(m[1].replace(/\s+/g, ""));
    if (book) return { book, chapter: parseInt(m[2], 10) };
  }
  return { book: null, chapter: null };
}

export { BIBLE_VOL_DICT, matchBook };
