// Service tools — 예배(순서 전체) 생성/조회/수정/복사/삭제/공유 (design §8-2).
// A Service is one worship order (flat slide list) and the unit that is shared.
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { nowIso, parseSlide } from "./_helpers.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { saveUpload } from "../lib/uploads.js";

const SHARE_FORMAT = "worship-service/v2";
const UPLOAD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/uploads");

function slidesOf(db, serviceId) {
  return db.query("SELECT * FROM slides WHERE service_id = ? ORDER BY position").all(serviceId).map(parseSlide);
}

// /uploads/... 를 참조하는 곳: 요소 image url + 배경(image/video) url.
function collectAssetUrls(slides) {
  const urls = new Set();
  for (const s of slides) {
    if (typeof s.background?.url === "string" && s.background.url.startsWith("/uploads/")) urls.add(s.background.url);
    for (const e of s.elements || []) {
      if (typeof e?.url === "string" && e.url.startsWith("/uploads/")) urls.add(e.url);
    }
  }
  return [...urls];
}

// slide의 url을 map(old→new)으로 치환한 새 slide 반환(배경 + 이미지 요소).
function remapAssets(slide, map) {
  const s = { ...slide };
  if (s.background?.url && map[s.background.url]) s.background = { ...s.background, url: map[s.background.url] };
  s.elements = (s.elements || []).map((e) => (e.url && map[e.url] ? { ...e, url: map[e.url] } : e));
  return s;
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
    return {
      ...service,
      theme_overrides: service.theme_overrides ? JSON.parse(service.theme_overrides) : null,
      slides: slidesOf(db, service_id),
    };
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
    const allowed = ["title", "date", "worship_part", "theme_id", "transition"];
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
  description: "예배 순서의 테마와 커스텀 색을 설정한다. overrides={background?, accent?}로 배경/메인색을 덮어쓴다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      theme_id: { type: "string" },
      overrides: { description: "{ background?, accent? } 객체 — 생략 시 유지, null이면 초기화" },
    },
    required: ["service_id"],
  },
  handler: ({ service_id, theme_id, overrides }, { db }) => {
    const sets = [], vals = [];
    if (theme_id !== undefined) { sets.push("theme_id = ?"); vals.push(theme_id); }
    if (overrides !== undefined) { sets.push("theme_overrides = ?"); vals.push(overrides == null ? null : JSON.stringify(overrides)); }
    if (!sets.length) throw new Error("theme_id 또는 overrides 필요");
    db.query(`UPDATE services SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), service_id);
    return { ok: true };
  },
});

register({
  name: "set_service_transition",
  description: "발표 전환 효과를 설정한다: none(없음) | fade | slide.",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" }, transition: { type: "string", enum: ["none", "fade", "slide"] } },
    required: ["service_id", "transition"],
  },
  handler: ({ service_id, transition }, { db }) => {
    db.query("UPDATE services SET transition = ?, updated_at = ? WHERE id = ?").run(transition, nowIso(), service_id);
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
    if (meta.theme_overrides != null) db.query("UPDATE services SET theme_overrides = ? WHERE id = ?").run(JSON.stringify(meta.theme_overrides), id);
    if (meta.transition != null) db.query("UPDATE services SET transition = ? WHERE id = ?").run(meta.transition, id);
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
  description: "예배 순서 전체를 공유용 JSON(worship-service/v2)으로 내보낸다. 슬라이드·테마 커스텀·전환과 " +
    "첨부 이미지(assets, base64)까지 포함해 다른 머신에서도 그대로 재현된다. assets=false면 이미지 제외(가벼움).",
  read: true,
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      assets: { type: "boolean", default: true, description: "첨부 이미지 파일을 함께 내보낼지" },
    },
    required: ["service_id"],
  },
  handler: ({ service_id, assets = true }, { db }) => {
    const s = db.query("SELECT * FROM services WHERE id = ?").get(service_id);
    if (!s) throw new Error(`unknown service: ${service_id}`);
    const slides = slidesOf(db, service_id).map(({ background, elements, transition }) =>
      ({ background, elements, transition }));
    // 참조된 업로드 파일을 base64로 번들 (다른 머신에서도 이미지 유지)
    const bundled = [];
    if (assets) {
      for (const url of collectAssetUrls(slides)) {
        const p = join(UPLOAD_DIR, basename(url));
        if (existsSync(p)) bundled.push({ url, data_base64: readFileSync(p).toString("base64") });
      }
    }
    return {
      format: SHARE_FORMAT,
      title: s.title, date: s.date, worship_part: s.worship_part, theme_id: s.theme_id,
      theme_overrides: s.theme_overrides ? JSON.parse(s.theme_overrides) : null,
      transition: s.transition || "none",
      slides, assets: bundled,
    };
  },
});

register({
  name: "import_service",
  description: "공유용 JSON(worship-service/v2)을 받아 새 예배 순서로 가져온다.",
  input_schema: {
    type: "object",
    properties: {
      payload: { type: "object", description: "worship-service/v2 객체" },
      title: { type: "string", description: "가져올 제목(생략 시 payload 제목 사용)" },
    },
    required: ["payload"],
  },
  handler: async ({ payload, title }, { db }) => {
    if (!payload || payload.format !== SHARE_FORMAT) {
      throw new Error(`unsupported format: ${payload?.format} (expected ${SHARE_FORMAT})`);
    }
    // 번들된 이미지 복원 → uploads에 저장하고 url을 새 경로로 매핑
    const map = {};
    for (const a of payload.assets || []) {
      if (!a?.url || !a?.data_base64) continue;
      const { url } = await saveUpload(basename(a.url), Buffer.from(a.data_base64, "base64"));
      map[a.url] = url;
    }
    const slidesIn = Array.isArray(payload.slides) ? payload.slides : [];
    const slides = Object.keys(map).length ? slidesIn.map((s) => remapAssets(s, map)) : slidesIn;
    const meta = {
      title: title || payload.title || "가져온 예배",
      date: payload.date || nowIso().slice(0, 10),
      worship_part: payload.worship_part || "1부",
      theme_id: payload.theme_id || "dark-blue",
      theme_overrides: payload.theme_overrides || null,
      transition: payload.transition || null,
    };
    const id = writeService(db, meta, slides);
    return { service_id: id };
  },
});
