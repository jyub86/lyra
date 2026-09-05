// 헤드리스 크롬이 굽는 내보내기 화면. 편집·발표와 같은 layer-renderer를 쓰므로
// 보이는 것과 나오는 이미지가 같다. WebSocket을 열지 않는다 — 발표 중인 화면의
// live 상태를 건드리면 안 되기 때문(편집기의 "발표중" 표시가 흔들린다).
import { callTool, loadServiceTheme } from "/shared/api.js";
import { renderSlideWithLayers } from "/shared/layer-renderer.js";

const q = new URLSearchParams(location.search);
const serviceId = q.get("service_id");
const indexParam = q.get("index");
const idsParam = q.get("ids");
const includeHidden = q.get("hidden") === "1";   // 기본: 발표에서 숨긴 장은 제외

// 배경 영상은 <video>로 그리지 않고 **정지 이미지로 바꿔서** 그린다.
// --print-to-pdf 의 --virtual-time-budget 은 미디어 디코드를 기다려주지 않아서, 영상을
// 그대로 두면 첫 프레임(루프 배경은 보통 검정)이 찍히거나 아예 비어 나온다. 서버에서
// ffmpeg으로 대표 프레임(기본=중간 지점, background.poster_time 으로 지정 가능)을 뽑아
// <img>로 그리면 이미지 대기 경로(waitPainted)가 그대로 통해 확실하게 찍힌다.
// ffmpeg이 없으면 원래대로 <video>를 그린다(첫 프레임 · graceful).
async function withPosterBackgrounds(slides) {
  const posters = new Map();   // 영상 url → 정지 이미지 url (여러 장이 같은 배경을 쓴다)
  const out = [];
  for (const s of slides) {
    const bg = s.background;
    if (bg?.type !== "video" || !bg.url) { out.push(s); continue; }
    const key = `${bg.url}|${bg.poster_time ?? ""}`;
    if (!posters.has(key)) {
      const args = { url: bg.url };
      if (bg.poster_time != null) args.seconds = bg.poster_time;
      posters.set(key, await callTool("get_video_poster", args).then((r) => r.url).catch(() => null));
    }
    const poster = posters.get(key);
    out.push(poster
      ? { ...s, background: { type: "image", url: poster, fit: bg.fit || "cover", overlay_dim: bg.overlay_dim } }
      : s);
  }
  return out;
}

// 폰트와 모든 이미지가 실제로 그려질 때까지 기다린다. 이걸 안 하면 스크린샷에
// 폰트 대체(네모)나 빈 이미지가 찍힌다.
async function waitPainted(root) {
  await document.fonts.ready;
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(imgs.map((im) => (im.complete ? im.decode?.().catch(() => {}) : new Promise((r) => {
    im.addEventListener("load", r, { once: true });
    im.addEventListener("error", r, { once: true });
  }))));
  // 레이아웃·페인트가 지나가도록 잠깐. requestAnimationFrame은 탭이 백그라운드면
  // 아예 호출되지 않아(=신호가 영원히 안 뜬다) 타이머를 쓴다.
  await new Promise((r) => setTimeout(r, 50));
}

async function main() {
  const pages = document.getElementById("pages");
  if (!serviceId) { document.documentElement.dataset.error = "service_id 필요"; return; }
  const service = await callTool("get_service", { service_id: serviceId });
  const theme = await loadServiceTheme(service);

  let slides = service.slides || [];
  if (!includeHidden) slides = slides.filter((s) => !s.hidden);
  if (idsParam) {
    const want = new Set(idsParam.split(",").filter(Boolean));
    slides = slides.filter((s) => want.has(s.id));
  }
  if (indexParam != null) {
    const i = Number(indexParam);
    slides = slides[i] ? [slides[i]] : [];
    document.body.classList.add("single");
  }

  slides = await withPosterBackgrounds(slides);   // 배경 영상 → 대표 프레임 정지 이미지

  for (const s of slides) {
    const page = document.createElement("div");
    page.className = "page";
    const stage = document.createElement("div");
    stage.className = "slide-layers";
    renderSlideWithLayers(stage, s, theme, { live: false });   // 영상 요소는 무음 정지 프레임
    page.appendChild(stage);
    pages.appendChild(page);
  }

  await waitPainted(pages);
  // 헤드리스 쪽에서 "이제 찍어도 된다"를 판단하는 신호 + 몇 장인지
  document.documentElement.dataset.count = String(slides.length);
  document.documentElement.dataset.ready = "1";
}

main().catch((e) => { document.documentElement.dataset.error = String(e.message || e); });
