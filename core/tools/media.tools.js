// Media tools (design §8-2). Video background + media upload + PDF/image import.
import { register } from "./registry.js";
import { saveUpload } from "../lib/uploads.js";
import { fileToSlidesFromPath } from "../lib/pdf-import.js";
import { insertSlides } from "./slide.tools.js";
import { serviceIdForSlide, touchService } from "./_helpers.js";
import { ulid } from "../lib/ulid.js";
import { makeLoopVideo, probeVideo, extractFrame, ffmpegAvailable } from "../lib/ffmpeg.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, normalize, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFor } from "../lib/render-cache.js";

const DATA_DIR = normalize(join(dirname(fileURLToPath(import.meta.url)), "../../data"));
// "/uploads/xxx.mp4"(서버 URL) 또는 절대 경로 → 실제 파일 경로. 경로 이탈(..)은 차단.
function resolveVideoPath(pathOrUrl) {
  const s = String(pathOrUrl || "");
  if (!s) throw new Error("path 또는 url이 필요합니다");
  if (s.startsWith("/uploads/") || s.startsWith("/render-cache/")) {
    const full = normalize(join(DATA_DIR, s));
    if (!full.startsWith(DATA_DIR)) throw new Error("허용되지 않은 경로입니다");
    if (!existsSync(full)) throw new Error(`파일이 없습니다: ${s}`);
    return full;
  }
  if (!existsSync(s)) throw new Error(`파일이 없습니다: ${s}`);
  return s;
}

register({
  name: "upload_media",
  description: "미디어 파일(영상/이미지)을 base64로 받아 저장하고 url을 반환한다. 브라우저 업로드는 POST /api/upload(멀티파트)를 쓴다.",
  input_schema: {
    type: "object",
    properties: {
      filename: { type: "string", description: "원본 파일명(확장자 포함)" },
      data_base64: { type: "string", description: "파일 내용 base64" },
    },
    required: ["filename", "data_base64"],
  },
  handler: async ({ filename, data_base64 }) => {
    const bytes = Buffer.from(data_base64, "base64");
    return saveUpload(filename, bytes);
  },
});

register({
  name: "import_pdf",
  description: "PPT(.pptx/.ppt/.odp)·PDF·이미지 파일(서버 경로)을 페이지별 이미지 슬라이드로 예배 순서에 추가한다. 라이브러리 검색 결과 가져오기에도 사용. 브라우저 업로드는 POST /api/import.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      path: { type: "string", description: "서버의 PDF/이미지 파일 경로" },
      position: { type: "integer", description: "삽입 시작 위치(생략 시 맨 끝)" },
    },
    required: ["service_id", "path"],
  },
  handler: async ({ service_id, path, position }, ctx) => {
    if (!ctx.db.query("SELECT id FROM services WHERE id = ?").get(service_id)) throw new Error(`unknown service: ${service_id}`);
    // 렌더 캐시 사용 — 미리 변환(prerender)해둔 자주 쓰는 PPT는 변환 없이 즉시 삽입.
    const slides = await fileToSlidesFromPath(path);
    // 페이지별 add_slide를 반복하지 않고 한 트랜잭션으로 일괄 삽입(이벤트도 import_pdf 1회만).
    const slide_ids = insertSlides(ctx.db, service_id, slides, position);
    return { slide_ids };
  },
});

register({
  name: "set_video_background",
  description: "슬라이드 배경을 영상으로 설정한다(자동재생·음소거·반복 기본). 영상 위에 content 텍스트가 올라간다. " +
    "slide_ids로 여러 장에 같은 영상을 한 번에 깔 수 있고, 연속된 슬라이드가 같은 영상이면 발표 중 되감지 않고 이어서 재생된다.",
  input_schema: {
    type: "object",
    properties: {
      slide_id: { type: "string" },
      slide_ids: { type: "array", items: { type: "string" }, description: "여러 슬라이드에 같은 영상 배경 적용" },
      url: { type: "string", description: "영상 URL (예: /uploads/xxx.mp4)" },
      loop: { type: "boolean", default: true },
      muted: { type: "boolean", default: true },
      overlay_dim: { type: "number", default: 0.4, description: "가독성용 어둡게(0~1)" },
      playback_rate: { type: "number" },
    },
    required: ["url"],
  },
  handler: ({ slide_id, slide_ids, url, loop, muted, overlay_dim, playback_rate }, { db }) => {
    const background = { type: "video", url, loop, muted, overlay_dim };
    if (playback_rate) background.playback_rate = playback_rate;
    const ids = [...new Set([...(slide_ids || []), ...(slide_id ? [slide_id] : [])])];
    if (!ids.length) throw new Error("slide_id 또는 slide_ids가 필요합니다");
    const q = db.query("UPDATE slides SET background = ? WHERE id = ?");
    const services = new Set();
    const tx = db.transaction(() => {
      for (const id of ids) {
        if (q.run(JSON.stringify(background), id).changes === 0) throw new Error(`unknown slide: ${id}`);
        const sid = serviceIdForSlide(db, id);
        if (sid) services.add(sid);
      }
      for (const sid of services) touchService(db, sid);
    });
    tx();
    return { ok: true, background, count: ids.length };
  },
});

