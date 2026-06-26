// Layer compositor (design §5, §12). background → content → overlays.
// Shared by editor preview and presenter so they render identically.
import { renderSlide } from "./slide-renderer.js";

export function applyTheme(root, theme) {
  const c = (theme && theme.colors) || {};
  const f = (theme && theme.font) || {};
  const set = (k, v) => v != null && root.style.setProperty(k, v);
  set("--text", c.text || "#ffffff");
  set("--accent", c.accent || "#7aa2f7");
  set("--muted", c.muted || "#c0caf5");
  set("--leader", c.leader || c.accent || "#7aa2f7");
  set("--congregation", c.congregation || "#e0af68");
  set("--font-family", f.family || "sans-serif");
  set("--title-size", (f.title_size || 5.0) + "cqw");
  set("--body-size", (f.body_size || 3.2) + "cqw");
  set("--label-size", (f.label_size || 1.8) + "cqw");
  set("--line-height", f.line_height || 1.5);
  set("--weight", f.weight || 600);
}

// Renders a background spec into `bgEl`. Video is wired in M8.
export function renderBackground(bgEl, bg) {
  bgEl.replaceChildren();
  bgEl.style.cssText = "";
  if (!bg || bg.type === "color") {
    bgEl.style.background = (bg && bg.value) || "#000";
  } else if (bg.type === "gradient") {
    bgEl.style.background = `linear-gradient(${bg.angle ?? 135}deg, ${bg.from}, ${bg.to})`;
  } else if (bg.type === "image") {
    bgEl.style.backgroundImage = `url("${bg.url}")`;
    bgEl.style.backgroundSize = bg.fit || "cover";
    bgEl.style.backgroundPosition = "center";
  } else if (bg.type === "video") {
    const v = document.createElement("video");
    v.src = bg.url;
    v.autoplay = true;
    v.muted = bg.muted !== false; // muted by default → autoplay allowed
    v.loop = bg.loop !== false;
    v.playsInline = true;
    v.className = "bg-video";
    if (bg.playback_rate) v.playbackRate = bg.playback_rate;
    bgEl.appendChild(v);
    v.play?.().catch(() => {});
  }
  // Readability dim over image/video.
  const dim = bg && bg.overlay_dim;
  if (dim && dim > 0) {
    const d = document.createElement("div");
    d.className = "bg-dim";
    d.style.background = `rgba(0,0,0,${dim})`;
    bgEl.appendChild(d);
  }
}

function renderOverlays(root, overlays) {
  root.replaceChildren();
  for (const o of overlays || []) {
    const n = document.createElement(o.type === "image" ? "img" : "div");
    n.className = "overlay";
    n.style.left = (o.x ?? 0.5) * 100 + "%";
    n.style.top = (o.y ?? 0.5) * 100 + "%";
    if (o.type === "image") {
      n.src = o.url;
      n.style.width = (o.scale ?? 0.1) * 100 + "%";
    } else {
      n.textContent = o.text || "";
      n.style.fontSize = (o.size ?? 24) / 10 + "cqw";
      n.style.color = o.color || "var(--text)";
      n.style.textAlign = o.align || "center";
    }
    root.appendChild(n);
  }
}

export function renderSlideWithLayers(container, slide, theme) {
  container.classList.add("slide-layers");
  applyTheme(container, theme);

  let bgEl = container.querySelector(":scope > .layer-bg");
  let contentEl = container.querySelector(":scope > .layer-content");
  let overlayEl = container.querySelector(":scope > .layer-overlays");
  if (!bgEl) {
    container.replaceChildren();
    bgEl = mk("layer-bg"); contentEl = mk("layer-content"); overlayEl = mk("layer-overlays");
    container.append(bgEl, contentEl, overlayEl);
  }

  const bg = slide.background ?? (theme && theme.background) ?? { type: "color", value: "#000" };
  renderBackground(bgEl, bg);
  renderSlide(contentEl, slide, theme);
  renderOverlays(overlayEl, slide.overlays || []);
}

function mk(cls) {
  const n = document.createElement("div");
  n.className = cls;
  return n;
}
