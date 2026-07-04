#!/usr/bin/env bun
// 무료 웹폰트를 로컬에 내려받아 self-host 한다 (오프라인·예배 중 무중단 원칙).
// 출처: fontsource(jsDelivr) — 패밀리별 subset 결합 woff2(korean/latin) 1파일씩.
// 산출물: data/fonts/files/*.woff2, data/fonts/fonts.css(@font-face), data/fonts/fonts.json(매니페스트).
// 재실행 가능. 실행: bun run scripts/build-fonts.js
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data/fonts");
const FILES = join(OUT, "files");
const CDN = "https://cdn.jsdelivr.net/npm/@fontsource";

// unicode-range: 한글(자모·완성형·CJK기호·전각·한자) / 라틴 기본.
const RANGE = {
  korean: "U+1100-11FF,U+3000-303F,U+3130-318F,U+A960-A97F,U+AC00-D7A3,U+D7B0-D7FF,U+FF00-FFEF,U+3200-32FF,U+4E00-9FFF",
  latin: "U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
};

// 큐레이션: 무료(OFL) 한글·영어 폰트. subsets = 받을 결합 서브셋, weights = 굵기.
const FONTS = [
  // ---- 한글 ----
  { id: "noto-sans-kr",     family: "Noto Sans KR",    label: "노토 산스 (본문)",   category: "sans",    script: "ko", subsets: ["korean", "latin"], weights: [400, 700] },
  { id: "gowun-dodum",      family: "Gowun Dodum",     label: "고운 도담 (깔끔)",   category: "sans",    script: "ko", subsets: ["korean", "latin"], weights: [400] },
  { id: "nanum-myeongjo",   family: "Nanum Myeongjo",  label: "나눔 명조 (명조)",   category: "serif",   script: "ko", subsets: ["korean", "latin"], weights: [400, 700] },
  { id: "song-myung",       family: "Song Myung",      label: "송명 (우아한 명조)", category: "serif",   script: "ko", subsets: ["korean", "latin"], weights: [400] },
  { id: "black-han-sans",   family: "Black Han Sans",  label: "블랙 한 산스 (제목)", category: "display", script: "ko", subsets: ["korean", "latin"], weights: [400] },
  { id: "do-hyeon",         family: "Do Hyeon",        label: "도현 (제목)",        category: "display", script: "ko", subsets: ["korean", "latin"], weights: [400] },
  { id: "jua",              family: "Jua",             label: "주아 (둥근 제목)",   category: "display", script: "ko", subsets: ["korean", "latin"], weights: [400] },
  { id: "gaegu",            family: "Gaegu",           label: "개구 (손글씨)",      category: "hand",    script: "ko", subsets: ["korean", "latin"], weights: [400, 700] },
  { id: "nanum-pen-script", family: "Nanum Pen Script", label: "나눔 펜 (붓글씨)",  category: "hand",    script: "ko", subsets: ["korean", "latin"], weights: [400] },
  // ---- 영어 ----
  { id: "montserrat",       family: "Montserrat",      label: "Montserrat (산스)",  category: "sans",    script: "en", subsets: ["latin"], weights: [400, 700] },
  { id: "roboto",           family: "Roboto",          label: "Roboto (산스)",      category: "sans",    script: "en", subsets: ["latin"], weights: [400, 700] },
  { id: "playfair-display", family: "Playfair Display", label: "Playfair (세리프)", category: "serif",   script: "en", subsets: ["latin"], weights: [400, 700] },
  { id: "bebas-neue",       family: "Bebas Neue",      label: "Bebas Neue (임팩트)", category: "display", script: "en", subsets: ["latin"], weights: [400] },
  { id: "dancing-script",   family: "Dancing Script",  label: "Dancing Script (필기)", category: "hand", script: "en", subsets: ["latin"], weights: [400] },
];

mkdirSync(FILES, { recursive: true });

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

const css = [];
const manifest = [];
let ok = 0, miss = 0;

for (const f of FONTS) {
  const faces = [];
  for (const weight of f.weights) {
    for (const subset of f.subsets) {
      const name = `${f.id}-${subset}-${weight}-normal.woff2`;
      const dest = join(FILES, name);
      if (!existsSync(dest)) {
        const bytes = await download(`${CDN}/${f.id}@5/files/${name}`);
        if (!bytes) { console.warn(`  miss: ${name}`); miss++; continue; }
        writeFileSync(dest, bytes);
      }
      ok++;
      faces.push(
        `@font-face {\n` +
        `  font-family: '${f.family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n` +
        `  src: url('/fonts/files/${name}') format('woff2');\n` +
        `  unicode-range: ${RANGE[subset]};\n}`
      );
    }
  }
  if (faces.length) {
    css.push(`/* ${f.family} (${f.label}) */\n` + faces.join("\n"));
    manifest.push({ id: f.id, family: f.family, label: f.label, category: f.category, script: f.script, weights: f.weights });
  }
}

writeFileSync(join(OUT, "fonts.css"), css.join("\n\n") + "\n");
writeFileSync(join(OUT, "fonts.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n폰트 ${manifest.length}종, 파일 ${ok}개 저장 (누락 ${miss}). → data/fonts/`);
