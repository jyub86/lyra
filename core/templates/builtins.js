// Built-in templates = the slide kinds, represented as templates (design §7).
// Each built-in carries a user-editable design wrapper ({background,style,overlays});
// content comes from params at apply time. Seeded idempotently (INSERT OR IGNORE)
// so user design edits survive restarts. list_templates orders by rowid → built-ins
// appear first in this seed order, custom templates after.

// generator built-ins reuse a content tool (params_schema derived from its schema)
const GENERATORS = [
  { id: "builtin-bible", name: "성경 본문", tool: "add_bible_slides" },
  { id: "builtin-hymn", name: "찬송가", tool: "add_hymn_slides" },
  { id: "builtin-reading", name: "교독문", tool: "add_reading_slides" },
  { id: "builtin-praise", name: "찬양(가사)", tool: "add_praise_slides" },
  { id: "builtin-announcement", name: "광고", tool: "add_announcement_slide" },
];

// static built-ins build slide data directly from params
const STATICS = [
  { id: "builtin-title", name: "타이틀", template_type: "title",
    params_schema: { type: "object", properties: { title: { type: "string" }, subtitle: { type: "string" } }, required: ["title"] } },
  { id: "builtin-section", name: "순서 구분", template_type: "section",
    params_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
  { id: "builtin-blank", name: "빈 화면", template_type: "blank",
    params_schema: { type: "object", properties: {} } },
];

// desired display order
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

// getTool: registry.get — used to derive generator params_schema from the content tool.
export function seedBuiltins(db, getTool) {
  const defs = {};
  for (const g of GENERATORS) {
    defs[g.id] = { name: g.name, params_schema: paramsFromTool(getTool(g.tool)?.input_schema), spec: { tool: g.tool, design: {} } };
  }
  for (const s of STATICS) {
    defs[s.id] = { name: s.name, params_schema: s.params_schema, spec: { template_type: s.template_type, design: {} } };
  }
  const ins = db.prepare(
    "INSERT OR IGNORE INTO templates (id,name,description,kind,produces,params_schema,spec) VALUES (?,?,?,?,?,?,?)"
  );
  for (const id of ORDER) {
    const t = defs[id];
    ins.run(id, t.name, "기본 슬라이드 종류", "builtin", "slides", JSON.stringify(t.params_schema), JSON.stringify(t.spec));
  }
}
