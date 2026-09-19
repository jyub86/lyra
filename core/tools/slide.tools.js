// Slide tools (v4) — a slide is { background, elements:[] }. Elements are
// text / shape / image / bible / hymn / reading (content elements). The editor
// replaces the whole elements array (set_slide_elements); per-element edits are
// done client-side. Slides belong directly to a Service in flat order.
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import {
  nextPosition, makeRoom, closeGap, applyOrder, parseSlide, touchService, serviceIdForSlide,
} from "./_helpers.js";
import { matchKeys, keyLabel } from "../lib/element-match.js";

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
      background: { type: "object", nullable: true, description: "null이면 테마 기본 배경" },
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
  description: "슬라이드 배경을 설정한다. null이면 테마 기본. slide_ids로 여러 장에 같은 배경을 한 번에 " +
    "적용할 수 있다(가사 슬라이드 여러 장에 같은 배경 영상을 까는 용도). 발표 화면은 연속된 슬라이드의 " +
    "배경 영상/GIF가 같으면 되감지 않고 이어서 재생한다.",
  input_schema: {
    type: "object",
    properties: {
      slide_id: { type: "string", description: "대상 슬라이드 하나" },
      slide_ids: { type: "array", items: { type: "string" }, description: "여러 슬라이드에 같은 배경 적용" },
      background: { type: "object", nullable: true, description: "배경 객체(color/gradient/image/video). 생략·null이면 테마 기본" },
    },
  },
  handler: ({ slide_id, slide_ids, background }, { db }) => {
    const ids = [...new Set([...(slide_ids || []), ...(slide_id ? [slide_id] : [])])];
    if (!ids.length) throw new Error("slide_id 또는 slide_ids가 필요합니다");
    const value = background == null ? null : JSON.stringify(background);
    const q = db.query("UPDATE slides SET background = ? WHERE id = ?");
    const services = new Set();
    const tx = db.transaction(() => {
      for (const id of ids) {
        const r = q.run(value, id);
        if (r.changes === 0) throw new Error(`unknown slide: ${id}`);
        const sid = serviceIdForSlide(db, id);
        if (sid) services.add(sid);
      }
      for (const sid of services) touchService(db, sid);
    });
    tx();
    return { ok: true, count: ids.length };
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

// ---------- 여러 슬라이드의 "같은 요소"를 한 번에 ----------
// 로고를 30장에 넣거나, 44장에 깔린 띠 도형 색을 바꾸거나, 가사 상자를 12장에서 함께
// 올리는 일. 예전엔 장마다 반복하거나 copy_slide_style로 "한 장 꾸미고 퍼뜨리기"만
// 가능했다(그마저 서식 12개 필드뿐 — 도형 fill·이미지 url·글자 내용은 못 바꿨다).
//
// 짝짓기는 copy_slide_style과 **같은 규칙**(core/lib/element-match.js).
// 짝이 없는 슬라이드는 건드리지 않고, 몇 장에서 찾았는지를 항상 돌려준다.

// slide_ids 또는 service_id로 대상 슬라이드를 모은다(순서대로).
function collectSlides(db, { slide_ids, service_id, include_hidden = true }) {
  let rows;
  if (slide_ids?.length) {
    const q = db.query("SELECT * FROM slides WHERE id = ?");
    rows = slide_ids.map((id) => q.get(id)).filter(Boolean);
  } else if (service_id) {
    rows = db.query("SELECT * FROM slides WHERE service_id = ? ORDER BY position").all(service_id);
  } else {
    throw new Error("slide_ids 또는 service_id 중 하나는 필요합니다");
  }
  if (!include_hidden) rows = rows.filter((r) => !r.hidden);
  if (!rows.length) throw new Error("대상 슬라이드가 없습니다");
  return rows.map(parseSlide);
}

register({
  name: "list_element_keys",
  description: "여러 슬라이드에 걸쳐 있는 '같은 역할의 요소'를 훑어 목록으로 돌려준다. " +
    "각 항목의 key를 update_elements·remove_elements에 그대로 넘기면 그 요소만 한 번에 고칠 수 있다. " +
    "어떤 요소가 몇 장에 있는지 먼저 확인할 때 쓴다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string", description: "예배 전체를 훑는다" },
      slide_ids: { type: "array", items: { type: "string" }, description: "이 슬라이드들만(생략=예배 전체)" },
    },
  },
  handler: ({ service_id, slide_ids }, { db }) => {
    const slides = collectSlides(db, { slide_ids, service_id });
    const map = new Map();
    for (const s of slides) {
      const els = s.elements || [];
      matchKeys(els).forEach((key, i) => {
        const e = els[i];
        if (!map.has(key)) {
          map.set(key, { key, label: keyLabel(key), type: e.type, count: 0, slide_ids: [], sample: "" });
        }
        const row = map.get(key);
        row.count++;
        row.slide_ids.push(s.id);
        if (!row.sample) row.sample = String(e.text ?? e.url ?? e.fill ?? "").slice(0, 40);
      });
    }
    const keys = [...map.values()].sort((a, b) => b.count - a.count);
    return { slides: slides.length, keys };
  },
});

