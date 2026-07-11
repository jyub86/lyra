// Slide tools (v4) — a slide is { background, elements:[] }. Elements are
// text / shape / image / bible / hymn / reading (content elements). The editor
// replaces the whole elements array (set_slide_elements); per-element edits are
// done client-side. Slides belong directly to a Service in flat order.
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import {
  nextPosition, makeRoom, closeGap, applyOrder, parseSlide, touchService, serviceIdForSlide,
} from "./_helpers.js";

// Reusable insert used by add_slide AND apply_template / content tools.
// `slide` = { background?, elements?, transition? }.
export function insertSlide(db, serviceId, slide, position) {
  const id = ulid();
  let pos = position;
  if (pos === undefined || pos === null) pos = nextPosition(db, "slides", "service_id", serviceId);
  else makeRoom(db, "slides", "service_id", serviceId, pos);
  db.query(
    `INSERT INTO slides (id, service_id, position, background, elements, transition)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id, serviceId, pos,
    slide.background ? JSON.stringify(slide.background) : null,
    JSON.stringify(slide.elements ?? []),
    slide.transition ?? "fade"
  );
  return id;
}

export function insertSlides(db, serviceId, slides, startPosition) {
  const ids = [];
  const tx = db.transaction(() => {
    let pos = startPosition;
    for (const s of slides) {
      ids.push(insertSlide(db, serviceId, s, pos));
      if (pos !== undefined && pos !== null) pos += 1;
    }
    touchService(db, serviceId);
  });
  tx();
  return ids;
}

register({
  name: "add_slide",
  description: "예배 순서에 슬라이드 하나를 추가한다. elements(요소 배열)/background/transition은 선택. position 생략 시 맨 끝.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      elements: { type: "array", description: "요소 배열 (text/shape/image/bible/hymn/reading)" },
      background: { type: "object" },
      transition: { type: "string", default: "fade" },
      position: { type: "integer" },
    },
    required: ["service_id"],
  },
  handler: ({ service_id, elements, background, transition, position }, { db }) => {
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) throw new Error(`unknown service: ${service_id}`);
    let id;
    const tx = db.transaction(() => {
      id = insertSlide(db, service_id, { elements: elements ?? [], background, transition }, position);
      touchService(db, service_id);
    });
    tx();
    return { slide_id: id };
  },
});

register({
  name: "update_slide",
  description: "슬라이드 필드를 수정한다. fields에 elements/background/transition 일부.",
  input_schema: {
    type: "object",
    properties: { slide_id: { type: "string" }, fields: { type: "object" } },
    required: ["slide_id", "fields"],
  },
  handler: ({ slide_id, fields }, { db }) => {
    const jsonCols = new Set(["elements", "background"]);
    const allowed = ["elements", "background", "transition", "hidden"];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) throw new Error("no updatable fields provided");
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => (jsonCols.has(k) ? (fields[k] == null ? null : JSON.stringify(fields[k])) : fields[k]));
    db.query(`UPDATE slides SET ${set} WHERE id = ?`).run(...vals, slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true };
  },
});

register({
  name: "set_service_slides",
  description: "예배의 슬라이드 전체를 주어진 배열로 교체한다(id·순서·hidden 보존). 실행취소/다시실행 스냅샷 복원에 쓴다.",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" }, slides: { type: "array" } },
    required: ["service_id", "slides"],
  },
  handler: ({ service_id, slides }, { db }) => {
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) throw new Error(`unknown service: ${service_id}`);
    const tx = db.transaction(() => {
      db.query("DELETE FROM slides WHERE service_id = ?").run(service_id);
      const ins = db.query(
        "INSERT INTO slides (id, service_id, position, background, elements, transition, hidden) VALUES (?,?,?,?,?,?,?)"
      );
      slides.forEach((s, i) => ins.run(
        s.id || ulid(), service_id, i,
        s.background ? JSON.stringify(s.background) : null,
        JSON.stringify(s.elements ?? []),
        s.transition ?? "fade",
        s.hidden ? 1 : 0
      ));
      touchService(db, service_id);
    });
    tx();
    return { ok: true, count: slides.length };
  },
});

register({
  name: "set_slide_hidden",
  description: "슬라이드를 발표에서 숨김/보임 설정한다. 숨긴 슬라이드는 발표 이동 시 건너뛰지만 편집기엔 남는다.",
  input_schema: {
    type: "object",
    properties: { slide_id: { type: "string" }, hidden: { type: "boolean" } },
    required: ["slide_id", "hidden"],
  },
  handler: ({ slide_id, hidden }, { db }) => {
    db.query("UPDATE slides SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true, hidden: !!hidden };
  },
});

register({
  name: "set_slide_elements",
  description: "슬라이드의 요소 배열 전체를 설정한다.",
  input_schema: {
    type: "object",
    properties: { slide_id: { type: "string" }, elements: { type: "array" } },
    required: ["slide_id", "elements"],
  },
  handler: ({ slide_id, elements }, { db }) => {
    db.query("UPDATE slides SET elements = ? WHERE id = ?").run(JSON.stringify(elements), slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true };
  },
});

register({
  name: "set_slide_background",
  description: "슬라이드 배경을 설정한다. null이면 테마 기본.",
  input_schema: {
    type: "object",
    properties: { slide_id: { type: "string" }, background: { type: "object" } },
    required: ["slide_id"],
  },
  handler: ({ slide_id, background }, { db }) => {
    db.query("UPDATE slides SET background = ? WHERE id = ?").run(background == null ? null : JSON.stringify(background), slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true };
  },
});

register({
  name: "reorder_slides",
  description: "예배 순서 내 슬라이드 순서를 명시한 ID 배열대로 재배열한다.",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" }, ordered_slide_ids: { type: "array", items: { type: "string" } } },
    required: ["service_id", "ordered_slide_ids"],
  },
  handler: ({ service_id, ordered_slide_ids }, { db }) => {
    applyOrder(db, "slides", ordered_slide_ids);
    touchService(db, service_id);
    return { ok: true };
  },
});

register({
  name: "remove_slide",
  description: "슬라이드를 삭제하고 뒤 슬라이드들의 순서를 메운다.",
  input_schema: {
    type: "object",
    properties: { slide_id: { type: "string" } },
    required: ["slide_id"],
  },
  handler: ({ slide_id }, { db }) => {
    const slide = db.query("SELECT service_id, position FROM slides WHERE id = ?").get(slide_id);
    if (!slide) return { ok: true };
    const tx = db.transaction(() => {
      db.query("DELETE FROM slides WHERE id = ?").run(slide_id);
      closeGap(db, "slides", "service_id", slide.service_id, slide.position);
      touchService(db, slide.service_id);
    });
    tx();
    return { ok: true };
  },
});
