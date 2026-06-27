// Content slide-generation tools — 고가치, LLM이 주로 사용 (design §8-2).
// Each fetches structured content from the DB, splits it deterministically,
// and appends the resulting slides to a service's order.
import { register } from "./registry.js";
import { insertSlides } from "./slide.tools.js";
import { getBiblePassage, getHymn, getReading } from "../db/content.js";
import { splitBible, splitHymn, splitReading, splitPraise } from "../splitter.js";

function requireService(db, serviceId) {
  if (!db.query("SELECT id FROM services WHERE id = ?").get(serviceId)) {
    throw new Error(`unknown service: ${serviceId}`);
  }
}

register({
  name: "add_bible_slides",
  description: "지정한 성경 본문(책/장/절 범위)을 예배 순서에 본문 슬라이드로 추가한다. 절 수에 따라 자동 분할된다.",
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
  handler: ({ service_id, book, chapter, verse_start, verse_end, layout }, { db }) => {
    requireService(db, service_id);
    const passage = getBiblePassage(db, book, chapter, verse_start, verse_end);
    if (passage.verses.length === 0) throw new Error(`no verses found for ${book} ${chapter}:${verse_start}-${verse_end}`);
    const pages = splitBible(passage.verses, layout, {
      book_name: passage.book_name, short_name: passage.short_name, chapter,
    });
    const slides = pages.map((data) => ({ template_type: "bible", data }));
    return { slide_ids: insertSlides(db, service_id, slides) };
  },
});

register({
  name: "add_hymn_slides",
  description: "찬송가 번호를 받아 가사 슬라이드를 예배 순서에 추가한다. 절 선택과 슬라이드당 줄 수를 지정할 수 있다.",
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
  handler: ({ service_id, number, verse_nos, lines_per_slide }, { db }) => {
    requireService(db, service_id);
    const hymn = getHymn(db, number);
    if (!hymn) throw new Error(`unknown hymn: ${number}`);
    const pages = splitHymn(hymn, verse_nos, lines_per_slide);
    const slides = pages.map((data) => ({ template_type: "hymn", data }));
    return { slide_ids: insertSlides(db, service_id, slides) };
  },
});

register({
  name: "add_reading_slides",
  description: "교독문 번호를 받아 교독문 슬라이드를 예배 순서에 추가한다(인도자/회중 교대로 분할).",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      number: { type: "integer", description: "교독문 번호" },
      segments_per_slide: { type: "integer", default: 2 },
    },
    required: ["service_id", "number"],
  },
  handler: ({ service_id, number, segments_per_slide }, { db }) => {
    requireService(db, service_id);
    const reading = getReading(db, number);
    if (!reading) throw new Error(`unknown reading: ${number}`);
    const pages = splitReading(reading, segments_per_slide);
    const slides = pages.map((data) => ({ template_type: "responsive_reading", data }));
    return { slide_ids: insertSlides(db, service_id, slides) };
  },
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
        description: "[{ label, lines:[...] }]",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            lines: { type: "array", items: { type: "string" } },
          },
          required: ["lines"],
        },
      },
      lines_per_slide: { type: "integer", default: 2 },
    },
    required: ["service_id", "title", "sections"],
  },
  handler: ({ service_id, title, sections, lines_per_slide }, { db }) => {
    requireService(db, service_id);
    const pages = splitPraise(title, sections, lines_per_slide);
    const slides = pages.map((data) => ({ template_type: "praise", data }));
    return { slide_ids: insertSlides(db, service_id, slides) };
  },
});

register({
  name: "add_announcement_slide",
  description: "광고 항목 배열을 받아 광고 슬라이드 하나를 예배 순서에 추가한다.",
  input_schema: {
    type: "object",
    properties: {
      service_id: { type: "string" },
      items: { type: "array", items: { type: "string" }, description: "광고 항목들" },
      title: { type: "string", default: "광고" },
    },
    required: ["service_id", "items"],
  },
  handler: ({ service_id, items, title }, { db }) => {
    requireService(db, service_id);
    return { slide_ids: insertSlides(db, service_id, [{ template_type: "announcement", data: { title, items } }]) };
  },
});
