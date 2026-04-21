/**
 * Rich layout blocks: gallery, carousel, hero, map, card-list, split.
 *
 * The agent emits a fenced code block like:
 *   ```obsidian-agents-gallery
 *   { "columns": 3, "items": [...] }
 *   ```
 *
 * parseRichLayouts() lifts those blocks out of the markdown into placeholders,
 * and mountRichLayout() renders each one into its placeholder after the
 * markdown renderer has run.
 */

import { MarkdownRenderer, Component } from "obsidian";

export type RichLayoutKind =
  | "gallery"
  | "carousel"
  | "hero"
  | "map"
  | "card-list"
  | "split"
  | "terms";

export interface ParsedRichLayout {
  placeholder: string;
  kind: RichLayoutKind;
  data: unknown;
}

/**
 * A single citation / reference. Rendered as a subtle numbered footer
 * underneath any layout block. The model uses this to credit sources
 * (Wikipedia articles, news stories, data pages) without cluttering the
 * main visual.
 */
interface LayoutSource {
  label: string; // human-readable (e.g. "Wikipedia: Isaac Newton")
  href: string;
  site?: string; // optional short publisher/site name shown as a chip
}

/**
 * Layouts whose items can optionally link somewhere. `href` makes the
 * visual click-through to an external URL (and suppresses the lightbox
 * for image items that opt in via `link: true`). We keep the default
 * click = lightbox so existing galleries still work.
 */
interface GalleryItem {
  src: string;
  alt?: string;
  caption?: string;
  href?: string; // if set, a small link icon overlays the tile
}
interface GallerySpec {
  columns?: number;
  items: GalleryItem[];
  sources?: LayoutSource[];
}

interface CarouselItem {
  src: string;
  alt?: string;
  caption?: string;
  href?: string;
}
interface CarouselSpec {
  items: CarouselItem[];
  height?: string;
  sources?: LayoutSource[];
}

interface HeroImage {
  src: string;
  alt?: string;
  href?: string;
}
interface HeroSpec {
  primary: HeroImage;
  secondary?: HeroImage[];
  sources?: LayoutSource[];
}

interface MapPin {
  lat: number;
  lng: number;
  label?: string;
  rating?: number | string;
  body?: string;
  href?: string; // shown as a "Visit ↗" link inside the popup
}
interface MapSpec {
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: string;
  pins: MapPin[];
  sources?: LayoutSource[];
}

interface CardLink {
  label: string;
  href: string;
}
interface CardItem {
  title: string;
  rating?: number | string;
  category?: string;
  status?: string; // "Open", "Closed", etc.
  body?: string;
  thumbnail?: string;
  href?: string; // makes the whole card title clickable
  links?: CardLink[]; // extra action links shown as chips below the body
}
interface CardListSpec {
  items: CardItem[];
  sources?: LayoutSource[];
}

/**
 * Split layout: visual on one side, text on the other.
 *
 * The `visual` variant types live inside the same block so the agent can
 * pair prose with an image, a small gallery, or an interactive applet
 * without stacking three separate blocks.
 */
type SplitVisual =
  | { kind: "image"; src: string; alt?: string; caption?: string; href?: string }
  | {
      kind: "gallery";
      items: Array<{ src: string; alt?: string; caption?: string; href?: string }>;
      columns?: number;
    }
  | {
      kind: "applet";
      // Either raw HTML body (for obsidian-agents-applet) or a React component
      // body (for obsidian-agents-react). The applet is rendered in a sandboxed
      // iframe exactly like standalone applets.
      language: "html" | "react";
      code: string;
      height?: string;
    };

interface SplitSpec {
  side: "left" | "right"; // which side the visual sits on
  ratio?: string; // CSS grid-template-columns value, e.g. "1fr 2fr"
  width?: string; // legacy — visual column width (e.g. "320px")
  visual: SplitVisual;
  text: string; // markdown
  sources?: LayoutSource[];
}

/**
 * Glossary-style term definitions. Not a visible layout block — registers
 * term entries into a per-document map so that inline `[[Label]]{#slug}`
 * markers in the prose can open a side panel with the detail view.
 */
export interface TermKeyFact {
  label: string;
  value: string;
}
export interface TermImage {
  src: string;
  alt?: string;
  caption?: string;
  href?: string;
}
export interface TermSection {
  heading?: string;
  body: string; // markdown
}
export interface TermDefinition {
  id: string;
  title: string;
  summary?: string;
  keyFacts?: TermKeyFact[];
  images?: TermImage[];
  sections?: TermSection[];
  sources?: LayoutSource[];
  href?: string; // optional canonical link shown in the panel header
}
interface TermsSpec {
  terms: TermDefinition[];
}

