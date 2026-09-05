// Unified templates (v4) — a template is an element arrangement:
//   spec = { background, elements:[...] }
// Built-in slide kinds carry content elements (bible/hymn/reading) and/or text
// elements with `bind:"<param>"`. apply_template fills binds, fetches content from
// params, and AUTO-SPLITS long content/lyrics into N slides (each reusing the
// template design). Editing a built-in keeps the element layout/style (content
// snapshot stripped — content stays param-driven). 커스텀 템플릿도 bind/콘텐츠 요소가
// 있으면(= save_template이 params_schema를 뽑아낸 경우) 같은 생성·분할 경로를 탄다
// → "내가 꾸민 가사 디자인"을 매주 가사만 넣어 재사용할 수 있다.
import { register, get } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { insertSlide } from "./slide.tools.js";
import { touchService, serviceIdForSlide, parseSlide } from "./_helpers.js";
import { BUILTIN_IDS, seedBuiltins, paramsFromTool } from "../templates/builtins.js";
import { getBiblePassage, getHymn, getReading } from "../db/content.js";
import { splitBible, splitHymn, splitReading, bibleAutoCapacity } from "../splitter.js";

const CONTENT_TYPES = new Set(["bible", "hymn", "reading"]);
const CONTENT_TOOL = { bible: "add_bible_slides", hymn: "add_hymn_slides", reading: "add_reading_slides" };

// 서식(디자인)으로 취급하는 필드 — 내용은 건드리지 않고 이것만 덮어쓴다.
export const STYLE_FIELDS = ["font", "size", "color", "align", "valign", "weight",
  "line_height", "x", "y", "w", "h", "opacity"];

// 본문(가사·성경 본문 등)을 그리는 요소인지. style은 본문에만 적용한다 —
// 제목·참조처럼 부속 요소까지 같이 키우면 배치가 무너진다.
const BODY_FIELDS = new Set(["all", "text", "body", "lyrics"]);
const BODY_BINDS = new Set(["lyrics", "items"]);
function styleTargets(els) {
  const body = (els || []).filter((e) =>
    (CONTENT_TYPES.has(e.type) && (!e.field || BODY_FIELDS.has(e.field))) ||
    (e.type === "text" && BODY_BINDS.has(e.bind)));
  if (body.length) return new Set(body);
  // 본문이라 할 만한 게 없으면(타이틀·구분 등) params로 채워지는 텍스트 전부에 적용.
  return new Set((els || []).filter((e) => e.type === "text" && e.bind));
}

function withStyle(el, style) {
  if (!style) return el;
  const out = { ...el };
  for (const k of STYLE_FIELDS) if (style[k] !== undefined && style[k] !== null) out[k] = style[k];
  return out;
}

// 슬라이드 요소에서 "무엇을 입력받아야 하는지"를 뽑는다(커스텀 템플릿용).
// bind된 텍스트 → 그 이름의 문자열 파라미터(lyrics면 줄 수까지),
// 콘텐츠 요소(bible/hymn/reading) → 해당 콘텐츠 도구의 입력 스키마.
// 이게 있어야 커스텀 템플릿도 "가사만 넣으면 여러 장 생성"이 된다.
export function deriveParamsSchema(elements) {
  const contentEl = (elements || []).find((e) => CONTENT_TYPES.has(e.type));
  if (contentEl) return paramsFromTool(get(CONTENT_TOOL[contentEl.type])?.input_schema);
  const properties = {};
  const required = [];
  for (const e of elements || []) {
    if (e.type !== "text" || !e.bind) continue;
    properties[e.bind] = { type: "string" };
    if (!required.includes(e.bind)) required.push(e.bind);
    if (e.bind === "lyrics") properties.lines_per_slide = { type: "integer", default: 2 };
  }
  return Object.keys(properties).length
    ? { type: "object", properties, required }
    : { type: "object", properties: {} };
}

const PLACEHOLDER = { lyrics: "가사", items: "항목", title: "제목", subtitle: "부제", label: "구분" };

