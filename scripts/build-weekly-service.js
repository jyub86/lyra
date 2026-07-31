#!/usr/bin/env bun
// 주보 스펙(JSON) → 그 주 예배 순서 생성. Base 예배를 복제한 뒤 바뀐 부분만 갈아끼운다.
//
//   bun run scripts/build-weekly-service.js spec.json [--base <service_id>] [--dry-run]
//
// 해석(주보 PDF 읽기)은 호출자(LLM)가 하고, 이 스크립트는 조립만 결정적으로 한다.
// 슬라이드는 인덱스가 아니라 **순서 제목 텍스트 + 몇 번째인지**로 찾으므로 Base가 조금 바뀌어도 버틴다.
// 스펙에 없는 항목(찬양대 가사·새가족·설교 인용 성구)은 손대지 않고 TODO로 보고한다.

import { $ } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = new URL("../adapters/cli.js", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const HYMN_DIR = "/Users/jisubpark/church/ppt/찬양/새찬송가_WIDE";
const BASE_DEFAULT = "01KYV7ZMR39E2HHSTFQ42DDT35"; // "2026-07-19 주일오전예배 Base"

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith("--"));
if (!specPath) die("사용법: build-weekly-service.js <spec.json> [--base <service_id>] [--dry-run]");
const BASE = valueOf("--base") || BASE_DEFAULT;
const DRY = args.includes("--dry-run");

const spec = JSON.parse(await Bun.file(specPath).text());
for (const k of ["date", "hymn1", "hymn2", "reading", "scripture", "sermon"]) {
  if (!spec[k]) die(`스펙에 '${k}' 없음`);
}

async function call(name, a) {
  const out = await $`bun run ${CLI} call ${name} --json ${JSON.stringify(a)}`.cwd(ROOT).text();
  return JSON.parse(out);
}

// ── 슬라이드 찾기: 순서 제목(가장 큰 text 요소)이 label 인 n번째 슬라이드 ──
function titleOf(slide) {
  const t = (slide.elements || []).filter((e) => e.type === "text" && e.text);
  if (!t.length) return null;
  return t.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a)).text.replace(/\s+/g, "");
}
function makeFinder(slides) {
  return (label, nth = 0) => {
    const key = label.replace(/\s+/g, "");
    const hits = slides.filter((s) => titleOf(s) === key);
    if (!hits[nth]) die(`Base에서 '${label}' ${nth + 1}번째 슬라이드를 못 찾음 — Base 구조가 바뀌었는지 확인하세요.`);
    return hits[nth];
  };
}

// 텍스트 교체 시 html(부분 서식)은 지운다 — 렌더러가 html을 우선하기 때문
function setText(el, next) { el.text = next; delete el.html; }
// 슬라이드 안에서 n번째로 '작은 글씨' 텍스트(=캡션/부제) 요소
function captionEls(slide) {
  const t = (slide.elements || []).filter((e) => e.type === "text");
  const max = Math.max(...t.map((e) => e.size || 0));
  return t.filter((e) => (e.size || 0) < max);
}

// ── 0. Base 사전 점검 + 백업 ────────────────────────────────────
// 편집기 실행취소(undo)는 set_service_slides로 예배 전체를 지우고 그 탭의 스냅샷으로 덮어쓴다.
// 낡은 탭이 열려 있으면 Base가 조용히 망가질 수 있어서, 복제 전에 모양을 확인하고 백업을 남긴다.
const REQUIRED = ["묵도", "교독문", "신앙고백", "헌금봉헌", "교회소식", "성경봉독", "말씀선포", "축도"];
{
  const b = await call("get_service", { service_id: BASE });
  const titles = new Set(b.slides.map((s) => titleOf(s)).filter(Boolean));
  const missing = REQUIRED.filter((r) => !titles.has(r.replace(/\s+/g, "")));
  if (missing.length) die(`Base(${BASE})에 순서 슬라이드가 없습니다: ${missing.join(", ")}\n` +
    `편집기 탭의 실행취소로 Base가 훼손됐을 수 있습니다. data/base-backups/ 의 최신 백업과 비교하세요.`);

  const dir = join(ROOT, "data/base-backups");
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `${spec.date}.json`);
  writeFileSync(backup, JSON.stringify(await call("export_service", { service_id: BASE }), null, 2));
  console.log(`Base 점검 OK (${b.slides.length}장) · 백업 → ${backup}`);
}

// ── 1. Base 복제 ────────────────────────────────────────────────
const title = `${spec.date} 주일오전예배`;
if (DRY) console.log(`[dry-run] duplicate_service(${BASE}) → "${title}"`);
const svc = DRY ? { service_id: "DRY" } : await call("duplicate_service", { service_id: BASE, title });
const SVC = svc.service_id;
if (!DRY) await call("update_service", { service_id: SVC, fields: { date: spec.date, worship_part: "1부" } });
console.log(`예배 생성: ${title}  (${SVC})`);

const base = DRY ? await call("get_service", { service_id: BASE })
                 : await call("get_service", { service_id: SVC });
const find = makeFinder(base.slides);
const edits = [];   // [slide, 설명]
const queue = [];   // update_slide 호출 목록

