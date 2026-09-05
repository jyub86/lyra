// 발표 화면. WebSocket으로 편집/도구의 present_* 명령을 따라가고, 로컬 키보드로도
// 조작(도구를 호출해 모두 동기화). 렌더링은 편집과 동일한 layer-renderer 사용.
// 슬라이드 전환은 service.transition(none|fade|slide)을 따른다.
import { callTool, loadServiceTheme } from "/shared/api.js";
import { renderSlideWithLayers, bgKey, isLiveBackground } from "/shared/layer-renderer.js";

const deck = document.getElementById("deck");
const black = document.getElementById("black");
const hint = document.getElementById("hint");

const state = {
  service: null, theme: null, index: 0, blackout: false, stage: null,
  bgLayer: null, bgKey: null,   // 슬라이드를 넘겨도 살려두는 배경(영상·GIF) 레이어
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
function flatSlides() { return state.service?.slides || []; }

async function loadService(serviceId) {
  let id = serviceId;
  if (!id) { const services = await callTool("list_services"); id = services[0]?.id; }
  if (!id) return;
  // 마지막으로 발표하던 예배가 지워졌을 수도 있다 → 최신 예배로 대체(빈 화면 방지).
  let svc = await callTool("get_service", { service_id: id }).catch(() => null);
  if (!svc) {
    const services = await callTool("list_services").catch(() => []);
    if (!services[0]?.id) return;
    svc = await callTool("get_service", { service_id: services[0].id });
  }
  state.service = svc;
  state.theme = await loadServiceTheme(state.service);
}

// ---- 여러 슬라이드에 걸친 배경 영상/GIF ----
// 가사 슬라이드 뒤에 루프 영상을 까는 구성에서는, 슬라이드를 넘길 때마다 <video>를 새로
// 만들면 루프가 처음으로 되감기고 검게 깜박인다. 그래서 배경이 같은 동안에는 그 배경
// 레이어를 deck 바닥에 남겨두고 글씨(스테이지)만 갈아끼운다 — 사운드 트랙과 같은 발상.
// (배경이 바뀌는 순간에는 평소대로 스테이지 안에서 그려 전환 효과를 그대로 태운다)
const TRANSPARENT_BG = { type: "color", value: "transparent" };

function liveKey(slide) {
  const bg = slide?.background ?? state.theme?.background ?? null;
  return isLiveBackground(bg) ? bgKey(bg) : null;
}

function dropLiveBg() {
  state.bgLayer?.remove();
  state.bgLayer = null;
  state.bgKey = null;
}

// 방금 붙인 스테이지의 배경 레이어를 deck 바닥으로 옮긴다. 위치·크기가 같아 화면상 변화는
// 없고(옮기는 것이라 영상은 계속 재생), 이후 슬라이드는 그 위에 글씨만 얹는다.
function hoistLiveBg(stage, key) {
  const bg = stage.querySelector(":scope > .layer-bg");
  if (!bg) return;
  deck.insertBefore(bg, deck.firstChild);
  stage.classList.add("on-live-bg");
  state.bgLayer = bg;
  state.bgKey = key;
}

function makeStage(slide, onLiveBg) {
  const el = document.createElement("div");
  el.className = "slide-layers" + (onLiveBg ? " on-live-bg" : "");
  // 배경이 이미 바닥에서 재생 중이면 스테이지는 투명하게 그린다(아래 영상이 비쳐 보이도록).
  const s = onLiveBg ? { ...slide, background: TRANSPARENT_BG } : slide;
  renderSlideWithLayers(el, s, state.theme, { live: true });   // 발표: 영상 요소 소리 재생
  return el;
}

// 새 스테이지를 만들되, 이미지가 디코드될 때까지 기다린다. 교체 전에 디코드해두면
// 화면을 바꿀 때 이미지가 아직 안 그려져 생기는 검정 깜박임이 없다.
async function makeStageDecoded(slide, onLiveBg) {
  const el = makeStage(slide, onLiveBg);
  const imgs = [...el.querySelectorAll("img")].filter((i) => i.getAttribute("src"));
  // 최대 300ms만 기다림(느리거나 깨진 이미지에 무한정 매달리지 않게).
  await Promise.race([
    Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => {}) : Promise.resolve()))),
    new Promise((r) => setTimeout(r, 300)),
  ]);
  return el;
}

