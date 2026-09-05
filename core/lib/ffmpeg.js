// 배경 영상 손질(ffmpeg) — 이음새가 안 맞는 영상을 "루프처럼" 만든다.
// 가사 뒤에 영상을 깔면 발표 중 계속 반복되는데, 끝 프레임과 첫 프레임이 다르면 되감길
// 때마다 툭 튄다. 여기서 한 번 구워두면 발표 때는 그냥 loop만 하면 된다(런타임 비용 0).
// ffmpeg는 선택 외부 도구 — 없으면 명확한 안내로 graceful (soffice/poppler/cwebp와 동일 정책).
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function bundleBinDirs() {
  const dirs = [];
  try {
    for (const name of readdirSync(join(ROOT, "tools"))) {
      const base = join(ROOT, "tools", name);
      dirs.push(base, join(base, "bin"));
    }
  } catch { /* tools/ 없음 */ }
  return dirs;
}

const cache = {};
// name = "ffmpeg" | "ffprobe" (둘은 항상 같이 설치된다)
export function findFfmpeg(name = "ffmpeg") {
  if (cache[name] !== undefined) return cache[name];
  const win = process.platform === "win32";
  const file = win ? `${name}.exe` : name;
  const onPath = Bun.which(name);
  if (onPath) return (cache[name] = onPath);
  const candidates = [];
  if (process.env.LYRA_FFMPEG) candidates.push(dirname(process.env.LYRA_FFMPEG));
  candidates.push(...bundleBinDirs());
  candidates.push(...(win
    ? ["C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin", "C:\\Program Files (x86)\\ffmpeg\\bin"]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]));
  for (const d of candidates) { const p = join(d, file); if (existsSync(p)) return (cache[name] = p); }
  return (cache[name] = null);
}
export function ffmpegAvailable() { return !!findFfmpeg("ffmpeg") && !!findFfmpeg("ffprobe"); }

const NEED = "ffmpeg이 필요합니다. macOS: `brew install ffmpeg` · Windows: ffmpeg.exe·ffprobe.exe를 " +
  "받아 PATH에 넣거나 Lyra의 tools/ 폴더에 두세요(또는 LYRA_FFMPEG 환경변수로 경로 지정).";

async function run(bin, args) {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

// 영상 정보 — 길이·해상도·코덱. 루프 recipe가 길이를 알아야 한다.
export async function probeVideo(path) {
  const ffprobe = findFfmpeg("ffprobe");
  if (!ffprobe) throw new Error(NEED);
  const { out, code, err } = await run(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name,r_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json", path,
  ]);
  if (code !== 0) throw new Error(`영상 정보를 읽지 못했습니다: ${err.trim().split("\n").pop() || code}`);
  let info;
  try { info = JSON.parse(out); } catch { throw new Error("영상 정보를 읽지 못했습니다"); }
  const s = info.streams?.[0];
  if (!s) throw new Error("영상 트랙이 없습니다(이미지 파일인가요?)");
  const duration = Number(info.format?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: s.width, height: s.height, codec: s.codec_name,
    fps: s.r_frame_rate,
  };
}

// 영상의 한 프레임을 정지 이미지(JPEG)로 뽑는다.
// 이미지 내보내기가 쓴다 — 헤드리스 크롬의 --print-to-pdf 는 --virtual-time-budget 이
// 미디어 디코드를 기다려주지 않아 <video>가 첫 프레임(보통 검정)으로 찍히거나 아예 비어
// 나온다. 그래서 배경 영상은 미리 정지 이미지로 바꿔 <img>로 그린다(이 경로는 안정적).
export async function extractFrame(inPath, outPath, seconds) {
  const ffmpeg = findFfmpeg("ffmpeg");
  if (!ffmpeg) throw new Error(NEED);
  let t = Number(seconds);
  if (!Number.isFinite(t) || t < 0) {
    const info = await probeVideo(inPath);
    // 중간 지점 — 앞뒤가 검정(페이드 인/아웃)이어도 대표적인 그림이 나온다.
    t = info.duration > 0 ? info.duration / 2 : 0;
  }
  // -ss 를 -i 앞에 두면 키프레임 단위로 빠르게 점프한다(정확도보다 속도).
  const { code, err } = await run(ffmpeg, [
    "-y", "-ss", t.toFixed(3), "-i", inPath, "-frames:v", "1",
    "-q:v", "3", "-an", outPath,
  ]);
  if (code !== 0 || !existsSync(outPath)) {
    throw new Error(`프레임 추출 실패: ${err.trim().split("\n").slice(-1)[0] || code}`);
  }
  return { seconds: t };
}

