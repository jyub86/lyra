// PNG → WebP 변환(cwebp). 가져온 PPT/PDF 페이지 이미지를 WebP로 저장하면 용량이
// 7~12배 작아진다(투명도 유지, Chrome 네이티브 렌더). cwebp는 선택 외부 도구로,
// 없으면 null을 돌려 호출자가 PNG로 graceful fallback 한다(soffice/poppler와 동일 정책).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function bundleBinDirs() {
  const dirs = [];
  try {
    for (const name of readdirSync(join(ROOT, "tools"))) {
      const base = join(ROOT, "tools", name);
      dirs.push(base, join(base, "bin"), join(base, "Library", "bin"));
    }
  } catch { /* tools/ 없음 */ }
  return dirs;
}

let _cwebp; // 탐지 결과 캐시(undefined=미탐지, null=없음, string=경로)
export function findCwebp() {
  if (_cwebp !== undefined) return _cwebp;
  const win = process.platform === "win32";
  const file = win ? "cwebp.exe" : "cwebp";
  const onPath = Bun.which("cwebp");
  if (onPath) return (_cwebp = onPath);
  const candidates = [];
  if (process.env.LYRA_CWEBP) candidates.push(process.env.LYRA_CWEBP);
  candidates.push(...bundleBinDirs());
  candidates.push(...(win
    ? ["C:\\Program Files\\libwebp\\bin", "C:\\libwebp\\bin"]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]));
  for (const d of candidates) { const p = join(d, file); if (existsSync(p)) return (_cwebp = p); }
  return (_cwebp = null);
}
export function webpAvailable() { return !!findCwebp(); }

// 동시 실행 제한(과도한 프로세스 방지).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

// PNG 버퍼 배열 → WebP 버퍼 배열(품질 q, 0~100). cwebp가 없거나 하나라도 실패하면 null.
export async function pngBuffersToWebp(pngBuffers, quality = 90) {
  const cwebp = findCwebp();
  if (!cwebp) return null;
  const dir = mkdtempSync(join(tmpdir(), "lyra-webp-"));
  try {
    const results = await mapLimit(pngBuffers, 6, async (buf, i) => {
      const inP = join(dir, `i${i}.png`), outP = join(dir, `o${i}.webp`);
      writeFileSync(inP, buf);
      const proc = Bun.spawn([cwebp, "-quiet", "-q", String(quality), inP, "-o", outP], { stdout: "ignore", stderr: "ignore" });
      const code = await proc.exited;
      return code === 0 && existsSync(outP) ? readFileSync(outP) : null;
    });
    return results.every(Boolean) ? results : null; // 하나라도 실패하면 PNG로 폴백
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
