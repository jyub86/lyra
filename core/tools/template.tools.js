// Unified template tools (design §7). One list of templates:
//   - built-in slide kinds (kind="builtin"): generator (spec.tool) or static
//     (spec.template_type), each with an editable design wrapper (spec.design).
//   - custom design templates (kind="custom"): a full saved slide design.
// apply_template adds a slide from any of them; built-ins take params + apply
// their design wrapper. Editing a built-in edits only the design (content stays
// param-driven). Content tools (add_*_slides) remain the primary LLM/CLI API and
// are reused here.
import { register, execute } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { insertSlide } from "./slide.tools.js";
import { touchService, parseSlide } from "./_helpers.js";
import { BUILTIN_IDS } from "../templates/builtins.js";

function designOf(slide) {
  return {
    template_type: slide.template_type,
    data: slide.data ?? {},
    background: slide.background ?? null,
    overlays: slide.overlays ?? [],
  };
}

// the editable "look" portion of a slide (used for built-in design wrappers)
function designWrapper(slide) {
  return {
    background: slide.background ?? null,
    style: slide.data?.style ?? null,
    overlays: slide.overlays ?? [],
  };
}

// patch a (already-created) slide with a design wrapper, if any
function applyDesignWrapper(db, slideId, design) {
  if (!design || (design.background == null && !(design.overlays?.length) && !design.style)) return;
  const row = db.query("SELECT data FROM slides WHERE id = ?").get(slideId);
  if (!row) return;
  const sets = [], vals = [];
  if (design.style) {
    const data = JSON.parse(row.data);
    data.style = { ...(data.style || {}), ...design.style };
    sets.push("data = ?"); vals.push(JSON.stringify(data));
  }
  if (design.background != null) { sets.push("background = ?"); vals.push(JSON.stringify(design.background)); }
  if (design.overlays?.length) { sets.push("overlays = ?"); vals.push(JSON.stringify(design.overlays)); }
  if (sets.length) db.query(`UPDATE slides SET ${sets.join(", ")} WHERE id = ?`).run(...vals, slideId);
}

register({
  name: "list_templates",
  description: "모든 템플릿(기본 슬라이드 종류 + 커스텀 디자인)을 반환한다. 기본 종류가 먼저.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) =>
    // built-ins first ('builtin' < 'custom'), each by insertion order
    db.query("SELECT id, name, kind, produces, params_schema FROM templates ORDER BY kind, rowid").all()
      .map((t) => ({ ...t, params_schema: JSON.parse(t.params_schema) })),
});

register({
  name: "get_template",
  description: "템플릿 하나를 params_schema·spec까지 포함해 반환한다.",
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
  description: "슬라이드 디자인(template_type/data/background/overlays)을 새 커스텀 디자인 템플릿으로 저장한다.",
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
  description: "템플릿에서 슬라이드를 예배 순서에 추가한다. 기본 종류는 params(책·장·절, 제목 등)를 받고 디자인이 적용된다.",
  input_schema: {
    type: "object",
    properties: {
      template_id: { type: "string" },
      service_id: { type: "string" },
      params: { type: "object", description: "기본 종류의 입력값(생성형/정적)" },
      position: { type: "integer", description: "삽입 위치(생략 시 맨 끝)" },
    },
    required: ["template_id", "service_id"],
  },
  handler: async ({ template_id, service_id, params, position }, ctx) => {
    const { db } = ctx;
    const t = db.query("SELECT kind, spec FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) {
      throw new Error(`unknown service: ${service_id}`);
    }
    const spec = JSON.parse(t.spec);
    const p = params || {};

    // built-in generator: reuse the content tool, then apply the design wrapper
    if (spec.tool) {
      const result = await execute(spec.tool, { service_id, ...p }, ctx);
      const ids = result.slide_ids || (result.slide_id ? [result.slide_id] : []);
      for (const id of ids) applyDesignWrapper(db, id, spec.design);
      return { slide_ids: ids };
    }

    // built-in static: build data from params + design wrapper
    if (t.kind === "builtin") {
      const data = { ...p };
      if (spec.design?.style) data.style = spec.design.style;
      let id;
      const tx = db.transaction(() => {
        id = insertSlide(db, service_id, {
          template_type: spec.template_type, data,
          background: spec.design?.background ?? null,
          overlays: spec.design?.overlays ?? null,
        }, position);
        touchService(db, service_id);
      });
      tx();
      return { slide_ids: [id] };
    }

    // custom design template: insert the saved design as-is
    let id;
    const tx = db.transaction(() => {
      id = insertSlide(db, service_id, spec, position);
      touchService(db, service_id);
    });
    tx();
    return { slide_ids: [id] };
  },
});

register({
  name: "update_template",
  description: "템플릿을 수정한다. 기본 종류는 디자인(배경·콘텐츠 스타일·요소)만, 커스텀은 전체 디자인을 덮어쓴다. reset=true면 기본 종류 디자인 초기화.",
  input_schema: {
    type: "object",
    properties: {
      template_id: { type: "string" },
      name: { type: "string" },
      slide: { type: "object", description: "디자인 소스 슬라이드(선택)" },
      reset: { type: "boolean", description: "기본 종류 디자인 초기화" },
    },
    required: ["template_id"],
  },
  handler: ({ template_id, name, slide, reset }, { db }) => {
    const t = db.query("SELECT kind, spec FROM templates WHERE id = ?").get(template_id);
    if (!t) throw new Error(`unknown template: ${template_id}`);
    if (name !== undefined) db.query("UPDATE templates SET name = ? WHERE id = ?").run(name, template_id);

    if (reset && t.kind === "builtin") {
      const spec = JSON.parse(t.spec); spec.design = {};
      db.query("UPDATE templates SET spec = ? WHERE id = ?").run(JSON.stringify(spec), template_id);
    } else if (slide !== undefined) {
      if (t.kind === "builtin") {
        const spec = JSON.parse(t.spec);
        spec.design = designWrapper(slide); // design only — content stays param-driven
        db.query("UPDATE templates SET spec = ? WHERE id = ?").run(JSON.stringify(spec), template_id);
      } else {
        db.query("UPDATE templates SET spec = ? WHERE id = ?").run(JSON.stringify(designOf(slide)), template_id);
      }
    }
    return { ok: true };
  },
});

register({
  name: "delete_template",
  description: "커스텀 디자인 템플릿을 삭제한다. 기본 슬라이드 종류는 삭제할 수 없다(초기화만 가능).",
  input_schema: {
    type: "object",
    properties: { template_id: { type: "string" } },
    required: ["template_id"],
  },
  handler: ({ template_id }, { db }) => {
    if (BUILTIN_IDS.has(template_id)) throw new Error("기본 슬라이드 종류는 삭제할 수 없습니다 (초기화만 가능).");
    db.query("DELETE FROM templates WHERE id = ?").run(template_id);
    return { ok: true };
  },
});
