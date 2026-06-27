// Service tools — 예배(순서 전체) 생성/조회/수정/복사/삭제/공유 (design §8-2).
// A Service is one worship order (flat slide list) and the unit that is shared.
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { nowIso, parseSlide } from "./_helpers.js";

const SHARE_FORMAT = "worship-service/v2";

function slidesOf(db, serviceId) {
  return db.query("SELECT * FROM slides WHERE service_id = ? ORDER BY position").all(serviceId).map(parseSlide);
}

register({
  name: "list_services",
  description: "저장된 예배 순서(Service) 목록을 최신순으로 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_args, { db }) =>
    db.query("SELECT * FROM services ORDER BY date DESC, created_at DESC").all(),
});

register({
  name: "get_service",
  description: "예배 순서 하나를 슬라이드 목록(평면, 순서대로)까지 포함해 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string", description: "대상 Service ID" } },
    required: ["service_id"],
  },
  handler: ({ service_id }, { db }) => {
    const service = db.query("SELECT * FROM services WHERE id = ?").get(service_id);
    if (!service) throw new Error(`unknown service: ${service_id}`);
    return { ...service, slides: slidesOf(db, service_id) };
  },
});

register({
  name: "create_service",
  description: "새 예배 순서를 만든다. 제목/날짜/예배부(1부·2부·연합)와 선택적 테마를 받는다.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      worship_part: { type: "string", description: "예: 1부 / 2부 / 연합" },
      theme_id: { type: "string", default: "dark-blue" },
    },
    required: ["title", "date", "worship_part"],
  },
  handler: ({ title, date, worship_part, theme_id }, { db }) => {
    const id = ulid();
    const ts = nowIso();
    db.query(
      `INSERT INTO services (id, title, date, worship_part, theme_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, date, worship_part, theme_id, ts, ts);
    return { service_id: id };
  },
});

register({
  name: "update_service",
  description: "예배 순서의 필드(title/date/worship_part/theme_id)를 수정한다.",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" }, fields: { type: "object" } },
    required: ["service_id", "fields"],
  },
  handler: ({ service_id, fields }, { db }) => {
    const allowed = ["title", "date", "worship_part", "theme_id"];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) throw new Error("no updatable fields provided");
    const set = keys.map((k) => `${k} = ?`).join(", ");
    db.query(`UPDATE services SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), nowIso(), service_id);
    return { ok: true };
  },
});

register({
  name: "set_service_theme",
  description: "예배 순서의 테마를 변경한다.",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" }, theme_id: { type: "string" } },
    required: ["service_id", "theme_id"],
  },
  handler: ({ service_id, theme_id }, { db }) => {
    db.query("UPDATE services SET theme_id = ?, updated_at = ? WHERE id = ?")
      .run(theme_id, nowIso(), service_id);
    return { ok: true };
  },
});

// Shared insert path for duplicate/import: write a service row + its slides.
function writeService(db, meta, slides) {
  const id = ulid();
  const ts = nowIso();
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO services (id, title, date, worship_part, theme_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, meta.title, meta.date, meta.worship_part, meta.theme_id || "dark-blue", ts, ts);
    const insert = db.query(
      `INSERT INTO slides (id, service_id, position, background, elements, transition)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    slides.forEach((s, i) => {
      insert.run(
        ulid(), id, i,
        s.background ? JSON.stringify(s.background) : null,
        JSON.stringify(s.elements ?? []),
        s.transition ?? "fade"
      );
    });
  });
  tx();
  return id;
}

register({
  name: "duplicate_service",
  description: "예배 순서 전체(슬라이드 포함)를 복사해 새 예배를 만든다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      title: { type: "string", description: "새 제목(생략 시 원본+' (사본)')" },
    },
    required: ["service_id"],
  },
  handler: ({ service_id, title }, { db }) => {
    const src = db.query("SELECT * FROM services WHERE id = ?").get(service_id);
    if (!src) throw new Error(`unknown service: ${service_id}`);
    const newId = writeService(db, { ...src, title: title || `${src.title} (사본)` }, slidesOf(db, service_id));
    return { service_id: newId };
  },
});

register({
  name: "delete_service",
  description: "예배 순서를 삭제한다(슬라이드 연쇄 삭제).",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" } },
    required: ["service_id"],
  },
  handler: ({ service_id }, { db }) => {
    db.query("DELETE FROM services WHERE id = ?").run(service_id);
    return { ok: true };
  },
});

// ===== 공유 (export/import) — 한 예배 순서 전체가 공유 단위 =====

register({
  name: "export_service",
  description: "예배 순서 전체를 공유용 JSON(worship-service/v1)으로 내보낸다. 슬라이드가 순서대로 포함된다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" } },
    required: ["service_id"],
  },
  handler: ({ service_id }, { db }) => {
    const s = db.query("SELECT * FROM services WHERE id = ?").get(service_id);
    if (!s) throw new Error(`unknown service: ${service_id}`);
    const slides = slidesOf(db, service_id).map(({ background, elements, transition }) =>
      ({ background, elements, transition }));
    return {
      format: SHARE_FORMAT,
      title: s.title, date: s.date, worship_part: s.worship_part, theme_id: s.theme_id,
      slides,
    };
  },
});

register({
  name: "import_service",
  description: "공유용 JSON(worship-service/v1)을 받아 새 예배 순서로 가져온다.",
  input_schema: {
    type: "object",
    properties: {
      payload: { type: "object", description: "worship-service/v1 객체" },
      title: { type: "string", description: "가져올 제목(생략 시 payload 제목 사용)" },
    },
    required: ["payload"],
  },
  handler: ({ payload, title }, { db }) => {
    if (!payload || payload.format !== SHARE_FORMAT) {
      throw new Error(`unsupported format: ${payload?.format} (expected ${SHARE_FORMAT})`);
    }
    const meta = {
      title: title || payload.title || "가져온 예배",
      date: payload.date || nowIso().slice(0, 10),
      worship_part: payload.worship_part || "1부",
      theme_id: payload.theme_id || "dark-blue",
    };
    const id = writeService(db, meta, Array.isArray(payload.slides) ? payload.slides : []);
    return { service_id: id };
  },
});