// Global registry keyed by term id. Populated by `obsidian-agents-terms` blocks at
// render time and consumed by the inline click handler + the TermPanel.
// Scoped to `window` so every view in the workspace shares definitions.
declare global {
  interface Window {
    __obsidianAgentsTerms?: Map<string, TermDefinition>;
  }
}

function getTermRegistry(): Map<string, TermDefinition> {
  if (!window.__obsidianAgentsTerms) {
    window.__obsidianAgentsTerms = new Map();
  }
  return window.__obsidianAgentsTerms;
}

export function registerTerm(def: TermDefinition): void {
  if (!def || !def.id) return;
  getTermRegistry().set(def.id, def);
}

export function getTerm(id: string): TermDefinition | undefined {
  return getTermRegistry().get(id);
}

const RE = /```obsidian-agents-(gallery|carousel|hero|map|card-list|split|terms)[^\n]*\n([\s\S]*?)```/g;

export function parseRichLayouts(content: string): {
  content: string;
  layouts: ParsedRichLayout[];
} {
  const layouts: ParsedRichLayout[] = [];
  let idx = 0;
  const out = content.replace(RE, (_m, kind: string, body: string) => {
    const id = `obsidian-agents-rich-${idx++}`;
    let data: unknown = null;
    try {
      data = JSON.parse(body);
    } catch {
      data = { __error: "Invalid JSON", raw: body.trim() };
    }
    layouts.push({ placeholder: id, kind: kind as RichLayoutKind, data });
    return `\n\n<div data-obsidian-agents-rich="${id}"></div>\n\n`;
  });
  return { content: out, layouts };
}

// --- Shared helpers: link safety + sources footer + link overlay ---------

/**
 * Accept only http(s) and mailto URLs. Anything else (javascript:, data:,
 * file:) is dropped — this is user-facing content coming from an LLM so we
 * don't want to blindly trust the scheme.
 */
function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return trimmed;
  }
  return null;
}

function hostnameOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Small "↗" link-out badge placed on top-right of image tiles. When the
 * user clicks it, the image opens in a new tab instead of the lightbox.
 * The underlying image click still opens the lightbox — the badge is an
 * explicit, separate affordance so both behaviors coexist.
 */
function mountLinkBadge(host: HTMLElement, href: string): void {
  const badge = host.createEl("a", { cls: "obsidian-agents-rich-link-badge" });
  badge.href = href;
  badge.target = "_blank";
  badge.rel = "noopener noreferrer";
  badge.setAttribute("aria-label", `Open ${hostnameOf(href) || "link"} in a new tab`);
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>';
  badge.addEventListener("click", (e) => {
    // Prevent the click from also triggering the image lightbox underneath.
    e.stopPropagation();
  });
}

function renderSourcesFooter(host: HTMLElement, sources: LayoutSource[] | undefined): void {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const footer = host.createDiv({ cls: "obsidian-agents-rich-sources" });
  footer.createSpan({ cls: "obsidian-agents-rich-sources-label", text: "Sources" });
  sources.forEach((s, i) => {
    const href = safeHref(s?.href);
    if (!href) return;
    const link = footer.createEl("a", { cls: "obsidian-agents-rich-source" });
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.createSpan({ cls: "obsidian-agents-rich-source-num", text: `${i + 1}` });
    link.createSpan({ cls: "obsidian-agents-rich-source-label", text: s.label || hostnameOf(href) });
    const site = s.site || hostnameOf(href);
    if (site) {
      link.createSpan({ cls: "obsidian-agents-rich-source-site", text: site });
    }
  });
}

// --- Lightbox (gallery + carousel share it) -------------------------------

interface LightboxItem {
  src: string;
  caption?: string;
}

function openLightboxGallery(items: LightboxItem[], startIndex: number): void {
  const overlay = document.body.createDiv({ cls: "obsidian-agents-lightbox" });
  overlay.setAttribute("role", "dialog");

  const counter = overlay.createDiv({ cls: "obsidian-agents-rich-lightbox-counter" });
  const img = overlay.createEl("img", { cls: "obsidian-agents-lightbox-img" });
  const caption = overlay.createDiv({ cls: "obsidian-agents-rich-lightbox-caption" });

  let i = Math.max(0, Math.min(startIndex, items.length - 1));

  const show = () => {
    img.src = items[i].src;
    img.alt = items[i].caption || "";
    caption.setText(items[i].caption || "");
    counter.setText(`${i + 1} / ${items.length}`);
  };

  const next = () => {
    i = (i + 1) % items.length;
    show();
  };
  const prev = () => {
    i = (i - 1 + items.length) % items.length;
    show();
  };

  if (items.length > 1) {
    const prevBtn = overlay.createEl("button", {
      cls: "obsidian-agents-rich-lightbox-arrow obsidian-agents-rich-lightbox-prev",
      attr: { "aria-label": "Previous" },
    });
    prevBtn.innerHTML = "‹";
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      prev();
    });
    const nextBtn = overlay.createEl("button", {
      cls: "obsidian-agents-rich-lightbox-arrow obsidian-agents-rich-lightbox-next",
      attr: { "aria-label": "Next" },
    });
    nextBtn.innerHTML = "›";
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      next();
    });
  }

  const close = overlay.createEl("button", {
    cls: "obsidian-agents-lightbox-close",
    attr: { "aria-label": "Close" },
  });
  close.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  const dismiss = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
    else if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") prev();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
  close.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey);

  show();
}

