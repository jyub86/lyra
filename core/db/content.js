// Content queries: 성경 / 찬송가 / 교독문.
// Pure read helpers over the content tables. Used by search.tools.js and
// content.tools.js. Correct even before seeding (just returns empty).

// Build a safe FTS5 MATCH string: AND of quoted tokens (last gets a prefix *).
function ftsQuery(q) {
  const toks = String(q || "").trim().split(/\s+/).filter(Boolean)
    .map((t) => t.replace(/"/g, '""'));
  if (toks.length === 0) return null;
  return toks.map((t, i) => (i === toks.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
}

// ---------- 성경 ----------

// Resolve a book name/short-name/alias → book_order. Throws if unknown.
export function resolveBook(db, name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("book name required");
  const direct = db.query(
    "SELECT book_order FROM bible_books WHERE name = ? OR short_name = ? LIMIT 1"
  ).get(n, n);
  if (direct) return direct.book_order;
  const alias = db.query("SELECT book_order FROM bible_aliases WHERE alias = ? LIMIT 1").get(n);
  if (alias) return alias.book_order;
  throw new Error(`unknown bible book: ${name}`);
}

export function getBookInfo(db, bookOrder) {
  return db.query("SELECT book_order, name, short_name, testament FROM bible_books WHERE book_order = ?").get(bookOrder);
}

export function listBibleBooks(db) {
  return db.query("SELECT book_order, name, short_name, testament, chapter_count FROM bible_books ORDER BY book_order").all();
}

export function queryVerses(db, bookOrder, chapter, vStart, vEnd) {
  return db.query(
    `SELECT verse, text FROM bible_verses
      WHERE book_order = ? AND chapter = ? AND verse BETWEEN ? AND ?
      ORDER BY verse`
  ).all(bookOrder, chapter, vStart, vEnd);
}

// High-level: resolve book + fetch verses + attach display name.
export function getBiblePassage(db, book, chapter, vStart, vEnd) {
  const bookOrder = resolveBook(db, book);
  const info = getBookInfo(db, bookOrder);
  const verses = queryVerses(db, bookOrder, chapter, vStart, vEnd);
  return { book_order: bookOrder, book_name: info?.name, short_name: info?.short_name, chapter, verses };
}

export function searchBible(db, query, limit = 20) {
  const m = ftsQuery(query);
  if (!m) return [];
  return db.query(
    `SELECT book_order, chapter, verse, text FROM bible_fts
      WHERE bible_fts MATCH ? ORDER BY rank LIMIT ?`
  ).all(m, limit);
}

// ---------- 찬송가 ----------

export function getHymn(db, number) {
  const hymn = db.query("SELECT number, title, category FROM hymns WHERE number = ?").get(number);
  if (!hymn) return null;
  const rows = db.query(
    "SELECT verse_no, label, text FROM hymn_verses WHERE hymn_number = ? ORDER BY verse_no"
  ).all(number);
  // verse_no=0 = 후렴(별도). 나머지가 절.
  const refrainRow = rows.find((v) => v.verse_no === 0);
  const verses = rows.filter((v) => v.verse_no !== 0).map((v) => ({ verse_no: v.verse_no, label: v.label, lines: v.text.split("\n") }));
  const refrain = refrainRow ? refrainRow.text.split("\n") : null;
  return { ...hymn, verses, refrain };
}

export function searchHymn(db, query, limit = 20) {
  const m = ftsQuery(query);
  if (!m) return [];
  return db.query(
    `SELECT number, title FROM hymns_fts WHERE hymns_fts MATCH ? ORDER BY rank LIMIT ?`
  ).all(m, limit);
}

// ---------- 찬양 가사 ----------
// 기존 찬양 PPT 모음에서 추출한 가사. pages = 원본 PPT의 슬라이드 나눔 그대로.

export function getSong(db, id) {
  const song = db.query("SELECT id, title, source, pages, conf FROM songs WHERE id = ?").get(id);
  if (!song) return null;
  const rows = db.query("SELECT page_no, text FROM song_pages WHERE song_id = ? ORDER BY page_no").all(id);
  return { ...song, lyrics: rows.map((r) => r.text.split("\n")) };
}

export function searchSong(db, query, limit = 20) {
  const m = ftsQuery(query);
  if (!m) return [];
  return db.query(
    `SELECT song_id FROM songs_fts WHERE songs_fts MATCH ? ORDER BY rank LIMIT ?`
  ).all(m, limit).map((r) => {
    const meta = db.query("SELECT id, title, pages, conf FROM songs WHERE id = ?").get(r.song_id);
    return meta || { id: r.song_id };
  }).filter(Boolean);
}

export function listSongs(db, limit = 500, offset = 0) {
  return db.query("SELECT id, title, pages, conf FROM songs ORDER BY title LIMIT ? OFFSET ?").all(limit, offset);
}

// ---------- 교독문 ----------

export function getReading(db, number) {
  const reading = db.query("SELECT number, title FROM responsive_readings WHERE number = ?").get(number);
  if (!reading) return null;
  const segments = db.query(
    "SELECT position, role, text FROM reading_segments WHERE reading_number = ? ORDER BY position"
  ).all(number);
  return { ...reading, segments };
}

export function searchReading(db, query, limit = 20) {
  const m = ftsQuery(query);
  if (!m) return [];
  return db.query(
    `SELECT DISTINCT reading_number FROM readings_fts WHERE readings_fts MATCH ? LIMIT ?`
  ).all(m, limit).map((r) => {
    const meta = db.query("SELECT number, title FROM responsive_readings WHERE number = ?").get(r.reading_number);
    return meta || { number: r.reading_number };
  });
}