// Fetch + split a content element's data into per-slide chunks { params, content }.
// bodyEl = 본문을 그리는 요소(있으면 그 박스·글자 크기로 auto 분할량을 정한다).
function contentChunks(db, type, params, bodyEl) {
  if (type === "bible") {
    const p = getBiblePassage(db, params.book, params.chapter, params.verse_start, params.verse_end);
    if (!p.verses.length) throw new Error(`본문 없음: ${params.book} ${params.chapter}:${params.verse_start}-${params.verse_end}`);
    const pages = splitBible(p.verses, params.layout || "auto",
      { book_name: p.book_name, short_name: p.short_name, chapter: params.chapter },
      bibleAutoCapacity(bodyEl));
    return pages.map((pg) => ({
      params: { book: params.book, chapter: params.chapter, verse_start: pg.verses[0].verse, verse_end: pg.verses[pg.verses.length - 1].verse, layout: params.layout || "auto" },
      content: { ref: pg.ref, verses: pg.verses },
    }));
  }
  if (type === "hymn") {
    const hymn = getHymn(db, params.number);
    if (!hymn) throw new Error(`찬송가 없음: ${params.number}`);
    // verse_no(0=후렴)를 params에 남겨, 편집기에서 다시 가져와도 같은 절/후렴이 유지되게 한다.
    return splitHymn(hymn, params.verse_nos, params.lines_per_slide || 4).map((pg) => ({
      params: { number: hymn.number, verse_no: pg.verse_no },
      content: { number: pg.number, title: pg.title, label: pg.label, lines: pg.lines },
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
// style = 이번에 추가하는 슬라이드에만 적용할 서식 덮어쓰기(곡마다 글꼴·크기·위치를
// 다르게 하고 싶을 때). 템플릿 자체는 바뀌지 않는다.
function buildSlidesFromTemplate(db, spec, params, style) {
  const els0 = spec.elements || [];
  const targets = style ? styleTargets(els0) : null;
  const els = targets ? els0.map((e) => (targets.has(e) ? withStyle(e, style) : e)) : els0;
  const bg = spec.background ?? null;

  const contentEls = els.filter((e) => CONTENT_TYPES.has(e.type));
  if (contentEls.length) {
    const type = contentEls[0].type; // split by the first content element's type
    // 본문을 그리는 요소(참조/제목만 그리는 요소 제외)를 기준으로 분할량을 정한다.
    const bodyEl = contentEls.find((e) => !e.field || e.field === "all" || e.field === "text" || e.field === "body") || contentEls[0];
    const chunks = contentChunks(db, type, params, bodyEl);
    if (!chunks.length) throw new Error("콘텐츠를 가져오지 못했습니다");
    // every content element of that type (e.g. hymn title/label/lyrics) shares the chunk
    return chunks.map((chunk) => ({
      background: bg,
      elements: els.map((e) => {
        if (e.type === type) {
          // 새로 가져온 내용을 넣을 땐 옛 인라인 편집(html)을 버린다 — 남기면 렌더러가
          // html을 우선해 방금 가져온 가사가 아니라 옛 글이 그려진다.
          const { html, ...rest } = e;
          return { ...rest, params: chunk.params, content: chunk.content };
        }
        return CONTENT_TYPES.has(e.type) ? { ...e } : fillElement(e, params);
      }),
    }));
  }

  // lyrics text → 장 나누기
  const lyricsEl = els.find((e) => e.type === "text" && e.bind === "lyrics");
  if (lyricsEl && params.lyrics) {
    const raw = String(params.lyrics).replace(/\r\n?/g, "\n");
    // 빈 줄이 있으면 **그것을 장 구분으로** 본다. "찬양 가사에서 찾기"의 복사가 원본 PPT의
    // 장 나눔을 빈 줄로 실어 보내므로, 붙여넣기만 해도 원래 넘김이 그대로 재현된다.
    // 빈 줄이 없으면 예전처럼 lines_per_slide로 균등 분할.
    const blocks = raw.split(/\n[ \t]*\n/)
      .map((b) => b.split("\n").map((s) => s.trim()).filter(Boolean))
      .filter((b) => b.length);
    let chunks;
    if (blocks.length > 1) {
      chunks = blocks.map((b) => b.join("\n"));
    } else {
      const lines = blocks[0] || [];
      const per = params.lines_per_slide || 2;
      chunks = [];
      for (let i = 0; i < lines.length; i += per) chunks.push(lines.slice(i, i + per).join("\n"));
    }
    if (!chunks.length) chunks.push("");
    return chunks.map((text) => ({
      background: bg,
      elements: els.map((e) => (e === lyricsEl ? { ...e, text } : fillElement(e, params))),
    }));
  }

  return [{ background: bg, elements: els.map((e) => fillElement(e, params)) }];
}

// 템플릿으로 저장할 때 "내용"은 떼어내고 디자인만 남긴다.
// 콘텐츠 요소 → 가져온 스냅샷 제거 · bind된 텍스트 → 글자를 자리표시자로
// (다음에 이 템플릿으로 추가할 때 params로 채워지므로 지난주 가사가 남아 있으면 안 된다).
function stripForTemplate(elements) {
  return (elements || []).map((e) => {
    // 콘텐츠 요소는 **디자인만** 남긴다. html은 그 슬라이드의 내용을 인라인 편집한 흔적이라
    // 템플릿에 남으면 다음에 이 템플릿으로 만든 슬라이드가 새로 가져온 가사 대신 옛 글을
    // 그대로 그린다(렌더러가 html을 우선한다). 게다가 편집기가 남긴 빈 <div>·ce-line 여백까지
    // 따라와 줄 간격이 실제보다 넓어진다. → content·params와 함께 html도 뗀다.
    if (CONTENT_TYPES.has(e.type)) { const { content, params, html, ...rest } = e; return rest; }
    if (e.type === "text" && e.bind) {
      const { html, ...rest } = e;
      return { ...rest, text: PLACEHOLDER[e.bind] || e.bind };
    }
    return e;
  });
}

// 요소 짝짓기 키 — 같은 역할의 요소를 슬라이드끼리 맞춘다.
// bind(가사 등) → 콘텐츠 종류+field(성경 본문/참조) → 종류+등장순서.
function matchKeys(els) {
  const seen = {};
  return (els || []).map((e) => {
    if (e.type === "text" && e.bind) return `bind:${e.bind}`;
    if (CONTENT_TYPES.has(e.type)) return `content:${e.type}:${e.field || "all"}`;
    const n = (seen[e.type] = (seen[e.type] || 0) + 1);
    return `type:${e.type}:${n}`;
  });
}

// 예전에 저장한 커스텀 템플릿(입력칸 없이 내용이 굳어 있는 것)을 생성형으로 바꾼다.
// 디자인은 그대로 두고 입력칸(params_schema)만 만들고 굳은 내용을 비운다.
register({
  name: "upgrade_template_params",
  description: "커스텀 템플릿에 입력칸(params_schema)을 만들어 준다. 저장 당시의 내용(지난주 가사 등)은 지워지고 " +
    "디자인은 그대로 남는다 → 이후엔 가사만 넣으면 같은 디자인으로 여러 장이 생성된다. " +
    "bind/콘텐츠 요소가 없으면 만들 게 없다고 알려준다.",
  input_schema: {
    type: "object",
    properties: { template_id: { type: "string" } },
    required: ["template_id"],
  },
  handler: ({ template_id }, { db }) => {
    const t = db.query("SELECT kind, spec FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (t.kind !== "custom") throw new Error("기본 슬라이드 종류는 이미 입력칸이 있습니다");
    const spec = JSON.parse(t.spec);
    const elements = stripForTemplate(spec.elements || []);
    const schema = deriveParamsSchema(elements);
    const keys = Object.keys(schema.properties || {});
    if (!keys.length) {
      throw new Error("이 템플릿에는 내용을 채울 요소(가사·성경 등)가 없어 입력칸을 만들 수 없습니다");
    }
    db.query("UPDATE templates SET spec = ?, params_schema = ? WHERE id = ?")
      .run(JSON.stringify({ background: spec.background ?? null, elements }), JSON.stringify(schema), template_id);
    return { ok: true, params: keys, params_schema: schema };
  },
});

register({
  name: "copy_slide_style",
  description: "한 슬라이드의 서식(글꼴·크기·색·정렬·위치)을 다른 슬라이드들의 같은 역할 요소에 복사한다. " +
    "내용은 그대로 두고 서식만 바뀐다 — 가사 한 장을 원하는 대로 꾸민 뒤 나머지 장에 퍼뜨릴 때 쓴다. " +
    "요소는 bind(가사 등)·콘텐츠 종류·등장순서로 짝지어진다. include_background=true면 배경도 함께 복사.",
  input_schema: {
    type: "object",
    properties: {
      source_slide_id: { type: "string", description: "서식을 가져올 슬라이드" },
      target_slide_ids: { type: "array", items: { type: "string" }, description: "서식을 입힐 슬라이드들" },
      include_background: { type: "boolean", default: false },
      fields: {
        type: "array", items: { type: "string" },
        description: `복사할 서식 필드(생략 시 전부): ${STYLE_FIELDS.join(", ")}`,
      },
    },
    required: ["source_slide_id", "target_slide_ids"],
  },
  handler: ({ source_slide_id, target_slide_ids, include_background, fields }, { db }) => {
    const row = db.query("SELECT * FROM slides WHERE id = ?").get(source_slide_id);
    if (!row) throw new Error(`unknown slide: ${source_slide_id}`);
    const src = parseSlide(row);
    const use = Array.isArray(fields) && fields.length
      ? STYLE_FIELDS.filter((f) => fields.includes(f))
      : STYLE_FIELDS;

    // 원본의 "역할 → 서식" 표를 만든다.
    const srcEls = src.elements || [];
    const styleByKey = new Map();
    matchKeys(srcEls).forEach((key, i) => {
      const e = srcEls[i];
      const style = {};
      for (const f of use) if (e[f] !== undefined) style[f] = e[f];
      styleByKey.set(key, style);
    });

    const upd = db.query("UPDATE slides SET elements = ? WHERE id = ?");
    const bgq = db.query("UPDATE slides SET background = ? WHERE id = ?");
    const services = new Set();
    let changed = 0, matched = 0;
    const tx = db.transaction(() => {
      for (const id of target_slide_ids) {
        if (id === source_slide_id) continue;
        const r = db.query("SELECT * FROM slides WHERE id = ?").get(id);
        if (!r) throw new Error(`unknown slide: ${id}`);
        const tgt = parseSlide(r);
        const els = tgt.elements || [];
        const keys = matchKeys(els);
        const next = els.map((e, i) => {
          const style = styleByKey.get(keys[i]);
          if (!style) return e;                       // 짝이 없는 요소는 건드리지 않는다
          matched += 1;
          return { ...e, ...style };
        });
        upd.run(JSON.stringify(next), id);
        if (include_background) bgq.run(src.background == null ? null : JSON.stringify(src.background), id);
        changed += 1;
        const sid = serviceIdForSlide(db, id);
        if (sid) services.add(sid);
      }
      for (const sid of services) touchService(db, sid);
    });
    tx();
    return { ok: true, slides: changed, elements: matched };
  },
});

register({
  name: "list_templates",
  description: "모든 템플릿(기본 슬라이드 종류 + 커스텀 디자인)을 반환한다. 기본 종류가 먼저. " +
    "spec(배경·요소 배치)까지 함께 주므로 어떤 서식으로 만들어지는지 미리 알 수 있다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) =>
    db.query("SELECT id, name, kind, produces, params_schema, spec FROM templates ORDER BY kind, rowid").all()
      .map((t) => ({ ...t, params_schema: JSON.parse(t.params_schema), spec: JSON.parse(t.spec) })),
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
  description: "슬라이드 디자인(background + elements)을 새 커스텀 디자인 템플릿으로 저장한다. " +
    "가사·성경 등 내용을 채우는 요소(bind/콘텐츠 요소)가 있으면 입력칸(params_schema)을 자동으로 만들고 " +
    "지난 내용은 비운다 → 다음엔 가사만 넣으면 같은 디자인으로 여러 장이 생성된다.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      slide: { type: "object", description: "{ background?, elements }" },
      description: { type: "string", default: "" },
      keep_content: { type: "boolean", default: false, description: "true면 내용까지 그대로 굳혀서 저장(입력칸 없음)" },
    },
    required: ["name", "slide"],
  },
  handler: ({ name, slide, description, keep_content }, { db }) => {
    const id = ulid();
    const raw = slide.elements ?? [];
    const elements = keep_content ? raw : stripForTemplate(raw);
    const schema = keep_content ? { type: "object", properties: {} } : deriveParamsSchema(elements);
    db.query(`INSERT INTO templates (id,name,description,kind,produces,params_schema,spec) VALUES (?,?,?,'custom','slides',?,?)`)
      .run(id, name, description || "", JSON.stringify(schema),
        JSON.stringify({ background: slide.background ?? null, elements }));
    return { template_id: id, params_schema: schema };
  },
});

register({
  name: "apply_template",
  description: "템플릿에서 슬라이드를 예배 순서에 추가한다. 기본 종류는 params(책·장·절, 가사 등)로 내용을 채우고 " +
    "긴 내용은 자동 분할된다. style을 주면 이번에 추가하는 본문 요소의 서식(글꼴·크기·색·정렬·위치)만 " +
    "덮어쓴다 — 템플릿은 그대로 두고 곡마다 다르게 하고 싶을 때 쓴다.",
  input_schema: {
    type: "object",
    properties: {
      template_id: { type: "string" },
      service_id: { type: "string" },
      params: { type: "object" },
      position: { type: "integer" },
      style: {
        type: "object",
        description: "본문 요소 서식 덮어쓰기: { font?, size?, color?, align?, valign?, weight?, line_height?, x?, y?, w?, h?, opacity? }",
      },
    },
    required: ["template_id", "service_id"],
  },
  handler: async ({ template_id, service_id, params, position, style }, { db }) => {
    const t = db.query("SELECT kind, spec, params_schema FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) throw new Error(`unknown service: ${service_id}`);
    const spec = JSON.parse(t.spec);
    // 커스텀 템플릿도 입력 파라미터가 선언돼 있으면 기본 종류와 같은 생성·분할 경로를 탄다
    // (가사만 넣으면 여러 장 생성). 옛 커스텀 템플릿은 params_schema가 비어 있어 예전처럼
    // 디자인 그대로 한 장 추가된다 — 동작이 바뀌지 않는다.
    let wantsParams = false;
    try { wantsParams = Object.keys(JSON.parse(t.params_schema || "{}").properties || {}).length > 0; } catch {}
    const toAdd = t.kind === "builtin" || wantsParams
      ? buildSlidesFromTemplate(db, spec, params || {}, style)
      : [{ background: spec.background ?? null,
           elements: (spec.elements || []).map((e) => withStyle({ ...e }, style)) }];
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
      const elements = stripForTemplate(slide.elements);
      const spec = { background: slide.background ?? null, elements };
      db.query("UPDATE templates SET spec = ? WHERE id = ?").run(JSON.stringify(spec), template_id);
      // 커스텀 템플릿은 요소 구성이 바뀔 수 있으니 입력칸도 다시 뽑는다(기본 종류는 고정).
      if (t.kind === "custom") {
        db.query("UPDATE templates SET params_schema = ? WHERE id = ?")
          .run(JSON.stringify(deriveParamsSchema(elements)), template_id);
      }
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

register({
  name: "reset_templates",
  description: "기본 슬라이드 종류(builtin 템플릿)가 비었거나 일부 빠졌을 때 다시 시드한다(멱등). " +
    "커스텀 템플릿은 건드리지 않는다. 템플릿이 0개면 아무것도 추가할 수 없으므로 복구용으로 쓴다.",
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) => {
    seedBuiltins(db, get);
    return { ok: true, count: db.query("SELECT COUNT(*) AS n FROM templates").get().n };
  },
});