// --- Renderers ------------------------------------------------------------

function renderGallery(host: HTMLElement, spec: GallerySpec): void {
  const items = Array.isArray(spec?.items) ? spec.items : [];
  if (items.length === 0) return;

  host.addClass("obsidian-agents-rich-gallery");
  const columns = Math.max(1, Math.min(4, Number(spec.columns) || Math.min(items.length, 3)));
  host.style.setProperty("--obsidian-agents-gallery-columns", String(columns));

  const lightboxItems: LightboxItem[] = items.map((it) => ({
    src: it.src,
    caption: it.caption || it.alt,
  }));

  items.forEach((item, idx) => {
    const cell = host.createDiv({ cls: "obsidian-agents-rich-gallery-cell" });
    const img = cell.createEl("img", { cls: "obsidian-agents-rich-gallery-img" });
    img.src = item.src;
    img.alt = item.alt || "";
    img.loading = "lazy";
    img.addEventListener("click", () => openLightboxGallery(lightboxItems, idx));
    if (item.caption) {
      cell.createDiv({ cls: "obsidian-agents-rich-gallery-caption", text: item.caption });
    }

    const linkHref = safeHref(item.href);
    if (linkHref) mountLinkBadge(cell, linkHref);

    // Show a "+N" badge on the last tile if more items exist than the first row.
    if (idx === columns - 1 && items.length > columns) {
      const badge = cell.createDiv({ cls: "obsidian-agents-rich-gallery-badge" });
      badge.setText(`+${items.length - columns}`);
    }
  });

  renderSourcesFooter(host, spec.sources);
}

function renderCarousel(host: HTMLElement, spec: CarouselSpec): void {
  const items = Array.isArray(spec?.items) ? spec.items : [];
  if (items.length === 0) return;

  host.addClass("obsidian-agents-rich-carousel");
  if (spec.height) {
    host.style.setProperty("--obsidian-agents-carousel-height", spec.height);
  }

  const track = host.createDiv({ cls: "obsidian-agents-rich-carousel-track" });
  const lightboxItems: LightboxItem[] = items.map((it) => ({
    src: it.src,
    caption: it.caption || it.alt,
  }));

  items.forEach((item, idx) => {
    const slide = track.createDiv({ cls: "obsidian-agents-rich-carousel-slide" });
    const img = slide.createEl("img", { cls: "obsidian-agents-rich-carousel-img" });
    img.src = item.src;
    img.alt = item.alt || "";
    img.loading = "lazy";
    img.addEventListener("click", () => openLightboxGallery(lightboxItems, idx));
    if (item.caption) {
      slide.createDiv({ cls: "obsidian-agents-rich-carousel-caption", text: item.caption });
    }
    const linkHref = safeHref(item.href);
    if (linkHref) mountLinkBadge(slide, linkHref);
  });

  const counter = host.createDiv({ cls: "obsidian-agents-rich-carousel-counter" });
  counter.setText(`${items.length}`);

  if (items.length > 1) {
    const mkArrow = (dir: "prev" | "next", symbol: string) => {
      const btn = host.createEl("button", {
        cls: `obsidian-agents-rich-carousel-arrow obsidian-agents-rich-carousel-${dir}`,
        attr: { "aria-label": dir === "prev" ? "Previous" : "Next" },
      });
      btn.innerHTML = symbol;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const slide = track.querySelector<HTMLElement>(".obsidian-agents-rich-carousel-slide");
        const w = slide ? slide.offsetWidth + 12 : 300;
        track.scrollBy({ left: dir === "next" ? w : -w, behavior: "smooth" });
      });
    };
    mkArrow("prev", "‹");
    mkArrow("next", "›");
  }

  renderSourcesFooter(host, spec.sources);
}

