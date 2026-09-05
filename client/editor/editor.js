// 편집 UI 컨트롤러. 예배(순서) > 슬라이드 평면 구조. 모든 동작은 Tool 호출.
import { callTool, loadServiceTheme, uploadFile, BUILTIN_THEMES, CLIENT_ID } from "/shared/api.js";
import { renderSlideWithLayers, renderElements } from "/shared/layer-renderer.js";

const $ = (id) => document.getElementById(id);

const state = {
  services: [],
  serviceId: null,
  service: null,        // get_service (flat slides[])
  theme: null,
  selected: null,       // primary slide id (preview/inspector)
  selectedSet: new Set(), // multi-selection
  anchor: null,         // range-select anchor (shift+click)
  mode: "list",         // "list" | "tiles"
  editEl: null,         // primary selected element index (design panel/resize)
  editElSet: new Set(), // selected element indices (drag-marquee multi-select)
  inlineEdit: null,     // 캔버스에서 인라인 편집 중인 텍스트 요소 index (null=아님)
  templates: [],        // design templates (cached)
  editingTemplate: null, // { id, name, kind, draft } while editing a template's design
  styleSource: null,    // 서식 복사기: 서식을 가져올 원본 슬라이드 id
  fonts: [],            // self-host 웹폰트 목록 (list_fonts)
  backgrounds: [],      // 저장해 둔 배경 라이브러리 (list_backgrounds)
};

// 글꼴 <select>를 "테마 기본" + 용도 그룹(optgroup)으로 채운다. current=현재 family.
function fillFontSelect(sel, current) {
  sel.replaceChildren();
  const base = document.createElement("option"); base.value = ""; base.textContent = "테마 기본"; sel.appendChild(base);
  const groups = {};
  for (const f of state.fonts) (groups[f.group] ??= []).push(f);
  for (const [g, list] of Object.entries(groups)) {
    const og = document.createElement("optgroup"); og.label = g;
    for (const f of list) { const o = document.createElement("option"); o.value = f.family; o.textContent = f.label; og.appendChild(o); }
    sel.appendChild(og);
  }
  sel.value = current ?? "";
}

// 잠깐 뜨는 알림(복사/붙여넣기 등 피드백).
let toastT = null;
function toast(text) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = text; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1400);
}

function setSingleSelection(id) {
  state.selected = id;
  state.anchor = id;
  state.selectedSet = new Set(id ? [id] : []);
  state.editEl = null;
  state.editElSet = new Set();
  state.editingTemplate = null;
}

const slides = () => state.service?.slides || [];

// ===== 발표 위치 추적 (리스트·타일에 현재 발표 중인 슬라이드 표시) =====
// 발표 화면과 같은 WebSocket present 이벤트를 따라가며, 현재 편집 중인 예배가
// 발표 중인 예배와 같을 때만 해당 슬라이드에 .presenting 표시를 붙인다.
// live=false(발표 화면이 모두 닫힘)이면 어떤 슬라이드도 발표 중이 아니다.
const present = { service_id: null, index: 0, live: false };
function presentingSlideId() {
  if (!present.live || !state.service || present.service_id !== state.serviceId) return null;
  return slides()[present.index]?.id ?? null;
}
// 리스트/타일을 다시 그리지 않고 .presenting 클래스만 갱신(발표 넘어갈 때마다 호출).
function updatePresentingMarker() {
  const id = presentingSlideId();
  for (const n of document.querySelectorAll(".slide-row.presenting, .tile.presenting")) n.classList.remove("presenting");
  if (id != null) {
    for (const n of document.querySelectorAll(`.slide-row[data-id="${id}"], .tile[data-id="${id}"]`)) n.classList.add("presenting");
  }
  updatePresentingBadge(id);
}
// 상단바 표시 — 목록이 안 보이는 화면(휴대폰의 편집·속성 탭)에서도 무엇이 나가는지 알 수 있게.
function updatePresentingBadge(id) {
  const btn = $("presenting-now");
  if (!btn) return;
  if (!present.live) { btn.hidden = true; return; }
  btn.hidden = false;
  const otherService = present.service_id && present.service_id !== state.serviceId;
  btn.classList.toggle("other", !!otherService);
  if (otherService) {
    // 발표 중이지만 지금 편집 중인 예배가 아니다 → 누르면 그 예배로 전환.
    btn.textContent = "● 발표중 · 다른 예배";
    btn.title = "발표 중인 예배로 전환";
  } else if (id != null) {
    btn.textContent = `● 발표중 ${slides().findIndex((s) => s.id === id) + 1}/${slides().length}`;
    btn.title = "발표 중인 슬라이드로 이동";
  } else {
    // 같은 예배인데 그 자리가 없다(그 슬라이드를 지웠거나 순서가 줄었을 때).
    btn.textContent = "● 발표중";
    btn.title = "발표 중";
  }
}
// 상단바 표시 클릭 → 발표 중인 슬라이드(또는 예배)로 이동.
async function goToPresenting() {
  if (!present.live) return;
  if (present.service_id && present.service_id !== state.serviceId) {
    const sel = $("service-select");
    if ([...sel.options].some((o) => o.value === present.service_id)) {
      sel.value = present.service_id;
      await selectService(present.service_id);
    }
    return;
  }
  const id = presentingSlideId();
  if (id == null) return;
  setSingleSelection(id);
  if (document.body.dataset.pane) setPane("list");   // 휴대폰: 순서 화면으로 넘어가 보여준다
  render();
  revealSlide(id);
}
function connectPresentWs() {
  const ws = new WebSocket(`ws://${location.host}/ws?role=editor`);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    // 다른 사람/다른 기기(또는 CLI·MCP)가 내용을 바꿈 → 새로고침 없이 반영.
    // 내가 만든 변경(origin === 내 탭)은 이미 화면에 반영돼 있으니 무시.
    if (m.type === "changed") { if (m.origin !== CLIENT_ID) onRemoteChange(); return; }
    if (m.type !== "present") return;
    if ("service_id" in m) present.service_id = m.service_id;
    if (typeof m.index === "number") present.index = m.index;
    if ("live" in m) present.live = !!m.live;
    updatePresentingMarker();
  };
  ws.onclose = () => setTimeout(connectPresentWs, 1000);   // 자동 재연결
}

// ===== 다른 곳의 변경을 반영 (둘이서 동시 편집) =====
// 지금 내가 뭔가 붙잡고 있는 중인지 — 이 동안 화면을 다시 그리면 작업이 날아간다.
let draggingEls = 0;   // 요소 드래그·리사이즈 진행 중(마우스 누르고 있는 동안)
function localEditBusy() {
  return !!state.editingTemplate         // 저장 안 한 템플릿 초안
    || state.inlineEdit != null          // 캔버스에서 글자 입력 중
    || draggingEls > 0                   // 요소를 끌고 있음
    || dragId != null                    // 리스트에서 슬라이드 순서 옮기는 중
    || isTypingTarget();                 // 패널 입력칸에 타이핑 중(포커스를 뺏지 않도록)
}

let remoteTimer = null, remotePending = false;
function onRemoteChange() {
  remotePending = true;
  clearTimeout(remoteTimer);
  // 요소 드래그는 mouseup마다 저장돼 알림이 몰아친다 → 잠깐 모았다가 한 번만 반영.
  remoteTimer = setTimeout(applyRemoteChange, 250);
}
async function applyRemoteChange() {
  if (!remotePending || !state.serviceId) return;
  if (localEditBusy()) { remoteTimer = setTimeout(applyRemoteChange, 600); return; }  // 손 뗄 때까지 미룸
  remotePending = false;
  const scroller = document.querySelector("aside.col.order");
  const scrollTop = scroller?.scrollTop ?? 0;
  const beforeCount = els().length;
  let svc;
  try {
    svc = await callTool("get_service", { service_id: state.serviceId });
  } catch {
    await loadServices();   // 이 예배가 지워졌을 수 있다 → 목록부터 다시
    toast("예배 목록이 바뀌어 다시 불러왔습니다");
    return;
  }
  state.service = svc;
  state.theme = await loadServiceTheme(svc);
  syncThemeControls();
  // 사라진 슬라이드는 선택에서 제거
  const exist = new Set(slides().map((s) => s.id));
  state.selectedSet = new Set([...state.selectedSet].filter((id) => exist.has(id)));
  if (!exist.has(state.selected)) state.selected = slides()[0]?.id || null;
  if (state.selected && !state.selectedSet.size) state.selectedSet.add(state.selected);
  // 요소 개수가 달라졌으면 인덱스로 잡아둔 요소 선택은 엉뚱한 걸 가리키게 된다 → 해제.
  if (els().length !== beforeCount) { state.editEl = null; state.editElSet = new Set(); }
  // 남의 변경을 내 실행취소 스택에 얹으면 ⌘Z가 그 사람 작업까지 되돌린다(예배 전체 교체).
  // 그래서 여기서 기준점을 다시 잡는다 — 이 시점 이후의 내 변경만 되돌릴 수 있다.
  resetHistory();
  render();
  if (scroller) scroller.scrollTop = scrollTop;
  toast("다른 곳의 변경을 반영했습니다");
}

function slideLabel(s) {
  for (const e of s.elements || []) {
    if (e.type === "text" && e.text) return e.text.split("\n")[0];
    if (e.type === "bible") return e.content?.ref || "성경 본문";
    if (e.type === "hymn") return e.content?.title || "찬송가";
    if (e.type === "reading") return e.content?.title || "교독문";
  }
  return (s.elements || [])[0] ? (s.elements[0].type) : "빈 화면";
}
const KIND_LABEL = { bible: "성경", hymn: "찬송", reading: "교독", text: "텍스트", shape: "도형", image: "이미지" };
function slideKind(s) {
  const els = s.elements || [];
  const content = els.find((e) => ["bible", "hymn", "reading"].includes(e.type));
  if (content) return KIND_LABEL[content.type];
  if (!els.length) return "빈";
  return KIND_LABEL[els[0].type] || els[0].type;
}

function elx(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// A mini live preview of a slide (shared by list rows and tiles).
// Video backgrounds are swapped for a placeholder to avoid many <video> elements.
function thumbSlide(s) {
  let out = s;
  // 영상 배경/요소는 썸네일에서 <video> 대신 플레이스홀더로(여러 개 동시 재생 방지)
  if (s.background?.type === "video") {
    out = { ...out, background: { type: "gradient", from: "#1f2933", to: "#0b0e14", angle: 135 } };
  }
  if ((s.elements || []).some((e) => e.type === "video")) {
    out = { ...out, elements: (out.elements || []).map((e) =>
      e.type === "video" ? { type: "shape", shape: "rect", x: e.x, y: e.y, w: e.w, h: e.h, fill: "#0b0e14", stroke: "#556", stroke_width: 1 } : e) };
  }
  return out;
}
function buildThumb(s) {
  const t = elx("div", "thumb");
  const stage = elx("div", "slide-layers");
  t.appendChild(stage);
  renderSlideWithLayers(stage, thumbSlide(s), state.theme);
  return t;
}

// Compute the new id order when the dragged item (and, if it's part of a
// multi-selection, the whole selected group) is dropped before `targetId`.
// The group keeps its relative order. Returns null if dropping into the group.
function groupOrderFor(targetId) {
  const ids = slides().map((s) => s.id);
  const group = (state.selectedSet.has(dragId) && state.selectedSet.size > 1)
    ? ids.filter((id) => state.selectedSet.has(id))
    : [dragId];
  if (group.includes(targetId)) return null;
  const set = new Set(group);
  const rest = ids.filter((id) => !set.has(id));
  const at = rest.indexOf(targetId);
  return [...rest.slice(0, at), ...group, ...rest.slice(at)];
}

// Shared HTML5 drag-to-reorder for any element carrying dataset.id (rows & tiles).
// Multi-selection aware: dragging a selected row moves the whole selection.
let dragId = null;
function wireDrag(el) {
  el.addEventListener("dragstart", (e) => { dragId = el.dataset.id; e.dataTransfer.effectAllowed = "move"; });
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!dragId) return;
    const newIds = groupOrderFor(el.dataset.id);
    dragId = null;
    if (!newIds) return;
    await callTool("reorder_slides", { service_id: state.serviceId, ordered_slide_ids: newIds });
    await refresh();
  });
}

// ===== 좁은 화면(휴대폰·아이패드 세로) =====
// 3열 고정 레이아웃은 좌우 패널만 600px이라 좁은 화면에선 캔버스가 안 들어간다.
// CSS가 레이아웃을 바꾸고, 여기서는 "지금 어느 화면인지"와 서랍 여닫기만 관리한다.
function setPane(pane) {
  document.body.dataset.pane = pane;
  for (const b of document.querySelectorAll("#mobile-tabs button")) b.classList.toggle("active", b.dataset.pane === pane);
  // 속성은 서랍으로 띄운다(휴대폰에선 화면 전체를 덮음)
  document.body.classList.toggle("props-open", pane === "props");
  if (pane === "canvas") renderPreview();   // 숨어 있던 캔버스는 크기가 0이었으므로 다시 그린다
}
function togglePropsDrawer(open) {
  const on = open ?? !document.body.classList.contains("props-open");
  document.body.classList.toggle("props-open", on);
}
function wireResponsive() {
  // 터치 기기면 순서 바꾸기 ▲▼를 띄운다(HTML5 드래그는 터치에서 동작하지 않음).
  if (matchMedia("(hover: none)").matches || navigator.maxTouchPoints > 0) document.body.classList.add("touch");
  $("props-toggle").onclick = () => togglePropsDrawer();
  $("presenting-now").onclick = goToPresenting;
  for (const b of document.querySelectorAll("#mobile-tabs button")) b.onclick = () => setPane(b.dataset.pane);
  // 휴대폰 폭에서만 탭 화면을 쓴다. 넓어지면 3열로 돌아가므로 서랍도 닫는다.
  const narrow = matchMedia("(max-width: 767px)");
  const sync = () => {
    if (narrow.matches) setPane(document.body.dataset.pane || "canvas");
    else { delete document.body.dataset.pane; document.body.classList.remove("props-open"); }
  };
  narrow.addEventListener("change", sync);
  sync();
}
// 슬라이드 한 칸 위/아래로 (터치에서 드래그 대신)
async function moveSlide(id, delta) {
  const ids = slides().map((s) => s.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  await callTool("reorder_slides", { service_id: state.serviceId, ordered_slide_ids: ids });
  await refresh();
  revealSlide(id);
}

// List-row click with multi-select (plain / ⌘·Ctrl toggle / Shift range).
function onRowClick(s, e) {
  state.editEl = null;
  state.editElSet = new Set();
  state.editingTemplate = null;
  const ids = slides().map((x) => x.id);
  if (e.shiftKey && state.anchor && ids.includes(state.anchor)) {
    const a = ids.indexOf(state.anchor), b = ids.indexOf(s.id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    state.selectedSet = new Set(ids.slice(lo, hi + 1));
    state.selected = s.id;
  } else if (e.metaKey || e.ctrlKey) {
    if (state.selectedSet.has(s.id)) state.selectedSet.delete(s.id);
    else state.selectedSet.add(s.id);
    state.selected = s.id;
    state.anchor = s.id;
  } else {
    setSingleSelection(s.id);
  }
  render();
}

// ---------- service / theme ----------
async function loadServices(selectId) {
  state.services = await callTool("list_services");
  const sel = $("service-select");
  sel.innerHTML = "";
  for (const s of state.services) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = `${s.date} ${s.worship_part} · ${s.title}`;
    sel.appendChild(o);
  }
  // 초기 로드(명시적 선택 없음)에선 현재 발표 중인 예배를 우선 선택 → 진행 중 발표를 끊지 않고 동기화.
  let target = selectId;
  if (!target) {
    const ps = await callTool("get_presentation_state").catch(() => ({}));
    target = (ps?.service_id && state.services.some((s) => s.id === ps.service_id)) ? ps.service_id : state.services[0]?.id;
  }
  if (target) { sel.value = target; await selectService(target); }
  else { state.service = null; render(); }
}

async function selectService(id) {
  state.serviceId = id;
  state.service = await callTool("get_service", { service_id: id });
  state.theme = await loadServiceTheme(state.service);
  syncThemeControls();
  setSingleSelection(slides()[0]?.id || null);
  resetHistory();          // 새 예배 → 실행취소 기록 초기화(현재 상태를 기준으로)
  render();
  // 발표 화면 동기화: 현재 편집 중인 예배를 발표 대상으로(다르면 첫 슬라이드로, 같으면 유지).
  // 새 세션을 열면 발표 화면 재오픈·새로고침도 이 예배를 따라온다.
  callTool("present_set_service", { service_id: id }).catch(() => {});
}

// ===== 실행취소 / 다시실행 (⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z) =====
// 슬라이드 전체 스냅샷을 선형 스택으로 기록. 각 커밋 후 refresh()에서 자동 기록.
let history = [], histIdx = -1, suppressHistory = false;
function snapshotSlides() {
  return slides().map((s) => ({
    id: s.id,
    elements: structuredClone(s.elements || []),
    background: s.background ? structuredClone(s.background) : null,
    transition: s.transition || "fade",
    hidden: s.hidden ? 1 : 0,
  }));
}
function recordState() {
  if (suppressHistory || !state.service) return;
  const snap = snapshotSlides();
  if (histIdx >= 0 && JSON.stringify(snap) === JSON.stringify(history[histIdx])) return; // 변화 없음
  history = history.slice(0, histIdx + 1);   // redo 가지 잘라내기
  history.push(snap);
  if (history.length > 60) history.shift();
  histIdx = history.length - 1;
  updateUndoButtons();
}
function resetHistory() { history = []; histIdx = -1; suppressHistory = false; recordState(); }
function updateUndoButtons() {
  const u = $("undo-btn"), r = $("redo-btn");
  if (u) u.disabled = histIdx <= 0;
  if (r) r.disabled = histIdx >= history.length - 1;
}
async function restoreSnapshot(snap) {
  suppressHistory = true;
  try {
    await callTool("set_service_slides", { service_id: state.serviceId, slides: snap });
    await refresh();
  } finally { suppressHistory = false; }
  updateUndoButtons();
}
async function undo() {
  if (histIdx <= 0) { toast("더 되돌릴 게 없어요"); return; }
  histIdx--;
  await restoreSnapshot(history[histIdx]);
  toast("실행 취소");
}
async function redo() {
  if (histIdx >= history.length - 1) { toast("다시 실행할 게 없어요"); return; }
  histIdx++;
  await restoreSnapshot(history[histIdx]);
  toast("다시 실행");
}

// reflect the service's theme/color/transition into the topbar controls
function syncThemeControls() {
  const s = state.service;
  if (!s) return;
  $("theme-select").value = s.theme_id;
  $("bg-color").value = state.theme?.background?.value || "#1a1a2e";
  $("accent-color").value = state.theme?.colors?.accent || "#7aa2f7";
  $("font-select").value = s.theme_overrides?.font || "";
  $("transition-select").value = s.transition || "none";
}

async function refresh() {
  state.service = await callTool("get_service", { service_id: state.serviceId });
  const exist = new Set(slides().map((s) => s.id));
  state.selectedSet = new Set([...state.selectedSet].filter((id) => exist.has(id)));
  if (!exist.has(state.selected)) state.selected = slides()[0]?.id || null;
  if (state.selected && state.selectedSet.size === 0) state.selectedSet.add(state.selected);
  recordState();   // 커밋된 변경을 실행취소 스택에 기록(복원 중이면 무시)
  render();
}

async function reloadTheme() {
  state.service = await callTool("get_service", { service_id: state.serviceId });
  state.theme = await loadServiceTheme(state.service);
  syncThemeControls();
  render();
}

function initThemeSelect() {
  const sel = $("theme-select");
  for (const t of BUILTIN_THEMES) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name; sel.appendChild(o);
  }
  sel.onchange = async () => {
    await callTool("set_service_theme", { service_id: state.serviceId, theme_id: sel.value });
    await reloadTheme();
  };
  // custom colors: background (테마 기본 배경) + accent (메인)
  const setOverride = async (patch) => {
    const cur = state.service?.theme_overrides || {};
    await callTool("set_service_theme", { service_id: state.serviceId, overrides: { ...cur, ...patch } });
    await reloadTheme();
  };
  $("bg-color").onchange = (e) => setOverride({ background: { type: "color", value: e.target.value } });
  $("accent-color").onchange = (e) => setOverride({ accent: e.target.value });
  $("font-select").onchange = (e) => setOverride({ font: e.target.value || undefined });
  $("theme-reset").onclick = async () => {
    await callTool("set_service_theme", { service_id: state.serviceId, overrides: null });
    await reloadTheme();
  };
  $("transition-select").onchange = async (e) => {
    await callTool("set_service_transition", { service_id: state.serviceId, transition: e.target.value });
    state.service.transition = e.target.value;
    try { await callTool("present_reload"); } catch {}
  };
}

// ---------- render ----------
function render() {
  $("edit-view").hidden = state.mode !== "list";
  $("tiles-view").hidden = state.mode !== "tiles";
  $("view-list").classList.toggle("active", state.mode === "list");
  $("view-tiles").classList.toggle("active", state.mode === "tiles");
  $("order-count").textContent = state.service ? `${slides().length}장` : "";
  const editing = !!state.editingTemplate;
  $("tpl-edit-bar").hidden = !editing;
  $("canvas-bar").hidden = editing;
  if (editing) $("tpl-edit-name").textContent = state.editingTemplate.name;
  if (state.mode === "tiles") renderTiles();
  else { renderList(); renderPreview(); renderInspector(); renderDesignPanel(); renderTemplatePanel(); }
  updatePresentingBadge(presentingSlideId());   // 예배를 바꿔도 상단바 표시가 따라오게
}

// The slide the canvas/design editor is operating on: the template draft while
// editing a template, otherwise the selected service slide.
function selectedSlide() {
  if (state.editingTemplate) return state.editingTemplate.draft;
  return slides().find((s) => s.id === state.selected) || null;
}
// The actual selected service slide (ignores any template draft).
function serviceSlide() {
  return slides().find((s) => s.id === state.selected) || null;
}

