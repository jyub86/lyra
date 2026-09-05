// Content slide tools — 1차 LLM/CLI API (design §9). In v4 these delegate to
// apply_template(builtin-*) so generated slides inherit the (editable) template
// design and auto-split. The input_schemas here also define the built-in
// templates' params (seedBuiltins derives them).
import { register, execute } from "./registry.js";
import { getSong } from "../db/content.js";

register({
  name: "add_bible_slides",
  description: "성경 본문(책/장/절 범위)을 예배 순서에 추가한다. 절 수에 따라 자동 분할되고 성경 템플릿 디자인이 적용된다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      book: { type: "string", description: "책 이름 또는 약칭 (예: 요한복음, 요)" },
      chapter: { type: "integer" },
      verse_start: { type: "integer" },
      verse_end: { type: "integer" },
      layout: { type: "string", enum: ["auto", "one-per-verse", "all-in-one"], default: "auto" },
    },
    required: ["service_id", "book", "chapter", "verse_start", "verse_end"],
  },
  handler: ({ service_id, book, chapter, verse_start, verse_end, layout }, ctx) =>
    execute("apply_template", { template_id: "builtin-bible", service_id, params: { book, chapter, verse_start, verse_end, layout } }, ctx),
});

register({
  name: "add_hymn_slides",
  description: "찬송가 번호를 받아 가사 슬라이드를 예배 순서에 추가한다(찬송가 템플릿 디자인 적용).",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      number: { type: "integer", description: "찬송가 번호" },
      verse_nos: { type: "array", items: { type: "integer" }, description: "표시할 절 번호(생략 시 전체)" },
      lines_per_slide: { type: "integer", default: 4 },
    },
    required: ["service_id", "number"],
  },
  handler: ({ service_id, number, verse_nos, lines_per_slide }, ctx) =>
    execute("apply_template", { template_id: "builtin-hymn", service_id, params: { number, verse_nos, lines_per_slide } }, ctx),
});

register({
  name: "add_reading_slides",
  description: "교독문 번호를 받아 교독문 슬라이드를 예배 순서에 추가한다(교독문 템플릿 디자인 적용).",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      number: { type: "integer", description: "교독문 번호" },
      segments_per_slide: { type: "integer", default: 2 },
    },
    required: ["service_id", "number"],
  },
  handler: ({ service_id, number, segments_per_slide }, ctx) =>
    execute("apply_template", { template_id: "builtin-reading", service_id, params: { number, segments_per_slide } }, ctx),
});

register({
  name: "add_praise_slides",
  description:
    "찬양팀 찬양 가사를 구조화된 sections로 받아 예배 순서에 슬라이드로 추가한다. " +
    "sections=[{label, lines:[...]}]. 지저분한 가사 해석은 호출자(LLM)가 담당한다(내부 파서 없음).",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      title: { type: "string" },
      sections: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, lines: { type: "array", items: { type: "string" } } }, required: ["lines"] },
      },
      lines_per_slide: { type: "integer", default: 2 },
    },
    required: ["service_id", "title", "sections"],
  },
  handler: ({ service_id, sections, lines_per_slide }, ctx) => {
    const lyrics = (sections || []).flatMap((s) => s.lines || []).join("\n");
    return execute("apply_template", { template_id: "builtin-praise", service_id, params: { lyrics, lines_per_slide } }, ctx);
  },
});

// 추출해 둔 찬양 가사를 슬라이드로 넣는다. 기본은 **원본 PPT의 슬라이드 나눔 그대로**
// (한 장씩 그대로 재현) — keep_pages=false로 주면 줄만 이어붙여 lines_per_slide로 다시 나눈다.
// 디자인은 template_id(기본 builtin-praise, 또는 내가 만든 가사 템플릿)에서 온다.
register({
  name: "add_song_slides",
  description: "추출해 둔 찬양 가사(song_id)를 예배 순서에 가사 슬라이드로 추가한다. " +
    "기본은 원본 PPT의 장 나눔을 그대로 재현하고, keep_pages=false면 lines_per_slide로 다시 나눈다. " +
    "template_id로 디자인(내가 만든 가사 템플릿 등)을 고를 수 있고 style로 이번만 서식을 덮어쓸 수 있다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      song_id: { type: "integer", description: "search_song / list_songs 로 찾은 곡 id" },
      template_id: { type: "string", default: "builtin-praise", description: "가사 디자인 템플릿" },
      keep_pages: { type: "boolean", default: true, description: "원본 PPT의 장 나눔 유지" },
      lines_per_slide: { type: "integer", default: 2, description: "keep_pages=false일 때 한 장에 담을 줄 수" },
      position: { type: "integer" },
      style: { type: "object", description: "본문 서식 덮어쓰기 (apply_template의 style과 동일)" },
    },
    required: ["service_id", "song_id"],
  },
  handler: async ({ service_id, song_id, template_id, keep_pages, lines_per_slide, position, style }, ctx) => {
    const song = getSong(ctx.db, song_id);
    if (!song) throw new Error(`unknown song: ${song_id}`);
    const tpl = template_id || "builtin-praise";
    // 장 나눔을 유지할 때는 장마다 apply_template을 한 번씩 불러(한 장씩) 원본 구성을 그대로 만든다.
    // 이어붙이면 lines_per_slide 규칙이 원본 나눔을 뭉개기 때문.
    const slide_ids = [];
    let pos = position;
    if (keep_pages !== false) {
      for (const lines of song.lyrics) {
        const r = await execute("apply_template", {
          template_id: tpl, service_id, position: pos, style,
          params: { lyrics: lines.join("\n"), lines_per_slide: lines.length || 1 },
        }, ctx);
        slide_ids.push(...(r.slide_ids || []));
        if (pos != null) pos += (r.slide_ids || []).length;
      }
    } else {
      const r = await execute("apply_template", {
        template_id: tpl, service_id, position: pos, style,
        params: { lyrics: song.lyrics.flat().join("\n"), lines_per_slide: lines_per_slide || 2 },
      }, ctx);
      slide_ids.push(...(r.slide_ids || []));
    }
    return { slide_ids, title: song.title, pages: song.lyrics.length };
  },
});

register({
  name: "add_announcement_slide",
  description: "광고 항목 배열을 받아 광고 슬라이드를 예배 순서에 추가한다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      title: { type: "string", default: "광고" },
    },
    required: ["service_id", "items"],
  },
  handler: ({ service_id, items }, ctx) =>
    execute("apply_template", { template_id: "builtin-announcement", service_id, params: { items } }, ctx),
});
