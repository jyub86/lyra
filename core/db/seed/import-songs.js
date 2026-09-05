// Import 찬양 가사 from songs.json into songs/song_pages/songs_fts.
// Source shape (lyra-songs/v1, scripts/extract-song-lyrics.js 산출물):
//   { format, source_dir, songs:[ { title, source, ext, slides, pages:[[줄,...],...], conf } ], failed }
// pages = 원본 PPT의 슬라이드 나눔 그대로. 빈 배열인 장은 건너뛰고 page_no는 1..N으로 다시 매긴다.
// songs.json은 사람이 손으로 고쳐도 되는 원본 → 고친 뒤 다시 이 스크립트를 돌리면 반영된다.

// 파일명에서 온 제목의 잡음을 없앤다 — 검색·목록에서 방해만 되는 것들.
// 원본 파일명은 songs.source에 그대로 남으므로 정보가 사라지진 않는다.
//   "PPT 시선 16_9 (WIDE)" → "시선"      "갈급한 내 맘…_Wide" → "갈급한 내 맘…"
//
// NFC 정규화가 중요하다: macOS 파일명은 한글을 NFD(자모 분리)로 준다. 그대로 넣으면
// 실측 381/400곡이 NFD로 저장돼 "내 안에 사는 이" 같은 평범한 검색(LIKE·정확일치)이
// 0건이 된다(FTS는 우연히 동작해 눈에 안 띈다). 라이브러리 색인과 같은 정책.
export function cleanTitle(raw) {
  let t = String(raw || "").normalize("NFC");
  t = t.replace(/^\s*(?:PPT|ppt|PPTX?)\s+/, "");              // 앞머리 "PPT "
  t = t.replace(/[\s_\-]*\(?\s*(?:WIDE|wide|Wide|와이드)\s*\)?/g, " "); // 와이드 표기
  t = t.replace(/[\s_\-]*\b16[\s_:\-]?9\b/g, " ");             // 16_9 / 16:9
  t = t.replace(/[\s_\-]*\(?\s*(?:검|자|영상)\s*\)?\s*$/, "");   // 끝의 (검)·(자) 같은 표기
  t = t.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim();
  t = t.replace(/^[\-–—·.]+|[\-–—·.]+$/g, "").trim();
  return t || String(raw || "").trim();
}

// ---- OCR 뒤처리 (실측 기반) ----