// 출력은 항상 H.264/yuv420p/무음 — 어느 PC(윈도우 방송실 포함)에서도 재생되는 조합.
// 배경 영상은 소리를 쓰지 않으므로 오디오는 버린다.
const ENCODE = ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

// mode:
//  "crossfade" — 끝 N초를 첫 N초에 디졸브해 겹친다. 결과 길이 = 원본 - N.
//     물·구름·보케처럼 방향성 없는 배경에 가장 자연스럽다(권장).
//  "pingpong"  — 정방향 + 역방향. 결과 길이 ≈ 2배, 이음새는 완전히 일치.
//     되돌아가는 게 티 나지만(글자·사람·한 방향으로 흐르는 것) 어떤 영상이든 확실히 이어진다.
export async function makeLoopVideo(inPath, outPath, { mode = "crossfade", seconds = 1.5 } = {}) {
  const ffmpeg = findFfmpeg("ffmpeg");
  if (!ffmpeg) throw new Error(NEED);
  const info = await probeVideo(inPath);
  const D = info.duration;
  if (!(D > 0)) throw new Error("영상 길이를 알 수 없습니다");

  let filter;
  if (mode === "pingpong") {
    // reverse는 영상을 전부 메모리에 올린다 → 너무 긴 영상은 막는다.
    if (D > 60) throw new Error(`왕복 방식은 60초 이하만 가능합니다(이 영상 ${D.toFixed(1)}초). 디졸브 방식을 쓰거나 먼저 잘라주세요.`);
    // 역방향의 첫 프레임은 정방향 끝 프레임과 같으므로 1프레임 버려 멈칫함을 없앤다.
    filter = "[0:v]split[a][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];" +
             "[a][r]concat=n=2:v=1:a=0[out]";
  } else {
    // 겹치는 구간은 영상 길이의 1/3을 넘지 않게(그러면 원본이 거의 안 남는다).
    const N = Math.max(0.2, Math.min(Number(seconds) || 1.5, D / 3));
    const bodyEnd = D - N;
    if (!(bodyEnd > N)) throw new Error(`영상이 너무 짧아 디졸브할 수 없습니다(${D.toFixed(1)}초). 왕복 방식을 써보세요.`);
    const f = (v) => v.toFixed(3);
    // body(N ~ D-N) 뒤에 [끝 N초 → 첫 N초] 디졸브를 붙인다. 디졸브가 끝나는 지점은
    // 원본 N초 지점 = body의 시작과 같은 그림 → 되감겨도 이음새가 보이지 않는다.
    filter =
      "[0:v]split=3[v1][v2][v3];" +
      `[v1]trim=start=${f(N)}:end=${f(bodyEnd)},setpts=PTS-STARTPTS[body];` +
      `[v2]trim=start=${f(bodyEnd)}:end=${f(D)},setpts=PTS-STARTPTS[tail];` +
      `[v3]trim=start=0:end=${f(N)},setpts=PTS-STARTPTS[head];` +
      `[tail][head]xfade=transition=fade:duration=${f(N)}:offset=0[blend];` +
      "[body][blend]concat=n=2:v=1:a=0[out]";
  }

  const { code, err } = await run(ffmpeg, [
    "-y", "-i", inPath, "-filter_complex", filter, "-map", "[out]", ...ENCODE, outPath,
  ]);
  if (code !== 0 || !existsSync(outPath)) {
    throw new Error(`루프 변환 실패: ${err.trim().split("\n").slice(-2).join(" ") || code}`);
  }
  const after = await probeVideo(outPath);
  return { source: info, result: after, mode };
}
