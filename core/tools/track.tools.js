// 사운드 트랙 도구 — 예배(Service)에 붙는 음악 목록. 슬라이드 하나가 아니라 **구간**
// (시작 슬라이드 ~ 끝 슬라이드)에 걸려 있어, 발표 중 슬라이드를 넘겨도 소리가 이어진다.
// 구간이 겹치면 여러 트랙이 동시에 난다. 재생은 발표 화면(presenter)에서만 한다.
//   track = { id, name, url, start_slide_id, end_slide_id, loop, volume }
// end_slide_id 가 없으면 예배 끝까지. 슬라이드 id로 잡아두므로 순서를 바꿔도 따라간다.
import { register } from "./registry.js";
import { ulid } from "../lib/ulid.js";
import { nowIso } from "./_helpers.js";

export function readTracks(db, serviceId) {
  const s = db.query("SELECT tracks FROM services WHERE id = ?").get(serviceId);
  if (!s) throw new Error(`unknown service: ${serviceId}`);
  try { return JSON.parse(s.tracks || "[]"); } catch { return []; }
}

function writeTracks(db, serviceId, tracks) {
  db.query("UPDATE services SET tracks = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(tracks), nowIso(), serviceId);
}

// 슬라이드가 이 예배에 속하는지 확인(없는 id를 붙여 구간이 사라지는 것 방지).
function checkSlide(db, serviceId, slideId, label) {
  if (slideId == null) return null;
  const row = db.query("SELECT id FROM slides WHERE id = ? AND service_id = ?").get(slideId, serviceId);
  if (!row) throw new Error(`${label}: 이 예배에 없는 슬라이드입니다 (${slideId})`);
  return slideId;
}

const clampVol = (v) => (v == null ? 0.8 : Math.max(0, Math.min(1, Number(v))));
// 시작 페이드(초). 기본 0.15 = 귀에는 즉시 들리되 팝 노이즈만 막는 정도.
const clampFade = (v) => (v == null ? 0.15 : Math.max(0, Math.min(10, Number(v))));

register({
  name: "list_tracks",
  description: "예배의 사운드 트랙 목록을 반환한다. 각 트랙은 시작~끝 슬라이드 구간 동안 발표 화면에서 재생된다.",
  read: true,
  input_schema: { type: "object", properties: { service_id: { type: "string" } }, required: ["service_id"] },
  handler: ({ service_id }, { db }) => ({ tracks: readTracks(db, service_id) }),
});

register({
  name: "add_track",
  description: "예배에 사운드 트랙을 추가한다. url은 업로드된 오디오(/uploads/…)나 외부 주소. " +
    "start_slide_id부터 end_slide_id까지(생략 시 예배 끝까지) 발표 중 계속 재생된다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      url: { type: "string", description: "오디오 URL (예: /uploads/xxx.mp3)" },
      name: { type: "string", description: "표시 이름(생략 시 파일명)" },
      start_slide_id: { type: "string", description: "재생 시작 슬라이드(생략 시 첫 슬라이드)" },
      end_slide_id: { type: "string", description: "재생 끝 슬라이드(생략 시 예배 끝까지)" },
      loop: { type: "boolean", default: true },
      volume: { type: "number", default: 0.8, description: "0~1" },
      fade_in: { type: "number", default: 0.15, description: "시작 페이드 시간(초). 0.15=바로 들림, 크게 주면 서서히 커진다" },
    },
    required: ["service_id", "url"],
  },
  handler: ({ service_id, url, name, start_slide_id, end_slide_id, loop, volume, fade_in }, { db }) => {
    const tracks = readTracks(db, service_id);
    const first = db.query("SELECT id FROM slides WHERE service_id = ? ORDER BY position LIMIT 1").get(service_id);
    const track = {
      id: ulid(),
      name: name || decodeURIComponent(String(url).split("/").pop() || "사운드"),
      url,
      start_slide_id: checkSlide(db, service_id, start_slide_id, "시작 슬라이드") ?? first?.id ?? null,
      end_slide_id: checkSlide(db, service_id, end_slide_id, "끝 슬라이드"),
      loop: loop !== false,
      volume: clampVol(volume),
      fade_in: clampFade(fade_in),
    };
    tracks.push(track);
    writeTracks(db, service_id, tracks);
    return { track_id: track.id, track };
  },
});

register({
  name: "update_track",
  description: "사운드 트랙을 수정한다(name/url/start_slide_id/end_slide_id/loop/volume). end_slide_id를 null로 주면 예배 끝까지.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      track_id: { type: "string" },
      fields: { type: "object", description: "{ name?, url?, start_slide_id?, end_slide_id?, loop?, volume?, fade_in? }" },
    },
    required: ["service_id", "track_id", "fields"],
  },
  handler: ({ service_id, track_id, fields }, { db }) => {
    const tracks = readTracks(db, service_id);
    const t = tracks.find((x) => x.id === track_id);
    if (!t) throw new Error(`unknown track: ${track_id}`);
    if (fields.name !== undefined) t.name = String(fields.name);
    if (fields.url !== undefined) t.url = String(fields.url);
    if (fields.start_slide_id !== undefined) t.start_slide_id = checkSlide(db, service_id, fields.start_slide_id, "시작 슬라이드");
    if (fields.end_slide_id !== undefined) t.end_slide_id = checkSlide(db, service_id, fields.end_slide_id, "끝 슬라이드");
    if (fields.loop !== undefined) t.loop = !!fields.loop;
    if (fields.volume !== undefined) t.volume = clampVol(fields.volume);
    if (fields.fade_in !== undefined) t.fade_in = clampFade(fields.fade_in);
    writeTracks(db, service_id, tracks);
    return { ok: true, track: t };
  },
});

register({
  name: "remove_track",
  description: "사운드 트랙을 목록에서 제거한다(업로드된 파일 자체는 남는다).",
  input_schema: {
    type: "object",
    properties: { service_id: { type: "string" }, track_id: { type: "string" } },
    required: ["service_id", "track_id"],
  },
  handler: ({ service_id, track_id }, { db }) => {
    const tracks = readTracks(db, service_id);
    const next = tracks.filter((t) => t.id !== track_id);
    if (next.length === tracks.length) throw new Error(`unknown track: ${track_id}`);
    writeTracks(db, service_id, next);
    return { ok: true };
  },
});
