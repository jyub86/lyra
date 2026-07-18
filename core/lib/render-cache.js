// 렌더 캐시 — 자주 쓰는 PPT/PDF를 미리 이미지로 변환해두고 가져오기를 즉시 처리.
// 키 = sha1(파일경로 + mtime + 렌더너비). 파일이 바뀌면(mtime) 새 키 → 새 폴더라
// 이전에 가져간 슬라이드의 이미지는 그대로 유효하다. 캐시 이미지는 /render-cache/ 로 서빙.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/render-cache");
const DONE = ".done"; // 렌더 완료 표시(부분 렌더를 히트로 오인하지 않게)

function fileMtime(path) {
  return existsSync(path) ? Math.floor(statSync(path).mtimeMs) : null;
}
function keyFor(path, mtime, width) {
  return createHash("sha1").update(`${path}\n${mtime}\n${width}`).digest("hex").slice(0, 16);
}

// 캐시 히트면 { key, urls[], dir }, 아니면 null.
export function getCached(path, width) {
  const mtime = fileMtime(path);
  if (mtime == null) return null;
  const key = keyFor(path, mtime, width);
  const dir = join(CACHE_DIR, key);
  if (!existsSync(join(dir, DONE))) return null;
  const pages = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  if (!pages.length) return null;
  return { key, dir, urls: pages.map((p) => `/render-cache/${key}/${p}`) };
}

// 현재 파일(경로+mtime+너비)이 캐시돼 있는지.
export function isCached(path, width) {
  return getCached(path, width) != null;
}

// 페이지 PNG 버퍼 배열을 캐시에 저장하고 { key, urls[] } 반환.
export function putCached(path, width, pngBuffers) {
  const mtime = fileMtime(path);
  if (mtime == null) throw new Error(`파일 없음: ${path}`);
  const key = keyFor(path, mtime, width);
  const dir = join(CACHE_DIR, key);
  rmSync(dir, { recursive: true, force: true }); // 이전 부분 결과 제거
  mkdirSync(dir, { recursive: true });
  const urls = [];
  pngBuffers.forEach((buf, i) => {
    const name = `page-${String(i + 1).padStart(4, "0")}.png`;
    writeFileSync(join(dir, name), buf);
    urls.push(`/render-cache/${key}/${name}`);
  });
  writeFileSync(join(dir, DONE), ""); // 완료 표시
  return { key, urls };
}
