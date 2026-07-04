// PPT 라이브러리 — 지정 폴더(재귀)에서 파일명+내용으로 검색해 가져오기 (design v4.2).
// 폴더를 한 번 색인(library_index 캐시, mtime 증분)하고 부분 문자열로 검색.
// 결과 가져오기는 기존 import_pdf(service_id, path) 재사용.
import { register } from "./registry.js";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { extractText, SUPPORTED_EXT } from "../lib/ppt-extract.js";
import { nowIso } from "./_helpers.js";

function getSetting(db, key) {
  return db.query("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}
function setSetting(db, key, value) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// Recursively collect supported files under `dir` (skips dotfiles/dirs).
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SUPPORTED_EXT.has(extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

register({
  name: "get_library_dir",
  description: "지정된 PPT 라이브러리 폴더 경로와 색인된 파일 수를 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) => ({
    library_dir: getSetting(db, "library_dir"),
    indexed: db.query("SELECT COUNT(*) n FROM library_index").get().n,
  }),
});

register({
  name: "set_library_dir",
  description: "PPT 라이브러리 폴더(서버 절대경로)를 설정한다. 이후 index_library로 색인한다.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "폴더 절대경로" } },
    required: ["path"],
  },
  handler: ({ path }, { db }) => {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`폴더가 없습니다: ${path}`);
    setSetting(db, "library_dir", path);
    return { ok: true, library_dir: path };
  },
});

register({
  name: "index_library",
  description: "라이브러리 폴더를 재귀 탐색해 PPT/PDF를 색인한다(파일명+내용). 변경된 파일만 다시 추출한다.",
  input_schema: {
    type: "object",
    properties: { refresh: { type: "boolean", default: false, description: "true면 강제 재색인" } },
  },
  handler: ({ refresh }, { db }) => {
    const dir = getSetting(db, "library_dir");
    if (!dir) throw new Error("라이브러리 폴더가 설정되지 않았습니다 (set_library_dir).");
    if (!existsSync(dir)) throw new Error(`라이브러리 폴더가 없습니다: ${dir}`);

    // Always walk; extract new/changed files (or all, if refresh forces re-extract).
    const files = walk(dir);
    const seen = new Set(files);
    const prior = new Map(db.query("SELECT path, mtime FROM library_index").all().map((r) => [r.path, r.mtime]));
    const up = db.query(
      `INSERT INTO library_index (path,name,relpath,ext,size,mtime,pages,text,indexed_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET name=excluded.name,relpath=excluded.relpath,ext=excluded.ext,
         size=excluded.size,mtime=excluded.mtime,pages=excluded.pages,text=excluded.text,indexed_at=excluded.indexed_at`
    );
    let added = 0, updated = 0, skipped = 0;
    const ts = nowIso();
    for (const f of files) {
      const st = statSync(f);
      const mtime = Math.floor(st.mtimeMs);
      const had = prior.has(f);
      if (!refresh && had && prior.get(f) === mtime) { skipped++; continue; }
      const { text, pages } = extractText(f);
      up.run(f, basename(f), relative(dir, f), extname(f).toLowerCase(), st.size, mtime, pages, text, ts);
      had ? updated++ : added++;
    }
    // remove entries for files that disappeared
    let removed = 0;
    for (const p of prior.keys()) if (!seen.has(p)) { db.query("DELETE FROM library_index WHERE path = ?").run(p); removed++; }
    return { files: files.length, added, updated, removed, skipped };
  },
});

register({
  name: "search_library",
  description: "색인된 라이브러리에서 파일명·내용을 부분 문자열로 검색한다. 결과에 매치 스니펫 포함.",
  read: true,
  input_schema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", default: 40 } },
    required: ["query"],
  },
  handler: ({ query, limit }, { db }) => {
    // 띄어쓰기로 나눈 각 단어를 모두 포함(AND). 각 단어는 파일명 또는 내용 어디든.
    const terms = String(query || "").trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return { results: [] };
    const esc = (t) => `%${t.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const clause = terms.map(() => "(name LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')").join(" AND ");
    const args = terms.flatMap((t) => [esc(t), esc(t)]);
    const rows = db.query(
      `SELECT path,name,relpath,ext,pages,text FROM library_index WHERE ${clause} ORDER BY name LIMIT ?`
    ).all(...args, limit);

    const lterms = terms.map((t) => t.toLowerCase());
    const results = rows.map((r) => {
      const lname = r.name.toLowerCase(), ltext = (r.text || "").toLowerCase();
      const inName = lterms.every((t) => lname.includes(t));
      let snippet = "";
      if (!inName && r.text) {
        // 내용에서 처음 걸린 단어 주변을 스니펫으로
        let best = -1, blen = 0;
        for (const t of lterms) { const i = ltext.indexOf(t); if (i >= 0 && (best < 0 || i < best)) { best = i; blen = t.length; } }
        if (best >= 0) { const s = Math.max(0, best - 30); snippet = (s > 0 ? "…" : "") + r.text.slice(s, best + blen + 40).trim() + "…"; }
      }
      return { path: r.path, name: r.name, relpath: r.relpath, ext: r.ext, pages: r.pages, matched_in: inName ? "name" : "content", snippet };
    });
    return { results };
  },
});
