// 발표 화면. WebSocket으로 편집/도구의 present_* 명령을 따라가고, 로컬 키보드로도
// 조작(도구를 호출해 모두 동기화). 렌더링은 편집과 동일한 layer-renderer 사용.
// 슬라이드 전환은 service.transition(none|fade|slide)을 따른다.
import { callTool, loadServiceTheme } from "/shared/api.js";
import { renderSlideWithLayers } from "/shared/layer-renderer.js";

const deck = document.getElementById("deck");
const black = document.getElementById("black");
const hint = document.getElementById("hint");

const state = { service: null, theme: null, index: 0, blackout: false, stage: null };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
function flatSlides() { return state.service?.slides || []; }

async function loadService(serviceId) {
  let id = serviceId;
  if (!id) { const services = await callTool("list_services"); id = services[0]?.id; }
  if (!id) return;
  state.service = await callTool("get_service", { service_id: id });
  state.theme = await loadServiceTheme(state.service);
}

function makeStage(slide) {
  const el = document.createElement("div");
  el.className = "slide-layers";
  renderSlideWithLayers(el, slide, state.theme);
  return el;
}

// Replace the deck contents immediately (no animation).
function renderNow() {
  const slides = flatSlides();
  state.index = clamp(state.index, 0, Math.max(0, slides.length - 1));
  black.hidden = !state.blackout;
  const slide = slides[state.index];
  deck.replaceChildren();
  if (slide) { state.stage = makeStage(slide); deck.appendChild(state.stage); }
  else state.stage = null;
}

// Crossfade / slide from the current stage to `newIndex` per service.transition.
const DUR = 360;
function transitionTo(newIndex) {
  const slides = flatSlides();
  const idx = clamp(newIndex, 0, Math.max(0, slides.length - 1));
  const transition = state.service?.transition || "none";
  const dir = idx >= state.index ? 1 : -1;
  const slide = slides[idx];
  state.index = idx;
  black.hidden = !state.blackout;
  if (!slide) { renderNow(); return; }
  if (transition === "none" || !state.stage) { renderNow(); return; }

  const outgoing = state.stage;
  const incoming = makeStage(slide);
  deck.appendChild(incoming);
  state.stage = incoming;

  // initial offset, then animate to rest
  incoming.style.transition = "none";
  if (transition === "fade") incoming.style.opacity = "0";
  else incoming.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
  void incoming.offsetWidth; // reflow
  const ease = `opacity ${DUR}ms ease, transform ${DUR}ms ease`;
  incoming.style.transition = ease;
  outgoing.style.transition = ease;
  if (transition === "fade") { incoming.style.opacity = "1"; outgoing.style.opacity = "0"; }
  else { incoming.style.transform = "translateX(0)"; outgoing.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`; }

  setTimeout(() => {
    outgoing.remove();
    incoming.style.transition = incoming.style.transform = incoming.style.opacity = "";
  }, DUR + 40);
}

// ---- WebSocket follow ----
// content edits arrive rapidly (element drags commit on mouseup); coalesce them
let changedTimer = null;
function onContentChanged() {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(async () => {
    if (!state.service?.id) return;
    await loadService(state.service.id); // re-fetch fresh content
    renderNow();                          // re-render current slide (no index change/anim)
  }, 150);
}

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "changed") { onContentChanged(); return; } // live edit reflection
    if (msg.type !== "present") return;
    let reloaded = false;
    if (msg.service_id && msg.service_id !== state.service?.id) { await loadService(msg.service_id); reloaded = true; }
    else if (msg.action === "reload") { await loadService(state.service?.id); reloaded = true; }
    if (typeof msg.blackout === "boolean") state.blackout = msg.blackout;
    const idxChanged = typeof msg.index === "number" && msg.index !== state.index;
    if (idxChanged && !reloaded) transitionTo(msg.index);
    else { if (typeof msg.index === "number") state.index = msg.index; renderNow(); }
  };
  ws.onclose = () => setTimeout(connectWs, 1000); // auto-reconnect
}

// ---- local keyboard (drives tools so editor stays in sync) ----
function go(delta) {
  const slides = flatSlides();
  let i = state.index + delta;
  while (i >= 0 && i < slides.length && slides[i]?.hidden) i += delta;   // 숨긴 슬라이드 건너뛰기
  if (i < 0 || i >= slides.length) return;                              // 그 방향에 보이는 슬라이드 없음
  if (i !== state.index) callTool("present_goto", { service_id: state.service?.id, page_index: i }).catch(() => {});
}
document.addEventListener("keydown", (e) => {
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
  else if (e.key.toLowerCase() === "b") { callTool("present_blackout", { on: !state.blackout }).catch(() => {}); }
  else if (e.key.toLowerCase() === "f") { document.documentElement.requestFullscreen?.(); }
});

setTimeout(() => hint.classList.add("fade"), 3500);
document.addEventListener("mousemove", () => { hint.classList.remove("fade"); setTimeout(() => hint.classList.add("fade"), 2500); });

async function init() {
  const ps = await callTool("get_presentation_state").catch(() => ({}));
  state.index = ps.index || 0;
  state.blackout = !!ps.blackout;
  await loadService(ps.service_id);
  renderNow();
  connectWs();
}
init();
