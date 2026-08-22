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
