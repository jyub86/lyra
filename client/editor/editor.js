// 편집 UI 컨트롤러. 모든 동작은 Tool 호출(api.callTool) — UI는 레지스트리의 한 소비자.
import { callTool, loadTheme, uploadFile, BUILTIN_THEMES } from "/shared/api.js";
import { renderSlideWithLayers } from "/shared/layer-renderer.js";

const $ = (id) => document.getElementById(id);

const state = {
  services: [],
  serviceId: null,
  service: null,     // get_service tree
  theme: null,
  selected: null,    // slide id
};

// ---------- helpers ----------
function flatSlides(service) {
  const out = [];
  for (const scene of service?.scenes || []) {
    for (const slide of scene.slides) out.push({ ...slide, sceneName: scene.name });
  }
  return out;
}
function slideLabel(slide) {
  const d = slide.data || {};
  return d.title || d.ref || d.label || (d.segments && d.segments[0]?.text) ||
    (d.lines && d.lines[0]) || (d.items && d.items[0]) || slide.template_type;
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
  const target = selectId || state.services[0]?.id;
  if (target) { sel.value = target; await selectService(target); }
  else { state.service = null; render(); }
}

async function selectService(id) {
  state.serviceId = id;
  state.service = await callTool("get_service", { service_id: id });
  state.theme = await loadTheme(state.service.theme_id);
  $("theme-select").value = state.service.theme_id;
  const all = flatSlides(state.service);
  state.selected = all[0]?.id || null;
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
    state.theme = await loadTheme(sel.value);
    renderPreview();
  };
}

// ---------- render ----------
function render() {
  renderTree();
  renderTargetScenes();
  renderPreview();
  renderInspector();
}

function renderTree() {
  const root = $("scene-list");
  root.innerHTML = "";
  if (!state.service) { root.innerHTML = '<p class="muted" style="padding:12px">예배 덱이 없습니다. “+ 새 예배”로 시작하세요.</p>'; return; }
  state.service.scenes.forEach((scene, si) => {
    const box = document.createElement("div");
    box.className = "scene";
    const head = document.createElement("div");
    head.className = "scene-head";
    head.innerHTML = `<span class="ord" title="씬 삭제">✕</span><span class="name">${scene.name}</span>`;
    head.querySelector(".ord").onclick = () => removeScene(scene.id);
    box.appendChild(head);
    scene.slides.forEach((slide) => {
      const it = document.createElement("div");
      it.className = "slide-item" + (slide.id === state.selected ? " sel" : "");
      it.innerHTML = `<span class="badge">${slide.template_type}</span><span class="label">${slideLabel(slide)}</span><span class="ord danger" title="삭제">✕</span>`;
      it.querySelector(".label").onclick = () => { state.selected = slide.id; render(); };
      it.querySelector(".badge").onclick = () => { state.selected = slide.id; render(); };
      it.querySelector(".ord").onclick = (e) => { e.stopPropagation(); removeSlide(slide.id); };
      box.appendChild(it);
    });
    root.appendChild(box);
  });
}

function renderTargetScenes() {
  const sel = $("target-scene");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const scene of state.service?.scenes || []) {
    const o = document.createElement("option");
    o.value = scene.id; o.textContent = scene.name; sel.appendChild(o);
  }
  if (prev) sel.value = prev;
}

function selectedSlide() {
  return flatSlides(state.service).find((s) => s.id === state.selected) || null;
}

function renderPreview() {
  const slide = selectedSlide();
  const prev = $("preview");
  if (!slide) { prev.replaceChildren(); $("slide-pos").textContent = "—"; return; }
  renderSlideWithLayers(prev, slide, state.theme);
  const all = flatSlides(state.service);
  const idx = all.findIndex((s) => s.id === slide.id);
  $("slide-pos").textContent = `${idx + 1} / ${all.length} · ${slide.sceneName}`;
}

function navSlide(delta) {
  const all = flatSlides(state.service);
  const idx = all.findIndex((s) => s.id === state.selected);
  const next = all[idx + delta];
  if (next) { state.selected = next.id; render(); }
}

