// Media tools (design §8-2). Video background + media upload.
// import_pptx (F17) is post-MVP (M15) and intentionally not registered yet.
import { register } from "./registry.js";
import { saveUpload } from "../lib/uploads.js";
import { serviceIdForSlide, touchService } from "./_helpers.js";

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
  name: "set_video_background",
  description: "슬라이드 배경을 영상으로 설정한다(자동재생·음소거·반복 기본). 영상 위에 content 텍스트가 올라간다.",
  input_schema: {
    type: "object",
    properties: {
      slide_id: { type: "string" },
      url: { type: "string", description: "영상 URL (예: /uploads/xxx.mp4)" },
      loop: { type: "boolean", default: true },
      muted: { type: "boolean", default: true },
      overlay_dim: { type: "number", default: 0.4, description: "가독성용 어둡게(0~1)" },
      playback_rate: { type: "number" },
    },
    required: ["slide_id", "url"],
  },
  handler: ({ slide_id, url, loop, muted, overlay_dim, playback_rate }, { db }) => {
    const background = { type: "video", url, loop, muted, overlay_dim };
    if (playback_rate) background.playback_rate = playback_rate;
    const r = db.query("UPDATE slides SET background = ? WHERE id = ?").run(JSON.stringify(background), slide_id);
    if (r.changes === 0) throw new Error(`unknown slide: ${slide_id}`);
    const sid = serviceIdForSlide(db, slide_id);
    if (sid) touchService(db, sid);
    return { ok: true, background };
  },
});
