// Scene tools — 씬 추가/수정/삭제/순서변경 (design §8-2).
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import {
  nextPosition, makeRoom, closeGap, applyOrder, parseSlide, touchService, serviceIdForScene,
} from "./_helpers.js";

register({
  name: "get_scene",
  description: "씬 하나를 슬라이드 목록까지 포함해 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { scene_id: { type: "string" } },
    required: ["scene_id"],
  },
  handler: ({ scene_id }, { db }) => {
    const scene = db.query("SELECT * FROM scenes WHERE id = ?").get(scene_id);
    if (!scene) throw new Error(`unknown scene: ${scene_id}`);
    scene.slides = db.query("SELECT * FROM slides WHERE scene_id = ? ORDER BY position").all(scene_id).map(parseSlide);
    return scene;
  },
});

register({
  name: "add_scene",
  description: "예배 덱에 새 씬을 추가한다. position 생략 시 맨 뒤에 붙는다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      name: { type: "string", description: "씬 이름 (예: 예배로 부름, 찬양, 말씀, 광고)" },
      position: { type: "integer", description: "삽입 위치(0-base). 생략 시 맨 끝." },
    },
    required: ["service_id", "name"],
  },
  handler: ({ service_id, name, position }, { db }) => {
    const svc = db.query("SELECT id FROM services WHERE id = ?").get(service_id);
    if (!svc) throw new Error(`unknown service: ${service_id}`);
    const id = ulid();
    const tx = db.transaction(() => {
      let pos = position;
      if (pos === undefined || pos === null) {
        pos = nextPosition(db, "scenes", "service_id", service_id);
      } else {
        makeRoom(db, "scenes", "service_id", service_id, pos);
      }
      db.query("INSERT INTO scenes (id, service_id, position, name) VALUES (?, ?, ?, ?)")
        .run(id, service_id, pos, name);
      touchService(db, service_id);
    });
    tx();
    return { scene_id: id };
  },
});

register({
  name: "update_scene",
  description: "씬의 필드(name)를 수정한다.",
  input_schema: {
    type: "object",
    properties: { scene_id: { type: "string" }, fields: { type: "object" } },
    required: ["scene_id", "fields"],
  },
  handler: ({ scene_id, fields }, { db }) => {
    if (fields.name !== undefined) {
      db.query("UPDATE scenes SET name = ? WHERE id = ?").run(fields.name, scene_id);
    }
    const sid = serviceIdForScene(db, scene_id);
    if (sid) touchService(db, sid);
    return { ok: true };
  },
});

register({
  name: "reorder_scenes",
  description: "예배 덱 내 씬 순서를 명시한 ID 배열대로 재배열한다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      ordered_scene_ids: { type: "array", items: { type: "string" } },
    },
    required: ["service_id", "ordered_scene_ids"],
  },
  handler: ({ service_id, ordered_scene_ids }, { db }) => {
    applyOrder(db, "scenes", ordered_scene_ids);
    touchService(db, service_id);
    return { ok: true };
  },
});

register({
  name: "remove_scene",
  description: "씬을 삭제한다(슬라이드 연쇄 삭제). 뒤 씬들의 순서를 메운다.",
  input_schema: {
    type: "object",
    properties: { scene_id: { type: "string" } },
    required: ["scene_id"],
  },
  handler: ({ scene_id }, { db }) => {
    const scene = db.query("SELECT service_id, position FROM scenes WHERE id = ?").get(scene_id);
    if (!scene) return { ok: true };
    const tx = db.transaction(() => {
      db.query("DELETE FROM scenes WHERE id = ?").run(scene_id);
      closeGap(db, "scenes", "service_id", scene.service_id, scene.position);
      touchService(db, scene.service_id);
    });
    tx();
    return { ok: true };
  },
});
