// Built-in templates = slide-kind element layouts (v4). Every template is an
// element arrangement: spec = { background, elements:[...] }. Content elements
// (bible/hymn/reading) carry no content here — content is fetched from params at
// apply time and the design (their box/style + any decorations) is editable.
// Text elements use `bind:"<param>"` to be filled from the add-form params.
// Seeded idempotently (INSERT OR IGNORE); list_templates orders built-ins first.

// generators: params_schema derived from the content tool's input_schema
const GENERATORS = [
  { id: "builtin-bible", name: "성경 본문", tool: "add_bible_slides",
    elements: [
      { type: "bible", field: "ref", x: 0.1, y: 0.12, w: 0.8, h: 0.08, size: 2.2, align: "center", weight: 700, color: "#7aa2f7" },
      { type: "bible", field: "text", x: 0.08, y: 0.26, w: 0.84, h: 0.56, size: 3.2, align: "center", weight: 600, line_height: 1.5, show_numbers: true },
    ] },
  { id: "builtin-hymn", name: "찬송가", tool: "add_hymn_slides",
    elements: [
      { type: "hymn", field: "title", x: 0.1, y: 0.12, w: 0.8, h: 0.1, size: 2.6, align: "center", weight: 700, color: "#c0caf5" },
      { type: "hymn", field: "label", x: 0.3, y: 0.24, w: 0.4, h: 0.07, size: 2.2, align: "center", weight: 700 },
      { type: "hymn", field: "lyrics", x: 0.1, y: 0.34, w: 0.8, h: 0.5, size: 3.6, align: "center", weight: 600 },
    ] },
  { id: "builtin-reading", name: "교독문", tool: "add_reading_slides",
    elements: [
      { type: "reading", field: "title", x: 0.1, y: 0.12, w: 0.8, h: 0.08, size: 2.4, align: "center", weight: 700, color: "#7aa2f7" },
      { type: "reading", field: "body", x: 0.08, y: 0.24, w: 0.84, h: 0.6, size: 2.9, align: "center", weight: 600 },
    ] },
];

// statics: build slide data from params (text bound via `bind`)
const STATICS = [
  { id: "builtin-title", name: "타이틀",
    params_schema: { type: "object", properties: { title: { type: "string" }, subtitle: { type: "string" } }, required: ["title"] },
    elements: [
      { type: "text", bind: "title", text: "제목", x: 0.1, y: 0.36, w: 0.8, h: 0.18, size: 7, align: "center", weight: 800 },
      { type: "text", bind: "subtitle", text: "부제", x: 0.2, y: 0.58, w: 0.6, h: 0.08, size: 2.6, align: "center", weight: 600 },
    ] },
  { id: "builtin-section", name: "순서 구분",
    params_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    elements: [{ type: "text", bind: "label", text: "순서 구분", x: 0.1, y: 0.42, w: 0.8, h: 0.16, size: 5.5, align: "center", weight: 800 }] },
  { id: "builtin-praise", name: "찬양(가사)",
    params_schema: { type: "object", properties: { lyrics: { type: "string" }, lines_per_slide: { type: "integer", default: 2 } }, required: ["lyrics"] },
    elements: [{ type: "text", bind: "lyrics", text: "가사", x: 0.1, y: 0.3, w: 0.8, h: 0.4, size: 3.4, align: "center", weight: 600 }] },
  { id: "builtin-announcement", name: "광고",
    params_schema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] },
    elements: [{ type: "text", bind: "items", text: "광고", x: 0.12, y: 0.2, w: 0.76, h: 0.6, size: 2.8, align: "left", weight: 600 }] },
  { id: "builtin-blank", name: "빈 화면",
    params_schema: { type: "object", properties: {} },
    elements: [] },
];

const ORDER = [
  "builtin-title", "builtin-section", "builtin-bible", "builtin-hymn",
  "builtin-reading", "builtin-praise", "builtin-announcement", "builtin-blank",
];
export const BUILTIN_IDS = new Set(ORDER);

function paramsFromTool(schema) {
  const s = schema ? structuredClone(schema) : { type: "object", properties: {} };
  if (s.properties) delete s.properties.service_id;
  if (Array.isArray(s.required)) s.required = s.required.filter((r) => r !== "service_id");
  return s;
}

export function seedBuiltins(db, getTool) {
  const defs = {};
  for (const g of GENERATORS) defs[g.id] = { name: g.name, params_schema: paramsFromTool(getTool(g.tool)?.input_schema), spec: { background: null, elements: g.elements } };
  for (const s of STATICS) defs[s.id] = { name: s.name, params_schema: s.params_schema, spec: { background: null, elements: s.elements } };
  const ins = db.prepare("INSERT OR IGNORE INTO templates (id,name,description,kind,produces,params_schema,spec) VALUES (?,?,?,?,?,?,?)");
  for (const id of ORDER) {
    const t = defs[id];
    ins.run(id, t.name, "기본 슬라이드 종류", "builtin", "slides", JSON.stringify(t.params_schema), JSON.stringify(t.spec));
  }
}
