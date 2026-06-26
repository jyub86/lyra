// Service tools — 덱 생성/조회/수정/복사/삭제 (design §8-2).
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { nowIso, parseSlide } from "./_helpers.js";

register({
  name: "list_services",
  description: "저장된 예배 덱(Service) 목록을 최신순으로 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_args, { db }) =>
    db.query("SELECT * FROM services ORDER BY date DESC, created_at DESC").all(),
});

register({
  name: "get_service",
  description: "예배 덱 하나를 씬·슬라이드 트리까지 포함해 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string", description: "대상 Service ID" } },
    required: ["service_id"],
  },
  handler: ({ service_id }, { db }) => {
    const service = db.query("SELECT * FROM services WHERE id = ?").get(service_id);
    if (!service) throw new Error(`unknown service: ${service_id}`);
    const scenes = db.query("SELECT * FROM scenes WHERE service_id = ? ORDER BY position").all(service_id);
    for (const scene of scenes) {
      scene.slides = db
        .query("SELECT * FROM slides WHERE scene_id = ? ORDER BY position")
        .all(scene.id)
        .map(parseSlide);
    }
    return { ...service, scenes };
  },
});

register({
  name: "create_service",
  description: "새 예배 덱을 만든다. 제목/날짜/예배부(1부·2부·연합)와 선택적 테마를 받는다.",
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
  description: "예배 덱의 필드(title/date/worship_part/theme_id)를 수정한다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      fields: { type: "object" },
    },
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
  description: "예배 덱의 테마를 변경한다.",
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

register({
  name: "duplicate_service",
  description: "예배 덱 전체(씬·슬라이드 포함)를 복사해 새 덱을 만든다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      title: { type: "string", description: "새 덱 제목(생략 시 원본+' (사본)')" },
    },
    required: ["service_id"],
  },
  handler: ({ service_id, title }, { db }) => {
    const src = db.query("SELECT * FROM services WHERE id = ?").get(service_id);
    if (!src) throw new Error(`unknown service: ${service_id}`);
    const newId = ulid();
    const ts = nowIso();
    const tx = db.transaction(() => {
      db.query(
        `INSERT INTO services (id, title, date, worship_part, theme_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId, title || `${src.title} (사본)`, src.date, src.worship_part, src.theme_id, ts, ts);
      const scenes = db.query("SELECT * FROM scenes WHERE service_id = ? ORDER BY position").all(service_id);
      for (const scene of scenes) {
        const newSceneId = ulid();
        db.query("INSERT INTO scenes (id, service_id, position, name) VALUES (?, ?, ?, ?)")
          .run(newSceneId, newId, scene.position, scene.name);
        const slides = db.query("SELECT * FROM slides WHERE scene_id = ? ORDER BY position").all(scene.id);
        for (const s of slides) {
          db.query(
            `INSERT INTO slides (id, scene_id, position, template_type, data, background, overlays, transition)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(ulid(), newSceneId, s.position, s.template_type, s.data, s.background, s.overlays, s.transition);
        }
      }
    });
    tx();
    return { service_id: newId };
  },
});

register({
  name: "delete_service",
  description: "예배 덱을 삭제한다(씬·슬라이드 연쇄 삭제).",
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
