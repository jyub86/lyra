// 찬양 가사 관리 도구 — 편집기에서 곡을 직접 고치고 추가·삭제한다.
//
// 왜 DB와 파일을 같이 쓰는가: data/source/songs.json이 원본(사람이 손으로 고쳐도 되는 파일)이고
// DB는 그걸 적재한 결과다. UI에서 DB만 고치면 `bun run core/db/seed/index.js --songs`를 돌리는
// 순간 편집이 사라진다. 그래서 여기서는 **DB와 songs.json을 함께** 갱신한다.
//
// 가사 형식은 "빈 줄 = 장 구분" 텍스트로 주고받는다 — 찬양 가사 복사·붙여넣기와 같은 형식이라
// 사용자가 보는 것과 저장되는 것이 일치한다.
import { register } from "./registry.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTitle } from "../db/seed/import-songs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SONGS_JSON = join(ROOT, "data/source/songs.json");

// "빈 줄 = 장 구분" 텍스트 → [[줄,...], ...]
export function parseLyrics(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((block) => block.split("\n").map((l) => l.trim().normalize("NFC")).filter(Boolean))
    .filter((b) => b.length);
}
const formatLyrics = (pages) => (pages || []).map((p) => p.join("\n")).join("\n\n");

function readFile() {
  if (!existsSync(SONGS_JSON)) {
    return { format: "lyra-songs/v1", note: "편집기에서 만든 가사 모음", songs: [], failed: [] };
  }
  try { return JSON.parse(readFileSync(SONGS_JSON, "utf8")); }
  catch { throw new Error("songs.json을 읽지 못했습니다(형식 오류). 파일을 확인해 주세요."); }
}
function writeFile(data) {
  mkdirSync(dirname(SONGS_JSON), { recursive: true });
  writeFileSync(SONGS_JSON, JSON.stringify(data, null, 2));
}

// DB의 한 곡을 songs.json에서 찾는다. 제목이 유일한 연결고리라 정리된 제목으로 맞춘다
// (파일의 title은 파일명 원본이라 cleanTitle을 거쳐야 DB 제목과 같아진다).
const keyOf = (t) => cleanTitle(t).normalize("NFC");

function syncFile(mutate) {
  const data = readFile();
  data.songs = Array.isArray(data.songs) ? data.songs : [];
  mutate(data);
  writeFile(data);
}

// DB 한 곡 쓰기(있으면 갱신, 없으면 추가). pages는 정리 없이 **그대로** 저장한다 —
// 사용자가 직접 손본 가사에 자동 정리를 또 걸면 의도가 뭉개진다.
function writeSong(db, { song_id, title, pages, source = null, conf = null }) {
  const insP = db.prepare("INSERT INTO song_pages (song_id,page_no,text) VALUES (?,?,?)");
  let id = song_id;
  const tx = db.transaction(() => {
    if (id) {
      const cur = db.query("SELECT id FROM songs WHERE id = ?").get(id);
      if (!cur) throw new Error(`unknown song: ${id}`);
      db.query("UPDATE songs SET title = ?, pages = ? WHERE id = ?").run(title, pages.length, id);
      db.query("DELETE FROM song_pages WHERE song_id = ?").run(id);
    } else {
      const r = db.query("INSERT INTO songs (title,source,pages,conf) VALUES (?,?,?,?)")
        .run(title, source, pages.length, conf);
      id = Number(r.lastInsertRowid);
    }
    pages.forEach((lines, i) => insP.run(id, i + 1, lines.join("\n")));
    db.query("DELETE FROM songs_fts WHERE song_id = ?").run(id);
    db.query("INSERT INTO songs_fts (title,text,song_id) VALUES (?,?,?)")
      .run(title, pages.flat().join("\n"), id);
  });
  tx();
  return id;
}

register({
  name: "save_song",
  description: "찬양 가사를 저장한다. song_id를 주면 수정, 없으면 새 곡 추가. " +
    "lyrics는 '빈 줄 = 장 구분' 텍스트(찬양 가사 복사와 같은 형식). " +
    "DB와 원본 파일(data/source/songs.json)을 함께 갱신하므로 재적재해도 편집이 유지된다.",
  input_schema: {
    type: "object",
    properties: {
      song_id: { type: "integer", description: "수정할 곡 id (없으면 새 곡)" },
      title: { type: "string" },
      lyrics: { type: "string", description: "가사. 빈 줄로 장을 나눈다" },
    },
    required: ["title", "lyrics"],
  },
  handler: ({ song_id, title, lyrics }, { db }) => {
    const name = String(title).trim().normalize("NFC");
    if (!name) throw new Error("제목이 필요합니다");
    const pages = parseLyrics(lyrics);
    if (!pages.length) throw new Error("가사가 비어 있습니다");

    const prev = song_id ? db.query("SELECT title, source, conf FROM songs WHERE id = ?").get(song_id) : null;
    if (song_id && !prev) throw new Error(`unknown song: ${song_id}`);
    const id = writeSong(db, { song_id, title: name, pages, source: prev?.source ?? null, conf: prev?.conf ?? null });

    // 원본 파일도 맞춘다. 제목이 바뀌었으면 옛 제목으로 찾아 갱신한다.
    syncFile((data) => {
      const oldKey = prev ? keyOf(prev.title) : null;
      const hit = data.songs.find((s) => keyOf(s.title) === (oldKey ?? keyOf(name)));
      const body = {
        title: name, source: prev?.source ?? null, ext: null,
        slides: pages.length, pages,
        lines: pages.flat().length, chars: pages.flat().reduce((a, l) => a + l.length, 0),
        conf: prev?.conf ?? null, edited: true,
      };
      if (hit) Object.assign(hit, body); else data.songs.push(body);
      data.songs.sort((a, b) => String(a.title).localeCompare(String(b.title), "ko"));
    });
    return { song_id: id, title: name, pages: pages.length, lines: pages.flat().length };
  },
});

register({
  name: "delete_song",
  description: "찬양 가사를 목록에서 삭제한다(DB + 원본 파일). 원본 PPT 파일은 건드리지 않는다.",
  input_schema: {
    type: "object",
    properties: { song_id: { type: "integer" } },
    required: ["song_id"],
  },
  handler: ({ song_id }, { db }) => {
    const s = db.query("SELECT title FROM songs WHERE id = ?").get(song_id);
    if (!s) throw new Error(`unknown song: ${song_id}`);
    const tx = db.transaction(() => {
      db.query("DELETE FROM songs_fts WHERE song_id = ?").run(song_id);
      db.query("DELETE FROM song_pages WHERE song_id = ?").run(song_id);
      db.query("DELETE FROM songs WHERE id = ?").run(song_id);
    });
    tx();
    const key = keyOf(s.title);
    syncFile((data) => { data.songs = data.songs.filter((x) => keyOf(x.title) !== key); });
    return { ok: true, title: s.title };
  },
});

register({
  name: "get_song_text",
  description: "찬양 가사를 '빈 줄 = 장 구분' 텍스트로 반환한다(편집·복사용).",
  read: true,
  input_schema: {
    type: "object",
    properties: { song_id: { type: "integer" } },
    required: ["song_id"],
  },
  handler: ({ song_id }, { db }) => {
    const s = db.query("SELECT id, title, pages, conf FROM songs WHERE id = ?").get(song_id);
    if (!s) throw new Error(`unknown song: ${song_id}`);
    const rows = db.query("SELECT text FROM song_pages WHERE song_id = ? ORDER BY page_no").all(song_id);
    return { ...s, text: formatLyrics(rows.map((r) => r.text.split("\n"))) };
  },
});