function edit(slide, desc, mutate) {
  const els = structuredClone(slide.elements);
  mutate(els);
  queue.push({ slide_id: slide.id, fields: { elements: els } });
  edits.push(desc);
}

// ── 2. 텍스트만 바뀌는 순서 슬라이드 ────────────────────────────
// 찬송 슬라이드는 제목이 "찬송 NN장"이라 매주 달라진다 → 접두사로 찾는다.
// 주제찬송("주제찬송")은 접두사가 달라 걸리지 않는다.
function findByPrefix(prefix, nth = 0) {
  const hits = base.slides.filter((s) => (titleOf(s) || "").startsWith(prefix.replace(/\s+/g, "")));
  if (!hits[nth]) die(`Base에서 '${prefix}' ${nth + 1}번째를 못 찾음`);
  return hits[nth];
}

const hymnSlides = [findByPrefix("찬송", 0), findByPrefix("찬송", 1)];
for (const [i, h] of [spec.hymn1, spec.hymn2].entries()) {
  edit(hymnSlides[i], `찬송 ${h.number}장 "${h.title}"`, (els) => {
    const big = els.filter((e) => e.type === "text").reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a));
    setText(big, `찬송 ${h.number}장`);
    const caps = els.filter((e) => e.type === "text" && e !== big);
    setText(caps[caps.length - 1], `"${h.title}"`);   // 마지막 = 곡 제목
  });
}

edit(find("교 독 문"), `교독문 ${spec.reading.number}. ${spec.reading.title}`, (els) => {
  const caps = captionEls({ elements: els });
  setText(caps[caps.length - 1], `${spec.reading.number}. ${spec.reading.title}`);
});

if (spec.prayer) {
  edit(find("기 도", 0), `기도 1부 ${spec.prayer.part1}`, (els) => setText(captionEls({ elements: els })[0], spec.prayer.part1));
  edit(find("기 도", 1), `기도 2부 ${spec.prayer.part2}`, (els) => setText(captionEls({ elements: els })[0], spec.prayer.part2));
}
if (spec.offering) {
  edit(find("헌금봉헌", 0), `헌금봉헌 1부 ${spec.offering.part1}`, (els) => setText(captionEls({ elements: els })[0], spec.offering.part1));
  edit(find("헌금봉헌", 1), `헌금봉헌 2부 ${spec.offering.part2}`, (els) => setText(captionEls({ elements: els })[0], spec.offering.part2));
}

const sc = spec.scripture;
edit(find("성경봉독"), `성경봉독 ${sc.ref_text}`, (els) => {
  setText(captionEls({ elements: els })[0], `${sc.ref_text}\n${sc.page_text}`);
});

if (spec.choir) {
  for (const [i, c] of [spec.choir.part1, spec.choir.part2].entries()) {
    if (!c) continue;
    edit(find("찬 양", i), `찬양 ${i + 1}부 ${c.team} "${c.song}"`, (els) => {
      const caps = captionEls({ elements: els });
      setText(caps[0], c.team);
      setText(caps[caps.length - 1], `"${c.song}"`);
    });
  }
}

edit(find("말씀선포"), `말씀선포 "${spec.sermon.title}"`, (els) => {
  const texts = els.filter((e) => e.type === "text");
  const big = texts.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a));
  const rest = texts.filter((e) => e !== big);
  setText(rest[0], `"${spec.sermon.title}"`);                                   // 설교 제목
  setText(rest[1], `${sc.ref_text}\n${spec.sermon.preacher}`);                  // 본문 + 설교자
  setText(rest[2], kdate(spec.date));                                           // 2026年 8月 2日
});

for (const q of queue) if (!DRY) await call("update_slide", q);
edits.forEach((e) => console.log("  ✓", e));

// ── 3. 광고(교회소식) 슬라이드 재구성 ───────────────────────────
const annSlides = base.slides.filter((s) => {
  const t = (s.elements || []).filter((e) => e.type === "text");
  // 순서 슬라이드가 아니라 '가로선 2개 + 왼쪽정렬 본문' 형태 = 광고
  return t.length === 1 && t[0].align === "left" && (s.elements || []).filter((e) => e.type === "shape").length === 2;
});
let annIds = [];
if (spec.announcements?.length) {
  const tmplText = annSlides.find((s) => !s.elements.some((e) => e.type === "image")) || annSlides[0];
  const tmplImage = annSlides.find((s) => s.elements.some((e) => e.type === "image"));
  for (const a of spec.announcements) {
    const src = a.image ? (tmplImage || tmplText) : tmplText;
    const els = structuredClone(src.elements);
    setText(els.find((e) => e.type === "text"), a.text);
    const img = els.find((e) => e.type === "image");
    if (a.image) {
      const up = DRY ? { url: "/uploads/DRY.png" }
        : await call("upload_media", { filename: `ann-${spec.date}.png`, data_base64: Buffer.from(await Bun.file(a.image).arrayBuffer()).toString("base64") });
      if (img) img.url = up.url;
    } else if (img) els.splice(els.indexOf(img), 1);
    const r = DRY ? { slide_id: "DRY" } : await call("add_slide", { service_id: SVC, elements: els });
    annIds.push(r.slide_id);
    console.log("  ✓ 광고:", a.text.split("\n")[0].slice(0, 40));
  }
}