function renderHero(host: HTMLElement, spec: HeroSpec): void {
  if (!spec?.primary?.src) return;
  host.addClass("obsidian-agents-rich-hero");

  const secondary = Array.isArray(spec.secondary) ? spec.secondary : [];
  const allItems: LightboxItem[] = [
    { src: spec.primary.src, caption: spec.primary.alt },
    ...secondary.map((s) => ({ src: s.src, caption: s.alt })),
  ];

  const primaryCell = host.createDiv({ cls: "obsidian-agents-rich-hero-primary" });
  const primaryImg = primaryCell.createEl("img", { cls: "obsidian-agents-rich-hero-primary-img" });
  primaryImg.src = spec.primary.src;
  primaryImg.alt = spec.primary.alt || "";
  primaryImg.loading = "lazy";
  primaryImg.addEventListener("click", () => openLightboxGallery(allItems, 0));
  const primaryHref = safeHref(spec.primary.href);
  if (primaryHref) mountLinkBadge(primaryCell, primaryHref);

  if (secondary.length > 0) {
    const stack = host.createDiv({ cls: "obsidian-agents-rich-hero-stack" });
    // Up to 2 visible tiles; rest collapses into a "+N" overlay on the last.
    const visible = secondary.slice(0, 2);
    const extra = secondary.length - visible.length;

    visible.forEach((item, idx) => {
      const cell = stack.createDiv({ cls: "obsidian-agents-rich-hero-secondary" });
      const img = cell.createEl("img", { cls: "obsidian-agents-rich-hero-secondary-img" });
      img.src = item.src;
      img.alt = item.alt || "";
      img.loading = "lazy";
      img.addEventListener("click", () => openLightboxGallery(allItems, idx + 1));

      const itemHref = safeHref(item.href);
      if (itemHref) mountLinkBadge(cell, itemHref);

      if (idx === visible.length - 1 && (extra > 0 || secondary.length >= 2)) {
        const total = 1 + secondary.length;
        const badge = cell.createDiv({ cls: "obsidian-agents-rich-hero-badge" });
        badge.setText(String(total));
      }
    });
  }

  renderSourcesFooter(host, spec.sources);
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readThemeVars(): Record<string, string> {
  const keys = [
    "background-primary",
    "background-secondary",
    "background-modifier-border",
    "text-normal",
    "text-muted",
    "interactive-accent",
  ];
  const out: Record<string, string> = {};
  const cs = getComputedStyle(document.body);
  for (const k of keys) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v) out[k] = v;
  }
  return out;
}