register({
  name: "update_elements",
  description: "여러 슬라이드에서 같은 역할의 요소를 찾아 한 번에 고친다(key는 list_element_keys로 확인). " +
    "patch에 준 필드만 덮어쓰고 나머지는 그대로 둔다 — 위치(x,y,w,h)·색(color,fill,stroke)·글꼴·크기·" +
    "이미지 url 등 요소의 아무 필드나 된다. 값이 null이면 그 필드를 지운다. " +
    "주의: text를 patch하면 장마다 다르던 글(가사 등)이 모두 같은 글로 덮인다.",
  input_schema: {
    type: "object",
    properties: {
      slide_ids: { type: "array", items: { type: "string" }, description: "대상 슬라이드(생략 시 service_id 전체)" },
      service_id: { type: "string", description: "예배 전체를 대상으로" },
      key: { type: "string", description: "list_element_keys가 준 key (예: bind:title, type:shape:1)" },
      patch: { type: "object", description: "덮어쓸 필드들 (예: {\"fill\":\"#123456\",\"y\":0.62})" },
    },
    required: ["key", "patch"],
  },
  handler: ({ slide_ids, service_id, key, patch }, { db }) => {
    if (!patch || typeof patch !== "object" || !Object.keys(patch).length) {
      throw new Error("patch에 바꿀 필드를 하나 이상 주세요");
    }
    const slides = collectSlides(db, { slide_ids, service_id });
    const upd = db.query("UPDATE slides SET elements = ? WHERE id = ?");
    const services = new Set();
    let changed = 0, matched = 0;
    const tx = db.transaction(() => {
      for (const s of slides) {
        const els = s.elements || [];
        const keys = matchKeys(els);
        let hit = false;
        const next = els.map((e, i) => {
          if (keys[i] !== key) return e;
          matched++; hit = true;
          const out = { ...e };
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete out[k]; else out[k] = v;
          }
          // 내용 요소의 굳은 html은 렌더러가 우선하므로, 서식을 바꿨는데 화면이 안 변하는
          // 일이 없도록 떼어낸다(인라인 편집이 남긴 흔적 — v4.13과 같은 이유).
          if (out.html && !("html" in patch)) delete out.html;
          return out;
        });
        if (!hit) continue;
        upd.run(JSON.stringify(next), s.id);
        services.add(s.service_id);
        changed++;
      }
      for (const sid of services) touchService(db, sid);
    });
    tx();
    return { key, slides: slides.length, changed, matched, skipped: slides.length - changed };
  },
});

register({
  name: "remove_elements",
  description: "여러 슬라이드에서 같은 역할의 요소를 한 번에 지운다(key는 list_element_keys로 확인). " +
    "짝이 없는 슬라이드는 건드리지 않는다.",
  input_schema: {
    type: "object",
    properties: {
      slide_ids: { type: "array", items: { type: "string" } },
      service_id: { type: "string" },
      key: { type: "string", description: "지울 요소의 key" },
    },
    required: ["key"],
  },
  handler: ({ slide_ids, service_id, key }, { db }) => {
    const slides = collectSlides(db, { slide_ids, service_id });
    const upd = db.query("UPDATE slides SET elements = ? WHERE id = ?");
    const services = new Set();
    let changed = 0, removed = 0;
    const tx = db.transaction(() => {
      for (const s of slides) {
        const els = s.elements || [];
        const keys = matchKeys(els);
        const next = els.filter((_, i) => keys[i] !== key);
        if (next.length === els.length) continue;
        removed += els.length - next.length;
        upd.run(JSON.stringify(next), s.id);
        services.add(s.service_id);
        changed++;
      }
      for (const sid of services) touchService(db, sid);
    });
    tx();
    return { key, slides: slides.length, changed, removed };
  },
});

// "이미 같은 게 있나" — 같은 도구를 두 번 돌렸을 때 로고가 두 개 겹치는 걸 막는다.
// matchKeys로 판정하면 안 된다: 이미지가 있는 장에 이미지를 더하면 type:image:2가 되어
// 기존 type:image:1과 안 겹치므로 **항상 통과**한다(실측으로 걸렸다).
// 정체성은 bind 이름 → type+url → type+text 순으로 본다.
function alreadyHas(els, el) {
  return (els || []).some((e) => {
    if (el.bind) return e.bind === el.bind;
    if (e.type !== el.type) return false;
    if (el.url) return e.url === el.url;
    if (el.text) return e.text === el.text;
    return false;
  });
}

register({
  name: "add_element_to_slides",
  description: "같은 요소(로고 이미지·문구 등)를 여러 슬라이드에 한 번에 추가한다. " +
    "element는 add_slide의 요소와 같은 모양 {type,x,y,w,h,...}. 같은 것이 이미 있는 슬라이드는 " +
    "건너뛴다(bind 이름 / 같은 종류+url / 같은 종류+글자로 판정) → 두 번 돌려도 겹치지 않는다. " +
    "skip_existing=false면 그래도 추가한다.",
  input_schema: {
    type: "object",
    properties: {
      slide_ids: { type: "array", items: { type: "string" } },
      service_id: { type: "string" },
      element: { type: "object", description: "추가할 요소 (예: {\"type\":\"image\",\"url\":\"/uploads/logo.png\",\"x\":0.86,\"y\":0.04,\"w\":0.1,\"h\":0.1})" },
      skip_existing: { type: "boolean", default: true, description: "같은 역할의 요소가 이미 있으면 건너뛴다" },
    },
    required: ["element"],
  },
  handler: ({ slide_ids, service_id, element, skip_existing }, { db }) => {
    if (!element || typeof element !== "object" || !element.type) {
      throw new Error("element에 type이 필요합니다");
    }
    const skip = skip_existing !== false;
    const slides = collectSlides(db, { slide_ids, service_id });
    const upd = db.query("UPDATE slides SET elements = ? WHERE id = ?");
    const services = new Set();
    let changed = 0;
    const tx = db.transaction(() => {
      for (const s of slides) {
        const els = s.elements || [];
        if (skip && alreadyHas(els, element)) continue;
        upd.run(JSON.stringify([...els, { ...element }]), s.id);
        services.add(s.service_id);
        changed++;
      }
      for (const sid of services) touchService(db, sid);
    });
    tx();
    return { slides: slides.length, changed, skipped: slides.length - changed };
  },
});
