// Slide tools — 슬라이드 추가/수정/삭제/순서변경/레이어 (design §8-2).
// Slides belong directly to a Service in one flat ordered list (no Scene layer).
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import {
  nextPosition, makeRoom, closeGap, applyOrder, parseSlide, touchService, serviceIdForSlide,
} from "./_helpers.js";

// Reusable insert used by add_slide AND the content/template tools.
// `slide` = { template_type, data, background?, overlays?, transition? }.
// Returns the new slide id. Caller owns the surrounding transaction when
// inserting many slides at once.
export function insertSlide(db, serviceId, slide, position) {
  const id = ulid();
  let pos = position;
  if (pos === undefined || pos === null) {
    pos = nextPosition(db, "slides", "service_id", serviceId);
  } else {
    makeRoom(db, "slides", "service_id", serviceId, pos);
  }
  db.query(
    `INSERT INTO slides (id, service_id, position, template_type, data, background, overlays, transition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, serviceId, pos, slide.template_type,
    JSON.stringify(slide.data ?? {}),
    slide.background ? JSON.stringify(slide.background) : null,
    slide.overlays ? JSON.stringify(slide.overlays) : null,
    slide.transition ?? "fade"
  );
  return id;
}

// Insert an array of slides contiguously (at the end, or from `startPosition`).
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
  description: "예배 순서에 슬라이드 하나를 추가한다. template_type과 data(JSON)는 필수, 배경/오버레이/전환은 선택. position 생략 시 맨 끝.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      template_type: { type: "string", description: "title/section/hymn/praise/bible/responsive_reading/announcement 등" },
      data: { type: "object" },
      position: { type: "integer", description: "삽입 위치(0-base). 생략 시 맨 끝." },
      background: { type: "object" },
      overlays: { type: "array" },
      transition: { type: "string", default: "fade" },
    },
    required: ["service_id", "template_type", "data"],
  },
  handler: ({ service_id, template_type, data, position, background, overlays, transition }, { db }) => {
    if (!db.query("SELECT id FROM services WHERE id = ?").get(service_id)) {
      throw new Error(`unknown service: ${service_id}`);
    }
    let id;
    const tx = db.transaction(() => {
      id = insertSlide(db, service_id, { template_type, data, background, overlays, transition }, position);
      touchService(db, service_id);
    });
    tx();
    return { slide_id: id };
  },
});

register({
  name: "update_slide",
  description: "슬라이드 필드를 수정한다. fields에 template_type/data/background/overlays/transition 일부를 넘긴다.",
  input_schema: {
    type: "object",
    properties: { slide_id: { type: "string" }, fields: { type: "object" } },
    required: ["slide_id", "fields"],
  },
  handler: ({ slide_id, fields }, { db }) => {
    const jsonCols = new Set(["data", "background", "overlays"]);
    const allowed = ["template_type", "data", "background", "overlays", "transition"];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) throw new Error("no updatable fields provided");
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => {
      if (!jsonCols.has(k)) return fields[k];
      return fields[k] == null ? null : JSON.stringify(fields[k]);
    });
    db.query(`UPDATE slides SET ${set} WHERE id = ?`).run(...vals, slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true };
  },
});

register({
  name: "set_slide_background",
  description: "슬라이드 배경 레이어를 설정한다. background=null이면 테마 기본 배경을 사용한다.",
  input_schema: {
    type: "object",
    properties: {
      slide_id: { type: "string" },
      background: { type: "object", description: "{type:color|image|video|gradient,...} 또는 null" },
    },
    required: ["slide_id"],
  },
  handler: ({ slide_id, background }, { db }) => {
    db.query("UPDATE slides SET background = ? WHERE id = ?")
      .run(background == null ? null : JSON.stringify(background), slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true };
  },
});

register({
  name: "set_slide_overlays",
  description: "슬라이드 오버레이(추가 텍스트/이미지) 레이어 배열을 설정한다.",
  input_schema: {
    type: "object",
    properties: {
      slide_id: { type: "string" },
      overlays: { type: "array", description: "오버레이 객체 배열" },
    },
    required: ["slide_id", "overlays"],
  },
  handler: ({ slide_id, overlays }, { db }) => {
    db.query("UPDATE slides SET overlays = ? WHERE id = ?").run(JSON.stringify(overlays), slide_id);
    touchService(db, serviceIdForSlide(db, slide_id));
    return { ok: true };
  },
});

register({
  name: "reorder_slides",
  description: "예배 순서 내 슬라이드 순서를 명시한 ID 배열대로 재배열한다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      ordered_slide_ids: { type: "array", items: { type: "string" } },
    },
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
