// Design-template tools (design §7). A template stores a slide's design
// (template_type + data + background + overlays) as a custom blueprint in the
// `templates` table, to be applied as a new slide or edited later.
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { insertSlide } from "./slide.tools.js";
import { touchService } from "./_helpers.js";

// Extract the design portion of a slide object (no id/position/scene linkage).
function designOf(slide) {
  return {
    template_type: slide.template_type,
    data: slide.data ?? {},
    background: slide.background ?? null,
    overlays: slide.overlays ?? [],
  };
}

register({
  name: "list_templates",
  description: "저장된 디자인 템플릿 목록을 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) =>
    db.query("SELECT id, name, description, produces FROM templates ORDER BY name").all(),
});

register({
  name: "get_template",
  description: "디자인 템플릿 하나를 spec(슬라이드 디자인)까지 포함해 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { template_id: { type: "string" } },
    required: ["template_id"],
  },
  handler: ({ template_id }, { db }) => {
    const t = db.query("SELECT * FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    return { ...t, params_schema: JSON.parse(t.params_schema), spec: JSON.parse(t.spec) };
  },
});

register({
  name: "save_template",
  description: "슬라이드 디자인(template_type/data/background/overlays)을 새 디자인 템플릿으로 저장한다.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      slide: { type: "object", description: "{ template_type, data, background?, overlays? }" },
      description: { type: "string", default: "" },
    },
    required: ["name", "slide"],
  },
  handler: ({ name, slide, description }, { db }) => {
    const id = ulid();
    db.query(
      `INSERT INTO templates (id, name, description, kind, produces, params_schema, spec)
       VALUES (?, ?, ?, 'custom', 'slides', '{}', ?)`
    ).run(id, name, description || "", JSON.stringify(designOf(slide)));
    return { template_id: id };
  },
});

register({
  name: "apply_template",
  description: "디자인 템플릿에서 새 슬라이드 1장을 예배 순서에 추가한다.",
  input_schema: {
    type: "object",
    properties: {
      template_id: { type: "string" },
      service_id: { type: "string" },
      position: { type: "integer", description: "삽입 위치(생략 시 맨 끝)" },
    },
    required: ["template_id", "service_id"],
  },
  handler: ({ template_id, service_id, position }, { db }) => {
    const t = db.query("SELECT spec FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) {
      throw new Error(`unknown service: ${service_id}`);
    }
    const design = JSON.parse(t.spec);
    let id;
    const tx = db.transaction(() => {
      id = insertSlide(db, service_id, design, position);
      touchService(db, service_id);
    });
    tx();
    return { slide_id: id };
  },
});

register({
  name: "update_template",
  description: "디자인 템플릿의 이름 또는 디자인(slide)을 덮어쓴다(편집).",
  input_schema: {
    type: "object",
    properties: {
      template_id: { type: "string" },
      name: { type: "string" },
      slide: { type: "object", description: "새 디자인으로 덮어쓸 슬라이드(선택)" },
    },
    required: ["template_id"],
  },
  handler: ({ template_id, name, slide }, { db }) => {
    const t = db.query("SELECT id FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (name !== undefined) db.query("UPDATE templates SET name = ? WHERE id = ?").run(name, template_id);
    if (slide !== undefined) db.query("UPDATE templates SET spec = ? WHERE id = ?").run(JSON.stringify(designOf(slide)), template_id);
    return { ok: true };
  },
});

register({
  name: "delete_template",
  description: "디자인 템플릿을 삭제한다.",
  input_schema: {
    type: "object",
    properties: { template_id: { type: "string" } },
    required: ["template_id"],
  },
  handler: ({ template_id }, { db }) => {
    db.query("DELETE FROM templates WHERE id = ?").run(template_id);
    return { ok: true };
  },
});