function renderList() {
  const root = $("slide-list");
  root.innerHTML = "";
  if (!state.service) { root.innerHTML = '<p class="muted" style="padding:12px">예배 순서가 없습니다. “+ 새 예배”로 시작하세요.</p>'; return; }
  root.appendChild(elx("p", "list-hint muted", "드래그로 이동 · ⌘/Ctrl·Shift 클릭으로 여러 개 선택해 함께 이동 · Page↑/↓로 슬라이드 이동"));
  const pid = presentingSlideId();
  const sound = slidesWithSound();
  slides().forEach((s, i) => {
    const sel = state.selectedSet.has(s.id);
    const row = elx("div", "slide-row" + (sel ? " sel" : "") + (s.id === state.selected ? " primary" : "") + (s.id === pid ? " presenting" : "") + (s.hidden ? " hidden" : "") + (s.id === state.styleSource ? " style-src" : ""));
    row.draggable = true;
    row.dataset.id = s.id;
    const meta = elx("div", "row-meta");
    meta.append(elx("span", "badge", slideKind(s)), elx("span", "label", slideLabel(s)));
    if (sound.has(s.id)) { const n = elx("span", "sound-mark", "♪"); n.title = "이 구간에서 사운드 트랙이 재생됩니다"; meta.appendChild(n); }
    const hide = elx("button", "hide" + (s.hidden ? " on" : ""), s.hidden ? "⊘" : "◉");
    hide.title = s.hidden ? "발표에 다시 보이기" : "발표에서 숨기기";
    hide.onclick = (e) => { e.stopPropagation(); toggleHidden(s.id); };
    const del = elx("button", "del danger", "✕");
    del.onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    // 터치 기기용 순서 이동(▲▼). CSS가 body.touch일 때만 보여준다.
    const movers = elx("div", "movers");
    const mv = (label, delta, title) => {
      const b = elx("button", null, label);
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); moveSlide(s.id, delta); };
      return b;
    };
    movers.append(mv("▲", -1, "위로"), mv("▼", 1, "아래로"));
    row.append(elx("span", "num", String(i + 1)), buildThumb(s), meta, movers, hide, del);
    row.onclick = (e) => onRowClick(s, e);
    wireDrag(row);
    root.appendChild(row);
  });
}

function renderPreview() {
  const slide = selectedSlide();
  const prev = $("preview");
  if (!slide) { prev.replaceChildren(); $("slide-pos").textContent = "—"; return; }
  renderSlideWithLayers(prev, slide, state.theme);
  renderEditLayer();
  const idx = slides().findIndex((s) => s.id === slide.id);
  const n = state.selectedSet.size;
  $("slide-pos").textContent = n > 1 ? `${n}개 선택됨 · 드래그로 함께 이동` : `${idx + 1} / ${slides().length}`;
}

function navSlide(delta) {
  const idx = slides().findIndex((s) => s.id === state.selected);
  const next = slides()[idx + delta];
  if (!next) return;
  setSingleSelection(next.id);   // 이동하면 멀티셀렉은 풀고 그 슬라이드만 선택
  render();
  revealSlide(next.id);
}