// ---- 루프용 영상 만들기 ----
// 이음새가 안 맞는 영상(끝 프레임 ≠ 첫 프레임)은 반복할 때마다 툭 튄다. 발표 중에 손보는
// 게 아니라 미리 한 번 구워서 파일로 만든다 → 발표 때는 그냥 loop, 런타임 비용 0.
// 출력은 항상 H.264/무음이라 코덱 호환(H.265 등) 문제도 같이 해결된다.
register({
  name: "make_loop_video",
  description: "영상을 매끄럽게 반복되는(루프용) 영상으로 변환해 새 파일로 저장하고 url을 반환한다. " +
    "mode=crossfade(기본, 끝과 시작을 디졸브로 겹침 · 물·구름 같은 배경에 자연스러움) 또는 " +
    "pingpong(정방향+역방향 · 이음새 완전 일치, 길이 2배). 출력은 H.264 무음이라 어느 PC에서도 재생된다. " +
    "ffmpeg이 필요하다(없으면 설치 안내).",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "업로드된 영상 URL (예: /uploads/xxx.mp4) 또는 서버의 파일 절대경로" },
      mode: { type: "string", enum: ["crossfade", "pingpong"], default: "crossfade" },
      seconds: { type: "number", default: 1.5, description: "crossfade일 때 겹칠 시간(초). 영상 길이의 1/3로 제한됨" },
    },
    required: ["url"],
  },
  handler: async ({ url, mode, seconds }) => {
    const inPath = resolveVideoPath(url);
    const tmp = join(DATA_DIR, "uploads", `${ulid()}.mp4`);
    const info = await makeLoopVideo(inPath, tmp, { mode: mode || "crossfade", seconds });
    const name = basename(String(url)).replace(extname(String(url)), "");
    return {
      url: `/uploads/${basename(tmp)}`,
      filename: `${name}-loop.mp4`,
      mode: info.mode,
      source_seconds: +info.source.duration.toFixed(2),
      result_seconds: +info.result.duration.toFixed(2),
      source_codec: info.source.codec,
    };
  },
});

// 배경 영상 → 정지 이미지(대표 프레임). 이미지 내보내기가 <video> 대신 이걸 그린다.
// 결과는 render-cache에 캐시(키 = 경로+mtime+시각) → 같은 예배를 여러 번 내보내도 한 번만 뽑는다.
register({
  name: "get_video_poster",
  description: "영상의 대표 프레임을 정지 이미지로 뽑아 url을 반환한다(기본=중간 지점, seconds로 지정 가능). " +
    "이미지로 내보낼 때 배경 영상을 그리는 데 쓴다. 결과는 캐시된다. ffmpeg이 필요하다.",
  read: true,
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "/uploads/… URL 또는 서버 파일 절대경로" },
      seconds: { type: "number", description: "뽑을 지점(초). 생략하면 영상 중간" },
    },
    required: ["url"],
  },
  handler: async ({ url, seconds }) => {
    const inPath = resolveVideoPath(url);
    const mtime = Math.floor(statSync(inPath).mtimeMs);
    const t = Number.isFinite(Number(seconds)) ? Number(seconds) : -1;
    const key = keyFor(inPath, mtime, `poster${t}`);
    const dir = join(DATA_DIR, "render-cache");
    const out = join(dir, `poster-${key}.jpg`);
    if (existsSync(out)) return { url: `/render-cache/${basename(out)}`, cached: true };
    mkdirSync(dir, { recursive: true });
    const r = await extractFrame(inPath, out, t < 0 ? undefined : t);
    return { url: `/render-cache/${basename(out)}`, cached: false, seconds: +r.seconds.toFixed(2) };
  },
});

register({
  name: "probe_video",
  description: "영상 파일의 길이·해상도·코덱을 반환한다(루프 변환·코덱 호환 확인용). ffmpeg(ffprobe)이 필요하다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "/uploads/… URL 또는 서버 파일 절대경로" } },
    required: ["url"],
  },
  handler: async ({ url }) => {
    const info = await probeVideo(resolveVideoPath(url));
    return { ...info, duration: +info.duration.toFixed(2), ffmpeg: ffmpegAvailable() };
  },
});

// ---- 배경 라이브러리 ----
// 자주 쓰는 배경(주로 가사 뒤에 까는 루프 영상)을 이름 붙여 저장해 두고 매주 다시 쓴다.
// 예배가 아니라 앱 전체에 속한다(settings 한 줄에 JSON 배열).
const BG_KEY = "backgrounds";
function readBackgrounds(db) {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(BG_KEY);
  try { return JSON.parse(row?.value || "[]"); } catch { return []; }
}
function writeBackgrounds(db, list) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(BG_KEY, JSON.stringify(list));
}

register({
  name: "list_backgrounds",
  description: "저장해 둔 배경 목록을 반환한다(가사 뒤에 까는 루프 영상 등 자주 쓰는 배경).",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_args, { db }) => ({ backgrounds: readBackgrounds(db) }),
});

register({
  name: "save_background",
  description: "배경을 이름 붙여 라이브러리에 저장한다. 같은 이름이 있으면 덮어쓴다. " +
    "여기 저장한 배경은 편집기 배경 고르기에서 여러 슬라이드에 한 번에 적용할 수 있다.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "표시 이름 (예: 잔잔한 물결 루프)" },
      background: { type: "object", description: "배경 객체(video/image/color/gradient)" },
    },
    required: ["name", "background"],
  },
  handler: ({ name, background }, { db }) => {
    const list = readBackgrounds(db);
    const existing = list.find((b) => b.name === name);
    if (existing) { existing.background = background; }
    else list.push({ id: ulid(), name, background });
    writeBackgrounds(db, list);
    return { ok: true, backgrounds: list };
  },
});

register({
  name: "remove_background",
  description: "배경 라이브러리에서 항목을 제거한다(업로드된 영상 파일 자체는 남는다).",
  input_schema: {
    type: "object",
    properties: { background_id: { type: "string" } },
    required: ["background_id"],
  },
  handler: ({ background_id }, { db }) => {
    const list = readBackgrounds(db);
    const next = list.filter((b) => b.id !== background_id);
    if (next.length === list.length) throw new Error(`unknown background: ${background_id}`);
    writeBackgrounds(db, next);
    return { ok: true };
  },
});
