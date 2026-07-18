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
  renderSlideWithLayers(el, slide, state.theme, { live: true });   // 발표: 영상 요소 소리 재생
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
  state.stage = incoming;

  incoming.style.transition = "none";
  if (transition === "fade") {
    // 부드러운 디졸브: 나가는 "배경"만 불투명하게 바닥에 유지(→ 어느 순간에도 검정 없음)
    // 하고, 그 위에서 옛 글씨는 사라지고 새 배경·글씨가 페이드인 → 실제로 스르륵 바뀌는
    // 게 보인다. 옛 글씨와 새 글씨가 대칭으로 교차(옛↓ 새↑)해 겹침도 과하지 않다.
    const outEls = outgoing.querySelector(":scope > .layer-elements");
    const inEls = incoming.querySelector(":scope > .layer-elements");
    const inBg = incoming.querySelector(":scope > .layer-bg");
    deck.appendChild(incoming);   // incoming = 위(나중 DOM), outgoing 배경이 바닥
    const ease = `opacity ${DUR}ms ease`;
    incoming.style.opacity = "1";
    if (inBg) inBg.style.opacity = "0";     // 새 배경/글씨는 0에서 시작해 페이드인
    if (inEls) inEls.style.opacity = "0";
    void incoming.offsetWidth; // reflow
    if (outEls) { outEls.style.transition = ease; outEls.style.opacity = "0"; } // 옛 글씨 페이드아웃
    if (inBg) { inBg.style.transition = ease; inBg.style.opacity = "1"; }        // 새 배경 페이드인(같은 배경이면 티 안 남)
    if (inEls) { inEls.style.transition = ease; inEls.style.opacity = "1"; }     // 새 글씨 페이드인
    // (나가는 .layer-bg 는 opacity 1 그대로 = 바닥 → 검정 방지)
  } else { // slide: 나란히 밀기(둘 다 불투명이라 검정 문제 없음)
    deck.appendChild(incoming);   // incoming = 위(나중 DOM)
    incoming.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
    void incoming.offsetWidth; // reflow
    const ease = `transform ${DUR}ms ease`;
    incoming.style.transition = ease;
    outgoing.style.transition = ease;
    incoming.style.transform = "translateX(0)";
    outgoing.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`;
  }

  setTimeout(() => {
    outgoing.remove();
    incoming.style.transition = incoming.style.transform = incoming.style.opacity = "";
    // fade에서 만졌던 내부 레이어 인라인 스타일 원복(다음 전환에 재사용되므로)
    for (const layer of incoming.querySelectorAll(":scope > .layer-bg, :scope > .layer-elements")) {
      layer.style.transition = layer.style.opacity = "";
    }
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
// ---- 슬라이드 번호 입력 → 점프 (별도 UI 없이: 숫자 타이핑 후 Enter, PowerPoint식) ----
let gotoBuf = "", gotoTimer = null;
function clearGoto() { clearTimeout(gotoTimer); gotoBuf = ""; }
function bufDigit(d) {
  gotoBuf = (gotoBuf + d).slice(0, 4);
  clearTimeout(gotoTimer); gotoTimer = setTimeout(clearGoto, 3000);   // 3초 입력 없으면 취소
}
function commitGoto() {
  if (!gotoBuf) return;
  const n = parseInt(gotoBuf, 10);
  clearGoto();
  if (!Number.isFinite(n)) return;
  const i = clamp(n - 1, 0, Math.max(0, flatSlides().length - 1));   // 1-based 번호 → index
  callTool("present_goto", { service_id: state.service?.id, page_index: i }).catch(() => {});
}

document.addEventListener("keydown", (e) => {
  // 번호 입력(화면 표시 없음)
  if (/^[0-9]$/.test(e.key)) { e.preventDefault(); bufDigit(e.key); return; }
  if (e.key === "Enter") { e.preventDefault(); commitGoto(); return; }
  if (e.key === "Backspace") { e.preventDefault(); gotoBuf = gotoBuf.slice(0, -1); return; }
  if (e.key === "Escape") { clearGoto(); return; }
  // 이동/제어
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); clearGoto(); go(1); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); clearGoto(); go(-1); }
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