function renderMap(host: HTMLElement, spec: MapSpec): void {
  const pins = Array.isArray(spec?.pins) ? spec.pins : [];
  if (pins.length === 0) return;

  host.addClass("obsidian-agents-rich-map");

  // Figure out center.
  let center = spec.center;
  if (!center) {
    const latSum = pins.reduce((a, p) => a + Number(p.lat || 0), 0);
    const lngSum = pins.reduce((a, p) => a + Number(p.lng || 0), 0);
    center = { lat: latSum / pins.length, lng: lngSum / pins.length };
  }
  const zoom = Math.max(1, Math.min(18, Number(spec.zoom) || 12));
  const height = spec.height || "320px";

  const theme = readThemeVars();
  const pinsJson = JSON.stringify(pins);
  const centerJson = JSON.stringify(center);

  // We use CARTO's free tile service instead of OpenStreetMap directly.
  // OSM's tile usage policy requires a `Referer` header on every request,
  // but `srcdoc` iframes have an opaque `about:srcdoc` origin and send no
  // referer, so OSM returns HTTP 403 "Access blocked". CARTO explicitly
  // allows embedded use with no referer and serves the same OpenStreetMap
  // data, rendered with a minimalist "Voyager" style.
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: transparent; overflow: hidden; }
  #map { position: absolute; inset: 0; width: 100%; height: 100%; background: #e6e6e6; }
  body { font-family: ${theme["font-interface"] || "system-ui, sans-serif"}; }
  .rating-pin {
    background: ${theme["background-primary"] || "#1e1e1e"};
    color: ${theme["text-normal"] || "#eee"};
    border: 1px solid ${theme["background-modifier-border"] || "rgba(255,255,255,0.15)"};
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .rating-pin .star { color: #f5c518; }
  .leaflet-popup-content-wrapper {
    background: ${theme["background-primary"] || "#1e1e1e"};
    color: ${theme["text-normal"] || "#eee"};
  }
  .leaflet-popup-tip { background: ${theme["background-primary"] || "#1e1e1e"}; }
</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  const center = ${centerJson};
  const pins = ${pinsJson};
  const initialZoom = ${zoom};

  let map = null;
  let tileLayer = null;
  let attempts = 0;
  // Known working state: center+zoom we last committed to the map, used to
  // force a full tile re-request on resize (redraw() alone doesn't always
  // request tiles that were skipped because the viewport had zero size).
  let committedCenter = null;
  let committedZoom = null;

  function ready() {
    const el = document.getElementById('map');
    return !!el && el.clientWidth > 0 && el.clientHeight > 0;
  }

  function refresh() {
    if (!map) return;
    map.invalidateSize(true);
    // Nudge the view to itself — this is the strongest way to force a
    // full tile re-request when some tiles in the grid never loaded.
    // Plain redraw() only repaints *already loaded* tiles; setView with
    // { animate: false } makes Leaflet recalculate the tile grid.
    if (committedCenter !== null && committedZoom !== null) {
      map.setView(committedCenter, committedZoom, { animate: false, reset: true });
    }
    if (tileLayer && typeof tileLayer.redraw === 'function') {
      tileLayer.redraw();
    }
  }

  function init() {
    if (!ready()) {
      // Wait for layout to settle (iframe sizing races the initial render).
      // Cap the retry loop so a genuinely broken embed doesn't spin forever.
      if (attempts++ < 120) {
        requestAnimationFrame(init);
      }
      return;
    }

    map = L.map('map', {
      zoomControl: true,
      attributionControl: false,
      preferCanvas: false,
    }).setView([center.lat, center.lng], initialZoom);

    // Single hostname — subdomain sharding (a/b/c/d.basemaps.cartocdn.com)
    // causes a specific failure mode where *some* subdomains return tiles
    // and others don't, producing a gray checkerboard. Pinning to the
    // canonical hostname avoids that entirely.
    tileLayer = L.tileLayer(
      'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      {
        maxZoom: 19,
        crossOrigin: true,
      }
    ).addTo(map);

    const bounds = [];
    pins.forEach((p) => {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
      const html = p.rating != null
        ? '<span class="star">★</span> ' + p.rating
        : (p.label || '');
      const icon = L.divIcon({
        className: '',
        html: '<div class="rating-pin">' + html + '</div>',
        iconSize: null,
      });
      const m = L.marker([p.lat, p.lng], { icon }).addTo(map);
      if (p.label || p.body || p.href) {
        let popup = '<strong>' + (p.label || '') + '</strong>';
        if (p.body) popup += '<br/>' + p.body;
        if (typeof p.href === 'string' && /^https?:\\/\\//i.test(p.href)) {
          popup += '<br/><a href="' + p.href + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;color:inherit;text-decoration:underline;">Visit &#8599;</a>';
        }
        m.bindPopup(popup);
      }
      bounds.push([p.lat, p.lng]);
    });

    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: initialZoom });
    }

    // Remember whatever view the map actually landed on so subsequent
    // refresh() calls can re-commit it and force a full tile re-request.
    committedCenter = map.getCenter();
    committedZoom = map.getZoom();

    // Staggered refreshes catch late reflows (font loading, iframe
    // resizing as the parent column settles, split-layout grid laying out).
    // Each call triggers both invalidateSize (recomputes tile grid) and
    // tileLayer.redraw (re-requests any tiles skipped at init time).
    requestAnimationFrame(refresh);
    setTimeout(refresh, 120);
    setTimeout(refresh, 400);
    setTimeout(refresh, 1000);
    setTimeout(refresh, 2000);

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(refresh);
      ro.observe(document.getElementById('map'));
    }
    window.addEventListener('resize', refresh);
    // Some browsers fire a late 'load' when remote scripts/styles fully
    // settle — grab that opportunity too.
    window.addEventListener('load', refresh);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
