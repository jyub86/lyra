#!/usr/bin/env bun
// 교회 홈페이지(Supabase)에 올라온 최신 주보(교회소식)를 받아 작업 폴더에 펼친다.
//
//   bun run scripts/fetch-bulletin.js            # 최신 1건
//   bun run scripts/fetch-bulletin.js --post 2536  # 특정 글 id
//
// 산출물: data/bulletins/<날짜>/  { bulletin.pdf, page-N.png, meta.json }
// 내용의 기준은 언제나 주보 PDF다. meta.json 의 content(홈페이지 본문)는 사람이 따로 적는 것이라
// 주보와 어긋날 수 있어 교차확인용으로만 쓴다.

import { $ } from "bun";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATEGORY_교회소식 = 2;
const RENDER_DPI = 200; // 눈으로 읽는 용도. 표를 잘라낼 땐 400으로 다시 렌더한다.

// ── .env (SUPABASE_URL / SUPABASE_ANON_KEY) ──────────────────────
function loadEnv() {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) throw new Error(`.env 없음: ${path}`);
  const env = {};
  for (const line of Bun.file(path).text ? require("node:fs").readFileSync(path, "utf8").split("\n") : []) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY"]) {
    if (!env[k]) throw new Error(`.env 에 ${k} 없음`);
  }
  return env;
}

const env = loadEnv();
const headers = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` };

const postArg = process.argv.indexOf("--post");
const query = postArg > -1
  ? `id=eq.${process.argv[postArg + 1]}`
  : `category_id=eq.${CATEGORY_교회소식}&order=created_at.desc&limit=1`;

const res = await fetch(`${env.SUPABASE_URL}/rest/v1/posts?select=*&${query}`, { headers });
if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
const [post] = await res.json();
if (!post) throw new Error("주보 글을 찾지 못했습니다.");

// "2026년 8월 2일 교회소식" → 2026-08-02 (예배 드리는 주일 날짜)
const m = post.title.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
if (!m) throw new Error(`제목에서 날짜를 못 읽음: ${post.title}`);
const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

const outDir = join(ROOT, "data/bulletins", date);
mkdirSync(outDir, { recursive: true });

// 첨부 PDF 내려받기 (public 버킷 URL — 별도 인증 불필요)
const pdfAtt = (post.attachments || []).find((a) => /\.pdf$/i.test(a.url));
if (!pdfAtt) throw new Error(`글 ${post.id}에 PDF 첨부가 없습니다.`);
const pdfPath = join(outDir, "bulletin.pdf");
const pdfRes = await fetch(pdfAtt.url);
if (!pdfRes.ok) throw new Error(`PDF 다운로드 실패 ${pdfRes.status}`);
writeFileSync(pdfPath, Buffer.from(await pdfRes.arrayBuffer()));

// 눈으로 읽을 수 있게 페이지 렌더 (2단 조판이라 텍스트 추출만으론 순서가 섞인다)
await $`pdftoppm -png -r ${RENDER_DPI} ${pdfPath} ${join(outDir, "page")}`.quiet();

const meta = {
  post_id: post.id,
  title: post.title,
  date,                                  // 예배 날짜 (주일)
  posted_at: post.created_at,
  pdf: pdfPath,
  pdf_name: pdfAtt.name,
  content: post.content,                 // 홈페이지 본문(사람이 따로 입력). 교차확인용 — 기준은 PDF
  media_urls: post.media_urls || [],     // 본문 첨부 이미지(저해상도. 슬라이드용은 PDF에서 크롭할 것)
};
writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));

const pages = [...new Bun.Glob("page-*.png").scanSync(outDir)].sort();
console.log(JSON.stringify({ ...meta, out_dir: outDir, pages: pages.map((p) => join(outDir, p)) }, null, 2));