// 순서 목록에서 해당 슬라이드 행이 보이도록 스크롤
function revealSlide(id) {
  document.querySelector(`.slide-row[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}

// ===== free-element canvas editing (Google-Slides-like) =====
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const els = () => selectedSlide()?.elements || [];

// ---- snapping to canvas edges/center (0, 0.5, 1) with visual guides ----
const SNAP_TARGETS = [0, 0.5, 1];
const SNAP_TOL = 0.012;
let activeGuides = { v: null, h: null }; // fractions where guide lines show

// Snap a moving box: try aligning its left/center/right (x-axis) and
// top/middle/bottom (y-axis) to targets. Returns adjusted {x,y} + records guides.
function snapMove(x, y, w, h) {
  activeGuides = { v: null, h: null };
  const axis = (start, size) => {
    let best = null;
    for (const [lineOffset, key] of [[0, "s"], [size / 2, "c"], [size, "e"]]) {
      for (const t of SNAP_TARGETS) {
        const d = Math.abs(start + lineOffset - t);
        if (d < SNAP_TOL && (!best || d < best.d)) best = { d, newStart: t - lineOffset, guide: t };
      }
    }
    return best;
  };
  const bx = axis(x, w), by = axis(y, h);
  if (bx) { x = bx.newStart; activeGuides.v = bx.guide; }
  if (by) { y = by.newStart; activeGuides.h = by.guide; }
  return { x, y };
}

// Snap a single dragged edge value to targets (for resize).
function snapEdge(v) {
  for (const t of SNAP_TARGETS) if (Math.abs(v - t) < SNAP_TOL) return t;
  return v;
}

function renderGuides() {
  const layer = $("preview")?.querySelector(":scope > .edit-layer");
  if (!layer) return;
  layer.querySelectorAll(".guide-v, .guide-h").forEach((n) => n.remove());
  if (activeGuides.v != null) { const g = elx("div", "guide-v"); g.style.left = activeGuides.v * 100 + "%"; layer.appendChild(g); }
  if (activeGuides.h != null) { const g = elx("div", "guide-h"); g.style.top = activeGuides.h * 100 + "%"; layer.appendChild(g); }
}
function clearGuides() { activeGuides = { v: null, h: null }; renderGuides(); }

// Interactive handle layer over #preview: select / move / resize elements.
function renderEditLayer() {
  const pv = $("preview");
  if (!pv) return;
  let layer = pv.querySelector(":scope > .edit-layer");
  if (state.mode !== "list" || !selectedSlide()) { layer?.remove(); return; }
  if (!layer) {
    layer = elx("div", "edit-layer");
    // 빈 곳에서 드래그 → 마퀴 멀티선택(클릭만 하면 선택 해제)
    layer.addEventListener("mousedown", (e) => { if (e.target === layer) startMarquee(e); });
    // 더블클릭 → '내용' 입력 포커스. selectEl이 매번 .eh 노드를 교체하므로 리스너는
    // (교체되지 않는) 레이어에 위임한다. 요소 인덱스는 capture 단계 mousedown으로 추적
    // (요소의 stopPropagation 이전에 실행). 트리거는 브라우저 네이티브 dblclick(정확한 임계값).
    layer._dblIndex = -1;
    layer.addEventListener("mousedown", (e) => {
      const eh = e.target.closest(".eh");
      layer._dblIndex = eh ? Number(eh.dataset.elIndex) : -1;
    }, true);
    // 텍스트·성경/찬송/교독 본문은 캔버스에서 바로 인라인 편집(전체/일부 글꼴·색), 그 외는 패널.
    let openedAt = 0;
    const openInline = (idx) => {
      if (idx < 0 || performance.now() - openedAt < 500) return;   // dblclick·터치 감지 중복 방지
      openedAt = performance.now();
      const t = els()[idx]?.type;
      if (["text", "bible", "hymn", "reading"].includes(t)) startInlineEdit(idx);
      else focusElementContent(idx);
    };
    layer.addEventListener("dblclick", (e) => { e.preventDefault(); openInline(layer._dblIndex); });
    // 아이패드: 네이티브 dblclick이 오지 않거나 늦는 경우가 있어 두 번 탭을 직접 감지한다.
    // 터치 포인터에서만 동작하므로 마우스(데스크톱) 경로는 그대로다.
    let lastTapAt = 0, lastTapIdx = -1;
    layer.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "touch") return;
      const eh = e.target.closest(".eh");
      const idx = eh ? Number(eh.dataset.elIndex) : -1;
      if (idx >= 0 && idx === lastTapIdx && e.timeStamp - lastTapAt < 400) {
        lastTapAt = 0; lastTapIdx = -1;
        openInline(idx);
      } else { lastTapAt = e.timeStamp; lastTapIdx = idx; }
    });
    pv.appendChild(layer);
  }
  layer.replaceChildren();
  els().forEach((el, i) => {
    const h = elx("div", "eh" + (state.editElSet.has(i) ? " sel" : ""));
    h.dataset.elIndex = i;
    h.style.left = (el.x ?? 0.4) * 100 + "%";
    h.style.top = (el.y ?? 0.4) * 100 + "%";
    h.style.width = (el.w ?? 0.2) * 100 + "%";
    h.style.height = (el.h ?? 0.12) * 100 + "%";
    h.addEventListener("mousedown", (e) => startMove(e, i));
    // 리사이즈 핸들은 단일 선택일 때만(다중은 이동만)
    if (i === state.editEl && state.editElSet.size === 1) {
      for (const pos of ["nw", "ne", "sw", "se"]) {
        const k = elx("div", "handle " + pos);
        k.addEventListener("mousedown", (e) => startResize(e, i, pos));
        h.appendChild(k);
      }
    }
    layer.appendChild(h);
  });
}

// 캔버스 빈 곳에서 드래그해 사각형 안(겹치는) 요소들을 다중 선택.
function startMarquee(e) {
  if (e.button !== 0) return;
  const pv = $("preview");
  const layer = pv.querySelector(":scope > .edit-layer");
  const rect = pv.getBoundingClientRect();
  const x0 = clamp01((e.clientX - rect.left) / rect.width);
  const y0 = clamp01((e.clientY - rect.top) / rect.height);
  const box = elx("div", "marquee");
  layer.appendChild(box);
  let moved = false, x1 = x0, y1 = y0;
  const draw = () => {
    box.style.left = Math.min(x0, x1) * 100 + "%";
    box.style.top = Math.min(y0, y1) * 100 + "%";
    box.style.width = Math.abs(x1 - x0) * 100 + "%";
    box.style.height = Math.abs(y1 - y0) * 100 + "%";
  };
  draw();
  const mv = (ev) => {
    moved = true;
    x1 = clamp01((ev.clientX - rect.left) / rect.width);
    y1 = clamp01((ev.clientY - rect.top) / rect.height);
    draw();
  };
  const up = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
    box.remove();
    if (!moved) { selectEl(null); return; }   // 클릭만 → 선택 해제
    const mx0 = Math.min(x0, x1), my0 = Math.min(y0, y1), mx1 = Math.max(x0, x1), my1 = Math.max(y0, y1);
    const hit = [];
    els().forEach((el, i) => {
      const ex0 = el.x ?? 0.4, ey0 = el.y ?? 0.4, ex1 = ex0 + (el.w ?? 0.2), ey1 = ey0 + (el.h ?? 0.12);
      if (ex0 < mx1 && ex1 > mx0 && ey0 < my1 && ey1 > my0) hit.push(i); // AABB 겹침
    });
    selectEls(hit);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

// Lightweight repaint during drag (no background rebuild → no video reload).
function repaintEls() {
  const ov = $("preview")?.querySelector(":scope > .layer-elements");
  if (ov) renderElements(ov, els());
  renderEditLayer();
}

function selectEl(i) {
  state.editEl = i;
  state.editElSet = i == null ? new Set() : new Set([i]);
  renderEditLayer();
  renderDesignPanel();
}

// 여러 요소를 한 번에 선택(마퀴). 첫 요소를 primary(디자인 패널)로.
function selectEls(indices) {
  state.editElSet = new Set(indices);
  state.editEl = indices.length ? indices[0] : null;
  renderEditLayer();
  renderDesignPanel();
}

// 요소를 선택하고 디자인 패널의 '내용' 입력으로 포커스를 옮긴다(더블클릭 시).
// 텍스트 요소면 '내용' textarea, 콘텐츠 요소는 첫 편집 입력에 포커스한다.
function focusElementContent(i) {
  selectEl(i);                                     // 선택 + 디자인 탭 + 패널 렌더
  const body = $("el-props");
  const input = body?.querySelector('[data-field="text"]') || body?.querySelector("textarea, input[type='text'], input:not([type])");
  if (input) {
    input.focus();
    if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length); // 커서 끝으로
  }
}

// 입력 중(텍스트 필드·contentEditable)인지 — 전역 단축키(Del/방향키/복사 등)가
// 편집을 가로채지 않도록 가드에 사용.
function isTypingTarget() {
  const a = document.activeElement;
  if (!a) return false;
  return a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable;
}

// 모달(추가·템플릿·사운드·성구·라이브러리)이 열려 있는지 — 전역 단축키 가드용.
function anyModalOpen() {
  return !!document.querySelector(".modal-overlay:not([hidden])");
}

// ----- 인라인 편집용 플로팅 서식 바 (드래그로 글자 선택 → 색/굵기 적용) -----
// 색 도구가 캔버스 위에 떠서, 선택을 유지한 채 부분 색상을 적용한다(패널로 가면 선택이 풀림).
// 스와치=최근 쓴 색 6종(부족하면 기본색으로 채움). 버튼은 mousedown 기본동작을 막아
// 편집 포커스를 뺏지 않는다 → 색이 확실히 적용됨.
const FMT_DEFAULT_COLORS = ["#ffffff", "#ffd43b", "#ff6b6b", "#4dabf7", "#69db7c", "#000000"];
function fmtSwatchColors() {
  const out = [...recentColors()];                    // 최근 색 우선
  for (const c of FMT_DEFAULT_COLORS) { if (out.length >= 6) break; if (!out.includes(c.toLowerCase())) out.push(c); }
  return out.slice(0, 6);
}
let fmtBar = null, fmtNode = null, fmtRange = null;
function getFmtBar() {
  if (fmtBar && fmtBar.isConnected) return fmtBar;
  const bar = elx("div", "inline-fmt"); bar.hidden = true;
  bar.appendChild(elx("div", "fmt-swatches"));        // 최근 색(보여줄 때마다 채움)
  // 커스텀 색(네이티브 피커). 피커는 포커스를 가져가지만 저장된 선택을 복원해 적용한다(preventDefault 안 함=피커 열림).
  const custom = document.createElement("input");
  custom.type = "color"; custom.className = "fmt-color"; custom.value = "#ffcc00"; custom.title = "커스텀 색";
  custom.addEventListener("input", () => applyColor(custom.value));
  bar.appendChild(custom);
  const keepFocus = (b) => { b.onmousedown = (e) => e.preventDefault(); return b; };  // 편집 포커스 유지
  const mk = (label, title, fn) => { const b = keepFocus(elx("button", "fmt-btn", label)); b.title = title; b.onclick = () => applyFmt(fn); return b; };
  bar.append(mk("B", "굵게", () => document.execCommand("bold")));
  // 글꼴 선택(선택 영역에 적용). 첫 옵션은 안내용.
  const fontSel = document.createElement("select"); fontSel.className = "fmt-font"; fontSel.title = "선택 글자 글꼴";
  const ph = document.createElement("option"); ph.value = ""; ph.textContent = "글꼴"; fontSel.appendChild(ph);
  fillFontSelect(fontSel, "");
  fontSel.querySelectorAll("option").forEach((o) => { if (o.value === "" && o.textContent !== "글꼴") o.remove(); }); // "테마 기본" 중복 제거
  fontSel.addEventListener("change", () => { if (fontSel.value) applyFmt(() => document.execCommand("fontName", false, fontSel.value)); fontSel.value = ""; });
  bar.append(fontSel, mk("✕", "서식 지움", () => document.execCommand("removeFormat")));
  document.body.appendChild(bar);
  fmtBar = bar; return bar;
}
// 최근 색 스와치를 다시 그린다(바를 띄울 때마다). 최근에 쓴 색이 앞으로 온다.
function renderFmtSwatches() {
  const sws = fmtBar?.querySelector(".fmt-swatches");
  if (!sws) return;
  sws.replaceChildren();
  for (const c of fmtSwatchColors()) {
    const sw = elx("button", "fmt-sw"); sw.style.background = c; sw.title = c;
    sw.onmousedown = (e) => e.preventDefault();       // 포커스 유지(색 확실히 적용)
    sw.onclick = () => applyColor(c);
    sws.appendChild(sw);
  }
}
function applyColor(hex) {
  applyFmt(() => document.execCommand("foreColor", false, hex));
  pushRecentColor(hex);                                // 방금 쓴 색을 최근 목록 맨 앞으로
}
function hideFmtBar() { if (fmtBar) fmtBar.hidden = true; }
function fmtBarHasFocus() { return !!(fmtBar && fmtBar.contains(document.activeElement)); }
// 저장해둔 선택영역을 복원한 뒤 서식 적용 → el에 라이브 저장(커밋은 blur).
function applyFmt(fn) {
  if (fmtNode == null || state.inlineEdit == null) return;
  fmtNode.focus();
  if (fmtRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(fmtRange); }
  fn();
  const s2 = window.getSelection();
  if (s2.rangeCount && !s2.getRangeAt(0).collapsed) fmtRange = s2.getRangeAt(0).cloneRange();  // 적용 후 갱신
  const el = els()[state.inlineEdit];
  if (el) { el.html = fmtNode.innerHTML; el.text = fmtNode.innerText; }
}
// 편집 대상 = 렌더된 텍스트의 내부 블록(.el-text-inner).
function inlineNode(i) {
  const box = $("preview")?.querySelectorAll(":scope > .layer-elements > .el")[i];
  return box ? (box.querySelector(".el-text-inner") || box) : null;
}
// 인라인 편집 중, 노드 안에서 드래그 선택하면 서식 바를 선택 위에 띄운다.
// IME(한글) 조합 중인지 — 조합 글자는 선택 상태로 잡히는 경우가 있어(특히 iOS),
// 그대로 두면 글자마다 서식 바가 떴다 사라지며 조합을 방해한다.
let imeComposing = false;
document.addEventListener("compositionstart", () => { imeComposing = true; }, true);
document.addEventListener("compositionend", () => { imeComposing = false; }, true);

document.addEventListener("selectionchange", () => {
  if (state.inlineEdit == null) { hideFmtBar(); return; }
  if (imeComposing) return;                           // 조합 중엔 건드리지 않는다
  if (fmtBarHasFocus()) return;                       // 바(커스텀 색 피커) 조작 중엔 유지
  const node = inlineNode(state.inlineEdit);
  const sel = window.getSelection();
  if (!node || !sel.rangeCount) { hideFmtBar(); return; }
  const range = sel.getRangeAt(0);
  if (range.collapsed || !node.contains(range.commonAncestorContainer)) { hideFmtBar(); return; }
  fmtNode = node; fmtRange = range.cloneRange();
  const bar = getFmtBar();
  renderFmtSwatches();                                 // 최근 색으로 갱신
  const r = range.getBoundingClientRect();
  bar.hidden = false;
  bar.style.left = (r.left + r.width / 2) + "px";
  bar.style.top = (r.top - 8) + "px";
});

// 캔버스에서 텍스트 요소를 바로 인라인 편집(더블클릭·텍스트 추가 시). 렌더된 노드를
// contentEditable로 만들어 그 자리에서 입력 → blur/Esc에 저장. 편집 중엔 edit-layer를
// 통과시켜(pointer-events:none) 커서·선택이 노드에 닿게 한다.
const INLINE_TYPES = new Set(["text", "bible", "hymn", "reading"]);
function startInlineEdit(i, opts = {}) {
  const el = els()[i];
  if (!el || !INLINE_TYPES.has(el.type)) { focusElementContent(i); return; }
  selectEl(i);                                       // 선택 + 디자인 탭 + 패널
  state.inlineEdit = i;
  const pv = $("preview");
  const layer = pv.querySelector(":scope > .edit-layer");
  if (layer) layer.style.pointerEvents = "none";     // 렌더 노드가 클릭/커서를 받도록
  const box = pv.querySelectorAll(":scope > .layer-elements > .el")[i];
  const node = box ? (box.querySelector(".el-text-inner") || box) : null;
  if (!node) { state.inlineEdit = null; if (layer) layer.style.pointerEvents = ""; return; }
  box.classList.add("inline-editing");
  node.contentEditable = "true";
  node.spellcheck = false;
  // 텍스트: el.html/el.text로 편집 원본을 채운다. 콘텐츠(성경/찬송/교독): 이미 렌더된
  // 본문(구조 또는 el.html)을 그대로 편집 대상으로 삼는다(내용을 지우지 않음).
  if (el.type === "text") { if (el.html) node.innerHTML = el.html; else node.textContent = el.text ?? ""; }
  node.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(node);
  if (!opts.selectAll) range.collapse(false);        // 기본: 커서 끝 / 새 요소: 전체 선택
  sel.removeAllRanges(); sel.addRange(range);
  let dirty = false;
  // 라이브(리페인트 X: 포커스 유지). innerText는 레이아웃을 강제하므로 타이핑 중엔 읽지 않고
  // 마무리(finish)에서 한 번만 읽는다 — 빠르게 칠 때 글자가 밀리지 않게.
  const onInput = () => { dirty = true; el.html = node.innerHTML; };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); node.blur(); return; }
    e.stopPropagation();                             // 전역 단축키로 새지 않게(Del 등)
  };
  const finish = (ev) => {
    // 서식 바(커스텀 색 피커 등)로 포커스가 옮겨간 blur면 편집을 끝내지 않는다.
    if (ev && fmtBar && (fmtBar.contains(ev.relatedTarget) || fmtBarHasFocus())) return;
    node.removeEventListener("input", onInput);
    node.removeEventListener("keydown", onKey);
    node.removeEventListener("blur", finish);
    node.contentEditable = "false";
    box.classList.remove("inline-editing");
    state.inlineEdit = null;
    hideFmtBar(); fmtNode = null;                     // 플로팅 서식 바 닫기
    if (layer) layer.style.pointerEvents = "";       // edit-layer는 refresh에도 재사용되므로 꼭 복구
    // 콘텐츠 요소는 실제로 편집했을 때만 el.html 저장(무편집 시 구조 렌더 유지).
    if (el.type === "text" || dirty) { el.html = node.innerHTML; el.text = node.innerText; }
    commitEls();                                     // 저장 + refresh(정식 렌더로 복귀)
  };
  node.addEventListener("input", onInput);
  node.addEventListener("keydown", onKey);
  node.addEventListener("blur", finish);
}

function startMove(e, i) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  // 선택 밖의 요소를 누르면 단일 선택으로, 이미 선택된 그룹이면 그룹을 함께 이동.
  if (!state.editElSet.has(i)) selectEl(i);
  const rect = $("preview").getBoundingClientRect();
  const group = [...state.editElSet];
  const single = group.length <= 1;
  const orig = group.map((gi) => ({ i: gi, x: els()[gi].x ?? 0.4, y: els()[gi].y ?? 0.4 }));
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const mv = (ev) => {
    moved = true;
    const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
    if (single) {
      const el = els()[i];
      let x = clamp01((orig[0]?.x ?? 0.4) + dx), y = clamp01((orig[0]?.y ?? 0.4) + dy);
      ({ x, y } = snapMove(x, y, el.w ?? 0.2, el.h ?? 0.12)); // snap only single
      el.x = x; el.y = y;
    } else {
      for (const o of orig) { const el = els()[o.i]; el.x = clamp01(o.x + dx); el.y = clamp01(o.y + dy); }
    }
    repaintEls(); renderGuides();
  };
  // 움직였을 때만 저장. 단순 클릭/더블클릭에서 commit→비동기 refresh가
  // 디자인 패널을 다시 그려 '내용' 입력 포커스를 뺏는 것을 막는다.
  const up = () => { draggingEls--; document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); clearGuides(); if (moved) commitEls(); };
  draggingEls++;   // 끄는 동안엔 남의 변경 반영을 미룬다(작업이 날아가지 않게)
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

function startResize(e, i, pos) {
  e.preventDefault(); e.stopPropagation();
  const rect = $("preview").getBoundingClientRect();
  const el = els()[i];
  const sx = e.clientX, sy = e.clientY;
  const o = { x: el.x ?? 0.4, y: el.y ?? 0.4, w: el.w ?? 0.2, h: el.h ?? 0.12 };
  const mv = (ev) => {
    const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
    activeGuides = { v: null, h: null };
    if (pos.includes("e")) { const r = snapEdge(o.x + o.w + dx); el.w = Math.max(0.03, r - o.x); if (r !== o.x + o.w + dx) activeGuides.v = r; }
    if (pos.includes("s")) { const b = snapEdge(o.y + o.h + dy); el.h = Math.max(0.03, b - o.y); if (b !== o.y + o.h + dy) activeGuides.h = b; }
    if (pos.includes("w")) { const l = snapEdge(o.x + dx); el.x = l; el.w = Math.max(0.03, o.x + o.w - l); if (l !== o.x + dx) activeGuides.v = l; }
    if (pos.includes("n")) { const t = snapEdge(o.y + dy); el.y = t; el.h = Math.max(0.03, o.y + o.h - t); if (t !== o.y + dy) activeGuides.h = t; }
    repaintEls(); renderGuides();
  };
  const up = () => { draggingEls--; document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); clearGuides(); commitEls(); };
  draggingEls++;
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

async function commitEls() {
  if (state.editingTemplate) { repaintEls(); return; } // draft: local only
  const slide = selectedSlide();
  if (!slide) return;
  await callTool("set_slide_elements", { slide_id: slide.id, elements: slide.elements || [] });
  await refresh();
}

const ADD_DEFAULTS = {
  text: () => ({ type: "text", x: 0.34, y: 0.42, w: 0.32, h: 0.12, text: "텍스트", size: 4, color: "#ffffff", align: "center", weight: 600 }),
  rect: () => ({ type: "shape", shape: "rect", x: 0.4, y: 0.4, w: 0.2, h: 0.16, fill: "#7aa2f7", stroke: "#ffffff", stroke_width: 0, radius: 6 }),
  ellipse: () => ({ type: "shape", shape: "ellipse", x: 0.4, y: 0.4, w: 0.18, h: 0.18, fill: "#7aa2f7", stroke: "#ffffff", stroke_width: 0 }),
  line: () => ({ type: "shape", shape: "line", x: 0.3, y: 0.5, w: 0.4, h: 0.02, stroke: "#ffffff", stroke_width: 3 }),
  // content elements: added empty → user fills params in the design panel + 다시 가져오기
  bible: () => ({ type: "bible", x: 0.1, y: 0.25, w: 0.8, h: 0.5, size: 3.2, align: "center", weight: 600, line_height: 1.5, show_numbers: "auto", params: {}, content: null }),
  hymn: () => ({ type: "hymn", x: 0.1, y: 0.25, w: 0.8, h: 0.5, size: 3.2, align: "center", weight: 600, params: {}, content: null }),
  reading: () => ({ type: "reading", x: 0.08, y: 0.2, w: 0.84, h: 0.6, size: 2.9, align: "center", weight: 600, params: {}, content: null }),
  image: () => ({ type: "image", x: 0.35, y: 0.32, w: 0.3, h: 0.3, fit: "contain" }),
  // 영상 요소: 로컬 업로드/URL. muted:false = 발표에서 소리 재생.
  video: () => ({ type: "video", x: 0.25, y: 0.2, w: 0.5, h: 0.5, url: "", fit: "contain", loop: true, muted: false }),
};

async function addElement(kind, extra) {
  const slide = selectedSlide();
  if (!slide) { msg("add-msg", "슬라이드를 먼저 선택하세요.", true); return; }
  const el = { ...ADD_DEFAULTS[kind](), ...extra };
  slide.elements = [...(slide.elements || []), el];
  state.editEl = slide.elements.length - 1;
  await commitEls();
  selectEl(state.editEl);
  if (kind === "text") startInlineEdit(state.editEl, { selectAll: true }); // 추가하자마자 캔버스에서 입력
}

function deleteEl(i) {
  const slide = selectedSlide();
  if (!slide || i == null) return;
  slide.elements = (slide.elements || []).filter((_, j) => j !== i);
  state.editEl = null;
  state.editElSet = new Set();
  commitEls();
}

// 선택된 요소들(단일·다중)을 한 번에 삭제.
function deleteSelectedEls() {
  const slide = selectedSlide();
  if (!slide || !state.editElSet.size) return;
  const rm = state.editElSet;
  slide.elements = (slide.elements || []).filter((_, j) => !rm.has(j));
  state.editEl = null;
  state.editElSet = new Set();
  commitEls();
}

function moveElZ(i, toFront) {
  const slide = selectedSlide();
  const arr = slide?.elements;
  if (!arr || i == null) return;
  const [el] = arr.splice(i, 1);
  if (toFront) { arr.push(el); state.editEl = arr.length - 1; }
  else { arr.unshift(el); state.editEl = 0; }
  commitEls();
}

// ----- 디자인 패널 (선택한 요소 속성) -----
const CONTENT_PARAMS = {
  bible: [["책(이름/약칭)", "book", "text"], ["장", "chapter", "int"], ["시작 절", "verse_start", "int"], ["끝 절", "verse_end", "int"]],
  hymn: [["찬송가 번호", "number", "int"]],   // 절/후렴은 hymnVerseField 선택으로
  reading: [["교독문 번호", "number", "int"]],
};
// 표시 항목 — 콘텐츠 요소가 어느 부분을 보여줄지 (분리 배치용)
const FIELD_OPTIONS = {
  bible: [["all", "전체"], ["ref", "구절(요 3:16)"], ["text", "본문만"]],
  hymn: [["all", "전체"], ["title", "제목/장"], ["label", "절"], ["lyrics", "가사만"]],
  reading: [["all", "전체(인도자+회중)"], ["title", "제목"], ["body", "본문(인도자+회중)"], ["leader", "인도자만"], ["congregation", "회중만"], ["unison", "다같이만"]],
};
// 형식(format): 단일 줄 필드의 표시 문자열 (기본값 + 사용 가능 토큰)
const FMT_DEFAULT = {
  hymn: { title: "{number}장 {title}", label: "{label}" },
  bible: { ref: "{ref}" },
  reading: { title: "{number}번 {title}" },
};
const FMT_TOKENS = {
  hymn: { title: "{number}, {title}", label: "{label}" },
  bible: { ref: "{ref}" },
  reading: { title: "{number}, {title}" },
};

// ---- 색 팔레트: 이 예배에 쓰인 색 + 최근 쓴 색(localStorage) ----
const isHex = (c) => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c);
function serviceColors() {
  const set = new Set();
  const add = (c) => { if (isHex(c)) set.add(c.toLowerCase()); };
  for (const s of slides()) {
    if (s.background?.type === "color") add(s.background.value);
    if (s.background?.type === "gradient") { add(s.background.from); add(s.background.to); }
    for (const e of s.elements || []) { add(e.color); add(e.fill); add(e.stroke); }
  }
  return [...set];
}
function recentColors() { try { return JSON.parse(localStorage.getItem("lyra.recentColors") || "[]"); } catch { return []; } }
function pushRecentColor(hex) {
  if (!isHex(hex)) return;
  hex = hex.toLowerCase();
  const list = [hex, ...recentColors().filter((c) => c !== hex)].slice(0, 12);
  localStorage.setItem("lyra.recentColors", JSON.stringify(list));
}
// 스와치 묶음(최근 → 이 예배). onPick(hex) 호출. 없으면 null.
function colorSwatches(current, onPick) {
  const wrap = elx("div", "swatches");
  const seen = new Set();
  const addSw = (hex, group) => {
    if (!isHex(hex) || seen.has(hex.toLowerCase())) return;
    seen.add(hex.toLowerCase());
    const b = document.createElement("button");
    b.type = "button"; b.className = "swatch" + (hex.toLowerCase() === (current || "").toLowerCase() ? " cur" : "");
    b.style.background = hex; b.title = `${group}: ${hex}`;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onPick(hex); };
    wrap.appendChild(b);
  };
  recentColors().forEach((c) => addSw(c, "최근"));
  serviceColors().forEach((c) => addSw(c, "이 예배"));
  return wrap.children.length ? wrap : null;
}

// 찬송가 제목·가사로 검색 → 결과 클릭 시 onPick(number, title). 번호를 몰라도 찾도록.
function hymnSearchField(placeholder, onPick) {
  const wrap = elx("div", "hymn-search");
  const input = document.createElement("input");
  input.type = "search"; input.placeholder = placeholder || "찬송가 제목·가사로 검색 (예: 만복, 주 예수)";
  const results = elx("div", "hymn-search-results"); results.hidden = true;
  let timer = null;
  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) { results.hidden = true; results.replaceChildren(); return; }
    try {
      const { results: hits } = await callTool("search_hymn", { query: q, limit: 12 });
      results.replaceChildren();
      if (!hits.length) { results.append(elx("div", "hymn-hit-empty", "결과 없음")); results.hidden = false; return; }
      for (const h of hits) {
        const row = elx("button", "hymn-hit"); row.type = "button";
        row.append(elx("span", "hh-no", `${h.number}장`), elx("span", "hh-title", h.title));
        row.onmousedown = (e) => e.preventDefault();   // 클릭해도 입력 포커스 유지
        row.onclick = () => { results.hidden = true; onPick(h.number, h.title); };
        results.appendChild(row);
      }
      results.hidden = false;
    } catch (e) { results.replaceChildren(elx("div", "hymn-hit-empty", e.message)); results.hidden = false; }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(doSearch, 200); });
  input.addEventListener("focus", () => { if (results.children.length) results.hidden = false; });
  input.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 150));
  wrap.append(input, results);
  return wrap;
}

// 이 찬송 요소가 가리키는 절 (0=후렴, null=미지정). 예전에 만든 슬라이드는 params에
// verse_no가 없으므로 이미 가져온 라벨("후렴"/"2절")에서 추정한다.
function hymnVerseNo(el) {
  const v = el.params?.verse_no;
  if (v != null) return v;
  const label = el.content?.label || "";
  if (label.includes("후렴")) return 0;
  const m = /^(\d+)\s*절/.exec(label);
  return m ? Number(m[1]) : null;
}

// 찬송가 요소의 "절 / 후렴" 선택 (params.verse_no, 0=후렴). 번호를 알면 실제 절 목록으로
// 채우고, 후렴이 있는 찬송이면 "후렴"을 옵션으로 넣는다(후렴만 있는 슬라이드를 만들 수 있게).
function hymnVerseField(el, target) {
  const wrap = elx("label", null, "절 / 후렴");
  const sel = document.createElement("select");
  const cur = hymnVerseNo(el);
  const fill = (opts) => {
    sel.replaceChildren();
    for (const [v, t] of opts) { const o = document.createElement("option"); o.value = String(v); o.textContent = t; sel.appendChild(o); }
    sel.value = cur == null ? "" : String(cur);
    if (sel.selectedIndex < 0) sel.value = "";
  };
  // 목록을 가져오기 전에도 현재 값은 보이게 (깜박임 방지)
  fill([["", "1절 (기본)"], ...(cur != null ? [[cur, cur === 0 ? "후렴" : `${cur}절`]] : [])]);
  sel.onchange = () => {
    const params = { ...(el.params || {}) };
    if (sel.value === "") delete params.verse_no; else params.verse_no = Number(sel.value);
    el.params = params;
    fetchContentElement(state.editEl);
  };
  wrap.appendChild(sel); target.appendChild(wrap);
  const number = el.params?.number;
  if (!number) return;
  callTool("get_hymn", { number }).then((h) => {
    if (!sel.isConnected) return;
    const opts = [["", "1절 (기본)"], ...(h.verses || []).map((v) => [v.verse_no, v.label || `${v.verse_no}절`])];
    if (h.refrain?.length) opts.push([0, "후렴"]);
    fill(opts);
  }).catch(() => {});
}

// ---- 디자인 패널 접이식 그룹 (열림/닫힘은 localStorage에 기억) ----
// 패널은 편집할 때마다 다시 그려지므로, 열림 상태를 저장해 두지 않으면 매번 초기화된다.
function groupOpenMap() {
  try { return JSON.parse(localStorage.getItem("lyra.panelGroups") || "{}"); } catch { return {}; }
}
function isGroupOpen(key, def) { const m = groupOpenMap(); return typeof m[key] === "boolean" ? m[key] : def; }
function setGroupOpen(key, open) {
  const m = groupOpenMap(); m[key] = open;
  localStorage.setItem("lyra.panelGroups", JSON.stringify(m));
}
// 정적 HTML의 <details class="pgroup" data-gkey="…">도 같은 방식으로 기억.
function wireStaticGroups() {
  for (const d of document.querySelectorAll("details.pgroup[data-gkey]")) {
    d.open = isGroupOpen(d.dataset.gkey, d.open);
    d.addEventListener("toggle", () => setGroupOpen(d.dataset.gkey, d.open));
  }
}

function renderDesignPanel() {
  const empty = $("el-empty"), body = $("el-props");
  // 편집할 때마다 commitEls→refresh→render로 이 패널을 다시 그리는데, 그때 스크롤이
  // 맨 위로 튀지 않도록 스크롤 컨테이너(.col.panel)의 위치를 보존한다.
  const panel = body.closest(".col");
  const savedScroll = panel ? panel.scrollTop : 0;
  const restoreScroll = () => { if (panel) panel.scrollTop = savedScroll; };
  // 다중 선택: 개별 속성 대신 요약 + 일괄 동작
  if (state.editElSet.size > 1) {
    empty.hidden = true; body.hidden = false;
    body.replaceChildren();
    body.appendChild(elx("div", "section-title", `${state.editElSet.size}개 요소 선택됨`));
    body.appendChild(elx("p", "hint muted", "드래그로 함께 이동 · 방향키 미세이동 · Del 삭제 · ⌘/Ctrl+C·V 복사/붙여넣기"));
    const del = elx("button", "mini danger", "선택 요소 삭제"); del.onclick = () => deleteSelectedEls();
    body.appendChild(del);
    restoreScroll();
    return;
  }
  const el = state.editEl != null ? els()[state.editEl] : null;
  if (!el) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  body.replaceChildren();

  // 아래 입력들은 모두 "현재 그룹"(target)에 담긴다. group()을 부르면 그 다음 입력부터
  // 새 접이식 그룹으로 들어간다. group을 한 번도 안 부르면 예전처럼 평평하게 쌓인다.
  let target = body;
  const group = (key, label, defOpen = true) => {
    const d = elx("details", "pgroup");
    d.open = isGroupOpen(key, defOpen);
    d.addEventListener("toggle", () => setGroupOpen(key, d.open));
    const inner = elx("div", "pgroup-body");
    d.append(elx("summary", null, label), inner);
    body.appendChild(d);
    target = inner;
  };

  // field that edits el[field]; live on input, persist on change
  const field = (label, type, fieldName, opts = {}) => {
    const wrap = elx("label", null, label);
    let input;
    if (type === "textarea") { input = document.createElement("textarea"); input.rows = 2; input.value = el[fieldName] ?? ""; }
    else if (type === "check") { input = document.createElement("input"); input.type = "checkbox"; input.checked = el[fieldName] !== false; }
    else if (type === "select") {
      input = document.createElement("select");
      for (const [v, t] of opts.options) { const o = document.createElement("option"); o.value = v; o.textContent = t; input.appendChild(o); }
      input.value = el[fieldName] ?? opts.options[0][0];
    } else {
      input = document.createElement("input"); input.type = type;
      if (type === "range") { input.min = opts.min; input.max = opts.max; input.step = opts.step; }
      input.value = el[fieldName] ?? opts.def ?? "";
    }
    const apply = (commit) => {
      el[fieldName] = type === "check" ? input.checked : (type === "range" || opts.num ? Number(input.value) : input.value);
      repaintEls();
      if (commit) { commitEls(); if (type === "color") pushRecentColor(el[fieldName]); }
    };
    input.addEventListener("input", () => apply(false));
    input.addEventListener("change", () => apply(true));
    input.dataset.field = fieldName;   // 더블클릭 → 해당 입력 포커스용
    wrap.appendChild(input);
    // 색 입력엔 팔레트 스와치(이 예배 색 + 최근 색)를 붙여 빠르게 재사용
    if (type === "color") {
      const sw = colorSwatches(el[fieldName], (hex) => { input.value = hex; apply(true); renderDesignPanel(); });
      if (sw) wrap.appendChild(sw);
    }
    target.appendChild(wrap);
  };

  // 글자 크기: 슬라이더 + 숫자(정확값). 여러 슬라이드에 동일 값 적용 가능.
  const sizeRow = (min, max, def = 4) => {
    const wrap = elx("label", null, "글자 크기 (숫자)");
    const row = elx("div", "size-row");
    const range = document.createElement("input"); range.type = "range"; range.min = min; range.max = max; range.step = 0.1;
    const num = document.createElement("input"); num.type = "number"; num.min = min; num.max = max; num.step = 0.1;
    range.value = num.value = el.size ?? def;
    const apply = (v, commit) => { el.size = Number(v); range.value = num.value = el.size; repaintEls(); if (commit) commitEls(); };
    range.addEventListener("input", () => apply(range.value, false));
    range.addEventListener("change", () => apply(range.value, true));
    num.addEventListener("input", () => apply(num.value, false));
    num.addEventListener("change", () => apply(num.value, true));
    row.append(range, num); wrap.appendChild(row); target.appendChild(wrap);
  };

  // 슬라이더 + 숫자 조합으로 임의 숫자 필드 편집(줄 간격 등).
  const numRow = (label, fieldName, { min, max, step, def }) => {
    const wrap = elx("label", null, label);
    const row = elx("div", "size-row");
    const range = document.createElement("input"); range.type = "range"; range.min = min; range.max = max; range.step = step;
    const num = document.createElement("input"); num.type = "number"; num.min = min; num.max = max; num.step = step;
    range.value = num.value = el[fieldName] ?? def;
    const apply = (v, commit) => { el[fieldName] = Number(v); range.value = num.value = el[fieldName]; repaintEls(); if (commit) commitEls(); };
    range.addEventListener("input", () => apply(range.value, false));
    range.addEventListener("change", () => apply(range.value, true));
    num.addEventListener("input", () => apply(num.value, false));
    num.addEventListener("change", () => apply(num.value, true));
    row.append(range, num); wrap.appendChild(row); target.appendChild(wrap);
  };

  // 글꼴: 용도 그룹(optgroup) select. 값=family("" → 테마 기본 상속).
  const fontField = () => {
    const wrap = elx("label", null, "글꼴");
    const sel = document.createElement("select");
    fillFontSelect(sel, el.font || "");
    sel.addEventListener("change", () => { el.font = sel.value; repaintEls(); commitEls(); });
    wrap.appendChild(sel); target.appendChild(wrap);
  };

  // 리치 텍스트 '내용' 편집기: 일부만 선택해 색/굵기 적용(부분 색상). el.html에 저장, el.text=평문.
  // 표시는 패널 기본 스타일로 통일한다(.rt-editor CSS) — 슬라이드 서식(검은 글씨 등)을
  // 그대로 그리면 어두운 패널에서 안 보이기 때문. 서식 자체는 el.html에 그대로 유지된다.
  const richTextField = () => {
    // <label>로 감싸면 안쪽 아무 데나 클릭해도 첫 폼 컨트롤(색 입력)이 눌려 색 선택 창이
    // 잠깐 떴다 사라진다 → 캡션은 그냥 div로.
    const wrap = elx("div", "rt-field");
    wrap.appendChild(elx("div", "rt-label", "내용"));
    const ed = document.createElement("div");
    ed.className = "rt-editor"; ed.contentEditable = "true"; ed.dataset.field = "text";
    // 높이는 사용자가 아래 모서리를 끌어 조절(resize) → 다시 그려도 유지되게 기억한다.
    const savedH = Number(localStorage.getItem("lyra.rtEditorHeight")) || 0;
    if (savedH) ed.style.height = savedH + "px";
    const saveH = () => {
      if (!ed.isConnected) return;
      const h = Math.round(ed.getBoundingClientRect().height);
      if (h && h !== Number(localStorage.getItem("lyra.rtEditorHeight"))) localStorage.setItem("lyra.rtEditorHeight", String(h));
    };
    new ResizeObserver(saveH).observe(ed);
    ed.addEventListener("mouseup", saveH);   // 크기 조절 드래그가 끝나는 시점(RO 백업)
    if (el.html) ed.innerHTML = el.html; else ed.textContent = el.text ?? "";
    const save = (commit) => { el.html = ed.innerHTML; el.text = ed.innerText; repaintEls(); if (commit) commitEls(); };
    // 선택영역 추적: 색 입력(네이티브 피커) 상호작용으로 선택이 풀려도 복원해 적용.
    let range = null;
    const track = () => { const s = window.getSelection(); if (s.rangeCount && ed.contains(s.anchorNode)) range = s.getRangeAt(0).cloneRange(); };
    ed.addEventListener("keyup", track);
    ed.addEventListener("mouseup", track);
    // 타이핑 중엔 미리보기 갱신을 미룬다. 글자마다 repaintEls()를 돌리면 슬라이드의 모든
    // 요소 노드를 새로 만들고(배경 <img>까지 재생성) innerText가 레이아웃을 강제한다.
    // 아이패드/사파리처럼 CPU가 약한 기기에서 이 비용이 그대로 입력 지연으로 나타난다.
    // 모델(el.html)은 즉시 반영하므로 저장은 언제 끊겨도 안전.
    let liveT = null, composing = false;
    const liveSave = () => {
      el.html = ed.innerHTML;                 // innerText는 레이아웃을 강제하므로 여기선 안 읽는다
      clearTimeout(liveT);
      liveT = setTimeout(function tick() {    // 조합 중이면 끝날 때까지 기다렸다 그린다
        if (!ed.isConnected) return;
        if (composing) { liveT = setTimeout(tick, 250); return; }
        save(false);
      }, 250);
    };
    // 한글 조합 중(IME)에는 DOM을 건드리지 않는다 — 조합이 깨져 글자가 씹힌다.
    // iOS 사파리는 compositionstart/end가 빠지기도 해서 inputType으로도 판별한다.
    ed.addEventListener("compositionstart", () => { composing = true; });
    ed.addEventListener("compositionend", () => { composing = false; });
    ed.addEventListener("input", (e) => {
      track();
      if (e.inputType && e.inputType.startsWith("insertComposition")) composing = true;
      liveSave();
    });
    ed.addEventListener("blur", () => { clearTimeout(liveT); save(true); });
    const apply = (fn) => {
      ed.focus();
      if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
      fn(); track(); save(false);
    };
    // 서식 툴바
    const bar = elx("div", "rt-bar");
    const color = document.createElement("input"); color.type = "color"; color.value = "#ffcc00"; color.title = "선택한 글자 색";
    color.addEventListener("input", () => apply(() => document.execCommand("foreColor", false, color.value)));
    const btn = (label, fn) => { const b = elx("button", "mini", label); b.onmousedown = (e) => e.preventDefault(); b.onclick = () => apply(fn); return b; };
    bar.append(color,
      btn("선택 색", () => document.execCommand("foreColor", false, color.value)),
      btn("굵게", () => document.execCommand("bold")),
      btn("서식 지움", () => document.execCommand("removeFormat")));
    const hint = elx("p", "hint muted", "여기서는 읽기 쉽게 한 가지 색·글꼴로 보여줍니다. 실제 색·글꼴은 캔버스에서 확인하세요.");
    wrap.append(ed, bar, hint); target.appendChild(wrap);
  };

  // 텍스트 효과(그림자·외곽선) — 텍스트·성경/가사 공통. 영상 위 가독성용.
  const effectFields = () => {
    { const wrap = elx("label", null, "그림자");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!el.shadow;
      cb.onchange = () => { el.shadow = cb.checked; repaintEls(); commitEls(); renderDesignPanel(); };
      wrap.appendChild(cb); target.appendChild(wrap); }
    if (el.shadow) {
      field("그림자 색", "color", "shadow_color", { def: "#000000" });
      numRow("그림자 번짐", "shadow_blur", { min: 0, max: 0.4, step: 0.02, def: 0.12 });
    }
    numRow("외곽선 두께(px)", "outline_width", { min: 0, max: 8, step: 0.5, def: 0 });
    field("외곽선 색", "color", "outline_color", { def: "#000000" });
  };

  if (el.type === "text") {
    group("text-content", "내용");
    richTextField();
    group("text-type", "글자");
    sizeRow(1.5, 12);
    fontField();
    field("색(전체 기본)", "color", "color", { def: "#ffffff" });
    field("굵기", "select", "weight", { options: [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "더 굵게"]] });
    field("정렬(가로)", "select", "align", { options: [["center", "가운데"], ["left", "왼쪽"], ["right", "오른쪽"]] });
    field("정렬(세로)", "select", "valign", { options: [["middle", "가운데"], ["top", "위"], ["bottom", "아래"]] });
    numRow("줄 간격 (숫자)", "line_height", { min: 1, max: 2.6, step: 0.05, def: 1.3 });
    group("effects", "효과 · 투명도", false);
    effectFields();
  } else if (el.type === "shape") {
    group("shape-style", "도형");
    if (el.shape !== "line") {
      field("채움색", "color", "fill", { def: "#7aa2f7" });
      field("테두리색", "color", "stroke", { def: "#ffffff" });
      field("테두리 두께", "range", "stroke_width", { min: 0, max: 12, step: 1, num: true });
      if (el.shape === "rect") field("모서리", "range", "radius", { min: 0, max: 40, step: 1, num: true });
    } else {
      field("선 색", "color", "stroke", { def: "#ffffff" });
      field("선 두께", "range", "stroke_width", { min: 1, max: 14, step: 1, num: true });
    }
    group("effects", "효과 · 투명도", false);
  } else if (el.type === "image") {
    group("image-style", "이미지");
    target.appendChild(elx("p", "muted", "이미지는 캔버스에서 드래그·크기조절하세요."));
    group("effects", "효과 · 투명도", false);
  } else if (el.type === "video") {
    group("video-style", "영상");
    // URL 직접 입력
    { const wrap = elx("label", null, "영상 URL");
      const input = document.createElement("input"); input.type = "text"; input.value = el.url || "";
      input.placeholder = "https://…  또는 아래에서 파일 선택";
      input.oninput = () => { el.url = input.value; };
      input.onchange = () => { el.url = input.value; repaintEls(); commitEls(); };
      wrap.appendChild(input); target.appendChild(wrap);
      // 로컬 파일 업로드
      const file = document.createElement("input"); file.type = "file"; file.accept = "video/*";
      file.onchange = async () => {
        if (!file.files[0]) return;
        msg("add-msg", "영상 업로드 중…");
        try { const { url } = await uploadFile(file.files[0]); el.url = url; input.value = url; repaintEls(); commitEls(); msg("add-msg", "업로드 완료"); }
        catch (e) { msg("add-msg", e.message, true); }
      };
      target.appendChild(file);
    }
    field("반복 재생", "check", "loop");
    // 소리: 체크 = 소리 켜짐(= muted:false). 소리는 발표 화면에서만 재생됨.
    { const wrap = elx("label", null, "소리 (발표 화면에서)");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !el.muted;
      cb.onchange = () => { el.muted = !cb.checked; repaintEls(); commitEls(); };
      wrap.appendChild(cb); target.appendChild(wrap);
    }
    field("채움", "select", "fit", { options: [["contain", "전체 보이기"], ["cover", "꽉 채우기"]] });
    target.appendChild(elx("p", "hint muted", "편집 미리보기는 음소거이고, 소리는 발표 화면에서 재생됩니다."));
    group("effects", "효과 · 투명도", false);
  } else if (["bible", "hymn", "reading"].includes(el.type)) {
    const fkey = el.field ?? "all";
    // ── 내용: 어떤 본문을 가져올지(params) ──
    group("ce-source", "내용 가져오기");
    // 찬송가: 번호를 몰라도 제목·가사로 검색해 선택(→ 번호 채우고 본문 가져오기)
    if (el.type === "hymn") {
      const search = hymnSearchField("찬송가 제목·가사로 검색", (num) => {
        el.params = { ...(el.params || {}), number: num };
        fetchContentElement(state.editEl);   // 본문 가져오기 + 재렌더(번호 입력 갱신)
      });
      target.appendChild(search);
    }
    for (const [label, name, ptype] of CONTENT_PARAMS[el.type]) {
      const wrap = elx("label", null, label);
      const input = document.createElement("input");
      input.type = ptype === "int" ? "number" : "text";
      input.value = el.params?.[name] ?? "";
      input.onchange = () => { el.params = { ...(el.params || {}), [name]: ptype === "int" ? Number(input.value) : input.value }; };
      wrap.appendChild(input); target.appendChild(wrap);
    }
    if (el.type === "hymn") hymnVerseField(el, target);   // 절 / 후렴 선택
    { const refetch = elx("button", "mini accent", "다시 가져오기"); refetch.onclick = () => fetchContentElement(state.editEl);
      target.appendChild(refetch); }
    // ── 표시: 이 요소가 본문의 어느 부분을 어떤 형식으로 보여줄지 ──
    group("ce-display", "표시 항목");
    { // 표시 항목(field): 바꾸면 즉시 반영 + 패널 갱신(절 번호 표시 노출 여부)
      const wrap = elx("label", null, "표시 항목");
      const sel = document.createElement("select");
      for (const [v, t] of FIELD_OPTIONS[el.type]) { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = el.field ?? "all";
      sel.onchange = () => { el.field = sel.value; repaintEls(); commitEls(); renderDesignPanel(); };
      wrap.appendChild(sel); target.appendChild(wrap);
    }
    { // 형식(format): 단일 줄 필드(제목/구절)의 표시 문자열
      const fmtDef = FMT_DEFAULT[el.type]?.[fkey];
      if (fmtDef != null) {
        const wrap = elx("label", null, "형식");
        const input = document.createElement("input");
        input.type = "text"; input.value = el.format ?? fmtDef; input.placeholder = fmtDef;
        input.oninput = () => { el.format = input.value; repaintEls(); };
        input.onchange = () => { el.format = input.value; commitEls(); };
        wrap.appendChild(input); target.appendChild(wrap);
        target.appendChild(elx("p", "hint muted", `토큰: ${FMT_TOKENS[el.type][fkey]}`));
      }
    }
    if (el.type === "bible" && fkey !== "ref") {
      // 예전 슬라이드는 true/false로 저장돼 있다 → select 값으로 맞춰 보여준다.
      if (el.show_numbers === true) el.show_numbers = "always";
      else if (el.show_numbers === false) el.show_numbers = "never";
      field("절 번호", "select", "show_numbers", {
        options: [["auto", "여러 절일 때만"], ["always", "항상"], ["never", "표시 안 함"]],
      });
    }
    // ── 글자 ──
    group("ce-type", "글자");
    target.appendChild(elx("p", "hint muted", "본문을 더블클릭하면 전체·일부 글자의 글꼴·색을 바꿀 수 있어요(선택 후 떠오르는 서식 바)."));
    sizeRow(1.5, 10, 3.2);
    fontField();
    field("색(전체)", "color", "color", { def: "#ffffff" });
    field("정렬(가로)", "select", "align", { options: [["center", "가운데"], ["left", "왼쪽"], ["right", "오른쪽"]] });
    field("정렬(세로)", "select", "valign", { options: [["middle", "가운데"], ["top", "위"], ["bottom", "아래"]] });
    numRow("줄 간격 (숫자)", "line_height", { min: 1, max: 2.6, step: 0.05, def: 1.5 });
    field("굵기", "select", "weight", { options: [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "더 굵게"]] });
    // 교독문 인도자/회중 스타일 (전체·본문 = 인도자·회중이 함께 있을 때)
    if (el.type === "reading" && (fkey === "all" || fkey === "body")) {
      group("ce-role", "역할 스타일", false);
      field("역할 표시(인도자/회중)", "check", "show_tags");
      field("인도자 색", "color", "leader_color", { def: "#7aa2f7" });
      field("회중 색", "color", "congregation_color", { def: "#e0af68" });
    }
    group("effects", "효과 · 투명도", false);
    effectFields();   // 성경/찬송/교독문도 그림자·외곽선(영상 위 가독성)
  }

  // 투명도 — 모든 요소 공통(0=완전 투명, 1=불투명). 영상·이미지·도형·텍스트 모두 적용.
  numRow("투명도 (0~1)", "opacity", { min: 0, max: 1, step: 0.05, def: 1 });

  const actions = elx("div", "el-actions");
  const front = elx("button", "mini", "맨 앞으로"); front.onclick = () => moveElZ(state.editEl, true);
  const back = elx("button", "mini", "맨 뒤로"); back.onclick = () => moveElZ(state.editEl, false);
  const del = elx("button", "mini danger", "삭제"); del.onclick = () => deleteSelectedEls();
  actions.append(front, back, del);
  body.appendChild(actions);
  restoreScroll();   // 편집 후 재렌더에도 스크롤 위치 유지
}

// re-fetch a content element's snapshot from its params via read tools
async function fetchContentElement(i) {
  const el = els()[i];
  if (!el) return;
  const p = el.params || {};
  try {
    if (el.type === "bible") {
      const r = await callTool("get_bible_passage", { book: p.book, chapter: p.chapter, verse_start: p.verse_start, verse_end: p.verse_end });
      const ref = `${r.short_name || r.book_name} ${p.chapter}:${p.verse_start}${p.verse_end > p.verse_start ? "-" + p.verse_end : ""}`;
      el.content = { ref, verses: r.verses };
    } else if (el.type === "hymn") {
      const h = await callTool("get_hymn", { number: p.number });
      // 예전 슬라이드(verse_no 없음)는 현재 라벨에서 절/후렴을 추정해 그대로 유지한다.
      if (p.verse_no == null) {
        const guess = hymnVerseNo(el);
        if (guess != null) { p.verse_no = guess; el.params = { ...p }; }
      }
      // verse_no=0 → 후렴(별도 저장). 없으면 지정 절, 그것도 없으면 첫 절.
      if (p.verse_no === 0 && !h.refrain?.length) {
        // 후렴 없는 찬송으로 바꾼 경우: 막히지 않게 1절로 되돌린다.
        delete p.verse_no; el.params = { ...p };
        toast(`${h.number}장 “${h.title}”에는 후렴이 없어 1절을 가져왔습니다`);
      }
      if (p.verse_no === 0) {
        el.content = { number: h.number, title: h.title, label: "후렴", lines: h.refrain };
      } else {
        const v = (h.verses || []).find((x) => x.verse_no === (p.verse_no || 1)) || h.verses?.[0];
        el.content = { number: h.number, title: h.title, label: v?.label, lines: v?.lines || [] };
      }
      // 한 슬라이드의 찬송 요소들(제목/절/가사)은 같은 찬송·같은 절을 가리키므로 함께 갱신.
      for (const other of els()) {
        if (other === el || other.type !== "hymn") continue;
        other.params = { ...el.params };
        other.content = structuredClone(el.content);
        delete other.html; delete other.text;
      }
    } else if (el.type === "reading") {
      const rd = await callTool("get_reading", { number: p.number });
      el.content = { number: rd.number, title: rd.title, segments: rd.segments };
    }
    delete el.html; delete el.text;   // 다시 가져오면 인라인 편집 오버라이드를 버리고 구조 렌더로 복귀
    repaintEls();
    await commitEls();
    renderDesignPanel();              // 절 목록·번호 입력 갱신(템플릿 초안 편집 중에도)
  } catch (e) { alert("가져오기 실패: " + e.message); }
}

// ===== 디자인 템플릿 =====
function slideDesign(slide) {
  return { background: slide.background, elements: slide.elements };
}

async function loadTemplates() {
  state.templates = await callTool("list_templates").catch(() => []);
  // 자가복구: 템플릿이 0개면 아무것도 추가할 수 없으므로 기본 종류를 다시 시드한다.
  if (!state.templates?.length) {
    await callTool("reset_templates").catch(() => {});
    state.templates = await callTool("list_templates").catch(() => []);
  }
  renderTemplatePanel();
  renderAddTypeSelect();
  renderAddMenu();
}

// ＋추가 메뉴의 "슬라이드 추가" 항목 = 템플릿 목록(기본 종류 먼저, 내 템플릿은 구분선 뒤).
function renderAddMenu() {
  const box = $("menu-add-templates");
  if (!box) return;
  box.replaceChildren();
  let lastKind = null;
  for (const t of state.templates || []) {
    if (lastKind && t.kind !== lastKind) box.appendChild(elx("div", "menu-sep"));
    lastKind = t.kind;
    const b = elx("button", "menu-item", t.name);
    b.onclick = () => openAddSlide(t.id);
    box.appendChild(b);
  }
}

function openTemplates() {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하세요"); return; }
  msg("tpl-msg", "");
  renderTemplatePanel();
  $("tpl-modal").hidden = false;
}
function closeTemplates() { $("tpl-modal").hidden = true; }

// management list: save current slide's design into a template, rename, reset/delete
function renderTemplatePanel() {
  const list = $("tpl-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.templates?.length) { list.appendChild(elx("p", "muted", "템플릿이 없습니다.")); return; }
  let lastKind = null;
  for (const t of state.templates) {
    if (t.kind !== lastKind) { list.appendChild(elx("div", "tpl-group", t.kind === "builtin" ? "기본 종류" : "내 템플릿")); lastKind = t.kind; }
    const row = elx("div", "tpl-row");
    const name = elx("span", "tpl-name", t.name);
    name.title = "클릭하면 디자인 편집";
    name.onclick = () => editTemplate(t.id);
    const acts = elx("div", "tpl-acts");
    const edit = elx("button", "mini accent", "✎ 편집"); edit.title = "디자인 불러와서 편집"; edit.onclick = () => editTemplate(t.id);
    const stamp = elx("button", "mini", "이 디자인"); stamp.title = "현재 선택 슬라이드의 디자인을 이 템플릿에 저장"; stamp.onclick = () => updateTemplate(t.id);
    const ren = elx("button", "mini", "이름"); ren.onclick = () => renameTemplate(t.id, t.name);
    const last = elx("button", "mini" + (t.kind === "builtin" ? "" : " danger"), t.kind === "builtin" ? "초기화" : "삭제");
    last.onclick = () => (t.kind === "builtin" ? resetTemplate(t.id) : deleteTemplate(t.id));
    acts.append(edit, stamp, ren, last);
    row.append(name, acts);
    // 입력칸이 없는 커스텀 템플릿 = 내용이 굳어 있어 "가사만 넣어 여러 장" 이 안 된다.
    // 한 번 눌러 입력칸을 만들 수 있게 안내한다(디자인은 유지, 굳은 내용만 지워짐).
    const params = Object.keys(t.params_schema?.properties || {});
    if (t.kind === "custom") {
      if (params.length) {
        row.append(elx("p", "tpl-note muted", `입력: ${params.map((k) => PARAM_LABELS[k] || k).join(" · ")}`));
      } else if (hasFillable(t)) {
        const note = elx("p", "tpl-note muted", "내용이 굳어 있어 추가하면 저장 당시 내용 그대로 한 장만 들어갑니다.");
        const up = elx("button", "mini accent", "⚡ 입력칸 만들기");
        up.title = "디자인은 그대로 두고 가사 입력칸을 만듭니다. 저장 당시 내용은 지워집니다.";
        up.onclick = () => upgradeTemplate(t.id, t.name);
        note.appendChild(up);
        row.append(note);
      }
    }
    list.appendChild(row);
  }
}

// 내용을 채울 수 있는 요소(가사 등 bind 텍스트 · 성경/찬송/교독 콘텐츠 요소)가 있는지.
function hasFillable(t) {
  return (t?.spec?.elements || []).some((e) =>
    ["bible", "hymn", "reading"].includes(e.type) || (e.type === "text" && e.bind));
}

async function upgradeTemplate(id, name) {
  if (!confirm(`“${name}”에 입력칸을 만들까요?\n\n디자인(위치·글꼴·크기·배경)은 그대로 남고, 저장 당시의 내용(지난 가사 등)은 지워집니다.\n이후엔 추가할 때 가사를 넣으면 같은 디자인으로 여러 장이 생성됩니다.`)) return;
  try {
    const r = await callTool("upgrade_template_params", { template_id: id });
    await loadTemplates();
    renderTemplatePanel();
    msg("tpl-msg", `“${name}” 입력칸 생성: ${r.params.map((k) => PARAM_LABELS[k] || k).join(" · ")}`);
  } catch (e) { msg("tpl-msg", e.message, true); }
}

async function saveCurrentAsTemplate() {
  const slide = serviceSlide();
  if (!slide) { msg("tpl-msg", "슬라이드를 먼저 선택하세요.", true); return; }
  const name = prompt("새 디자인 템플릿 이름", slideLabel(slide) || "새 템플릿");
  if (!name) return;
  const r = await callTool("save_template", { name, slide: slideDesign(slide) });
  const params = Object.keys(r?.params_schema?.properties || {});
  await loadTemplates();
  renderTemplatePanel();
  msg("tpl-msg", params.length
    ? `“${name}” 저장됨 · 추가할 때 ${params.map((k) => PARAM_LABELS[k] || k).join(" · ")}를 입력하면 같은 디자인으로 생성됩니다`
    : `“${name}” 저장됨`);
}
async function updateTemplate(id) {
  const slide = serviceSlide();
  if (!slide) { msg("tpl-msg", "디자인 소스 슬라이드를 선택하세요.", true); return; }
  const t = state.templates.find((x) => x.id === id);
  const what = t?.kind === "builtin" ? "이 종류의 디자인(배경·요소 배치/스타일)" : "이 템플릿";
  if (!confirm(`현재 슬라이드 디자인으로 ${what}을 저장할까요?`)) return;
  await callTool("update_template", { template_id: id, slide: slideDesign(slide) });
  msg("tpl-msg", "디자인 저장됨");
  await loadTemplates();
}
async function renameTemplate(id, cur) {
  const name = prompt("새 이름", cur);
  if (!name) return;
  await callTool("update_template", { template_id: id, name });
  await loadTemplates();
}
async function resetTemplate(id) {
  if (!confirm("이 종류의 디자인을 초기화할까요?")) return;
  await callTool("update_template", { template_id: id, reset: true });
  msg("tpl-msg", "초기화됨");
  await loadTemplates();
}
async function deleteTemplate(id) {
  if (!confirm("이 템플릿을 삭제할까요?")) return;
  await callTool("delete_template", { template_id: id });
  await loadTemplates();
}

// ----- 템플릿 디자인 불러와서 편집 -----
// sample content so built-in content elements / bound text show how the design looks
const SAMPLE_CONTENT = {
  bible: { ref: "요 3:16", verses: [{ verse: 16, text: "하나님이 세상을 이처럼 사랑하사 독생자를 주셨으니" }] },
  hymn: { number: 1, title: "찬송 제목", label: "1절", lines: ["가사 첫째 줄", "가사 둘째 줄"] },
  reading: { number: 1, title: "교독문", segments: [{ role: "leader", text: "인도자 본문" }, { role: "congregation", text: "회중 본문" }] },
};
const SAMPLE_BIND = { title: "제목", subtitle: "부제", label: "순서 구분", lyrics: "가사 첫째 줄\n가사 둘째 줄", items: "광고 항목 1\n광고 항목 2" };

// build an editable draft slide from a template. custom = its design as-is;
// built-in = element layout with sample content/text filled (bind kept).
function draftFromTemplate(tpl) {
  const spec = tpl.spec || {};
  const elements = (spec.elements || []).map((e) => {
    const c = structuredClone(e);
    if (tpl.kind === "builtin") {
      if (SAMPLE_CONTENT[e.type]) c.content = structuredClone(SAMPLE_CONTENT[e.type]);
      else if (e.type === "text" && e.bind) c.text = SAMPLE_BIND[e.bind] ?? e.text ?? "";
    }
    return c;
  });
  return { background: spec.background ?? null, elements };
}

async function editTemplate(id) {
  const tpl = await callTool("get_template", { template_id: id });
  state.editingTemplate = { id, name: tpl.name, kind: tpl.kind, draft: draftFromTemplate(tpl) };
  state.editEl = null;
  state.editElSet = new Set();
  state.mode = "list";
  closeTemplates();          // 템플릿 모달을 닫고 캔버스에서 디자인 편집
  render();
}
async function saveTemplateEdit() {
  const et = state.editingTemplate;
  if (!et) return;
  await callTool("update_template", { template_id: et.id, slide: et.draft });
  state.editingTemplate = null;
  await loadTemplates();
  render();
  msg("tpl-msg", "템플릿에 저장됨");
}
function cancelTemplateEdit() {
  state.editingTemplate = null;
  render();
}


// ---------- tiles ----------
// 타일 → 이 슬라이드의 편집 화면(리스트 뷰 + 캔버스)으로 바로 이동.
function editSlideFromTile(id) {
  setSingleSelection(id);
  state.mode = "list";
  render();
  document.querySelector(`.slide-row[data-id="${id}"]`)?.scrollIntoView({ block: "center" });
}

function renderTiles() {
  const grid = $("tile-grid");
  grid.innerHTML = "";
  const pid = presentingSlideId();
  const sound = slidesWithSound();
  slides().forEach((s, i) => {
    const sel = state.selectedSet.has(s.id);
    const tile = elx("div", "tile" + (sel ? " sel" : "") + (s.id === state.selected ? " primary" : "") + (s.id === pid ? " presenting" : "") + (s.hidden ? " hidden" : ""));
    tile.draggable = true;
    tile.dataset.id = s.id;
    const cap = elx("div", "cap");
    cap.innerHTML = `<span class="num">${i + 1}</span><span class="badge">${slideKind(s)}</span>${sound.has(s.id) ? '<span class="sound-mark" title="사운드 트랙 재생 구간">♪</span>' : ""}<span class="label">${slideLabel(s)}</span><button class="edit-tile" title="이 슬라이드 편집 화면으로 이동">✎ 편집</button><button class="hide${s.hidden ? " on" : ""}" title="${s.hidden ? "발표에 다시 보이기" : "발표에서 숨기기"}">${s.hidden ? "⊘" : "◉"}</button><button class="del danger">✕</button>`;
    cap.querySelector(".edit-tile").onclick = (e) => { e.stopPropagation(); editSlideFromTile(s.id); };
    cap.querySelector(".hide").onclick = (e) => { e.stopPropagation(); toggleHidden(s.id); };
    cap.querySelector(".del").onclick = (e) => { e.stopPropagation(); removeSlide(s.id); };
    tile.append(buildThumb(s), cap);
    tile.onclick = (e) => onRowClick(s, e);   // same multi-select model as the list
    tile.ondblclick = () => presentIndex(i);
    wireDrag(tile);
    grid.appendChild(tile);
  });
}

// ---------- add slide (unified: pick any template + schema-driven params) ----------
const PARAM_LABELS = {
  title: "제목", subtitle: "부제", label: "구분 제목",
  book: "책 (이름/약칭)", chapter: "장", verse_start: "시작 절", verse_end: "끝 절", layout: "분할",
  number: "번호", verse_nos: "절 (예: 1,3)", lines_per_slide: "슬라이드당 줄 수",
  segments_per_slide: "슬라이드당 문장 수", sections: "가사 (한 줄씩)", lyrics: "가사 (한 줄씩)",
  items: "광고 항목 (한 줄씩)",
};
// 필드 아래 안내 문구 (페이지당 개수 조절이 무엇인지 명확히)
const PARAM_HINTS = {
  segments_per_slide: "한 슬라이드에 담을 인도자/회중 문장 수. 숫자를 키우면 슬라이드가 줄고, 줄이면 많아져요.",
  lines_per_slide: "한 슬라이드에 담을 가사 줄 수. 숫자를 키우면 슬라이드가 줄어요.",
};

// ＋추가 메뉴에서 종류를 고르면 → 입력이 필요한 종류만 작은 대화상자를 띄우고,
// 입력이 없는 종류(빈 화면·내 템플릿)는 곧바로 선택 아래에 추가한다.
function openAddSlide(templateId) {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하거나 만들어 주세요"); return; }
  const tpl = (state.templates || []).find((t) => t.id === templateId);
  if (!tpl) return;
  $("add-type").value = templateId;
  renderAddFields();
  msg("add-msg", "");
  if (!Object.keys(tpl.params_schema?.properties || {}).length) { addSlide("after"); return; }
  $("add-modal-title").textContent = `${tpl.name} 추가`;
  $("add-modal").hidden = false;
  $("add-fields").querySelector("input, textarea, select")?.focus();
}
function closeAddSlide() { $("add-modal").hidden = true; }

// populate the type/template dropdown (기본 종류 + 내 템플릿) from state.templates
function renderAddTypeSelect() {
  const sel = $("add-type");
  const cur = sel.value;
  sel.innerHTML = "";
  const gB = document.createElement("optgroup"); gB.label = "기본 종류";
  const gC = document.createElement("optgroup"); gC.label = "내 템플릿";
  for (const t of state.templates) {
    const o = document.createElement("option"); o.value = t.id; o.textContent = t.name;
    (t.kind === "builtin" ? gB : gC).appendChild(o);
  }
  sel.appendChild(gB);
  if (gC.children.length) sel.appendChild(gC);
  if (cur && state.templates.some((t) => t.id === cur)) sel.value = cur;
  renderAddFields();
}

// build the input form from the selected template's params_schema
function renderAddFields() {
  const tpl = state.templates.find((t) => t.id === $("add-type").value);
  const wrap = $("add-fields");
  wrap.innerHTML = "";
  const props = tpl?.params_schema?.properties || {};
  // 찬송가 템플릿: 번호를 몰라도 제목·가사로 검색해 번호 자동 입력
  const isHymn = tpl?.id === "builtin-hymn";
  for (const [key, def] of Object.entries(props)) {
    if (isHymn && key === "number") {
      const search = hymnSearchField("찬송가 제목·가사로 검색 (번호 몰라도 OK)", (num) => {
        const numInput = wrap.querySelector('[data-key="number"]');
        if (numInput) numInput.value = num;
      });
      wrap.appendChild(search);
    }
    wrap.appendChild(elx("label", null, PARAM_LABELS[key] || key));
    let input;
    if (def.enum) {
      input = document.createElement("select");
      for (const v of def.enum) { const o = document.createElement("option"); o.value = o.textContent = v; input.appendChild(o); }
      if (def.default != null) input.value = def.default;
    } else if (key === "lyrics" || key === "sections" || key === "items" || def.type === "array") {
      input = document.createElement("textarea");
      input.rows = (key === "lyrics" || key === "sections") ? 5 : 3;
      input.placeholder = (key === "lyrics" || key === "sections") ? "가사 한 줄씩" : key === "items" ? "항목 한 줄씩" : "쉼표로 구분";
    } else {
      input = document.createElement("input");
      input.type = (def.type === "integer" || def.type === "number") ? "number" : "text";
      if (def.default != null) input.value = def.default;
    }
    input.dataset.key = key;
    input.dataset.dtype = def.type || "string";
    wrap.appendChild(input);
    if (PARAM_HINTS[key]) wrap.appendChild(elx("p", "hint muted", PARAM_HINTS[key]));
  }
  renderAddStyleFields(tpl, wrap);
}

// 추가할 때 이번 것만 서식(글꼴·크기·색·정렬)을 바꿀 수 있는 접이식 그룹.
// 템플릿 자체는 건드리지 않는다 — 곡마다 다르게 하고 싶을 때. 비워두면 템플릿 기본값.
// 위치·크기는 여기서 숫자로 넣기보다 캔버스에서 끌어 맞추고 "서식 퍼뜨리기"가 낫다.
const STYLE_ROWS = [
  ["size", "글자 크기", "number"],
  ["color", "글자 색", "color"],
  ["align", "정렬(가로)", "select", [["left", "왼쪽"], ["center", "가운데"], ["right", "오른쪽"]]],
  ["valign", "정렬(세로)", "select", [["middle", "가운데"], ["top", "위"], ["bottom", "아래"]]],
  ["weight", "굵기", "select", [["400", "보통"], ["600", "중간"], ["700", "굵게"], ["800", "매우 굵게"]]],
  ["line_height", "줄 간격", "number"],
];

// 이 템플릿에서 서식을 덮어쓸 "본문 요소"(가사·성경 본문 등). 서버의 styleTargets와 같은 규칙.
function bodyElementOf(tpl) {
  const els = tpl?.spec?.elements || [];
  const body = els.filter((e) =>
    (["bible", "hymn", "reading"].includes(e.type) && (!e.field || ["all", "text", "body", "lyrics"].includes(e.field))) ||
    (e.type === "text" && ["lyrics", "items"].includes(e.bind)));
  if (body.length) return body[0];
  return els.find((e) => e.type === "text" && e.bind) || null;
}

function renderAddStyleFields(tpl, wrap) {
  const body = bodyElementOf(tpl);
  if (!body) return;
  const d = elx("details", "pgroup add-style");
  d.open = isGroupOpen("add-style", false);
  d.addEventListener("toggle", () => setGroupOpen("add-style", d.open));
  d.appendChild(elx("summary", null, "디자인 (이번에 추가하는 것만)"));
  const inner = elx("div", "pgroup-body");
  inner.appendChild(elx("p", "hint muted",
    "비워두면 템플릿 기본값을 씁니다. 템플릿 자체는 바뀌지 않아요 — 이 곡만 다르게 할 때 쓰세요."));
  for (const [key, label, type, options] of STYLE_ROWS) {
    inner.appendChild(elx("label", null, label));
    let input;
    if (type === "select") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = ""; blank.textContent = `템플릿 기본 (${optLabel(options, body[key])})`;
      input.appendChild(blank);
      for (const [v, t] of options) { const o = document.createElement("option"); o.value = v; o.textContent = t; input.appendChild(o); }
    } else if (type === "color") {
      // 색은 "안 바꿈"을 표현할 수 없으니 체크박스로 사용 여부를 함께 둔다.
      const row = elx("div", "size-row");
      const use = document.createElement("input"); use.type = "checkbox";
      input = document.createElement("input"); input.type = "color";
      input.value = body.color || "#ffffff";
      input.disabled = true;
      use.onchange = () => { input.disabled = !use.checked; };
      use.title = "체크하면 이 색으로 바꿉니다";
      row.append(use, input);
      input.dataset.styleKey = key;
      input.dataset.styleUse = "checkbox";
      inner.appendChild(row);
      continue;
    } else {
      input = document.createElement("input"); input.type = "number";
      input.step = key === "line_height" ? 0.1 : 0.1;
      input.placeholder = body[key] != null ? `템플릿 기본 ${body[key]}` : "템플릿 기본";
    }
    input.dataset.styleKey = key;
    inner.appendChild(input);
  }
  // 글꼴은 목록이 커서 마지막에
  inner.appendChild(elx("label", null, "글꼴"));
  const fsel = document.createElement("select");
  fillFontSelect(fsel, "");
  fsel.options[0].textContent = body.font ? `템플릿 기본 (${body.font})` : "템플릿 기본";
  fsel.dataset.styleKey = "font";
  inner.appendChild(fsel);
  d.appendChild(inner);
  wrap.appendChild(d);
}

function optLabel(options, value) {
  const hit = (options || []).find(([v]) => String(v) === String(value));
  return hit ? hit[1] : (value ?? "기본");
}

// 추가 모달의 디자인 그룹에서 값이 채워진 것만 모아 style 객체로.
function collectStyle() {
  const style = {};
  for (const input of $("add-fields").querySelectorAll("[data-style-key]")) {
    const key = input.dataset.styleKey;
    if (input.dataset.styleUse === "checkbox") {
      const cb = input.previousElementSibling;
      if (cb?.checked && input.value) style[key] = input.value;
      continue;
    }
    const v = String(input.value).trim();
    if (v === "") continue;
    style[key] = (input.type === "number" || key === "weight") ? Number(v) : v;
  }
  return Object.keys(style).length ? style : undefined;
}

function collectParams(tpl) {
  const params = {};
  for (const [key, def] of Object.entries(tpl?.params_schema?.properties || {})) {
    const input = $("add-fields").querySelector(`[data-key="${key}"]`);
    if (!input) continue;
    const v = input.value.trim();
    if (key === "sections") {
      const lines = v.split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines.length) params.sections = [{ label: "", lines }];
    } else if (key === "items") {
      params.items = v.split("\n").map((s) => s.trim()).filter(Boolean);
    } else if (def.type === "array") {
      if (v) params[key] = v.split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
    } else if (v === "") {
      // skip empty optional field
    } else if (def.type === "integer" || def.type === "number") {
      params[key] = Number(v);
    } else {
      params[key] = v;
    }
  }
  return params;
}

// where: "end"(순서 끝) | "after"(선택 슬라이드 바로 다음)
async function addSlide(where = "end") {
  const templateId = $("add-type").value;
  if (!state.serviceId) return msg("add-msg", "예배 순서가 없습니다.", true);
  const tpl = state.templates.find((t) => t.id === templateId);
  if (!tpl) return msg("add-msg", "추가할 종류/템플릿을 선택하세요.", true);
  let position; // undefined → 끝에 추가
  if (where === "after") {
    const idx = slides().findIndex((s) => s.id === state.selected);
    if (idx >= 0) position = idx + 1;
  }
  try {
    const res = await callTool("apply_template", {
      template_id: templateId, service_id: state.serviceId,
      params: collectParams(tpl), position, style: collectStyle(),
    });
    await refresh();
    if (res?.slide_ids?.[0]) { setSingleSelection(res.slide_ids[0]); render(); }
    closeAddSlide();
    toast(`“${tpl.name}” ${res?.slide_ids?.length || 1}장 추가됨`);
  } catch (e) { msg("add-msg", e.message, true); }
}

// ----- 슬라이드 복사 / 붙여넣기 (리스트·타일 멀티셀렉) -----
// 마지막 복사 종류("slide" | "element") — 붙여넣기가 이걸로 라우팅(슬라이드 이동 후에도 유지)
let lastCopyKind = null;
let slideClipboard = [];
function copySelectedSlides() {
  const sel = slides().filter((s) => state.selectedSet.has(s.id));
  if (!sel.length) return;
  slideClipboard = sel.map((s) => ({
    elements: structuredClone(s.elements || []),
    background: s.background ? structuredClone(s.background) : null,
    transition: s.transition || "fade",
  }));
  lastCopyKind = "slide";
  toast(`${sel.length}개 슬라이드 복사됨 · ⌘/Ctrl+V로 붙여넣기`);
}
async function pasteSlides() {
  if (!slideClipboard.length || !state.serviceId) return;
  // 붙여넣기 위치: 선택한 슬라이드 중 마지막 다음(없으면 순서 끝).
  const idxs = slides().map((s, i) => (state.selectedSet.has(s.id) ? i : -1)).filter((i) => i >= 0);
  let pos = idxs.length ? Math.max(...idxs) + 1 : undefined;
  const newIds = [];
  for (const c of slideClipboard) {
    const res = await callTool("add_slide", { service_id: state.serviceId, elements: c.elements, background: c.background, transition: c.transition, position: pos });
    newIds.push(res.slide_id);
    if (pos != null) pos += 1;
  }
  await refresh();
  state.selectedSet = new Set(newIds);
  state.selected = newIds[newIds.length - 1];
  state.anchor = state.selected;
  render();
  toast(`${newIds.length}개 붙여넣음`);
}

// ----- 요소 복사 / 붙여넣기 (디자인 탭에서 요소 선택 후) -----
let elementClipboard = [];
function copyElement() {
  const sel = [...state.editElSet].map((i) => els()[i]).filter(Boolean);
  if (!sel.length) return;
  elementClipboard = sel.map((el) => structuredClone(el));
  lastCopyKind = "element";
  toast(`요소 ${sel.length}개 복사됨 · ⌘/Ctrl+V로 붙여넣기`);
}
async function pasteElement() {
  if (!elementClipboard.length) return;
  const slide = selectedSlide();
  if (!slide) return;
  const base = (slide.elements || []).length;
  const copies = elementClipboard.map((el) => {
    const c = structuredClone(el);
    c.x = clamp01((c.x ?? 0.4) + 0.03);   // 살짝 옮겨 겹치지 않게
    c.y = clamp01((c.y ?? 0.4) + 0.03);
    return c;
  });
  slide.elements = [...(slide.elements || []), ...copies];
  await commitEls();
  selectEls(copies.map((_, k) => base + k));
  toast(`요소 ${copies.length}개 붙여넣음`);
}

// ---------- inspector (우측 패널 = 슬라이드 속성) ----------
function renderInspector() {
  const slide = selectedSlide();
  const empty = $("inspect-empty"), body = $("inspect-body");
  if (!slide) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  $("insp-bg-type").value = slide.background?.type || "theme";
  renderBgFields(slide.background);
  // 여러 장을 골라 뒀으면 배경은 그 전체에 함께 적용된다(가사 여러 장 = 같은 배경 영상).
  const n = state.editingTemplate ? 1 : state.selectedSet.size;
  const multi = $("insp-bg-multi");
  if (multi) { multi.hidden = n <= 1; multi.textContent = `선택한 ${n}장에 함께 적용됩니다`; }
  const save = $("insp-save");
  if (save) save.textContent = n > 1 ? `${n}장에 배경 적용` : "배경 저장";
  const pick = $("bg-pick-btn");
  if (pick) pick.hidden = !!state.editingTemplate;   // 템플릿 초안엔 예배 배경 목록이 없다
  renderStyleCopy(n);
  // 발표에서 숨기기 — 순서 목록의 ◉/⊘ 버튼과 같은 동작(템플릿 초안엔 해당 없음)
  const hide = $("insp-hidden");
  const row = hide?.closest(".insp-hide-row");
  if (row) row.hidden = !!state.editingTemplate;
  if (hide) { hide.checked = !!slide.hidden; hide.onchange = () => toggleHidden(slide.id); }
}

const BG_FIELDS = {
  theme: [],
  color: [["value", "색 (#hex)", "color:#1a1a2e"]],
  gradient: [["from", "시작색", "color:#1a1a2e"], ["to", "끝색", "color:#16213e"], ["angle", "각도", "number:135"]],
  image: [["url", "이미지 URL", "text"], ["overlay_dim", "어둡게(0~1)", "number:0.35"]],
  video: [["url", "영상 URL", "text"], ["loop", "반복", "check:1"], ["muted", "음소거", "check:1"], ["overlay_dim", "어둡게(0~1)", "number:0.4"]],
};

function renderBgFields(bg) {
  const type = $("insp-bg-type").value;
  const wrap = $("insp-bg-fields");
  wrap.innerHTML = "";
  // 라이브 미리보기(저장 X) — 드래그 중 즉시 반영
  const preview = () => { const s = selectedSlide(); if (s) { s.background = buildBackground(); renderPreview(); } };
  for (const [key, label, kind] of BG_FIELDS[type] || []) {
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    let input;
    if (kind.startsWith("check")) { input = document.createElement("input"); input.type = "checkbox"; input.checked = bg ? bg[key] !== false : kind.endsWith("1"); }
    else if (kind.startsWith("color")) { input = document.createElement("input"); input.type = "color"; input.value = bg?.[key] || kind.split(":")[1]; }
    else { input = document.createElement("input"); input.type = kind.startsWith("number") ? "number" : "text"; input.value = bg?.[key] ?? (kind.includes(":") ? kind.split(":")[1] : ""); }
    input.id = "bg-" + key;
    if (input.type !== "text") input.addEventListener("input", preview);   // 색/숫자/체크: 라이브 미리보기
    input.addEventListener("change", () => saveInspector());               // 확정 시 즉시 저장·적용
    wrap.appendChild(input);
    // 색 입력엔 팔레트 스와치(이 예배 색 + 최근 색)
    if (kind.startsWith("color")) {
      const sw = colorSwatches(bg?.[key], (hex) => { input.value = hex; preview(); saveInspector(); });
      if (sw) wrap.appendChild(sw);
    }
  }
  if (type === "image" || type === "video") {
    const file = document.createElement("input");
    file.type = "file"; file.accept = type === "video" ? "video/*" : "image/*";
    file.onchange = async () => {
      if (!file.files[0]) return;
      msg("insp-msg", "업로드 중…");
      try { const { url } = await uploadFile(file.files[0]); $("bg-url").value = url; msg("insp-msg", "업로드 완료"); await saveInspector(); }
      catch (e) { msg("insp-msg", e.message, true); }
    };
    wrap.appendChild(file);
  }
}

function buildBackground() {
  const type = $("insp-bg-type").value;
  const g = (k) => $("bg-" + k);
  if (type === "theme") return null;
  if (type === "color") return { type, value: g("value").value };
  if (type === "gradient") return { type, from: g("from").value, to: g("to").value, angle: +g("angle").value };
  if (type === "image") return { type, url: g("url").value, fit: "cover", overlay_dim: +g("overlay_dim").value };
  if (type === "video") return { type, url: g("url").value, loop: g("loop").checked, muted: g("muted").checked, overlay_dim: +g("overlay_dim").value };
  return null;
}

async function saveInspector() {
  const slide = selectedSlide();
  if (!slide) return;
  try {
    const bg = buildBackground();
    if (bg?.type === "color") pushRecentColor(bg.value);
    else if (bg?.type === "gradient") { pushRecentColor(bg.from); pushRecentColor(bg.to); }
    if (state.editingTemplate) {
      slide.background = bg;
      renderPreview();
    } else {
      // 여러 장을 선택해 뒀으면 그 전체에 같은 배경(= 가사 여러 장에 같은 배경 영상).
      const ids = bgTargetIds();
      await callTool("set_slide_background", { slide_ids: ids, background: bg });
      await refresh();
      msg("insp-msg", ids.length > 1 ? `${ids.length}장에 배경 적용됨` : "배경 적용됨");
      return;
    }
    msg("insp-msg", "배경 적용됨");
  } catch (e) { msg("insp-msg", e.message, true); }
}

// ---------- 서식 복사기 ----------
// 가사 한 장을 캔버스에서 원하는 대로 꾸민 뒤(위치·글꼴·크기), 나머지 장에 같은 서식을 입힌다.
// 내용은 그대로 두고 서식만 복사되므로 장마다 다시 만질 필요가 없다.
// "복사 → 붙이기" 2단계인 이유: 대상을 ⌘클릭으로 고르면 그 순간 현재 슬라이드가 바뀌어서,
// 한 단계로 하면 원본이 마지막에 클릭한 대상으로 슬쩍 바뀌어 버린다.
function styleSourceId() {
  const id = state.styleSource;
  return id && slides().some((s) => s.id === id) ? id : null;
}

function renderStyleCopy() {
  const box = document.querySelector(".insp-style-copy");
  const btn = $("style-copy-btn"), hint = $("style-copy-hint");
  if (!box || !btn) return;
  if (state.editingTemplate) { box.hidden = true; return; }
  box.hidden = false;
  const src = styleSourceId();
  const total = slides().length;
  if (!src) {
    btn.textContent = "🎨 이 서식 복사";
    btn.disabled = total <= 1 || !state.selected;
    hint.textContent = total > 1
      ? "이 슬라이드처럼 꾸민 뒤 눌러 두고, 대상 슬라이드를 골라 붙여넣으세요."
      : "서식을 옮길 다른 슬라이드가 없습니다.";
    return;
  }
  const srcNo = slides().findIndex((s) => s.id === src) + 1;
  const targets = [...state.selectedSet].filter((id) => id !== src);
  btn.disabled = false;
  if (targets.length) {
    btn.textContent = `🖌 ${targets.length}장에 서식 붙이기`;
    hint.textContent = `원본 ${srcNo}번 · 선택한 ${targets.length}장의 같은 요소에 글꼴·크기·색·정렬·위치가 복사됩니다.`;
  } else {
    btn.textContent = "🖌 나머지 전체에 붙이기";
    hint.textContent = `원본 ${srcNo}번 · 대상을 골라두면 그 장들만. 지금 누르면 나머지 ${total - 1}장에 적용됩니다.`;
  }
  const cancel = elx("button", "mini style-src-cancel", "복사 취소");
  cancel.onclick = () => { state.styleSource = null; render(); };
  hint.appendChild(cancel);
}

async function copyStyleToOthers() {
  const src = styleSourceId();
  // 1단계: 원본 지정
  if (!src) {
    if (!state.selected) return;
    state.styleSource = state.selected;
    render();
    toast("서식 복사됨 · 대상 슬라이드를 고르고 “붙이기”를 누르세요");
    return;
  }
  // 2단계: 붙이기
  const picked = [...state.selectedSet].filter((id) => id !== src);
  const targets = picked.length ? picked : slides().map((s) => s.id).filter((id) => id !== src);
  if (!targets.length) { toast("붙일 다른 슬라이드가 없습니다"); return; }
  if (!picked.length && !confirm(`나머지 ${targets.length}장 전체에 이 서식을 붙일까요?\n(내용은 그대로, 같은 역할의 요소만 글꼴·크기·색·정렬·위치가 바뀝니다)`)) return;
  try {
    const r = await callTool("copy_slide_style", { source_slide_id: src, target_slide_ids: targets });
    await refresh();
    toast(r.elements ? `${r.slides}장에 서식 적용됨 (요소 ${r.elements}개)` : `짝이 맞는 요소가 없어 바뀐 게 없습니다`);
  } catch (e) { msg("insp-msg", e.message, true); }
}

// 배경을 적용할 슬라이드들 — 멀티셀렉이면 선택 전체, 아니면 현재 한 장.
function bgTargetIds() {
  const sel = [...state.selectedSet];
  return sel.length > 1 ? sel : [state.selected].filter(Boolean);
}

// 배경을 여러 슬라이드에 한 번에 적용(배경 고르기 모달·라이브러리에서 사용).
async function applyBackgroundTo(ids, bg) {
  if (!ids.length) { toast("슬라이드를 먼저 선택하세요"); return; }
  await callTool("set_slide_background", { slide_ids: ids, background: bg });
  await refresh();
  toast(ids.length > 1 ? `${ids.length}장에 배경 적용됨` : "배경 적용됨");
}

// ---------- mutations ----------
async function removeSlide(id) {
  await callTool("remove_slide", { slide_id: id });
  state.selectedSet.delete(id);
  if (state.selected === id) state.selected = null;
  await refresh();
}
// 발표에서 숨김/보임 토글(편집기엔 남음). 멀티셀렉이면 선택 전체에 적용.
async function toggleHidden(id) {
  const targetIds = state.selectedSet.has(id) && state.selectedSet.size > 1 ? [...state.selectedSet] : [id];
  const cur = slides().find((s) => s.id === id);
  const next = !cur?.hidden;
  for (const sid of targetIds) await callTool("set_slide_hidden", { slide_id: sid, hidden: next });
  await refresh();
  toast(next ? `${targetIds.length}개 숨김(발표에서 건너뜀)` : `${targetIds.length}개 다시 보임`);
}
async function deleteSelected() {
  const ids = [...state.selectedSet];
  if (!ids.length) return;
  if (ids.length > 1 && !confirm(`${ids.length}개 슬라이드를 삭제할까요?`)) return;
  for (const id of ids) await callTool("remove_slide", { slide_id: id });
  state.selectedSet.clear(); state.selected = null; state.anchor = null;
  await refresh();
}
async function newService() {
  const title = prompt("예배 제목", "주일 예배"); if (!title) return;
  const date = prompt("날짜 (YYYY-MM-DD)", new Date().toISOString().slice(0, 10)); if (!date) return;
  const worship_part = prompt("예배부 (1부/2부/연합)", "1부") || "1부";
  const { service_id } = await callTool("create_service", { title, date, worship_part });
  await loadServices(service_id);
}

// 현재 예배 정보(이름·날짜·부) 수정 — 새로 만들지 않고 기존 것을 고친다.
async function editService() {
  const s = state.service;
  if (!s) return;
  const title = prompt("예배 제목", s.title); if (title == null) return;
  const date = prompt("날짜 (YYYY-MM-DD)", s.date); if (date == null) return;
  const worship_part = prompt("예배부 (1부/2부/연합 등)", s.worship_part); if (worship_part == null) return;
  await callTool("update_service", { service_id: state.serviceId, fields: { title, date, worship_part } });
  await loadServices(state.serviceId);
  toast("예배 정보 수정됨");
}

// 현재 예배 순서 삭제(슬라이드 전부 함께). 되돌릴 수 없어 확인 후 진행.
async function deleteService() {
  const s = state.service;
  if (!s) return;
  if (!confirm(`예배 순서 "${s.title}" 을(를) 삭제할까요?\n안의 슬라이드가 모두 함께 삭제되며 되돌릴 수 없습니다.`)) return;
  await callTool("delete_service", { service_id: state.serviceId });
  state.serviceId = null;
  state.service = null;
  await loadServices();   // 남은 예배 선택(없으면 빈 화면)
  toast("예배 순서 삭제됨");
}

// 다른 이름으로 저장 — 현재 예배 전체(슬라이드·테마 포함)를 복제해 새 예배로.
async function duplicateService() {
  const s = state.service;
  if (!s) return;
  const title = prompt("다른 이름으로 저장 — 새 제목", `${s.title} (사본)`);
  if (title == null) return;
  const { service_id } = await callTool("duplicate_service", { service_id: state.serviceId, title: title || undefined });
  await loadServices(service_id);
  toast("다른 이름으로 저장됨");
}
async function presentIndex(i) {
  try { await callTool("present_goto", { service_id: state.serviceId, page_index: i }); msg("add-msg", "발표 화면으로 전송"); }
  catch (e) { msg("add-msg", e.message, true); }
}
function presentHere() {
  const i = slides().findIndex((s) => s.id === state.selected);
  if (i >= 0) presentIndex(i);
}

// ---------- export / import ----------
const MB = 1048576;
// 첨부를 base64로 넣으면 1.33배로 커진다. 배경 영상은 수십 MB가 예사라 이 선을 넘으면 물어본다.
const ASSET_WARN_BYTES = 40 * MB;

// 예배를 .lyra 패키지로 내보낸다. 서버가 zip을 굽고 스트리밍으로 내려주므로
// 브라우저가 수백 MB를 메모리에 들지 않는다(예전 base64 JSON 방식의 실패 원인).
// 첨부가 크면 "참조만" 내보낼지 물어본다 — 받는 쪽에 같은 파일이 있으면 그걸 재사용한다.
async function exportService() {
  if (!state.serviceId) { toast("예배를 먼저 선택하세요"); return; }
  const refs = (await callTool("export_service", { service_id: state.serviceId, assets: false })).asset_refs || [];
  const bytes = refs.reduce((n, r) => n + (r.bytes || 0), 0);
  let include = refs.length > 0;
  if (bytes > ASSET_WARN_BYTES) {
    const mb = (bytes / MB).toFixed(0);
    include = confirm(
      `첨부 파일(배경 영상·이미지·음악)이 ${refs.length}개, 합계 ${mb}MB입니다.\n\n` +
      `확인 = 첨부까지 담기 (약 ${mb}MB · 처음 옮기거나 다른 교회에 줄 때)\n` +
      `취소 = 참조만 담기 (수십 KB · 받는 쪽에 같은 파일이 이미 있을 때)`
    );
  }
  showBusy("패키지 만드는 중…", include ? `첨부 ${refs.length}개 포함` : "참조만");
  try {
    const res = await fetch("/api/export/package", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lyra-client": CLIENT_ID },
      body: JSON.stringify({ service_id: state.serviceId, include_assets: include }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "내보내기 실패");
    const name = decodeURIComponent((res.headers.get("content-disposition") || "").split("filename*=UTF-8''")[1] || "service.lyra");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(include ? `패키지 내보냄 · 첨부 ${refs.length}개 포함` : `패키지 내보냄 · 참조만(첨부 ${refs.length}개 제외)`);
  } catch (e) { toast(e.message); }
  finally { hideBusy(); }
}
// 슬라이드를 이미지(WebP)로 내보내기 → zip 다운로드.
// 렌더는 서버가 헤드리스 크롬으로 /export 화면을 굽는다 → 발표 화면과 같은 그림이 나온다.
// 여러 장을 골라둔 상태면 그 장들만, 아니면 전장(발표에서 숨긴 장은 제외).
async function exportImages() {
  if (!state.serviceId) { toast("예배를 먼저 선택하세요"); return; }
  const picked = [...state.selectedSet];
  const onlyPicked = picked.length > 1;   // 한 장만 선택된 건 "그냥 커서" — 전장으로 본다
  const total = onlyPicked ? picked.length : slides().filter((s) => !s.hidden).length;
  showBusy("이미지로 내보내는 중…", `${total}장 · 크롬으로 렌더 중`);
  try {
    const res = await fetch("/api/export/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service_id: state.serviceId, slide_ids: onlyPicked ? picked : undefined }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "내보내기 실패");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.service?.date || "예배"}-이미지.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`이미지 ${res.headers.get("x-lyra-count") || total}장 내보냄`);
  } catch (e) {
    toast("내보내기 실패: " + e.message);
  } finally { hideBusy(); }
}

async function importService(file) {
  // 파일을 멀티파트로 그대로 전송(큰 파일도 클라이언트에서 파싱/재직렬화하지 않음).
  const mb = (file.size / 1048576).toFixed(0);
  showBusy("예배 순서 가져오는 중…", `${file.name} · ${mb}MB`);
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/import-service", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "가져오기 실패");
    await loadServices(body.service_id);
    hideBusy();
    // 첨부가 어떻게 처리됐는지 알려준다 — "참조만" 패키지를 받았을 때 무엇이 빠졌는지 알아야 한다.
    const miss = (body.missing || []).length;
    const parts = [];
    if (body.restored) parts.push(`첨부 ${body.restored}개 복원`);
    if (body.reused) parts.push(`${body.reused}개는 이미 있어 재사용`);
    msg("add-msg", parts.length ? `가져오기 완료 · ${parts.join(" · ")}` : "가져오기 완료");
    if (miss) {
      alert(`가져왔지만 첨부 ${miss}개가 없습니다.\n\n` +
        `"참조만" 패키지를 받았고 이 PC에 그 파일이 없을 때 생깁니다.\n` +
        `보낸 쪽에서 첨부까지 담아 다시 내보내거나, 해당 배경을 직접 지정해 주세요.`);
    }
  } catch (e) { hideBusy(); alert("가져오기 실패: " + e.message); }
}

// ---- busy overlay: spinner + message + live elapsed time ----
let busyTimer = null;
function showBusy(message, sub = "") {
  $("busy-msg").textContent = message;
  const base = sub;
  const t0 = performance.now();
  const tick = () => { $("busy-sub").textContent = `${base}${base ? " · " : ""}${((performance.now() - t0) / 1000).toFixed(1)}초 경과`; };
  tick();
  clearInterval(busyTimer); busyTimer = setInterval(tick, 200);
  $("busy").hidden = false;
}
function hideBusy() { clearInterval(busyTimer); busyTimer = null; $("busy").hidden = true; }

// PPT/PDF/이미지 → 이미지 슬라이드로 현재 예배에 추가
async function importSlidesFile(file) {
  if (!state.serviceId) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isOffice = ["pptx", "ppt", "odp", "key"].includes(ext);
  const label = isOffice ? "PowerPoint 변환 중…" : ext === "pdf" ? "PDF 변환 중…" : "이미지 가져오는 중…";
  const sub = isOffice ? `${file.name} · LibreOffice로 변환(첫 실행은 몇 초 걸려요)` : file.name;
  showBusy(label, sub);
  try {
    const fd = new FormData();
    fd.append("file", file);
    // 현재 선택한 슬라이드 바로 아래로 가져오기(선택 없으면 맨 끝).
    const idx = slides().findIndex((s) => s.id === state.selected);
    const posQ = idx >= 0 ? `&position=${idx + 1}` : "";
    const res = await fetch(`/api/import?service_id=${state.serviceId}${posQ}`, { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "가져오기 실패");
    await refresh();
    // 여러 파일을 이어서 가져올 때 순서가 유지되도록 마지막 가져온 슬라이드를 선택
    if (body.slide_ids?.length) { setSingleSelection(body.slide_ids[body.slide_ids.length - 1]); render(); }
    clearInterval(busyTimer); busyTimer = null;
    $("busy-msg").textContent = `${body.slide_ids.length}장 가져왔어요 ✓`;
    $("busy-sub").textContent = "";
    $("busy").querySelector(".spinner").style.display = "none";
    setTimeout(() => { $("busy").querySelector(".spinner").style.display = ""; hideBusy(); }, 900);
  } catch (e) {
    hideBusy();
    alert("슬라이드 가져오기 실패: " + e.message);
  }
}

// ---- 사운드 트랙 모달 (여러 슬라이드 구간에 걸쳐 재생되는 배경 음악) ----
// 트랙은 예배에 속하고 구간(시작~끝 슬라이드)을 가진다. 실제 재생은 발표 화면에서만.
const tracks = () => state.service?.tracks || [];
let previewAudio = null;

function stopTrackPreview() {
  if (!previewAudio) return;
  previewAudio.pause();
  previewAudio = null;
  for (const b of document.querySelectorAll("#sound-list .sd-play")) b.textContent = "▶ 미리듣기";
}

function openSound() {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하세요"); return; }
  $("sound-modal").hidden = false;
  msg("sound-status", "");
  renderSoundList();
}
function closeSound() { stopTrackPreview(); $("sound-modal").hidden = true; }

// ===== 찬양 가사 검색 (기존 PPT 모음에서 추출한 가사) =====
// 곡을 고르면 **가사를 복사**해 준다 — 슬라이드는 만들지 않는다. 사용자가 이미 만들어 둔
// 디자인 템플릿(＋추가)으로 넣는 게 낫기 때문. 복사 형식은 "빈 줄 = 장 구분"이라
// apply_template이 원본 PPT의 넘김을 그대로 재현한다.
// 가사는 OCR 산출물이라 오탈자가 있을 수 있어 conf가 낮은 곡엔 표시를 준다.
let songTimer = null;

function openSongs() {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하세요"); return; }
  $("song-modal").hidden = false;
  $("song-preview").hidden = true;
  fillSongTemplates();
  songPicked = null;
  msg("song-status", "");
  $("song-query").focus();
  searchSongs();
}
async function closeSongs() {
  if (!(await confirmSongDiscard())) return;
  markSongDirty(false);
  $("song-modal").hidden = true;
}

async function searchSongs() {
  const q = $("song-query").value.trim();
  const list = $("song-list");
  try {
    const r = q
      ? await callTool("search_song", { query: q, limit: 60 })
      : await callTool("list_songs", { limit: 60 });
    const songs = r.results || r.songs || [];
    list.replaceChildren();
    if (!songs.length) {
      list.appendChild(elx("p", "muted", q ? "일치하는 곡이 없습니다." : "추출된 찬양 가사가 없습니다. scripts/extract-song-lyrics.js 로 먼저 추출하세요."));
      msg("song-status", "");
      return;
    }
    msg("song-status", q ? `${songs.length}곡` : `전체 ${r.total ?? songs.length}곡`);
    for (const s of songs) {
      const row = elx("div", "lib-row song-row");
      const name = elx("span", "lib-name", s.title);
      const meta = elx("span", "muted song-meta", `${s.pages}장`);
      if (s.conf != null && s.conf < 0.4) {
        const w = elx("span", "song-warn", "검토");
        w.title = "OCR 신뢰도가 낮습니다 — 가사에 오탈자가 있을 수 있어요";
        meta.appendChild(w);
      }
      row.append(name, meta);
      row.onclick = () => pickSong(s, row);
      list.appendChild(row);
    }
  } catch (e) { msg("song-status", e.message, true); }
}

// 가사를 "빈 줄 = 장 구분" 형식의 텍스트로. 이대로 붙여넣으면 원본 넘김이 재현된다.
function songText(lyrics) {
  return (lyrics || []).map((page) => page.join("\n")).join("\n\n");
}

// 클립보드 복사. 아이패드 등에서 http로 접속하면 navigator.clipboard를 못 쓰므로
// (보안 컨텍스트가 아님) 선택 후 execCommand로 넘어간다. 그것도 막히면 직접 고르도록 남긴다.
async function copyText(text, srcEl) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 아래 폴백 */ }
  try {
    const ta = srcEl || Object.assign(document.createElement("textarea"), { value: text });
    if (!srcEl) { ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); }
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    if (!srcEl) ta.remove();
    return ok;
  } catch { return false; }
}

async function pickSong(song, row) {
  if (!(await confirmSongDiscard())) return;
  for (const r of document.querySelectorAll("#song-list .song-row.sel")) r.classList.remove("sel");
  row?.classList.add("sel");
  try {
    const full = await callTool("get_song_text", { song_id: song.id });
    showSongEditor({ id: full.id, title: full.title, text: full.text });
    const ok = await copyText(full.text, $("song-lyrics"));
    msg("song-status", ok
      ? `“${full.title}” 가사 복사됨 · ＋추가에서 템플릿을 고르고 붙여넣으세요`
      : "복사가 막혔습니다 — 아래 칸에서 직접 선택해 복사하세요");
  } catch (e) { msg("song-status", e.message, true); }
}

// 가사를 담을 수 있는 템플릿(bind:lyrics를 가진 것)만 고를 수 있게 채운다.
// 마지막에 쓴 디자인을 기억해 둔다 — 매주 같은 걸 쓰기 때문.
function fillSongTemplates() {
  const sel = $("song-template");
  if (!sel) return;
  const usable = state.templates.filter((t) =>
    (t.spec?.elements || []).some((e) => e.type === "text" && e.bind === "lyrics"));
  sel.replaceChildren();
  for (const t of usable) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.kind === "builtin" ? t.name : `${t.name} (내 템플릿)`;
    sel.appendChild(o);
  }
  if (!usable.length) {
    const o = document.createElement("option");
    o.value = "builtin-praise"; o.textContent = "찬양(가사)";
    sel.appendChild(o);
  }
  const last = localStorage.getItem("lyra.songTemplate");
  if (last && [...sel.options].some((o) => o.value === last)) sel.value = last;
}

// 편집 칸에 있는 가사 그대로 슬라이드를 만든다(저장하지 않은 수정·새 곡도 그대로 반영).
// 빈 줄이 장 구분이라 apply_template이 원본 넘김을 그대로 재현한다.
async function addSongToService() {
  const lyrics = $("song-lyrics").value;
  if (!lyrics.trim()) { msg("song-status", "가사가 비어 있습니다", true); return; }
  if (!state.serviceId) { msg("song-status", "예배를 먼저 선택하세요", true); return; }
  const templateId = $("song-template").value || "builtin-praise";
  localStorage.setItem("lyra.songTemplate", templateId);
  const idx = slides().findIndex((s) => s.id === state.selected);
  try {
    const r = await callTool("apply_template", {
      template_id: templateId,
      service_id: state.serviceId,
      params: { lyrics },
      position: idx >= 0 ? idx + 1 : undefined,
    });
    await refresh();
    if (r.slide_ids?.[0]) { setSingleSelection(r.slide_ids[0]); render(); }
    const name = $("song-title").value.trim() || "가사";
    msg("song-status", `“${name}” ${r.slide_ids?.length || 0}장 추가됨`);
    toast(`${r.slide_ids?.length || 0}장 추가됨`);
  } catch (e) { msg("song-status", e.message, true); }
}

// 오른쪽 편집 칸을 채운다. id가 없으면 새 곡.
function showSongEditor({ id, title, text }) {
  songPicked = { id: id ?? null, title: title || "", text: text || "" };
  $("song-preview").hidden = false;
  $("song-title").value = songPicked.title;
  $("song-lyrics").value = songPicked.text;
  $("song-delete").hidden = !id;
  markSongDirty(false);
  updateSongMeta();
}

// 가사 칸의 현재 내용으로 "N장 · 장당 M줄" 표시를 갱신한다(빈 줄 = 장 구분).
function updateSongMeta() {
  const pages = $("song-lyrics").value.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)
    .map((b) => b.split("\n").filter((l) => l.trim())).filter((b) => b.length);
  if (!pages.length) { $("song-preview-meta").textContent = ""; return; }
  const per = pages.map((p) => p.length);
  const lo = Math.min(...per), hi = Math.max(...per);
  $("song-preview-meta").textContent = `${pages.length}장 · 장당 ${lo === hi ? lo : `${lo}~${hi}`}줄`;
}

function markSongDirty(on) {
  songDirty = on;
  $("song-dirty").hidden = !on;
}

// 저장하지 않은 편집이 있으면 물어본다(다른 곡 선택·모달 닫기 전에).
async function confirmSongDiscard() {
  if (!songDirty) return true;
  return confirm("저장하지 않은 가사 수정이 있습니다. 버릴까요?");
}

async function saveSong() {
  const title = $("song-title").value.trim();
  const lyrics = $("song-lyrics").value;
  if (!title) { msg("song-status", "제목을 입력하세요", true); return; }
  try {
    const r = await callTool("save_song", { song_id: songPicked?.id ?? undefined, title, lyrics });
    songPicked = { id: r.song_id, title: r.title, text: lyrics };
    $("song-delete").hidden = false;   // 새 곡이었다면 이제 지울 수 있다
    markSongDirty(false);
    await searchSongs();
    // 저장한 곡을 목록에서 다시 선택 표시
    for (const row of document.querySelectorAll("#song-list .song-row"))
      if (row.querySelector(".lib-name")?.textContent === r.title) row.classList.add("sel");
    msg("song-status", `“${r.title}” 저장됨 · ${r.pages}장 ${r.lines}줄`);
  } catch (e) { msg("song-status", e.message, true); }
}

async function deleteSong() {
  if (!songPicked?.id) return;
  if (!confirm(`“${songPicked.title}”을(를) 목록에서 지울까요?\n원본 PPT 파일은 그대로 남습니다.`)) return;
  try {
    await callTool("delete_song", { song_id: songPicked.id });
    songPicked = null;
    markSongDirty(false);
    $("song-preview").hidden = true;
    await searchSongs();
    msg("song-status", "삭제됨");
  } catch (e) { msg("song-status", e.message, true); }
}

let songPicked = null;
let songDirty = false;

// ===== 배경 고르기 (여러 슬라이드에 같은 배경 영상/이미지) =====
// 가사만 띄우는 구성에서는 배경 루프 영상을 여러 장에 똑같이 깔아야 한다. 여기서 고른
// 배경은 선택한 슬라이드 전체에 한 번에 적용되고, 자주 쓰는 배경은 이름 붙여 저장해 둔다.
async function loadBackgrounds() {
  try { state.backgrounds = (await callTool("list_backgrounds")).backgrounds || []; }
  catch { state.backgrounds = []; }
}

function openBgPicker() {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하세요"); return; }
  $("bg-modal").hidden = false;
  msg("bg-status", "");
  renderBgPicker();
}
function closeBgPicker() { $("bg-modal").hidden = true; }

// 이 예배에서 실제로 쓰이고 있는 배경들(중복 제거) — 한 장에 깔아 본 뒤 나머지에 퍼뜨릴 때.
function backgroundsInUse() {
  const seen = new Map();
  for (const s of slides()) {
    if (!s.background) continue;
    const k = JSON.stringify(s.background);
    const cur = seen.get(k);
    if (cur) cur.count += 1;
    else seen.set(k, { background: s.background, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}

// 배경 미리보기 카드. 영상은 첫 프레임만(#t=0.1) 보여준다 — 여러 개를 동시에 재생하지 않는다.
function bgThumb(bg) {
  const t = elx("div", "bg-thumb");
  if (!bg) { t.classList.add("bg-none"); t.textContent = "테마 기본"; return t; }
  if (bg.type === "video") {
    const v = document.createElement("video");
    v.src = (bg.url || "") + "#t=0.1";
    v.muted = true; v.playsInline = true; v.preload = "metadata";
    t.appendChild(v);
    t.appendChild(elx("span", "bg-tag", "영상"));
  } else if (bg.type === "image") {
    t.style.backgroundImage = `url("${bg.url}")`;
    t.style.backgroundSize = "cover";
    t.style.backgroundPosition = "center";
    if (/\.gif(\?|#|$)/i.test(bg.url || "")) t.appendChild(elx("span", "bg-tag", "GIF"));
  } else if (bg.type === "gradient") {
    t.style.background = `linear-gradient(${bg.angle ?? 135}deg, ${bg.from}, ${bg.to})`;
  } else {
    t.style.background = bg.value || "#000";
  }
  return t;
}

function bgCard(bg, label, actions) {
  const card = elx("div", "bg-card");
  card.appendChild(bgThumb(bg));
  card.appendChild(elx("div", "bg-name", label));
  card.title = "선택한 슬라이드에 이 배경 적용";
  card.onclick = async () => {
    try { await applyBackgroundTo(bgTargetIds(), bg); renderBgPicker(); }
    catch (e) { msg("bg-status", e.message, true); }
  };
  const acts = [...(actions || [])];
  // 영상 배경은 "루프로 만들기"를 붙인다 — 이음새가 안 맞아 반복할 때 툭 튀는 영상을 고친다.
  if (bg?.type === "video" && bg.url) acts.unshift(["🔁 루프로", "", () => askLoopMode(bg, card)]);
  if (acts.length) {
    const row = elx("div", "bg-acts");
    for (const [text, cls, fn] of acts) {
      const b = elx("button", "mini " + (cls || ""), text);
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      row.appendChild(b);
    }
    card.appendChild(row);
  }
  return card;
}

// 루프 방식 선택 — 카드 안에서 바로 고른다(둘의 결과가 꽤 다르므로 설명을 붙인다).
function askLoopMode(bg, card) {
  const old = card.querySelector(".bg-acts");
  const box = elx("div", "bg-loop-ask");
  box.appendChild(elx("div", "muted", "어떻게 이을까요?"));
  const pick = (text, title, mode) => {
    const b = elx("button", "mini", text);
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); makeLoopBackground(bg, mode); };
    return b;
  };
  box.append(
    pick("디졸브", "끝과 시작을 겹쳐 서서히 넘긴다. 길이가 조금 짧아진다. 물·구름·보케처럼 방향성 없는 배경에 자연스럽다(권장).", "crossfade"),
    pick("왕복", "정방향으로 갔다가 거꾸로 돌아온다. 이음새는 완벽하지만 되돌아가는 게 티 날 수 있다. 길이 2배.", "pingpong"),
  );
  const cancel = elx("button", "mini", "취소");
  cancel.onclick = (e) => { e.stopPropagation(); box.replaceWith(old); };
  box.appendChild(cancel);
  old.replaceWith(box);
}

// 루프 영상을 굽고(서버 ffmpeg) → 라이브러리에 저장 + 선택한 슬라이드에 바로 적용.
async function makeLoopBackground(bg, mode) {
  const label = mode === "pingpong" ? "왕복" : "디졸브";
  showBusy(`루프 영상 만드는 중 (${label})…`, "영상 길이에 따라 몇 초~1분 정도 걸립니다");
  try {
    const r = await callTool("make_loop_video", { url: bg.url, mode });
    const looped = { ...bg, url: r.url, loop: true, muted: true };
    const name = `${r.filename.replace(/\.mp4$/i, "")} (${label})`;
    await callTool("save_background", { name, background: looped });
    await loadBackgrounds();
    const ids = bgTargetIds();
    if (ids.length) await applyBackgroundTo(ids, looped);
    renderBgPicker();
    msg("bg-status", `루프 완성 · ${r.source_seconds}초 → ${r.result_seconds}초 (저장한 배경에 추가됨)`);
  } catch (e) {
    msg("bg-status", e.message, true);
  } finally { hideBusy(); }
}

function renderBgPicker() {
  const n = bgTargetIds().length;
  $("bg-target-count").textContent = n > 1 ? `선택한 ${n}장` : "선택한 슬라이드 1장";

  const saved = $("bg-saved");
  saved.replaceChildren();
  if (!state.backgrounds.length) {
    saved.appendChild(elx("p", "muted", "아직 저장한 배경이 없습니다. 아래 “이 예배에서 쓰는 배경”에서 ⭐로 저장하거나, ＋로 영상을 올리세요."));
  }
  for (const item of state.backgrounds) {
    saved.appendChild(bgCard(item.background, item.name, [
      ["삭제", "danger", async () => {
        if (!confirm(`저장한 배경 “${item.name}”을(를) 목록에서 지울까요?`)) return;
        await callTool("remove_background", { background_id: item.id });
        await loadBackgrounds();
        renderBgPicker();
      }],
    ]));
  }

  const inuse = $("bg-inuse");
  inuse.replaceChildren();
  inuse.appendChild(bgCard(null, "테마 기본 (배경 없음)"));
  for (const { background, count } of backgroundsInUse()) {
    inuse.appendChild(bgCard(background, `${bgLabel(background)} · ${count}장`, [
      ["⭐ 저장", "", async () => {
        const name = prompt("배경 이름 (예: 잔잔한 물결 루프)", bgLabel(background));
        if (!name) return;
        await callTool("save_background", { name, background });
        await loadBackgrounds();
        renderBgPicker();
        toast("배경 저장됨");
      }],
    ]));
  }
}

function bgLabel(bg) {
  if (!bg) return "테마 기본";
  if (bg.type === "video" || bg.type === "image") {
    return decodeURIComponent(String(bg.url || "").split("/").pop() || bg.type);
  }
  if (bg.type === "gradient") return "그라데이션";
  return bg.value || "색";
}

// 영상/이미지를 올려 바로 선택한 슬라이드에 배경으로 깐다.
async function uploadBackground(file) {
  if (!file) return;
  const isVideo = /^video\//.test(file.type);
  msg("bg-status", "업로드 중…");
  try {
    const { url } = await uploadFile(file);
    const bg = isVideo
      ? { type: "video", url, loop: true, muted: true, overlay_dim: 0.4 }
      : { type: "image", url, fit: "cover", overlay_dim: 0.35 };
    await applyBackgroundTo(bgTargetIds(), bg);
    msg("bg-status", "적용 완료");
    renderBgPicker();
  } catch (e) { msg("bg-status", e.message, true); }
}

// 슬라이드 선택 <select> — 값=슬라이드 id. blankLabel이 있으면 "" 옵션을 맨 앞에.
function slideSelect(value, blankLabel, onPick) {
  const sel = document.createElement("select");
  if (blankLabel) { const o = document.createElement("option"); o.value = ""; o.textContent = blankLabel; sel.appendChild(o); }
  slides().forEach((s, i) => {
    const o = document.createElement("option");
    o.value = s.id;
    const label = slideLabel(s) || "";
    o.textContent = `${i + 1}. ${label.length > 22 ? label.slice(0, 22) + "…" : label}`;
    sel.appendChild(o);
  });
  sel.value = value || "";
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;   // 지워진 슬라이드를 가리키던 경우
  sel.onchange = () => onPick(sel.value || null);
  return sel;
}

function renderSoundList() {
  const list = $("sound-list");
  if (!list) return;
  list.replaceChildren();
  const items = tracks();
  if (!items.length) {
    list.appendChild(elx("p", "muted", "아직 사운드 트랙이 없습니다. “＋ 음악 파일 추가”로 mp3·m4a·wav 파일을 올리세요."));
    return;
  }
  for (const t of items) {
    const row = elx("div", "sound-row");

    const head = elx("div", "sd-head");
    const name = document.createElement("input");
    name.type = "text"; name.className = "sd-name"; name.value = t.name || "";
    name.onchange = () => saveTrack(t.id, { name: name.value });
    const play = elx("button", "mini sd-play", "▶ 미리듣기");
    play.onclick = () => toggleTrackPreview(t, play);
    const del = elx("button", "mini danger", "삭제");
    del.onclick = () => removeTrack(t.id, t.name);
    head.append(name, play, del);

    const range = elx("div", "sd-range");
    range.append(elx("span", "sd-lab", "시작"), slideSelect(t.start_slide_id, null, (v) => saveTrack(t.id, { start_slide_id: v })));
    range.append(elx("span", "sd-lab", "끝"), slideSelect(t.end_slide_id, "예배 끝까지", (v) => saveTrack(t.id, { end_slide_id: v })));
    const opts = elx("div", "sd-opts");
    { const lab = elx("label", "sd-check", "반복");
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = t.loop !== false;
      cb.onchange = () => saveTrack(t.id, { loop: cb.checked });
      lab.prepend(cb); opts.appendChild(lab); }
    { const lab = elx("label", "sd-vol", "볼륨");
      const r = document.createElement("input");
      r.type = "range"; r.min = 0; r.max = 1; r.step = 0.05; r.value = t.volume == null ? 0.8 : t.volume;
      r.onchange = () => saveTrack(t.id, { volume: Number(r.value) });
      r.oninput = () => { if (previewAudio?.dataset.trackId === t.id) previewAudio.volume = Number(r.value); };
      lab.appendChild(r); opts.appendChild(lab); }
    // 시작 페이드: 0.15초면 귀에는 바로 들린다(임팩트 유지). 크게 주면 서서히 스며든다.
    { const lab = elx("label", "sd-fade", "시작 페이드");
      const n = document.createElement("input");
      n.type = "number"; n.min = 0; n.max = 10; n.step = 0.05;
      n.value = t.fade_in == null ? 0.15 : t.fade_in;
      n.title = "0 = 바로 최대 음량 · 0.15 = 즉시 느낌(기본) · 1~3 = 서서히 커짐";
      n.onchange = () => saveTrack(t.id, { fade_in: Number(n.value) });
      lab.append(n, elx("span", "sd-unit", "초")); opts.appendChild(lab); }
    const span = trackSpan(t);
    opts.appendChild(elx("span", "sd-span muted", span ? `${span}장 구간` : "구간 없음"));

    row.append(head, range, opts);
    list.appendChild(row);
  }
}

// 트랙이 걸쳐 있는 슬라이드 수(0=구간을 못 찾음).
function trackSpan(t) {
  const arr = slides();
  const s = arr.findIndex((x) => x.id === t.start_slide_id);
  const e = t.end_slide_id ? arr.findIndex((x) => x.id === t.end_slide_id) : arr.length - 1;
  if (s < 0 || e < 0 || e < s) return 0;
  return e - s + 1;
}
// 이 슬라이드에서 소리가 나는지(리스트·타일에 ♪ 표시).
function slidesWithSound() {
  const arr = slides();
  const ids = new Set();
  for (const t of tracks()) {
    const s = arr.findIndex((x) => x.id === t.start_slide_id);
    const e = t.end_slide_id ? arr.findIndex((x) => x.id === t.end_slide_id) : arr.length - 1;
    if (s < 0 || e < 0) continue;
    for (let i = s; i <= e; i++) ids.add(arr[i].id);
  }
  return ids;
}

function toggleTrackPreview(t, btn) {
  const playing = previewAudio?.dataset.trackId === t.id && !previewAudio.paused;
  stopTrackPreview();
  if (playing) return;
  previewAudio = new Audio(t.url);
  previewAudio.dataset.trackId = t.id;
  previewAudio.volume = t.volume == null ? 0.8 : t.volume;
  previewAudio.loop = false;
  previewAudio.onended = () => stopTrackPreview();
  previewAudio.play().then(() => { btn.textContent = "■ 정지"; }).catch((e) => msg("sound-status", "재생 실패: " + e.message, true));
}

async function saveTrack(track_id, fields) {
  try {
    await callTool("update_track", { service_id: state.serviceId, track_id, fields });
    await refresh();
    renderSoundList();
    msg("sound-status", "저장됨");
  } catch (e) { msg("sound-status", e.message, true); }
}

async function removeTrack(track_id, name) {
  if (!confirm(`“${name || "이 트랙"}”을 목록에서 뺄까요?`)) return;
  stopTrackPreview();
  await callTool("remove_track", { service_id: state.serviceId, track_id });
  await refresh();
  renderSoundList();
}

// 음악 파일 업로드 → 트랙 추가(기본 구간: 선택한 슬라이드 ~ 예배 끝).
async function addTrackFile(file) {
  msg("sound-status", `${file.name} 업로드 중…`);
  try {
    const { url } = await uploadFile(file);
    const start = state.selected || slides()[0]?.id;
    await callTool("add_track", {
      service_id: state.serviceId, url,
      name: file.name.replace(/\.[^.]+$/, ""),
      start_slide_id: start,
    });
    await refresh();
    renderSoundList();
    msg("sound-status", "추가됨 — 시작·끝 슬라이드를 지정하세요");
  } catch (e) { msg("sound-status", e.message, true); }
}

// ---- 성구(성경 참조 → 본문 슬라이드) 모달 ----
let bibleRefTimer = null;
let bibleRefParsed = [];   // 마지막 미리보기에서 파싱된 참조

function openBibleRef() {
  if (!state.serviceId) { toast("예배 순서를 먼저 선택하세요"); return; }
  $("bibleref-modal").hidden = false;
  $("bibleref-msg").textContent = "";
  $("bibleref-status").textContent = "";
  previewBibleRefs();
  $("bibleref-input").focus();
}
function closeBibleRef() { $("bibleref-modal").hidden = true; }

// 입력 텍스트를 파싱해 참조 칩으로 미리보기(파싱만 — 빠름, DB 조회 없음).
async function previewBibleRefs() {
  const text = $("bibleref-input").value.trim();
  const box = $("bibleref-preview");
  if (!text) { bibleRefParsed = []; box.className = "bibleref-preview muted"; box.textContent = "해석된 참조가 여기에 표시됩니다."; return; }
  try {
    const { refs } = await callTool("parse_bible_refs", { text });
    bibleRefParsed = refs || [];
    box.className = "bibleref-preview";
    box.replaceChildren();
    if (!bibleRefParsed.length) { box.className = "bibleref-preview muted"; box.textContent = "해석된 참조가 없습니다. 예: 요 3:16-18, 롬 8:1"; return; }
    for (const r of bibleRefParsed) {
      const chip = elx("span", "bibleref-chip", r.ref);
      box.appendChild(chip);
    }
  } catch (e) { box.className = "bibleref-preview muted"; box.textContent = e.message; }
}

// 주보 PDF 업로드 → 빨강 성구 추출 → 입력창 채우고 미리보기.
async function extractBibleRefsFromPdf(file) {
  $("bibleref-status").textContent = "PDF에서 성구 추출 중…";
  try {
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/bible-refs/extract", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "추출 실패");
    $("bibleref-input").value = (body.refs || []).map((r) => r.ref).join(", ");
    await previewBibleRefs();
    const n = (body.refs || []).length;
    $("bibleref-status").textContent = n ? `${file.name} · 성구 ${n}개 추출됨 (검토 후 추가)` : `${file.name} · 빨강 성구를 찾지 못했어요`;
  } catch (e) { $("bibleref-status").textContent = "추출 실패: " + e.message; }
}

// 파싱된 참조 → 성경 본문 슬라이드 추가(선택한 순서 아래에).
async function addBibleRefSlides() {
  const text = $("bibleref-input").value.trim();
  if (!text) { $("bibleref-msg").textContent = "성경 참조를 입력하세요."; return; }
  const layout = $("bibleref-layout").value;
  const idx = slides().findIndex((s) => s.id === state.selected);
  const position = idx >= 0 ? idx + 1 : undefined;
  $("bibleref-add").disabled = true;
  $("bibleref-msg").className = "msg";
  $("bibleref-msg").textContent = "본문 조회·추가 중…";
  try {
    const res = await callTool("add_bible_ref_slides", { service_id: state.serviceId, text, layout, position });
    await refresh();
    if (res.slide_ids?.length) { setSingleSelection(res.slide_ids[res.slide_ids.length - 1]); render(); }
    const bad = res.unresolved || [];
    if (bad.length) {
      $("bibleref-msg").className = "msg err";
      $("bibleref-msg").textContent = `${res.slide_ids.length}장 추가 · 실패: ${bad.map((b) => b.ref).join(", ")}`;
    } else {
      toast(`성경 본문 ${res.slide_ids.length}장 추가됨`);
      closeBibleRef();
    }
  } catch (e) {
    $("bibleref-msg").className = "msg err";
    $("bibleref-msg").textContent = e.message;
  } finally {
    $("bibleref-add").disabled = false;
  }
}

// ---- PPT 라이브러리 검색 모달 ----
let libSearchTimer = null;
async function openLibrary() {
  $("library-modal").hidden = false;
  try {
    const { library_dir, indexed } = await callTool("get_library_dir");
    $("lib-dir").value = library_dir || "";
    $("lib-status").textContent = library_dir ? `색인 ${indexed}개` : "폴더를 지정하세요";
    if (library_dir && indexed === 0) await reindexLibrary();
    resetPrerenderUi(library_dir || "");
    renderLibResults([]);
    $("lib-query").focus();
  } catch (e) { $("lib-status").textContent = e.message; }
}
function closeLibrary() { prerenderCancel = true; $("library-modal").hidden = true; }

// ---- 폴더 미리 변환 (특정 폴더의 PPT를 미리 이미지로 변환해두기) ----
let prerenderUncached = [];   // 확인(scan)으로 찾은 미변환 파일 경로
let prerenderCancel = false;  // 진행 중 중지 플래그

function resetPrerenderUi(dir) {
  $("lib-pre-dir").value = dir || "";
  prerenderUncached = [];
  $("lib-pre-run").disabled = true;
  $("lib-pre-run").textContent = "⚡ 이 폴더 미리 변환";
  $("lib-pre-status").textContent = "";
  $("lib-pre-bar").hidden = true;
  $("lib-pre-cancel").hidden = true;
}

// 폴더 안의 변환 대상·미변환 수를 확인.
async function scanPrerenderDir() {
  const dir = $("lib-pre-dir").value.trim() || undefined;
  $("lib-pre-status").textContent = "확인 중…";
  try {
    const { files, total, cached } = await callTool("list_library_files", { dir });
    prerenderUncached = files.filter((f) => !f.cached).map((f) => f.path);
    const un = prerenderUncached.length;
    $("lib-pre-status").textContent = `PPT/PDF ${total}개 · 변환됨 ${cached} · 미변환 ${un}`;
    $("lib-pre-run").disabled = un === 0;
    $("lib-pre-run").textContent = un ? `⚡ 미변환 ${un}개 변환` : "⚡ 모두 변환됨";
  } catch (e) { $("lib-pre-status").textContent = e.message; }
}

// 미변환 파일들을 배치로 미리 변환하며 진행률 표시(중지 가능).
async function runPrerenderDir() {
  if (!prerenderUncached.length) return;
  const total = prerenderUncached.length;
  prerenderCancel = false;
  $("lib-pre-run").hidden = true;
  $("lib-pre-cancel").hidden = false;
  $("lib-pre-cancel").textContent = "중지";
  $("lib-pre-bar").hidden = false;
  const BATCH = 4;
  let done = 0, failed = 0;
  for (let i = 0; i < total && !prerenderCancel; i += BATCH) {
    const batch = prerenderUncached.slice(i, i + BATCH);
    try {
      const r = await callTool("prerender_library", { paths: batch });
      failed += (r.failed || []).length;
    } catch { failed += batch.length; }
    done = Math.min(i + BATCH, total);
    $("lib-pre-fill").style.width = Math.round((done / total) * 100) + "%";
    $("lib-pre-status").textContent = `변환 중… ${done}/${total}${failed ? ` (실패 ${failed})` : ""}`;
  }
  $("lib-pre-run").hidden = false;
  $("lib-pre-cancel").hidden = true;
  const stopped = prerenderCancel;
  $("lib-pre-status").textContent = stopped ? `중지됨 · ${done}/${total} 변환` : `완료 · ${done - failed}/${total} 변환${failed ? ` (실패 ${failed})` : ""}`;
  await scanPrerenderDir();       // 남은 미변환 수 갱신
  if ($("lib-query").value.trim()) await searchLibrary();  // 검색 결과 ⚡ 배지 갱신
}
function cancelPrerenderDir() { prerenderCancel = true; $("lib-pre-cancel").textContent = "중지 중…"; }

async function saveLibraryDir() {
  const path = $("lib-dir").value.trim();
  if (!path) return;
  try {
    await callTool("set_library_dir", { path });
    $("lib-status").textContent = "폴더 저장됨 · 색인 중…";
    await reindexLibrary();
  } catch (e) { $("lib-status").textContent = e.message; }
}

// 증분 색인(변경분만). 새 폴더면 전부 신규로 추출됨.
async function reindexLibrary() {
  showBusy("라이브러리 색인 중…", "새/변경된 PPT의 내용을 읽는 중이에요 (처음은 오래 걸릴 수 있어요)");
  try {
    const r = await callTool("index_library", {});
    $("lib-status").textContent = `색인 ${r.files}개 (신규 ${r.added}, 갱신 ${r.updated})`;
  } catch (e) { $("lib-status").textContent = e.message; }
  finally { hideBusy(); }
}

let libResults = [];   // 마지막 검색 결과(미리 변환 대상)

async function searchLibrary() {
  const q = $("lib-query").value.trim();
  if (!q) { libResults = []; renderLibResults([]); return; }
  try {
    const { results } = await callTool("search_library", { query: q });
    libResults = results;
    renderLibResults(results);
  } catch (e) { $("lib-results").innerHTML = `<div class="lib-empty">${e.message}</div>`; }
}

const RENDERABLE_EXT = new Set([".pptx", ".ppt", ".odp", ".pdf"]);

function renderLibResults(results) {
  const root = $("lib-results");
  root.replaceChildren();
  // 미리 변환 버튼: 렌더 대상 중 아직 캐시 안 된 게 있으면 활성화
  const prBtn = $("lib-prerender");
  const pending = results.filter((r) => RENDERABLE_EXT.has(r.ext) && !r.cached).length;
  if (prBtn) { prBtn.disabled = pending === 0; prBtn.textContent = pending ? `⚡ 미리 변환 (${pending})` : "⚡ 모두 변환됨"; }
  if (!results.length) { root.innerHTML = '<div class="lib-empty">검색어를 입력하세요. 제목과 슬라이드 내용에서 찾습니다.</div>'; return; }
  for (const r of results) {
    const row = elx("div", "lib-row");
    const info = elx("div", "info");
    const fname = elx("div", "fname", r.name);
    // 미리 변환돼 있으면 ⚡ 배지(가져오기 즉시)
    if (RENDERABLE_EXT.has(r.ext) && r.cached) fname.append(elx("span", "cached-badge", "⚡ 빠름"));
    info.append(fname);
    info.append(elx("div", "fmeta", `${r.relpath}${r.pages ? " · " + r.pages + "장" : ""}`));
    if (r.snippet) info.append(elx("div", "snip", r.snippet));
    const tag = elx("span", "mtag" + (r.matched_in === "content" ? " content" : ""), r.matched_in === "content" ? "내용" : "제목");
    const imp = elx("button", "mini accent", "가져오기");
    imp.onclick = () => importFromLibrary(r);
    row.append(info, tag, imp);
    root.appendChild(row);
  }
}

// 현재 검색 결과의 PPT/PDF를 미리 이미지로 변환(캐시) → 이후 가져오기가 즉시.
async function prerenderLibResults() {
  const paths = libResults.filter((r) => RENDERABLE_EXT.has(r.ext) && !r.cached).map((r) => r.path);
  if (!paths.length) return;
  const btn = $("lib-prerender");
  btn.disabled = true; btn.textContent = `⚡ 변환 중… (0/${paths.length})`;
  try {
    const res = await callTool("prerender_library", { paths });
    toast(`${res.rendered}개 미리 변환 완료 (${res.pages}장) — 이제 즉시 가져옵니다`);
    await searchLibrary();   // cached 플래그 갱신
  } catch (e) { toast("미리 변환 실패: " + e.message); btn.disabled = false; }
}

async function importFromLibrary(r) {
  if (!state.serviceId) return;
  const isOffice = [".pptx", ".ppt", ".odp"].includes(r.ext);
  showBusy(isOffice ? "PowerPoint 변환 중…" : "가져오는 중…", `${r.name}${isOffice ? " · LibreOffice로 변환" : ""}`);
  try {
    // 현재 선택한 슬라이드 바로 아래로 가져오기(선택 없으면 맨 끝) — 메뉴 임포트와 동일.
    const idx = slides().findIndex((s) => s.id === state.selected);
    const position = idx >= 0 ? idx + 1 : undefined;
    const { slide_ids } = await callTool("import_pdf", { service_id: state.serviceId, path: r.path, position });
    await refresh();
    // 이어서 가져올 때 순서가 유지되도록 마지막 가져온 슬라이드를 선택
    if (slide_ids?.length) { setSingleSelection(slide_ids[slide_ids.length - 1]); render(); }
    clearInterval(busyTimer); busyTimer = null;
    $("busy-msg").textContent = `${slide_ids.length}장 가져왔어요 ✓`;
    $("busy-sub").textContent = "";
    $("busy").querySelector(".spinner").style.display = "none";
    setTimeout(() => { $("busy").querySelector(".spinner").style.display = ""; hideBusy(); }, 900);
  } catch (e) { hideBusy(); alert("가져오기 실패: " + e.message); }
}

function msg(id, text, err) { const el = $(id); if (!el) return; el.textContent = text; el.className = "msg" + (err ? " err" : ""); }

// ---------- wire ----------
// ---- topbar dropdown menus / popovers ----
let openMenu = null;
function closeMenus() { if (openMenu) { openMenu.hidden = true; openMenu = null; } }
function wireMenu(btnId, panelId, { closeOnItem = false } = {}) {
  const btn = $(btnId), panel = $(panelId);
  btn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeMenus();
    if (willOpen) { panel.hidden = false; openMenu = panel; }
  };
  // 항목은 나중에 그려지기도 하므로(＋추가의 템플릿 목록) 위임으로 닫는다.
  if (closeOnItem) panel.addEventListener("click", (e) => { if (e.target.closest(".menu-item")) closeMenus(); });
}
document.addEventListener("click", (e) => { if (openMenu && !openMenu.parentElement.contains(e.target)) closeMenus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeMenus();
  // 열려 있는 모달도 Esc로 닫는다(추가·템플릿·사운드·성구·라이브러리).
  for (const [id, close] of [["add-modal", closeAddSlide], ["tpl-modal", closeTemplates],
    ["sound-modal", closeSound], ["bibleref-modal", closeBibleRef], ["library-modal", closeLibrary],
    ["bg-modal", closeBgPicker], ["song-modal", closeSongs]]) {
    if (!$(id)?.hidden) { close(); break; }
  }
});

// self-host 웹폰트 목록을 불러와 설정의 기본 글꼴 select를 채운다.
async function loadFonts() {
  try { state.fonts = (await callTool("list_fonts")).fonts || []; } catch { state.fonts = []; }
  fillFontSelect($("font-select"), state.service?.theme_overrides?.font || "");
  if (state.service) syncThemeControls();
}

// 설정 팝오버: 같은 네트워크 다른 기기에서 접속할 주소 목록.
async function loadNetwork() {
  const box = $("net-addrs");
  if (!box) return;
  try {
    const { addresses } = await callTool("list_network_addresses");
    if (!addresses?.length) { box.textContent = "네트워크 주소를 찾지 못했습니다."; return; }
    const port = location.port || "4321";
    box.replaceChildren();
    for (const ip of addresses) {
      const url = `http://${ip}:${port}`;
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = url;
      box.appendChild(a);
    }
  } catch { box.textContent = "주소 확인 실패"; }
}