// Replace the deck contents (no animation). 새 슬라이드 이미지를 디코드한 뒤 한 번에
// 교체 → 이전 슬라이드가 그때까지 남아 있어 깜박임이 없다.
let renderSeq = 0;
async function renderNow() {
  const slides = flatSlides();
  state.index = clamp(state.index, 0, Math.max(0, slides.length - 1));
  black.hidden = !state.blackout;
  syncTracks();                                  // 현재 위치에 맞는 사운드 트랙 재생/정지
  const slide = slides[state.index];
  const seq = ++renderSeq;
  if (!slide) { deck.replaceChildren(); dropLiveBg(); state.stage = null; return; }
  const key = liveKey(slide);
  const reuse = !!key && key === state.bgKey && !!state.bgLayer?.isConnected;
  const stage = await makeStageDecoded(slide, reuse);
  if (seq !== renderSeq) return;                 // 그 사이 더 최신 렌더가 시작됨 → 버림
  if (!reuse) dropLiveBg();
  // 디코드 완료 후 한 번에 교체 — 단, 계속 재생 중인 배경 레이어는 남긴다.
  for (const n of [...deck.children]) if (n !== state.bgLayer) n.remove();
  deck.appendChild(stage);
  state.stage = stage;
  if (!reuse && key) hoistLiveBg(stage, key);
}

// Crossfade / slide from the current stage to `newIndex` per service.transition.
const DUR = 360;
async function transitionTo(newIndex) {
  const slides = flatSlides();
  const idx = clamp(newIndex, 0, Math.max(0, slides.length - 1));
  const transition = state.service?.transition || "none";
  const dir = idx >= state.index ? 1 : -1;
  const slide = slides[idx];
  state.index = idx;
  black.hidden = !state.blackout;
  syncTracks();                                     // 구간이 바뀌면 트랙 시작/정지
  if (!slide) { renderNow(); return; }
  if (transition === "none" || !state.stage) { renderNow(); return; }

  // 배경이 이전 슬라이드와 같은 영상/GIF면 그 배경은 건드리지 않는다 → 글씨만 바뀐다.
  const key = liveKey(slide);
  const reuse = !!key && key === state.bgKey && !!state.bgLayer?.isConnected;
  const outgoing = state.stage;
  const incoming = await makeStageDecoded(slide, reuse);   // 이미지 디코드 후 애니메이션 시작(깜박임 방지)
  if (state.stage !== outgoing) return;             // 그 사이 다른 렌더/전환이 시작됨 → 취소
  state.stage = incoming;

  incoming.style.transition = "none";
  if (transition === "fade") {
    // 부드러운 디졸브: 나가는 "배경"만 불투명하게 바닥에 유지(→ 어느 순간에도 검정 없음)
    // 하고, 그 위에서 옛 글씨는 사라지고 새 배경·글씨가 페이드인 → 실제로 스르륵 바뀌는
    // 게 보인다. 옛 글씨와 새 글씨가 대칭으로 교차(옛↓ 새↑)해 겹침도 과하지 않다.
    const outEls = outgoing.querySelector(":scope > .layer-elements");
    const inEls = incoming.querySelector(":scope > .layer-elements");
    // 배경을 이어 쓰는 중이면 페이드시킬 새 배경이 없다(바닥의 영상이 그대로 보인다).
    const inBg = reuse ? null : incoming.querySelector(":scope > .layer-bg");
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
    // 배경 영상 구간을 벗어나는 중이면 옛 배경도 같이 밀어낸다(혼자 서 있지 않도록).
    // 이어 쓰는 중이면 배경은 그대로 두고 글씨만 밀린다.
    if (!reuse && state.bgLayer) {
      state.bgLayer.style.transition = ease;
      state.bgLayer.style.transform = `translateX(${dir > 0 ? -100 : 100}%)`;
    }
  }

  setTimeout(() => {
    outgoing.remove();
    incoming.style.transition = incoming.style.transform = incoming.style.opacity = "";
    // fade에서 만졌던 내부 레이어 인라인 스타일 원복(다음 전환에 재사용되므로)
    for (const layer of incoming.querySelectorAll(":scope > .layer-bg, :scope > .layer-elements")) {
      layer.style.transition = layer.style.opacity = "";
    }
    if (state.stage !== incoming) return;   // 그 사이 다른 전환이 시작됨 → 배경은 그쪽이 관리
    if (!reuse) {
      dropLiveBg();                          // 옛 배경 영상 정리(새 배경이 이미 위를 덮고 있다)
      if (key) hoistLiveBg(incoming, key);   // 새 배경이 영상/GIF면 다음 슬라이드를 위해 살려둔다
    }
  }, DUR + 40);
}

