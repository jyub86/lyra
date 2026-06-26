// 발표 화면. WebSocket으로 편집/도구의 present_* 명령을 따라가고, 로컬 키보드로도
// 조작(도구를 호출해 모두 동기화). 렌더링은 편집과 동일한 layer-renderer 사용.
import { callTool, loadTheme } from "/shared/api.js";
import { renderSlideWithLayers } from "/shared/layer-renderer.js";

const stage = document.getElementById("stage");
const black = document.getElementById("black");
const hint = document.getElementById("hint");

const state = { service: null, theme: null, index: 0, blackout: false };

function flatSlides() {
  const out = [];
  for (const scene of state.service?.scenes || []) for (const s of scene.slides) out.push(s);
  return out;
}

async function loadService(serviceId) {
  let id = serviceId;
  if (!id) {
    const services = await callTool("list_services");
    id = services[0]?.id;
  }
  if (!id) return;
  state.service = await callTool("get_service", { service_id: id });
  state.theme = await loadTheme(state.service.theme_id);
}

function render() {
  const slides = flatSlides();
  state.index = Math.max(0, Math.min(state.index, slides.length - 1));
  black.hidden = !state.blackout;
  const slide = slides[state.index];
  if (slide) renderSlideWithLayers(stage, slide, state.theme);
}

// ---- WebSocket follow ----
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "present") return;
    if (msg.service_id && msg.service_id !== state.service?.id) {
      await loadService(msg.service_id);
    } else if (msg.action === "reload") {
      await loadService(state.service?.id);
    }
    if (typeof msg.index === "number") state.index = msg.index;
    if (typeof msg.blackout === "boolean") state.blackout = msg.blackout;
    render();
  };
  ws.onclose = () => setTimeout(connectWs, 1000); // auto-reconnect
}

// ---- local keyboard (drives tools so editor stays in sync) ----
function go(delta) {
  const slides = flatSlides();
  const next = Math.max(0, Math.min(state.index + delta, slides.length - 1));
  if (next !== state.index) callTool("present_goto", { service_id: state.service?.id, page_index: next }).catch(() => {});
}
document.addEventListener("keydown", (e) => {
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
  else if (e.key.toLowerCase() === "b") { callTool("present_blackout", { on: !state.blackout }).catch(() => {}); }
  else if (e.key.toLowerCase() === "f") { document.documentElement.requestFullscreen?.(); }
});

// hide hint after a few seconds
setTimeout(() => hint.classList.add("fade"), 3500);
document.addEventListener("mousemove", () => { hint.classList.remove("fade"); setTimeout(() => hint.classList.add("fade"), 2500); });

async function init() {
  const ps = await callTool("get_presentation_state").catch(() => ({}));
  state.index = ps.index || 0;
  state.blackout = !!ps.blackout;
  await loadService(ps.service_id);
  render();
  connectWs();
}
init();