// ---------- add slide ----------
const ADD_FIELDS = {
  title: [["title", "제목", "text"], ["subtitle", "부제", "text"]],
  section: [["label", "구분 제목", "text"]],
  bible: [["book", "책(이름/약칭)", "text"], ["chapter", "장", "number"], ["verse_start", "시작 절", "number"], ["verse_end", "끝 절", "number"], ["layout", "분할", "select:auto,one-per-verse,all-in-one"]],
  hymn: [["number", "찬송가 번호", "number"], ["verse_nos", "절(예: 1,3)", "text"], ["lines_per_slide", "줄/슬라이드", "number:4"]],
  responsive_reading: [["number", "교독문 번호", "number"]],
  praise: [["title", "곡 제목", "text"], ["lyrics", "가사(줄바꿈으로 구분)", "textarea"], ["lines_per_slide", "줄/슬라이드", "number:2"]],
  announcement: [["items", "광고 항목(줄바꿈)", "textarea"]],
  blank: [],
};

function renderAddFields() {
  const type = $("add-type").value;
  const wrap = $("add-fields");
  wrap.innerHTML = "";
  for (const [key, label, kind] of ADD_FIELDS[type] || []) {
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    let input;
    if (kind === "textarea") { input = document.createElement("textarea"); input.rows = 5; }
    else if (kind.startsWith("select:")) {
      input = document.createElement("select");
      for (const opt of kind.slice(7).split(",")) { const o = document.createElement("option"); o.value = o.textContent = opt; input.appendChild(o); }
    } else {
      input = document.createElement("input");
      input.type = kind.startsWith("number") ? "number" : "text";
      if (kind.includes(":")) input.value = kind.split(":")[1];
    }
    input.id = "af-" + key;
    wrap.appendChild(input);
  }
}

function afVal(key) { return $("af-" + key)?.value?.trim() ?? ""; }

async function addSlide() {
  const type = $("add-type").value;
  const scene_id = $("target-scene").value;
  if (!scene_id) return msg("add-msg", "대상 씬이 없습니다.", true);
  try {
    if (type === "bible") {
      await callTool("add_bible_slides", {
        scene_id, book: afVal("book"), chapter: +afVal("chapter"),
        verse_start: +afVal("verse_start"), verse_end: +afVal("verse_end"), layout: afVal("layout"),
      });
    } else if (type === "hymn") {
      const vn = afVal("verse_nos");
      await callTool("add_hymn_slides", {
        scene_id, number: +afVal("number"),
        verse_nos: vn ? vn.split(",").map((x) => +x.trim()).filter(Boolean) : undefined,
        lines_per_slide: +afVal("lines_per_slide") || 4,
      });
    } else if (type === "responsive_reading") {
      await callTool("add_reading_slides", { scene_id, number: +afVal("number") });
    } else if (type === "praise") {
      const lines = afVal("lyrics").split("\n").map((s) => s.trim()).filter(Boolean);
      await callTool("add_praise_slides", {
        scene_id, title: afVal("title"), sections: [{ label: "", lines }],
        lines_per_slide: +afVal("lines_per_slide") || 2,
      });
    } else if (type === "announcement") {
      const items = afVal("items").split("\n").map((s) => s.trim()).filter(Boolean);
      await callTool("add_announcement_slide", { scene_id, items });
    } else {
      const data = type === "title" ? { title: afVal("title"), subtitle: afVal("subtitle") }
        : type === "section" ? { label: afVal("label") } : {};
      await callTool("add_slide", { scene_id, template_type: type, data });
    }
    msg("add-msg", "추가됨");
    await selectService(state.serviceId);
  } catch (e) { msg("add-msg", e.message, true); }
}

// ---------- inspector ----------
function renderInspector() {
  const slide = selectedSlide();
  const empty = $("inspect-empty"), body = $("inspect-body");
  if (!slide) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  $("insp-type").value = slide.template_type;
  $("insp-data").value = JSON.stringify(slide.data, null, 2);
  const bg = slide.background;
  $("insp-bg-type").value = bg?.type || "theme";
  renderBgFields(bg);
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
  for (const [key, label, kind] of BG_FIELDS[type] || []) {
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    let input;
    if (kind.startsWith("check")) { input = document.createElement("input"); input.type = "checkbox"; input.checked = bg ? bg[key] !== false : kind.endsWith("1"); }
    else if (kind.startsWith("color")) { input = document.createElement("input"); input.type = "color"; input.value = bg?.[key] || kind.split(":")[1]; }
    else { input = document.createElement("input"); input.type = kind.startsWith("number") ? "number" : "text"; input.value = bg?.[key] ?? (kind.includes(":") ? kind.split(":")[1] : ""); }
    input.id = "bg-" + key;
    wrap.appendChild(input);
  }
  // file picker for image/video → uploads and fills the url field
  if (type === "image" || type === "video") {
    const file = document.createElement("input");
    file.type = "file";
    file.accept = type === "video" ? "video/*" : "image/*";
    file.onchange = async () => {
      if (!file.files[0]) return;
      msg("insp-msg", "업로드 중…");
      try {
        const { url } = await uploadFile(file.files[0]);
        $("bg-url").value = url;
        msg("insp-msg", "업로드 완료");
      } catch (e) { msg("insp-msg", e.message, true); }
    };
    wrap.appendChild(file);
  }
}

