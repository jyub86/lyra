// poppler 실행파일(pdftoppm/pdftotext/pdfinfo) 경로 탐지.
// PATH 편집 없이도 쓰도록 여러 위치를 확인한다(특히 Windows에서 PATH 등록이 진입장벽):
//   1) PATH  2) LYRA_POPPLER(=bin 폴더)  3) 프로젝트 tools/ 아래 압축 푼 poppler  4) 일반 설치 위치
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../.."); // project root

// tools/ 안에 압축 푼 poppler의 bin 후보 (poppler-windows: <폴더>/Library/bin)
function bundleBinDirs() {
  const dirs = [];
  try {
    for (const name of readdirSync(join(ROOT, "tools"))) {
      const base = join(ROOT, "tools", name);
      dirs.push(base, join(base, "bin"), join(base, "Library", "bin"));
    }
  } catch {}
  return dirs;
}

export function findPoppler(exe) {
  const win = process.platform === "win32";
  const file = win ? `${exe}.exe` : exe;
  const onPath = Bun.which(exe);
  if (onPath) return onPath;
  const candidates = [];
  if (process.env.LYRA_POPPLER) candidates.push(process.env.LYRA_POPPLER);
  candidates.push(...bundleBinDirs());
  candidates.push(
    ...(win
      ? ["C:\\Program Files\\poppler\\Library\\bin", "C:\\poppler\\Library\\bin", "C:\\Program Files\\poppler\\bin"]
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]),
  );
  for (const d of candidates) {
    const p = join(d, file);
    if (existsSync(p)) return p;
  }
  return null;
}

export function popplerAvailable() { return !!findPoppler("pdftoppm"); }
