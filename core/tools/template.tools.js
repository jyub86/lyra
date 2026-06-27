// Unified templates (v4) — a template is an element arrangement:
//   spec = { background, elements:[...] }
// Built-in slide kinds carry content elements (bible/hymn/reading) and/or text
// elements with `bind:"<param>"`. apply_template fills binds, fetches content from
// params, and AUTO-SPLITS long content/lyrics into N slides (each reusing the
// template design). Editing a built-in keeps the element layout/style (content
// snapshot stripped — content stays param-driven). Custom templates = a saved
// slide design, inserted as-is.
import { register, get } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { insertSlide } from "./slide.tools.js";
import { touchService } from "./_helpers.js";
import { BUILTIN_IDS, seedBuiltins } from "../templates/builtins.js";
import { getBiblePassage, getHymn, getReading } from "../db/content.js";
import { splitBible, splitHymn, splitReading } from "../splitter.js";

const CONTENT_TYPES = new Set(["bible", "hymn", "reading"]);

// Fetch + split a content element's data into per-slide chunks { params, content }.
function contentChunks(db, type, params) {
  if (type === "bible") {
    const p = getBiblePassage(db, params.book, params.chapter, params.verse_start, params.verse_end);
    if (!p.verses.length) throw new Error(`본문 없음: ${params.book} ${params.chapter}:${params.verse_start}-${params.verse_end}`);
    const pages = splitBible(p.verses, params.layout || "auto", { book_name: p.book_name, short_name: p.short_name, chapter: params.chapter });
    return pages.map((pg) => ({
      params: { book: params.book, chapter: params.chapter, verse_start: pg.verses[0].verse, verse_end: pg.verses[pg.verses.length - 1].verse, layout: params.layout || "auto" },
      content: { ref: pg.ref, verses: pg.verses },
    }));
  }
  if (type === "hymn") {
    const hymn = getHymn(db, params.number);
    if (!hymn) throw new Error(`찬송가 없음: ${params.number}`);
    return splitHymn(hymn, params.verse_nos, params.lines_per_slide || 4).map((pg) => ({
      params: { number: hymn.number }, content: { number: pg.number, title: pg.title, label: pg.label, lines: pg.lines },
    }));
  }
  if (type === "reading") {
    const reading = getReading(db, params.number);
    if (!reading) throw new Error(`교독문 없음: ${params.number}`);
    return splitReading(reading, params.segments_per_slide || 2).map((pg) => ({
      params: { number: reading.number }, content: { number: pg.number, title: pg.title, segments: pg.segments },
    }));
  }
  return [];
}

// text element bound to a param → fill its text from params
function fillElement(el, params) {
  const e = { ...el };
  if (e.type === "text" && e.bind) {
    const v = params[e.bind];
    e.text = Array.isArray(v) ? v.join("\n") : v != null ? String(v) : e.text ?? "";
  }
  return e;
}

// Produce the slide(s) for applying a template with params (handles splitting).
function buildSlidesFromTemplate(db, spec, params) {
  const els = spec.elements || [];
  const bg = spec.background ?? null;

  const contentEl = els.find((e) => CONTENT_TYPES.has(e.type));
  if (contentEl) {
    const chunks = contentChunks(db, contentEl.type, params);
    if (!chunks.length) throw new Error("콘텐츠를 가져오지 못했습니다");
    return chunks.map((chunk) => ({
      background: bg,
      elements: els.map((e) => (e === contentEl ? { ...e, params: chunk.params, content: chunk.content } : fillElement(e, params))),
    }));
  }

  // lyrics text splits by lines_per_slide
  const lyricsEl = els.find((e) => e.type === "text" && e.bind === "lyrics");
  if (lyricsEl && params.lyrics) {
    const lines = String(params.lyrics).split("\n").map((s) => s.trim()).filter(Boolean);
    const per = params.lines_per_slide || 2;
    const chunks = [];
    for (let i = 0; i < lines.length; i += per) chunks.push(lines.slice(i, i + per).join("\n"));
    if (!chunks.length) chunks.push("");
    return chunks.map((text) => ({
      background: bg,
      elements: els.map((e) => (e === lyricsEl ? { ...e, text } : fillElement(e, params))),
    }));
  }

  return [{ background: bg, elements: els.map((e) => fillElement(e, params)) }];
}

// strip content snapshots from content elements when saving a built-in design
function stripForTemplate(elements) {
  return (elements || []).map((e) => {
    if (CONTENT_TYPES.has(e.type)) { const { content, params, ...rest } = e; return rest; }
    return e;
  });
}