// ── 4. 매주 새로 만드는 블록: 찬송 악보 · 교독문 · 성경봉독 ─────
const drop = new Set(annSlides.map((s) => s.id));
const blocks = {};
for (const [key, spec_] of [["hymn1", spec.hymn1], ["hymn2", spec.hymn2]]) {
  const path = `${HYMN_DIR}/${String(spec_.number).padStart(3, "0")}장.pptx`;
  if (!(await Bun.file(path).exists())) die(`찬송 악보 없음: ${path}`);
  blocks[key] = DRY ? [] : (await call("import_pdf", { service_id: SVC, path })).slide_ids;
  console.log(`  ✓ 찬송 ${spec_.number}장 악보 ${blocks[key].length}장`);
}
blocks.reading = DRY ? [] : (await call("add_reading_slides", { service_id: SVC, number: spec.reading.number })).slide_ids;
console.log(`  ✓ 교독문 ${spec.reading.number}번 ${blocks.reading.length}장`);
blocks.bible = DRY ? [] : (await call("add_bible_slides", {
  service_id: SVC, book: sc.book, chapter: sc.chapter,
  verse_start: sc.verse_start, verse_end: sc.verse_end, layout: sc.layout || "one-per-verse",
})).slide_ids;
console.log(`  ✓ 성경봉독 ${sc.ref_text} ${blocks.bible.length}장`);

// Base에서 가져온 옛 블록(악보/교독문/성경) 삭제 대상 표시
markOldBlock(hymnSlides[0], drop);
markOldBlock(find("교 독 문"), drop);
markOldBlock(hymnSlides[1], drop);
markOldBlock(find("성경봉독"), drop);

// ── 5. 재정렬: Base 순서를 따라가되 삭제분은 빼고 새 블록을 끼운다 ──
const insertAfter = new Map([
  [hymnSlides[0].id, blocks.hymn1],
  [find("교 독 문").id, blocks.reading],
  [hymnSlides[1].id, blocks.hymn2],
  [find("성경봉독").id, blocks.bible],
  [find("교회소식").id, annIds],
]);
const order = [];
for (const s of base.slides) {
  if (drop.has(s.id)) continue;
  order.push(s.id);
  if (insertAfter.has(s.id)) order.push(...insertAfter.get(s.id));
}

if (!DRY) {
  for (const id of drop) await call("remove_slide", { slide_id: id });
  await call("reorder_slides", { service_id: SVC, ordered_slide_ids: order });
}
console.log(`\n삭제 ${drop.size}장 · 최종 ${order.length}장`);

// ── 6. 주보로는 알 수 없어 손대지 않은 것 보고 ──────────────────
// Base에 실제로 남아 있는 것만 보고한다(사용자가 Base에서 뺀 자리는 언급하지 않음).
const todo = [];
if (spec.choir && countAfter(find("찬 양", 0), (s) => !titleOf(s)))
  todo.push(`찬양대 가사 (${spec.choir.part1?.song ?? "1부"} / ${spec.choir.part2?.song ?? "2부"}) — 크로마키 가사 슬라이드는 지난주 곡 그대로`);
if (base.slides.some((s) => titleOf(s) === "새가족")) todo.push("새가족 명단 — 주보에 없음");
if (countAfter(find("말씀선포"), (s) => (s.elements || []).some((e) => e.type === "bible")))
  todo.push("설교 인용 성구 — 지난주 설교 것 그대로");

if (todo.length) {
  console.log(`\n손대지 않음 — 확인 필요:`);
  todo.forEach((t) => console.log("  ·", t));
}
console.log(`\n편집기: http://localhost:4321/editor/  (예배 선택: ${title})`);

// ── helpers ─────────────────────────────────────────────────────
// 순서 슬라이드 바로 뒤에 붙어 있던 옛 블록(이미지 악보/교독문/성경 본문)을 삭제 대상에 넣는다
function markOldBlock(anchor, set) {
  const i = base.slides.findIndex((s) => s.id === anchor.id);
  for (let j = i + 1; j < base.slides.length; j++) {
    const els = base.slides[j].elements || [];
    const kind = els.map((e) => e.type);
    const isBlock = kind.includes("image") || kind.includes("reading") || kind.includes("bible");
    const isSectionSlide = titleOf(base.slides[j]) && !kind.includes("image");
    if (!isBlock || isSectionSlide) break;
    set.add(base.slides[j].id);
  }
}
// anchor 바로 뒤에 pred를 만족하는 슬라이드가 몇 장 이어지는지 (다음 순서 슬라이드 전까지)
function countAfter(anchor, pred) {
  const i = base.slides.findIndex((s) => s.id === anchor.id);
  let n = 0;
  for (let j = i + 1; j < base.slides.length && pred(base.slides[j]); j++) n++;
  return n;
}
function kdate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y}年 ${m}月 ${d}日`;
}
function valueOf(flag) { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : null; }
function die(msg) { console.error("에러:", msg); process.exit(1); }
