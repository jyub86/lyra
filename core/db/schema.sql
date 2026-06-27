-- Sunday Worship PPT — SQLite schema (design §4)
-- Single local file DB. Content (bible/hymns/readings) + Service > Slide (flat) hierarchy.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- =====================================================================
-- CONTENT: 성경 (Bible)
-- =====================================================================
CREATE TABLE IF NOT EXISTS bible_books (
  book_order    INTEGER PRIMARY KEY,   -- 1..66
  name          TEXT NOT NULL,         -- "창세기"
  short_name    TEXT,                  -- "창"
  testament     TEXT,                  -- "old" | "new"
  chapter_count INTEGER
);

-- 책 별칭/약칭 → book_order (예: "요", "요한복음", "요복")
CREATE TABLE IF NOT EXISTS bible_aliases (
  alias      TEXT PRIMARY KEY,
  book_order INTEGER NOT NULL REFERENCES bible_books(book_order) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bible_verses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_order INTEGER NOT NULL REFERENCES bible_books(book_order) ON DELETE CASCADE,
  chapter    INTEGER NOT NULL,
  verse      INTEGER NOT NULL,         -- int 절번호 (v1 호환)
  text       TEXT NOT NULL,
  UNIQUE (book_order, chapter, verse)
);
CREATE INDEX IF NOT EXISTS idx_verses_loc ON bible_verses(book_order, chapter, verse);

-- 전문 검색 (search_bible). 표시에 필요한 위치를 UNINDEXED로 보관.
CREATE VIRTUAL TABLE IF NOT EXISTS bible_fts USING fts5(
  text,
  book_order UNINDEXED,
  chapter    UNINDEXED,
  verse      UNINDEXED,
  tokenize = 'unicode61'
);

-- =====================================================================
-- CONTENT: 찬송가 (Hymns)
-- =====================================================================
CREATE TABLE IF NOT EXISTS hymns (
  number   INTEGER PRIMARY KEY,        -- 찬송가 번호
  title    TEXT NOT NULL,
  category TEXT                        -- 주제/분류 (있으면)
);

CREATE TABLE IF NOT EXISTS hymn_verses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hymn_number INTEGER NOT NULL REFERENCES hymns(number) ON DELETE CASCADE,
  verse_no    INTEGER NOT NULL,        -- 1,2,3...  (후렴은 0 또는 약속된 값)
  label       TEXT,                    -- "1절" | "후렴" 등 표시 라벨
  text        TEXT NOT NULL,           -- 줄바꿈(\n)으로 구분된 가사 줄
  UNIQUE (hymn_number, verse_no)
);
CREATE INDEX IF NOT EXISTS idx_hymn_verses ON hymn_verses(hymn_number, verse_no);

CREATE VIRTUAL TABLE IF NOT EXISTS hymns_fts USING fts5(
  title, text,
  number UNINDEXED,
  tokenize = 'unicode61'
);

-- =====================================================================
-- CONTENT: 교독문 (Responsive readings)
-- =====================================================================
CREATE TABLE IF NOT EXISTS responsive_readings (
  number INTEGER PRIMARY KEY,          -- 교독문 번호
  title  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_segments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reading_number INTEGER NOT NULL REFERENCES responsive_readings(number) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  role           TEXT NOT NULL,        -- "leader" | "congregation" | "unison"
  text           TEXT NOT NULL,
  UNIQUE (reading_number, position)
);
CREATE INDEX IF NOT EXISTS idx_reading_segments ON reading_segments(reading_number, position);

CREATE VIRTUAL TABLE IF NOT EXISTS readings_fts USING fts5(
  text,
  reading_number UNINDEXED,
  tokenize = 'unicode61'
);

-- =====================================================================
-- HIERARCHY: Service(예배 순서 전체) > Slide  (평면 — Scene 계층 없음)
-- 한 Service = 한 예배의 순서 전체이며, 이 단위가 공유(export/import)된다.
-- =====================================================================
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,       -- ulid
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,
  worship_part TEXT NOT NULL,          -- "1부" | "2부" | "연합"
  theme_id     TEXT NOT NULL DEFAULT 'dark-blue',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- v4: 슬라이드 = background + elements(요소 캔버스). 타입/typed-data 제거.
CREATE TABLE IF NOT EXISTS slides (
  id          TEXT PRIMARY KEY,        -- ulid
  service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,        -- 예배 순서 내 슬라이드 순번 (연속)
  background  TEXT,                    -- JSON (null = 테마 기본)
  elements    TEXT NOT NULL DEFAULT '[]', -- JSON 배열: text/shape/image + bible/hymn/reading 콘텐츠 요소
  transition  TEXT DEFAULT 'fade'
);
CREATE INDEX IF NOT EXISTS idx_slides_service ON slides(service_id, position);

-- =====================================================================
-- Templates
-- =====================================================================
CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- "builtin" | "custom"
  produces      TEXT NOT NULL,         -- "slides" | "service"
  params_schema TEXT NOT NULL,         -- JSON Schema
  spec          TEXT NOT NULL          -- builtin handler ref 또는 declarative blueprint
);

-- =====================================================================
-- Custom themes
-- =====================================================================
CREATE TABLE IF NOT EXISTS custom_themes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_theme TEXT NOT NULL,
  overrides  TEXT NOT NULL             -- JSON
);