register({
  name: "list_templates",
  description: "모든 템플릿(기본 슬라이드 종류 + 커스텀 디자인)을 반환한다. 기본 종류가 먼저.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) =>
    db.query("SELECT id, name, kind, produces, params_schema FROM templates ORDER BY kind, rowid").all()
      .map((t) => ({ ...t, params_schema: JSON.parse(t.params_schema) })),
});

register({
  name: "get_template",
  description: "템플릿 하나를 params_schema·spec(요소 배치)까지 포함해 반환한다.",
  read: true,
  input_schema: { type: "object", properties: { template_id: { type: "string" } }, required: ["template_id"] },
  handler: ({ template_id }, { db }) => {
    const t = db.query("SELECT * FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    return { ...t, params_schema: JSON.parse(t.params_schema), spec: JSON.parse(t.spec) };
  },
});

register({
  name: "save_template",
  description: "슬라이드 디자인(background + elements)을 새 커스텀 디자인 템플릿으로 저장한다.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string" }, slide: { type: "object", description: "{ background?, elements }" }, description: { type: "string", default: "" } },
    required: ["name", "slide"],
  },
  handler: ({ name, slide, description }, { db }) => {
    const id = ulid();
    db.query(`INSERT INTO templates (id,name,description,kind,produces,params_schema,spec) VALUES (?,?,?,'custom','slides','{}',?)`)
      .run(id, name, description || "", JSON.stringify({ background: slide.background ?? null, elements: slide.elements ?? [] }));
    return { template_id: id };
  },
});

register({
  name: "apply_template",
  description: "템플릿에서 슬라이드를 예배 순서에 추가한다. 기본 종류는 params(책·장·절, 제목 등)로 내용을 채우고 긴 내용은 자동 분할된다.",
  input_schema: {
    type: "object",
    properties: {
      template_id: { type: "string" },
      service_id: { type: "string" },
      params: { type: "object" },
      position: { type: "integer" },
    },
    required: ["template_id", "service_id"],
  },
  handler: async ({ template_id, service_id, params, position }, { db }) => {
    const t = db.query("SELECT kind, spec FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) throw new Error(`unknown service: ${service_id}`);
    const spec = JSON.parse(t.spec);
    const toAdd = t.kind === "custom"
      ? [{ background: spec.background ?? null, elements: (spec.elements || []).map((e) => ({ ...e })) }]
      : buildSlidesFromTemplate(db, spec, params || {});
    const ids = [];
    const tx = db.transaction(() => {
      let pos = position;
      for (const s of toAdd) { ids.push(insertSlide(db, service_id, s, pos)); if (pos != null) pos += 1; }
      touchService(db, service_id);
    });
    tx();
    return { slide_ids: ids };
  },
});

register({
  name: "update_template",
  description: "템플릿 수정. 기본 종류는 디자인(요소 배치·스타일)만 저장(내용 스냅샷 제거), 커스텀은 전체. reset=true면 기본 종류 초기화.",
  input_schema: {
    type: "object",
    properties: { template_id: { type: "string" }, name: { type: "string" }, slide: { type: "object" }, reset: { type: "boolean" } },
    required: ["template_id"],
  },
  handler: ({ template_id, name, slide, reset }, { db }) => {
    const t = db.query("SELECT kind FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (name !== undefined) db.query("UPDATE templates SET name = ? WHERE id = ?").run(name, template_id);
    if (reset && t.kind === "builtin") {
      db.query("DELETE FROM templates WHERE id = ?").run(template_id);
      seedBuiltins(db, get); // restores default layout
    } else if (slide !== undefined) {
      const spec = t.kind === "builtin"
        ? { background: slide.background ?? null, elements: stripForTemplate(slide.elements) }
        : { background: slide.background ?? null, elements: slide.elements ?? [] };
      db.query("UPDATE templates SET spec = ? WHERE id = ?").run(JSON.stringify(spec), template_id);
    }
    return { ok: true };
  },
});

register({
  name: "delete_template",
  description: "커스텀 디자인 템플릿을 삭제한다. 기본 슬라이드 종류는 삭제 불가(초기화만 가능).",
  input_schema: { type: "object", properties: { template_id: { type: "string" } }, required: ["template_id"] },
  handler: ({ template_id }, { db }) => {
    if (BUILTIN_IDS.has(template_id)) throw new Error("기본 슬라이드 종류는 삭제할 수 없습니다 (초기화만 가능).");
    db.query("DELETE FROM templates WHERE id = ?").run(template_id);
    return { ok: true };
  },
});