function buildBackground() {
  const type = $("insp-bg-type").value;
  if (type === "theme") return null;
  const get = (k) => $("bg-" + k);
  if (type === "color") return { type, value: get("value").value };
  if (type === "gradient") return { type, from: get("from").value, to: get("to").value, angle: +get("angle").value };
  if (type === "image") return { type, url: get("url").value, fit: "cover", overlay_dim: +get("overlay_dim").value };
  if (type === "video") return { type, url: get("url").value, loop: get("loop").checked, muted: get("muted").checked, overlay_dim: +get("overlay_dim").value };
  return null;
}

async function saveInspector() {
  const slide = selectedSlide();
  if (!slide) return;
  try {
    const data = JSON.parse($("insp-data").value);
    await callTool("update_slide", { slide_id: slide.id, fields: { data } });
    await callTool("set_slide_background", { slide_id: slide.id, background: buildBackground() });
    msg("insp-msg", "저장됨");
    await selectService(state.serviceId);
  } catch (e) { msg("insp-msg", e.message, true); }
}

// ---------- mutations ----------
async function newService() {
  const title = prompt("예배 제목", "주일 예배");
  if (!title) return;
  const date = prompt("날짜 (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
  if (!date) return;
  const worship_part = prompt("예배부 (1부/2부/연합)", "1부") || "1부";
  const { service_id } = await callTool("create_service", { title, date, worship_part });
  await loadServices(service_id);
}
async function addScene() {
  if (!state.serviceId) return;
  const name = prompt("씬 이름 (예: 예배로 부름, 찬양, 말씀, 광고)");
  if (!name) return;
  await callTool("add_scene", { service_id: state.serviceId, name });
  await selectService(state.serviceId);
}
async function removeScene(id) {
  if (!confirm("이 씬과 모든 슬라이드를 삭제할까요?")) return;
  await callTool("remove_scene", { scene_id: id });
  await selectService(state.serviceId);
}
async function removeSlide(id) {
  await callTool("remove_slide", { slide_id: id });
  if (state.selected === id) state.selected = null;
  await selectService(state.serviceId);
}
async function presentHere() {
  const all = flatSlides(state.service);
  const idx = all.findIndex((s) => s.id === state.selected);
  if (idx < 0) return;
  try { await callTool("present_goto", { service_id: state.serviceId, page_index: idx }); msg("add-msg", "발표 화면으로 전송"); }
  catch (e) { msg("add-msg", "발표 도구 미연결: " + e.message, true); }
}

function msg(id, text, err) { const el = $(id); el.textContent = text; el.className = "msg" + (err ? " err" : ""); }

// ---------- wire ----------
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("tab-add").hidden = t.dataset.tab !== "add";
      $("tab-inspect").hidden = t.dataset.tab !== "inspect";
    };
  });
}

function init() {
  initThemeSelect();
  initTabs();
  renderAddFields();
  $("service-select").onchange = (e) => selectService(e.target.value);
  $("new-service").onclick = newService;
  $("add-scene").onclick = addScene;
  $("add-type").onchange = renderAddFields;
  $("add-slide-btn").onclick = addSlide;
  $("prev-slide").onclick = () => navSlide(-1);
  $("next-slide").onclick = () => navSlide(1);
  $("del-slide").onclick = () => state.selected && removeSlide(state.selected);
  $("present-here").onclick = presentHere;
  $("insp-bg-type").onchange = () => renderBgFields(selectedSlide()?.background);
  $("insp-save").onclick = saveInspector;
  loadServices();
}

init();