// 가사 줄에서 장식·오인식 문자를 떼어낸다.
//
// 앞의 기호 오인식: 실측 755줄이 "1글자 + 공백 + 한글" 형태이고 그 1글자가
// 3(291) F(228) 5(190) J(23)에 몰려 있었다. 한 곡에 3이 291번 나올 수는 없으니 절 번호가 아니라
// **음표 기호(♪) 같은 장식을 OCR이 오인식**한 것이다. 해상도를 바꾸면 오인식되는 글자도
// 달라지므로 특정 글자 목록에 의존하지 않고 "홑 글자 + 공백 + 한글" 형태를 뗀다.
// 진짜 절 번호는 "1. " / "1) " 형태라서 아래 패턴에 걸리지 않는다.
const LEAD_GLYPH = /^[^\s가-힣][ \t](?=[가-힣])/;
// 줄 앞뒤에 남는 장식 문자(줄표·가운뎃점·별표·따옴표 등). 가사 안쪽 문장부호는 건드리지 않는다.
const EDGE_JUNK = /^[\s\-–—~·•*※◆■□○●▶▷「」『』"'`^_=+|\\/<>()[\]{}.,:;!?]+|[\s\-–—~·•*※◆■□○●▶▷「」『』"'`^_=+|\\/<>.,:;]+$/g;

// 음절 늘임표(하－시, 사랑을－) 제거.
// 원본 PPT는 음을 끄는 자리에 줄표를 넣어두는데, 가사 데이터로는 방해만 된다(실측 4,740줄).
// 영문 하이픈(Way-maker)은 단어의 일부이므로 **영문자 사이**에 있을 때만 남긴다.
function stripDashes(s) {
  return s.replace(/[\-–—]/g, (m, i, str) => {
    const a = str[i - 1], b = str[i + 1];
    return (a && b && /[A-Za-z]/.test(a) && /[A-Za-z]/.test(b)) ? m : "";
  });
}

export function stripLeadGlyph(line) {
  let s = String(line).normalize("NFC");
  s = s.replace(LEAD_GLYPH, "");
  s = stripDashes(s);
  s = s.replace(EDGE_JUNK, "");
  return s.replace(/\s{2,}/g, " ").trim();
}

// 글자(한글·영문·숫자)가 아예 없는 줄은 장식이다.
const hasWord = (s) => /[가-힣a-zA-Z0-9]/.test(s);

// 비교용 키 — 공백·기호·괄호·와이드 표기를 지운 알맹이.
const bareKey = (s) => String(s).normalize("NFC").replace(/[^가-힣a-zA-Z0-9]/g, "");
function titleKey(t) {
  let s = String(t).normalize("NFC").replace(/\(.*?\)/g, "");
  s = s.replace(/[\s_-]*(wide|와이드|16[\s_:-]?9|ppt)/gi, "");
  return bareKey(s);
}

// 두 문자열의 비슷한 정도(0~1). 글자 2개씩 묶어 겹치는 비율(Dice) — 의존성 없이 충분하다.
// OCR이 제목을 장마다 한두 글자 다르게 읽어도 같은 제목으로 보게 하려고 쓴다.
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

// 곡 제목이 모든 장에 박혀 있는 경우(제목 텍스트박스)를 제거한다.
// 추출 단계의 "여러 장 반복 = 장식" 규칙은 OCR이 장마다 미세하게 다르게 읽으면 놓치고,
// 후렴을 지키려 큰 글자를 남기게 했더니 큰 제목도 남았다(실측 23곡).
// → 파일명에서 온 제목과 비슷한 줄이 **거의 모든 장**에 있으면 그건 내용이 아니라 제목이다.
//   3장 미만인 곡엔 적용하지 않는다(짧은 후렴에서 제목=가사인 경우를 지우지 않도록).
//   후렴은 절과 번갈아 나오므로 "거의 모든 장"에 걸릴 수 없다 → 가사를 지울 위험이 없다.
// maxLoss가 헐거운 이유: 장당 2~3줄인 곡에서 제목 1줄을 빼면 그것만으로 33~50%가 준다.
// 25%로 조이면 정작 제목이 안 지워진다(실측 54곡 잔존). 이 규칙은 **파일명과 일치하는 줄**만
// 건드리므로 후렴을 통째로 지울 위험이 낮다 — 상한은 파국 방지용으로만 둔다.
export function dropTitleLines(pages, rawTitle, { ratio = 0.8, minPages = 3, sim = 0.75, maxLoss = 0.6 } = {}) {
  const tk = titleKey(rawTitle);
  if (tk.length < 6) return pages;
  const filled = pages.filter((p) => p.length);
  if (filled.length < minPages) return pages;
  const isTitle = (line) => {
    const b = bareKey(line);
    if (b.length < 5) return false;
    if (b === tk || tk.startsWith(b) || b.startsWith(tk)) return true;
    // 제목이 길고 줄이 그 일부일 수 있으니 같은 길이 구간과 비교한다.
    return similarity(b, tk) >= sim || similarity(b, tk.slice(0, b.length + 4)) >= sim;
  };
  const hits = filled.filter((p) => p.some(isTitle)).length;
  if (hits < Math.ceil(filled.length * ratio)) return pages;   // 일부 장에만 = 가사일 수 있다
  const out = pages.map((p) => p.filter((l) => !isTitle(l)));
  // 파일명이 곧 첫 가사 줄이고 그 줄이 후렴으로 되풀이되는 곡이 있다 → 손실이 크면 손대지 않는다.
  const before = pages.reduce((a, p) => a + p.length, 0);
  const after = out.reduce((a, p) => a + p.length, 0);
  if (before && after < before * (1 - maxLoss)) return pages;
  return out;
}

// 파일명과 무관하게 "거의 모든 장에 나오는 줄"을 제거한다.
// 노래는 한 줄이 모든 장에 나올 수 없다 — 그런 줄은 제목·워터마크 같은 고정 텍스트다.
// 파일명 비교(dropTitleLines)가 놓치는 경우를 여기서 잡는다: 파일명이 곧 첫 가사 줄인 곡,
// 파일명과 다르게 적힌 제목, OCR이 장마다 다르게 읽은 제목.
// OCR 편차를 견디려고 정확일치 대신 유사도로 묶고(≥0.8), 짧은 곡(4장 미만)은 건드리지 않는다
// (2~3장짜리 짧은 후렴에서는 한 줄이 모든 장에 나올 수 있다).
export function dropOmnipresentLines(pages, { ratio = 0.9, minPages = 4, sim = 0.8, maxLoss = 0.25 } = {}) {
  const filled = pages.filter((p) => p.length);
  if (filled.length < minPages) return pages;
  // 줄을 유사도로 묶어 "몇 개의 장에 나왔는지" 센다.
  const clusters = [];   // { key, pages:Set }
  pages.forEach((p, pi) => {
    for (const line of p) {
      const b = bareKey(line);
      if (b.length < 4) continue;
      const hit = clusters.find((c) => similarity(c.key, b) >= sim);
      if (hit) hit.pages.add(pi);
      else clusters.push({ key: b, pages: new Set([pi]) });
    }
  });
  const cut = Math.ceil(filled.length * ratio);
  const chrome = clusters.filter((c) => c.pages.size >= cut);
  if (!chrome.length) return pages;
  const out = pages.map((p) => p.filter((l) => {
    const b = bareKey(l);
    return !chrome.some((c) => similarity(c.key, b) >= sim);
  }));
  // 안전장치: 이 규칙으로 가사가 크게 줄면 그 "반복되는 줄"은 장식이 아니라 **핵심 후렴**이다.
  // (실측: "내 영이 주를 찬양합니다…" 18→10줄, "찬양하세 찬양하세…" 15→7줄처럼 같은 구절을
  //  계속 되풀이하는 곡이 있다. 제목이 남는 것보다 가사가 사라지는 게 훨씬 나쁜 실패다.)
  const before = pages.reduce((a, p) => a + p.length, 0);
  const after = out.reduce((a, p) => a + p.length, 0);
  if (before && after < before * (1 - maxLoss)) return pages;   // 손실이 크면 손대지 않는다
  return out;
}

// 한 곡의 pages를 정리한다(장식·기호 제거 → 파일명 제목 제거 → 빈 장 정돈).
//
// dropOmnipresentLines(파일명과 무관하게 모든 장에 나오는 줄 제거)는 **쓰지 않는다.**
// 실측: 제목 17곡을 지우려다 **50곡의 후렴을 지웠다**(예: 22→14줄, 15→7줄). 같은 구절을
// 계속 되풀이하는 찬양이 많아서, "텍스트가 모든 장에 반복된다"만으로는 제목과 후렴을
// 구분할 수 없다. 구분 가능한 신호는 **글자 크기**뿐이고 그건 OCR 좌표가 있는 추출 단계에만
// 있다 → lyricLines()의 bigRatio가 담당한다(반복 + 그 장에서 작은 글자 = 장식).
// 원칙: 제목이 몇 개 남는 것보다 가사가 사라지는 게 훨씬 나쁘다.
export function cleanSongPages(pages, rawTitle) {
  let out = (pages || []).map((p) => (p || []).map(stripLeadGlyph).filter((l) => l && hasWord(l)));
  out = dropTitleLines(out, rawTitle);      // 파일명 제목과 비슷한 줄이 거의 모든 장에 → 제거(손실 25% 상한)
  // 앞뒤의 빈 장은 떼고(표지·간지) 중간은 원본 구성이라 남긴다.
  while (out.length && !out[0].length) out.shift();
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

export function importSongs(db, data) {
  const songs = Array.isArray(data) ? data : (data.songs || []);
  const insS = db.prepare("INSERT OR REPLACE INTO songs (title,source,pages,conf) VALUES (?,?,?,?)");
  const insP = db.prepare("INSERT OR IGNORE INTO song_pages (song_id,page_no,text) VALUES (?,?,?)");
  const insF = db.prepare("INSERT INTO songs_fts (title,text,song_id) VALUES (?,?,?)");

  let pageCount = 0, lineCount = 0;
  const tx = db.transaction(() => {
    db.exec("DELETE FROM songs_fts; DELETE FROM song_pages; DELETE FROM songs;");
    for (const s of songs) {
      // OCR 뒤처리(기호 오인식·제목 박힘)를 적재 때도 한 번 더 — songs.json을 손으로
      // 고쳤거나 예전 형식이어도 DB에는 깨끗한 가사만 들어가게.
      const pages = cleanSongPages(s.pages, s.title).filter((p) => p.length);
      if (!pages.length) continue;                    // 가사를 못 읽은 곡은 넣지 않는다
      const title = cleanTitle(s.title);
      const r = insS.run(title, s.source ?? null, pages.length, s.conf ?? null);
      const songId = Number(r.lastInsertRowid);
      // 가사 본문도 NFC로 — 검색어와 같은 표기로 맞춰 둔다.
      pages.forEach((lines, i) => {
        insP.run(songId, i + 1, lines.map((l) => l.normalize("NFC")).join("\n"));
        pageCount++;
        lineCount += lines.length;
      });
      // 검색은 제목 + 전체 가사로 (곡을 찾는 게 목적이므로 장 단위로 쪼개지 않는다)
      insF.run(title, pages.flat().map((l) => l.normalize("NFC")).join("\n"), songId);
    }
  });
  tx();
  return { songs: db.query("SELECT count(*) n FROM songs").get().n, pages: pageCount, lines: lineCount };
}
