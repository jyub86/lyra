// Read/grounding tools — LLM이 본문을 확인하고 인용하기 위한 read tools (design §8-1).
import { register } from "./registry.js";
import {
  listBibleBooks, getBiblePassage, searchBible,
  getHymn, searchHymn, getReading, searchReading,
} from "../db/content.js";

register({
  name: "list_bible_books",
  description: "성경 66권 목록(권 순서/이름/약칭/구약신약)을 반환한다.",
  read: true,
  input_schema: { type: "object", properties: {} },
  handler: (_a, { db }) => ({ books: listBibleBooks(db) }),
});

register({
  name: "get_bible_passage",
  description: "성경 본문(책/장/절 범위)의 절 배열을 반환한다(슬라이드 생성 없이 조회만).",
  read: true,
  input_schema: {
    type: "object",
    properties: {
      book: { type: "string" },
      chapter: { type: "integer" },
      verse_start: { type: "integer" },
      verse_end: { type: "integer" },
    },
    required: ["book", "chapter", "verse_start", "verse_end"],
  },
  handler: ({ book, chapter, verse_start, verse_end }, { db }) =>
    getBiblePassage(db, book, chapter, verse_start, verse_end),
});

register({
  name: "search_bible",
  description: "성경 전문 검색. 일치하는 절(책/장/절/본문)을 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", default: 20 } },
    required: ["query"],
  },
  handler: ({ query, limit }, { db }) => ({ results: searchBible(db, query, limit) }),
});

register({
  name: "get_hymn",
  description: "찬송가 번호로 제목과 절별 가사를 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { number: { type: "integer" } },
    required: ["number"],
  },
  handler: ({ number }, { db }) => {
    const hymn = getHymn(db, number);
    if (!hymn) throw new Error(`unknown hymn: ${number}`);
    return hymn;
  },
});

register({
  name: "search_hymn",
  description: "찬송가 제목/가사 검색. 일치하는 번호·제목을 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", default: 20 } },
    required: ["query"],
  },
  handler: ({ query, limit }, { db }) => ({ results: searchHymn(db, query, limit) }),
});

register({
  name: "get_reading",
  description: "교독문 번호로 제목과 segment(인도자/회중/다같이) 배열을 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { number: { type: "integer" } },
    required: ["number"],
  },
  handler: ({ number }, { db }) => {
    const reading = getReading(db, number);
    if (!reading) throw new Error(`unknown reading: ${number}`);
    return reading;
  },
});

register({
  name: "search_reading",
  description: "교독문 본문 검색. 일치하는 번호·제목을 반환한다.",
  read: true,
  input_schema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", default: 20 } },
    required: ["query"],
  },
  handler: ({ query, limit }, { db }) => ({ results: searchReading(db, query, limit) }),
});