</body></html>`;

  const iframe = host.createEl("iframe", { cls: "obsidian-agents-rich-map-frame" });
  iframe.srcdoc = srcdoc;
  iframe.style.width = "100%";
  iframe.style.height = height;
  iframe.style.border = "none";
  iframe.style.borderRadius = "12px";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.setAttribute(
    "referrerpolicy",
    "no-referrer-when-downgrade"
  );
  void escapeAttr; // reserved for future use

  renderSourcesFooter(host, spec.sources);
}

function renderCardList(host: HTMLElement, spec: CardListSpec): void {
  const items = Array.isArray(spec?.items) ? spec.items : [];
  if (items.length === 0) return;

  host.addClass("obsidian-agents-rich-card-list");

  for (const item of items) {
    const card = host.createDiv({ cls: "obsidian-agents-rich-card" });

    if (item.thumbnail) {
      const thumb = card.createDiv({ cls: "obsidian-agents-rich-card-thumb" });
      const img = thumb.createEl("img");
      img.src = item.thumbnail;
      img.alt = item.title || "";
      img.loading = "lazy";
    }

    const body = card.createDiv({ cls: "obsidian-agents-rich-card-body" });
    const titleHref = safeHref(item.href);
    if (titleHref) {
      const titleLink = body.createEl("a", { cls: "obsidian-agents-rich-card-title obsidian-agents-rich-card-title-link" });
      titleLink.href = titleHref;
      titleLink.target = "_blank";
      titleLink.rel = "noopener noreferrer";
      titleLink.setText(item.title || "");
    } else {
      body.createDiv({ cls: "obsidian-agents-rich-card-title", text: item.title || "" });
    }

    const parts: string[] = [];
    if (item.rating != null) parts.push(`★ ${item.rating}`);
    if (item.category) parts.push(item.category);
    if (parts.length > 0 || item.status) {
      const meta = body.createDiv({ cls: "obsidian-agents-rich-card-meta" });
      if (parts.length > 0) {
        meta.createSpan({ text: parts.join(" • ") });
      }
      if (item.status) {
        if (parts.length > 0) meta.createSpan({ text: " • " });
        const statusLower = item.status.toLowerCase();
        const statusCls =
          statusLower === "open"
            ? "obsidian-agents-rich-card-status-open"
            : statusLower === "closed"
            ? "obsidian-agents-rich-card-status-closed"
            : "obsidian-agents-rich-card-status-neutral";
        meta.createSpan({ cls: statusCls, text: item.status });
      }
    }

    if (item.body) {
      body.createDiv({ cls: "obsidian-agents-rich-card-description", text: item.body });
    }

    if (Array.isArray(item.links) && item.links.length > 0) {
      const linksRow = body.createDiv({ cls: "obsidian-agents-rich-card-links" });
      for (const l of item.links) {
        const href = safeHref(l?.href);
        if (!href) continue;
        const a = linksRow.createEl("a", { cls: "obsidian-agents-rich-card-link" });
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.setText(l.label || hostnameOf(href));
      }
    }
  }

  renderSourcesFooter(host, spec.sources);
}

// --- Split (visual + text side-by-side) ---------------------------------

interface SplitRenderContext {
  app?: any;
  component?: Component;
  sourcePath?: string;
}

function buildAppletSrcdoc(
  language: "html" | "react",
  code: string,
  themeVars: Record<string, string>
): string {
  const varDecls = Object.entries(themeVars)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");
  const baseStyles = `
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--text-normal);
      font-family: var(--font-interface);
      font-size: 14px;
      line-height: 1.5;
    }
    body { padding: 10px 12px; }
    :root {
${varDecls}
    }
  `;
  if (language === "react") {
    return `<!doctype html><html><head><meta charset="utf-8">
