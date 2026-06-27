// Content slide tools — 1차 LLM/CLI API (design §9). In v4 these delegate to
// apply_template(builtin-*) so generated slides inherit the (editable) template
// design and auto-split. The input_schemas here also define the built-in
// templates' params (seedBuiltins derives them).
import { register, execute } from "./registry.js";

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
