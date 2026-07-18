// 렌더 캐시 — 자주 쓰는 PPT/PDF의 "변환(LibreOffice→PDF→PNG)" 결과를 저장해두고
// 재가져오기를 빠르게 한다. 슬라이드가 참조하는 실제 이미지는 uploads(영구)에 저장되고,
// 이 캐시는 변환 비용만 줄인다(캐시를 지워도 이미 만든 슬라이드는 안전).
// 키 = sha1(파일경로 + mtime + 렌더너비). 파일이 바뀌면(mtime) 새 키 → 새 폴더.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/render-cache");
const DONE = ".done"; // 렌더 완료 표시(부분 렌더를 히트로 오인하지 않게)

function fileMtime(path) {
  return existsSync(path) ? Math.floor(statSync(path).mtimeMs) : null;
}
function keyFor(path, mtime, width) {
  return createHash("sha1").update(`${path}\n${mtime}\n${width}`).digest("hex").slice(0, 16);
}
function cacheDirFor(path, width) {
  const mtime = fileMtime(path);
  if (mtime == null) return null;
  return join(CACHE_DIR, keyFor(path, mtime, width));
}

// 현재 파일(경로+mtime+너비)이 캐시돼 있는지.
export function isCached(path, width) {
  const dir = cacheDirFor(path, width);
  return !!dir && existsSync(join(dir, DONE));
}

// 캐시 히트면 { ext, buffers }(페이지 이미지, 순서대로), 아니면 null.
// 포맷(png/webp)은 저장된 파일 확장자로 판단(한 폴더는 동일 포맷).
export function getCachedImages(path, width) {
  const dir = cacheDirFor(path, width);
  if (!dir || !existsSync(join(dir, DONE))) return null;
  const pages = readdirSync(dir).filter((f) => f.endsWith(".png") || f.endsWith(".webp")).sort();
  if (!pages.length) return null;
  return { ext: extname(pages[0]), buffers: pages.map((p) => readFileSync(join(dir, p))) };
}

// 페이지 이미지 버퍼 배열을 캐시에 저장(ext=".png"|".webp"). 반환: 페이지 수.
export function putCachedImages(path, width, buffers, ext = ".png") {
  const dir = cacheDirFor(path, width);
  if (!dir) throw new Error(`파일 없음: ${path}`);
  rmSync(dir, { recursive: true, force: true }); // 이전 부분 결과 제거
  mkdirSync(dir, { recursive: true });
  buffers.forEach((buf, i) => {
    writeFileSync(join(dir, `page-${String(i + 1).padStart(4, "0")}${ext}`), buf);
  });
  writeFileSync(join(dir, DONE), ""); // 완료 표시
  return buffers.length;
}