<style>${baseStyles}</style></head><body><div id="root"></div>
<script type="module">
import React from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";
${code}
</script></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${baseStyles}</style></head><body>${code}</body></html>`;
}

function renderSplitVisual(host: HTMLElement, visual: SplitVisual): void {
  if (visual.kind === "image") {
    const cell = host.createDiv({ cls: "obsidian-agents-rich-split-image" });
    const img = cell.createEl("img", { cls: "obsidian-agents-rich-split-image-img" });
    img.src = visual.src;
    img.alt = visual.alt || "";
    img.loading = "lazy";
    img.addEventListener("click", () =>
      openLightboxGallery([{ src: visual.src, caption: visual.caption || visual.alt }], 0)
    );
    if (visual.caption) {
      cell.createDiv({ cls: "obsidian-agents-rich-split-image-caption", text: visual.caption });
    }
    const linkHref = safeHref(visual.href);
    if (linkHref) mountLinkBadge(cell, linkHref);
    return;
  }

  if (visual.kind === "gallery") {
    // Reuse gallery renderer; it owns its own grid + lightbox.
    renderGallery(host, {
      columns: visual.columns,
      items: visual.items,
    });
    return;
  }

  if (visual.kind === "applet") {
    const themeVars: Record<string, string> = {};
    const cs = getComputedStyle(host);
    for (const k of [
      "background-primary",
      "background-secondary",
      "background-modifier-border",
      "text-normal",
      "text-muted",
      "interactive-accent",
      "interactive-accent-hover",
      "text-on-accent",
      "font-interface",
      "font-monospace",
    ]) {
      const v = cs.getPropertyValue(`--${k}`).trim();
      if (v) themeVars[k] = v;
    }
    const srcdoc = buildAppletSrcdoc(visual.language, visual.code, themeVars);
    const iframe = host.createEl("iframe", { cls: "obsidian-agents-rich-split-applet" });
    iframe.srcdoc = srcdoc;
    iframe.style.width = "100%";
    iframe.style.border = "none";
    iframe.style.background = "transparent";
    iframe.style.borderRadius = "10px";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");

    if (visual.height) {
      iframe.style.height = visual.height;
    } else {
      iframe.style.height = "240px";
      // Auto-fit to content, same pattern as the main applet frame.
      iframe.addEventListener("load", () => {
        const fit = () => {
          try {
            const doc = iframe.contentDocument;
            if (!doc) return;
            doc.documentElement.style.height = "auto";
            doc.body.style.height = "auto";
            const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
            if (h > 0) iframe.style.height = `${h}px`;
          } catch {
            /* cross-origin, ignore */
          }
        };
        fit();
        setTimeout(fit, 120);
        setTimeout(fit, 400);
      });
    }
    return;
  }
}

function renderSplit(host: HTMLElement, spec: SplitSpec, ctx: SplitRenderContext): void {
  if (!spec || !spec.visual || typeof spec.text !== "string") return;

  const side: "left" | "right" = spec.side === "left" ? "left" : "right";
  host.addClass("obsidian-agents-rich-split");
  host.addClass(`obsidian-agents-rich-split-${side}`);

  // Grid template: visual-first or text-first depending on side.
  // Default 1fr : 1.4fr favoring text (more readable paragraphs).
  let ratio = spec.ratio;
  if (!ratio) {
    // Support legacy `width` on the visual column.
    if (spec.width) {
      ratio = side === "left" ? `${spec.width} 1fr` : `1fr ${spec.width}`;
    } else {
      ratio = side === "left" ? "1fr 1.4fr" : "1.4fr 1fr";
    }
  }
  host.style.gridTemplateColumns = ratio;

  const visualCell = document.createElement("div");
  visualCell.className = "obsidian-agents-rich-split-visual";
  renderSplitVisual(visualCell, spec.visual);

  const textCell = document.createElement("div");
  textCell.className = "obsidian-agents-rich-split-text markdown-rendered";
  if (ctx.app && ctx.component) {
    MarkdownRenderer.render(
      ctx.app,
      spec.text,
      textCell,
      ctx.sourcePath || "",
      ctx.component
    ).catch(() => {
      textCell.setText(spec.text);
    });
  } else {
    textCell.setText(spec.text);
  }

  // DOM order follows `side`: visual first when side === "left".
  if (side === "left") {
    host.appendChild(visualCell);
    host.appendChild(textCell);
  } else {
    host.appendChild(textCell);
    host.appendChild(visualCell);
  }

  if (Array.isArray(spec.sources) && spec.sources.length > 0) {
    const footerHost = document.createElement("div");
    footerHost.className = "obsidian-agents-rich-split-sources";
    renderSourcesFooter(footerHost, spec.sources);
    host.appendChild(footerHost);
  }
}

// --- Terms registry block -----------------------------------------------

/**
 * `obsidian-agents-terms` blocks are *silent by default*: they register their
 * term definitions into a global map and emit no visible UI. The inline
 * `[[Label]]{#slug}` markers in the surrounding prose become clickable
 * pills that dispatch an `obsidian-agents:open-term` event the ChatView
 * listens for — the ChatView then slides in a detail panel.
 */
function renderTerms(host: HTMLElement, spec: TermsSpec): void {
  const terms = Array.isArray(spec?.terms) ? spec.terms : [];
  if (terms.length === 0) return;

  for (const def of terms) {
    if (def && typeof def.id === "string" && def.id) {
      registerTerm(def);
    }
  }

  // Hide the block entirely — it has no visible content of its own.
  host.addClass("obsidian-agents-rich-terms-registry");
  host.style.display = "none";
}

/**
 * Walk the rendered markdown DOM and convert term markers into clickable
 * pills that open the TermPanel. Supports three author styles, in order
 * of preference:
 *
 *   1. `[[Label]]{#slug}`             — dedicated syntax, simplest.
 *   2. `[Label](...){#slug}`          — normal markdown link + slug tag.
 *      The markdown renderer has already turned this into `<a>…</a>{#slug}`,
 *      so we look for `{#slug}` text nodes that immediately follow an `<a>`
 *      and convert the `<a>` into a pill.
 *   3. `Label{#slug}`                 — bare word / phrase with slug tag.
 *
 * In every case the trailing `{#slug}` marker itself is removed. Runs
 * after `MarkdownRenderer.render` so it only touches the visible prose —
 * JSON inside layout blocks is safe because those blocks are already
 * lifted out as placeholders before markdown processing.
 *
 * The dispatched `obsidian-agents:open-term` event bubbles to the ChatView,
 * which routes it into the TermPanel.
 */
const BRACKET_TERM_RE = /\[\[([^\]]+?)\]\]\{#([a-z0-9][a-z0-9_-]*)\}/gi;
const TRAILING_SLUG_RE = /^\s*\{#([a-z0-9][a-z0-9_-]*)\}/i;
const BARE_TERM_RE = /([A-Za-z0-9][\w'’.\- ]{0,80}?)\{#([a-z0-9][a-z0-9_-]*)\}/g;

function buildTermPill(label: string, id: string): HTMLAnchorElement {
  const pill = document.createElement("a");
  pill.className = "obsidian-agents-term-pill";
  pill.setAttribute("data-term-id", id.toLowerCase());
  pill.href = "#";
  pill.textContent = label;
  pill.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const detail = { id: id.toLowerCase(), anchor: pill };
    pill.dispatchEvent(
      new CustomEvent("obsidian-agents:open-term", {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  });
  return pill;
}

/**
 * Promote an existing `<a>` element into a term pill. Keeps the link's
 * text but swaps its click handler for the term-opener.
 */
function promoteAnchorToTermPill(anchor: HTMLAnchorElement, id: string): void {
  const label = anchor.textContent || "";
  const pill = buildTermPill(label, id);
  anchor.replaceWith(pill);
}

export function activateTermLinks(root: HTMLElement): void {
  if (!root) return;

  // Pass 1: `[[Label]]{#slug}` in text nodes.
  replaceInTextNodes(root, BRACKET_TERM_RE, (m) => {
    const [, label, id] = m;
    return buildTermPill(label, id);
  });

  // Pass 2: `<a>...</a>{#slug}` — find text nodes starting with `{#slug}`
  // whose immediately previous sibling is an `<a>`. Convert that anchor
  // into a pill and strip the marker text.
  //
  // We also handle the case where the `{#slug}` appears *inside* the
  // same parent but with some inline whitespace — common in Obsidian's
  // markdown pipeline.
  const candidates: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const t = node.nodeValue || "";
      return TRAILING_SLUG_RE.test(t)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) candidates.push(n as Text);

  for (const text of candidates) {
    const raw = text.nodeValue || "";
    const m = raw.match(TRAILING_SLUG_RE);
    if (!m) continue;
    const id = m[1];
    // Look left for an <a> sibling.
    const prev = text.previousSibling;
    if (prev && prev.nodeType === 1 && (prev as Element).tagName === "A") {
      promoteAnchorToTermPill(prev as HTMLAnchorElement, id);
      text.nodeValue = raw.slice(m[0].length); // strip `{#slug}`
    }
  }

  // Pass 3: bare `Label{#slug}` still in text nodes (no surrounding
  // markdown link, no `[[...]]`). Runs last so it doesn't clobber the
  // previous passes.
  replaceInTextNodes(root, BARE_TERM_RE, (m) => {
    const [, label, id] = m;
    return buildTermPill(label.trim(), id);
  });
}

/**
 * Generic helper: walk text nodes under `root` and replace regex
 * matches with the element returned by `makeReplacement`. Preserves
 * surrounding text. Used by passes 1 and 3 of activateTermLinks.
 */
function replaceInTextNodes(
  root: HTMLElement,
  re: RegExp,
  makeReplacement: (m: RegExpExecArray) => Node
): void {
  const targets: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const t = node.nodeValue || "";
      // Reset regex state before .test() — global regexes are stateful.
      re.lastIndex = 0;
      return re.test(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  for (const text of targets) {
    // Skip nodes that sit inside existing term pills to avoid double work.
    if (text.parentElement?.closest(".obsidian-agents-term-pill")) continue;

    const raw = text.nodeValue || "";
    const frag = document.createDocumentFragment();
    let last = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      }
      frag.appendChild(makeReplacement(m));
      last = m.index + m[0].length;
    }
    if (last === 0) continue; // nothing matched
    if (last < raw.length) {
      frag.appendChild(document.createTextNode(raw.slice(last)));
    }
    text.replaceWith(frag);
  }
}

// --- Public mount ---------------------------------------------------------

export interface MountContext {
  app?: any;
  component?: Component;
  sourcePath?: string;
}

export function mountRichLayout(
  placeholder: HTMLElement,
  layout: ParsedRichLayout,
  ctx: MountContext = {}
): void {
  const wrap = document.createElement("div");
  wrap.className = "obsidian-agents-rich-layout obsidian-agents-layout-block obsidian-agents-layout-below";

  const data = layout.data as Record<string, unknown> | null;

  if (data && typeof data === "object" && "__error" in (data as object)) {
    const err = wrap.createDiv({ cls: "obsidian-agents-rich-error" });
    err.setText(`Invalid ${layout.kind} JSON`);
    const pre = wrap.createEl("pre");
    pre.setText(String((data as any).raw || ""));
    placeholder.replaceWith(wrap);
    return;
  }

  try {
    switch (layout.kind) {
      case "gallery":
        renderGallery(wrap, (data || {}) as unknown as GallerySpec);
        break;
      case "carousel":
        renderCarousel(wrap, (data || {}) as unknown as CarouselSpec);
        break;
      case "hero":
        renderHero(wrap, (data || {}) as unknown as HeroSpec);
        break;
      case "map":
        renderMap(wrap, (data || {}) as unknown as MapSpec);
        break;
      case "card-list":
        renderCardList(wrap, (data || {}) as unknown as CardListSpec);
        break;
      case "split":
        renderSplit(wrap, (data || {}) as unknown as SplitSpec, ctx);
        break;
      case "terms":
        renderTerms(wrap, (data || {}) as unknown as TermsSpec);
        break;
    }
  } catch (e) {
    const err = wrap.createDiv({ cls: "obsidian-agents-rich-error" });
    err.setText(`Failed to render ${layout.kind}: ${(e as Error).message}`);
  }

  placeholder.replaceWith(wrap);
}