// ---- 사운드 트랙 (여러 슬라이드 구간에 걸쳐 재생) ----
// 트랙은 예배(Service)에 속하고 시작~끝 슬라이드 구간을 가진다. <audio> 요소를 슬라이드
// 렌더와 별개로 살려두기 때문에 슬라이드를 넘겨도 소리가 끊기지 않는다. 구간이 겹치면
// 여러 트랙이 동시에 난다. 편집 화면은 소리를 내지 않는다(발표 전용).
const players = new Map();   // track id → { audio, url }

// 시작 슬라이드가 지워졌거나 지정되지 않았으면 구간 없음(null) → 재생하지 않는다.
// 끝이 없으면(또는 지워졌으면) 예배 끝까지.
function trackWindow(t, slides) {
  const start = slides.findIndex((x) => x.id === t.start_slide_id);
  if (start < 0) return null;
  const e = t.end_slide_id ? slides.findIndex((x) => x.id === t.end_slide_id) : slides.length - 1;
  return { start, end: e < 0 ? slides.length - 1 : e };
}

// 볼륨을 부드럽게 올리고 내린다(딱 끊기면 예배 중에 티가 크다).
// 화면이 가려진 탭에서는 타이머가 크게 늦춰지므로(브라우저 절전) 페이드 없이 즉시 적용해
// "구간을 벗어났는데 계속 재생" 같은 상태가 남지 않게 한다.
function fadeTo(audio, target, ms, done) {
  clearInterval(audio._fade);
  if (ms <= 0 || document.visibilityState === "hidden") { audio.volume = target; done?.(); return; }
  const from = audio.volume;
  const steps = Math.max(1, Math.round(ms / 40));
  let i = 0;
  audio._fade = setInterval(() => {
    i += 1;
    audio.volume = Math.max(0, Math.min(1, from + (target - from) * (i / steps)));
    if (i >= steps) { clearInterval(audio._fade); audio._fade = null; done?.(); }
  }, 40);
}

// 브라우저 자동재생 차단 시 안내 버튼(클릭=사용자 제스처 → 재생 시작)
let soundBtn = null;
function askForSound() {
  if (soundBtn) { soundBtn.hidden = false; return; }
  soundBtn = document.createElement("button");
  soundBtn.id = "sound-unlock";
  soundBtn.className = "sound-unlock";
  soundBtn.textContent = "🔊 소리 켜기";
  soundBtn.onclick = () => { soundBtn.hidden = true; syncTracks(); };
  document.body.appendChild(soundBtn);
}

function syncTracks() {
  const slides = flatSlides();
  const tracks = state.service?.tracks || [];
  const alive = new Set();
  for (const t of tracks) {
    if (!t?.url) continue;
    alive.add(t.id);
    let p = players.get(t.id);
    if (!p || p.url !== t.url) {
      p?.audio.remove();
      p?.audio.pause();
      const audio = new Audio(t.url);
      audio.preload = "auto";
      audio.dataset.trackId = t.id;
      audio.hidden = true;
      document.body.appendChild(audio);   // DOM에 두면 상태 확인·디버깅이 쉽다(화면엔 안 보임)
      p = { audio, url: t.url };
      players.set(t.id, p);
    }
    p.audio.loop = t.loop !== false;
    const vol = t.volume == null ? 0.8 : Number(t.volume);
    const win = trackWindow(t, slides);
    const active = !!win && state.index >= win.start && state.index <= win.end;
    if (active && p.audio.paused) {
      // 시작은 기본적으로 "바로 들리게"(0.15초 = 귀에는 즉시, 팝 노이즈만 방지).
      // 잔잔하게 스며들게 하고 싶은 트랙은 fade_in을 크게 주면 된다.
      const fadeIn = Math.max(0, (t.fade_in == null ? 0.15 : Number(t.fade_in))) * 1000;
      p.audio.volume = fadeIn > 0 ? 0 : vol;
      p.audio.play().then(() => fadeTo(p.audio, vol, fadeIn)).catch(askForSound);   // 자동재생 차단 대비
    } else if (active) {
      if (Math.abs(p.audio.volume - vol) > 0.01) fadeTo(p.audio, vol, 200);      // 볼륨 변경 반영
    } else if (!p.audio.paused) {
      fadeTo(p.audio, 0, 400, () => { p.audio.pause(); p.audio.currentTime = 0; });
    }
  }
  for (const [id, p] of players) {   // 목록에서 빠진(삭제된) 트랙 정리
    if (alive.has(id)) continue;
    p.audio.pause();
    p.audio.remove();
    players.delete(id);
  }
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
  const ws = new WebSocket(`ws://${location.host}/ws?role=presenter`);
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