function init() {
  initThemeSelect();
  wireResponsive();      // 좁은 화면: 하단 탭 · 속성 서랍 · 터치용 ▲▼
  wireStaticGroups();   // 정적 접이식 그룹(슬라이드 배경)의 열림 상태 기억
  wireMenu("menu-add-btn", "menu-add", { closeOnItem: true });
  wireMenu("menu-service-btn", "menu-service", { closeOnItem: true });
  renderAddFields();
  $("service-select").onchange = (e) => selectService(e.target.value);
  $("new-service").onclick = newService;
  $("edit-service").onclick = editService;
  $("dup-service").onclick = duplicateService;
  $("del-service").onclick = deleteService;
  $("view-list").onclick = () => { state.mode = "list"; render(); };
  $("view-tiles").onclick = () => { state.mode = "tiles"; render(); };
  // 슬라이드 추가 모달(＋추가 → 종류)
  $("add-type").onchange = renderAddFields;
  $("add-slide-btn").onclick = () => addSlide("end");
  $("add-after-btn").onclick = () => addSlide("after");
  $("add-close").onclick = closeAddSlide;
  $("add-modal").addEventListener("mousedown", (e) => { if (e.target === $("add-modal")) closeAddSlide(); });
  $("add-modal").addEventListener("keydown", (e) => {   // Enter = 선택 아래에 추가 (찬송가 검색창은 제외)
    if (e.key !== "Enter" || e.target.tagName === "TEXTAREA" || e.target.closest(".hymn-search")) return;
    e.preventDefault(); addSlide("after");
  });
  // 디자인 템플릿 모달
  $("tpl-btn").onclick = openTemplates;
  $("tpl-close").onclick = closeTemplates;
  $("tpl-modal").addEventListener("mousedown", (e) => { if (e.target === $("tpl-modal")) closeTemplates(); });

  // 드래그드롭: 이미지/PDF/PPT 파일을 현재 예배에 슬라이드로 가져오기
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-overlay").hidden = true; });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!state.serviceId) { toast("먼저 예배를 선택하거나 만들어 주세요"); return; }
    const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
    const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv", "ogg"]);
    for (const f of files) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (IMG_EXT.has(ext)) {
        // 이미지: 새 슬라이드가 아니라 현재 슬라이드에 이미지 요소로 첨부
        if (!selectedSlide()) { toast("이미지를 붙일 슬라이드를 먼저 선택하세요"); continue; }
        try { const { url } = await uploadFile(f); await addElement("image", { url }); toast("이미지 첨부됨"); }
        catch (err) { toast("이미지 첨부 실패: " + err.message); }
      } else if (VIDEO_EXT.has(ext)) {
        // 영상: 현재 슬라이드에 영상 요소로 첨부(소리는 발표 화면에서 재생)
        if (!selectedSlide()) { toast("영상을 붙일 슬라이드를 먼저 선택하세요"); continue; }
        try { const { url } = await uploadFile(f); await addElement("video", { url }); toast("영상 첨부됨(발표 화면에서 소리 재생)"); }
        catch (err) { toast("영상 첨부 실패: " + err.message); }
      } else {
        await importSlidesFile(f);   // PDF/PPT → 슬라이드로 가져오기(선택 아래)
      }
    }
  });

  // 복사/붙여넣기 (⌘/Ctrl+C·V):
  //  - 요소가 선택돼 있으면 요소를, 아니면 슬라이드(리스트·타일 멀티셀렉)를 대상으로.
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget()) return;   // 입력·인라인 편집 중엔 전역 단축키 무시
    // PageUp/PageDown = 이전/다음 슬라이드 (리스트 모드, 발표 화면과 같은 키)
    if ((e.key === "PageUp" || e.key === "PageDown") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (state.mode !== "list" || state.editingTemplate || anyModalOpen()) return;
      e.preventDefault();
      navSlide(e.key === "PageDown" ? 1 : -1);
      return;
    }
    // 요소 선택이 없을 때 Del/Backspace → 선택한 순서 삭제(멀티셀렉 한 번에).
    // (요소가 선택된 경우는 요소 삭제 핸들러가 처리)
    if (state.editEl == null && (e.key === "Delete" || e.key === "Backspace")) {
      if (state.selectedSet.size) { e.preventDefault(); deleteSelected(); }
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    // 실행취소/다시실행
    if (k === "z") { e.preventDefault(); (e.shiftKey ? redo() : undo()); return; }
    if (k === "y") { e.preventDefault(); redo(); return; }   // Windows 다시실행
    if (k !== "c" && k !== "v") return;
    e.preventDefault();
    if (k === "c") {
      // 복사: 요소가 선택돼 있으면 요소, 아니면 슬라이드
      if (state.editEl != null) copyElement(); else copySelectedSlides();
    } else {
      // 붙여넣기: 마지막에 복사한 종류로(다른 슬라이드로 이동해도 요소 붙여넣기 가능)
      if (lastCopyKind === "element") pasteElement(); else pasteSlides();
    }
  });
  $("undo-btn").onclick = undo;
  $("redo-btn").onclick = redo;
  $("prev-slide").onclick = () => navSlide(-1);
  $("next-slide").onclick = () => navSlide(1);
  $("del-slide").onclick = deleteSelected;
  $("present-here").onclick = presentHere;
  $("insp-bg-type").onchange = () => {
    renderBgFields(selectedSlide()?.background);
    const t = $("insp-bg-type").value;
    if (t === "theme" || t === "color" || t === "gradient") saveInspector();  // 즉시 적용(이미지/영상은 URL 지정 후)
  };
  $("insp-save").onclick = saveInspector;

  // element toolbar + design panel
  document.querySelectorAll(".canvas-tools [data-add]").forEach((b) => {
    b.onclick = () => (b.dataset.add === "image" ? $("el-image-file").click() : addElement(b.dataset.add));
  });
  $("el-image-file").onchange = async (e) => {
    if (!e.target.files[0]) return;
    try { const { url } = await uploadFile(e.target.files[0]); await addElement("image", { url }); }
    catch (err) { msg("add-msg", err.message, true); }
    e.target.value = "";
  };
  // keyboard: Delete removes selected element, arrows nudge
  document.addEventListener("keydown", (e) => {
    if (state.mode !== "list" || state.editEl == null) return;
    if (isTypingTarget()) return;   // 입력·인라인 편집 중엔 Del/방향키가 요소를 지우거나 옮기지 않게
    const group = [...state.editElSet].map((gi) => els()[gi]).filter(Boolean);
    if (!group.length) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelectedEls(); }
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = 0.005;
      for (const el of group) {   // 선택된 요소들을 함께 nudge
        if (e.key === "ArrowLeft") el.x = clamp01((el.x ?? 0.4) - d);
        if (e.key === "ArrowRight") el.x = clamp01((el.x ?? 0.4) + d);
        if (e.key === "ArrowUp") el.y = clamp01((el.y ?? 0.4) - d);
        if (e.key === "ArrowDown") el.y = clamp01((el.y ?? 0.4) + d);
      }
      repaintEls();
      clearTimeout(window.__nudgeT);
      window.__nudgeT = setTimeout(commitEls, 300);
    }
  });

  $("export-btn").onclick = exportService;
  $("export-img-btn").onclick = exportImages;
  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = (e) => e.target.files[0] && importService(e.target.files[0]);
  $("import-ppt").onclick = () => $("import-ppt-file").click();
  $("import-ppt-file").onchange = (e) => { const f = e.target.files[0]; if (f) importSlidesFile(f); e.target.value = ""; };
  // 라이브러리 모달
  $("library-btn").onclick = openLibrary;
  $("library-close").onclick = closeLibrary;
  $("lib-save").onclick = saveLibraryDir;
  $("lib-reindex").onclick = () => reindexLibrary();
  $("lib-query").addEventListener("input", () => { clearTimeout(libSearchTimer); libSearchTimer = setTimeout(searchLibrary, 250); });
  $("lib-prerender").onclick = prerenderLibResults;
  $("lib-pre-scan").onclick = scanPrerenderDir;
  $("lib-pre-run").onclick = runPrerenderDir;
  $("lib-pre-cancel").onclick = cancelPrerenderDir;
  $("lib-pre-dir").addEventListener("keydown", (e) => { if (e.key === "Enter") scanPrerenderDir(); });
  $("library-modal").addEventListener("mousedown", (e) => { if (e.target === $("library-modal")) closeLibrary(); });
  // 사운드 트랙 모달
  $("sound-btn").onclick = openSound;
  $("sound-close").onclick = closeSound;
  $("sound-add").onclick = () => $("sound-file").click();
  $("sound-file").onchange = (e) => { const f = e.target.files[0]; if (f) addTrackFile(f); e.target.value = ""; };
  $("sound-modal").addEventListener("mousedown", (e) => { if (e.target === $("sound-modal")) closeSound(); });
  // 찬양 가사 모달
  $("song-btn").onclick = openSongs;
  $("song-close").onclick = closeSongs;
  $("song-query").addEventListener("input", () => { clearTimeout(songTimer); songTimer = setTimeout(searchSongs, 200); });
  $("song-copy").onclick = async () => {
    const text = $("song-lyrics").value;   // 편집 중인 내용을 그대로 복사
    if (!text.trim()) return;
    const ok = await copyText(text, $("song-lyrics"));
    msg("song-status", ok ? "가사 복사됨 · ＋추가에서 템플릿을 고르고 붙여넣으세요"
      : "복사가 막혔습니다 — 아래 칸에서 직접 선택해 복사하세요");
  };
  $("song-new").onclick = async () => {
    if (!(await confirmSongDiscard())) return;
    for (const r of document.querySelectorAll("#song-list .song-row.sel")) r.classList.remove("sel");
    showSongEditor({ id: null, title: "", text: "" });
    msg("song-status", "새 곡 — 제목과 가사를 넣고 저장하세요");
    $("song-title").focus();
  };
  $("song-add").onclick = addSongToService;
  $("song-save").onclick = saveSong;
  $("song-delete").onclick = deleteSong;
  // 편집 중 표시 + 장/줄 수 실시간 갱신
  $("song-lyrics").addEventListener("input", () => { markSongDirty(true); updateSongMeta(); });
  $("song-title").addEventListener("input", () => markSongDirty(true));
  $("song-modal").addEventListener("mousedown", async (e) => {
    if (e.target === $("song-modal") && await confirmSongDiscard()) closeSongs();
  });
  $("style-copy-btn").onclick = copyStyleToOthers;
  // 배경 고르기 모달 (여러 슬라이드에 같은 배경 영상)
  $("bg-pick-btn").onclick = openBgPicker;
  $("bg-close").onclick = closeBgPicker;
  $("bg-upload-btn").onclick = () => $("bg-file").click();
  $("bg-file").onchange = (e) => { const f = e.target.files[0]; if (f) uploadBackground(f); e.target.value = ""; };
  $("bg-modal").addEventListener("mousedown", (e) => { if (e.target === $("bg-modal")) closeBgPicker(); });
  // 성구 모달
  $("bibleref-btn").onclick = openBibleRef;
  $("bibleref-close").onclick = closeBibleRef;
  $("bibleref-input").addEventListener("input", () => { clearTimeout(bibleRefTimer); bibleRefTimer = setTimeout(previewBibleRefs, 200); });
  $("bibleref-pdf-btn").onclick = () => $("bibleref-pdf-file").click();
  $("bibleref-pdf-file").onchange = (e) => { const f = e.target.files[0]; if (f) extractBibleRefsFromPdf(f); e.target.value = ""; };
  $("bibleref-add").onclick = addBibleRefSlides;
  $("bibleref-modal").addEventListener("mousedown", (e) => { if (e.target === $("bibleref-modal")) closeBibleRef(); });
  $("tpl-save").onclick = saveCurrentAsTemplate;
  $("tpl-edit-save").onclick = saveTemplateEdit;
  $("tpl-edit-cancel").onclick = cancelTemplateEdit;
  loadServices();
  loadTemplates();
  loadFonts();
  loadBackgrounds();
  loadNetwork();
  connectPresentWs();   // 발표 위치를 따라가 리스트·타일에 "발표중" 표시
}

init();
