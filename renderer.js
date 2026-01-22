// renderer.js

// ---------- Shortcuts ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

 // --- Time helpers for clips ---
 function clipInOutMs(c) {
   const start = Number(c.start ?? c.t ?? 0);
   const dur   = Number(c.duration ?? c.len ?? c.dur ?? 0);
   return [start, start + dur];
 }

 // --- Show/hide all text nodes based on current time ---
 function updateTextVisibility(t) {
   const arr = PROJECT.text || [];
   for (const tx of arr) {
     // find or reuse stage element
     let el = tx._el || document.querySelector(`.stage-text[data-id="${tx.id}"]`);
     if (!el) continue;
     const [tin, tout] = clipInOutMs(tx);
     const on = t >= tin && t < tout;
     if (on !== (!!el._on)) {
       el.style.display = on ? 'inline-flex' : 'none';
       el._on = on;
     }
   }
 }

 // ---------- Autosave helpers ----------
 const AUTOSAVE_MS = 5000; // 5s interval
 function serializeProject() {
  return {
    version: 1,
    pxPerSecond,              // timeline zoom
    duration: PROJECT.duration,
    items: PROJECT.items || [],
    audio: PROJECT.audio || [],
    bg: PROJECT.bg || null,
    timelineLabels: PROJECT.timelineLabels || [],
    paths: PATHS || null,     // asset lists to rehydrate palette
    stage: { width: 1280, height: 720 }, // for future proofing
    trackHeights: ensureTrackHeights()
  };
}

 async function restoreFromBackupIfAny() { return; }

 // Start autosave timer and beforeunload hook
 function startAutosaveLoop() {
   setInterval(() => {
     try { window.autosave.write(serializeProject()); } catch {}
   }, AUTOSAVE_MS);
   window.addEventListener('beforeunload', () => {
     try { window.autosave.write(serializeProject()); } catch {}
   });
 }

 // Clear backup after explicit save/export/open to avoid stale prompts
 function wireBackupClearers() {
   const clear = () => window.autosave.clear().catch(()=>{});
   $('#btn-save-project') && $('#btn-save-project').addEventListener('click', clear);
   $('#btn-export-project') && $('#btn-export-project').addEventListener('click', clear);
   $('#btn-open-project') && $('#btn-open-project').addEventListener('click', clear);
 }

 // Boot sequence
  (async () => {
   startAutosaveLoop();
   wireBackupClearers();
 })();

// ---------- Timeline layout (match CSS) ----------
let pxPerSecond = 10;          // zoomable elsewhere
const labelWidth = 220;        // .track-label width
const trackGap   = 10;         // .track { gap: 10px; }
const tracksPad  = 12;         // #tracks { padding-left: 12px; }
const SNAP_PX    = 8;          // pixel snap
const TIMELINE_MIN_MS = 3000;  // ms; short by default; grows/shrinks with content
const TIMELINE_DEFAULT_VIEW_MS = 480_000; // default ~8 min viewport for usable scroll room
const TIMELINE_MAX_MS = 10 * 60 * 60 * 1000; // 10 hours cap to avoid absurd widths
const TIMELINE_AUTO_EXTEND_THRESHOLD_PX = 120;
const TIMELINE_AUTO_EXTEND_MIN_STEP_MS = 15_000;
let timelineViewMs = TIMELINE_MIN_MS;

// LANE HEIGHTS: keep audio tall, others original size
const LANE_HEIGHT_VISUAL = 32;
const LANE_HEIGHT_BG     = 32;
const LANE_MIN_DEFAULT   = 24;   // px
const LANE_MIN_AUDIO     = 110;  // px
const LANE_MIN_TEXT      = 32;   // px
const LANE_MIN_BG        = 32;   // px
const LANE_MAX           = 200;  // px
const LANE_HEIGHT_AUDIO  = 110;
const STAGE_WIDTH        = 1280;
const STAGE_HEIGHT       = 720;
const STAGE_SCALE_MIN    = 0.1;
const STAGE_SCALE_MAX    = 10;
const STAGE_SCALE_EPS    = 0.0001;
const STAGE_ROTATION_MIN = -3600;
const STAGE_ROTATION_MAX = 3600;
const STAGE_ROTATION_EPS = 0.1;
const STAGE_ROTATE_HANDLE_POSITIONS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

const DEFAULT_FX = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  blur: 0,
  sharpen: 0,
  temperature: 0,
  tint: 0
});

const DEFAULT_CHROMA_KEY = Object.freeze({
  enabled: false,
  color: '#00ff00',
  intensity: 0.35
});

function defaultChromaKeySettings() {
  return {
    enabled: false,
    color: '#00ff00',
    intensity: 0.35
  };
}

function hydrateChromaKey(target) {
  if (!target) return defaultChromaKeySettings();
  const base = target.chromaKey;
  if (!base || typeof base !== 'object') {
    target.chromaKey = defaultChromaKeySettings();
  } else {
    const settings = target.chromaKey;
    settings.enabled = !!settings.enabled;
    settings.color = normalizeHexColor(settings.color) || DEFAULT_CHROMA_KEY.color;
    const intensity = Number(settings.intensity);
    settings.intensity = Number.isFinite(intensity) ? clamp01(intensity) : DEFAULT_CHROMA_KEY.intensity;
    target.chromaKey = settings;
  }
  return target.chromaKey;
}

function cloneChromaKey(cfg) {
  if (!cfg || typeof cfg !== 'object') return defaultChromaKeySettings();
  return {
    enabled: !!cfg.enabled,
    color: normalizeHexColor(cfg.color) || DEFAULT_CHROMA_KEY.color,
    intensity: clamp01(Number(cfg.intensity) || 0)
  };
}

function chromaKeyEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    !!a.enabled === !!b.enabled &&
    normalizeHexColor(a.color) === normalizeHexColor(b.color) &&
    Math.abs((Number(a.intensity) || 0) - (Number(b.intensity) || 0)) < 0.0001
  );
}

function chromaKeyIsActive(cfg) {
  if (!cfg) return false;
  return !!cfg.enabled && normalizeHexColor(cfg.color) && (Number(cfg.intensity) || 0) > 0.0001;
}

function chromaKeyHash(cfg) {
  if (!cfg) return '';
  const color = normalizeHexColor(cfg.color) || 'none';
  const enabled = cfg.enabled ? '1' : '0';
  const intensity = Number.isFinite(cfg.intensity) ? cfg.intensity.toFixed(4) : '0.0000';
  return `${enabled}|${color}|${intensity}`;
}

function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex.split('').map(ch => ch + ch).join('');
  }
  return `#${hex.toLowerCase()}`;
}

function hexToRgb(value) {
  const normalized = normalizeHexColor(value);
  if (!normalized) return null;
  const hex = normalized.slice(1);
  const expanded = hex.length === 3
    ? hex.split('').map(ch => ch + ch).join('')
    : hex;
  const int = parseInt(expanded, 16);
  if (!Number.isFinite(int)) return null;
  return {
    r: (int >> 16) & 0xff,
    g: (int >> 8) & 0xff,
    b: int & 0xff
  };
}

function rgbToHex(r, g, b) {
  const clampChannel = (v) => {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(255, Math.round(v)));
  };
  const rr = clampChannel(r);
  const gg = clampChannel(g);
  const bb = clampChannel(b);
  return `#${((rr << 16) | (gg << 8) | bb).toString(16).padStart(6, '0')}`;
}

function applyChromaKeyToImageData(imageData, cfg) {
  if (!cfg || !chromaKeyIsActive(cfg)) return imageData;
  const rgb = hexToRgb(cfg.color);
  if (!rgb) return imageData;
  const data = imageData?.data;
  if (!data || data.length === 0) return imageData;

  const tolerance = clamp01(cfg.intensity || 0);
  if (tolerance <= 0.0001) return imageData;

  const threshold = Math.max(1, tolerance * 255 * 1.4); // widen removal band
  const softness = Math.max(1, threshold * 0.35);
  const hardCut = Math.max(0, threshold - softness);

  const rKey = rgb.r;
  const gKey = rgb.g;
  const bKey = rgb.b;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 0) continue;

    const dr = r - rKey;
    const dg = g - gKey;
    const db = b - bKey;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distance >= threshold) continue;

    if (distance <= hardCut) {
      data[i + 3] = 0;
      continue;
    }

    const fade = clamp((distance - hardCut) / Math.max(1, softness), 0, 1);
    data[i + 3] = Math.round(a * fade);
  }
  return imageData;
}

function releaseImageBitmap(bitmap) {
  if (!bitmap) return;
  if (typeof bitmap.close === 'function') {
    try { bitmap.close(); } catch {}
  }
}

function invalidateChromaCache(target, { deep = true } = {}) {
  if (!target) return;
  if (target._chromaCanvas instanceof HTMLCanvasElement) {
    target._chromaCanvas.width = target._chromaCanvas.width; // clears
  }
  releaseImageBitmap(target._chromaBitmap);
  delete target._chromaCanvas;
  delete target._chromaBitmap;
  delete target._chromaHash;
  if (deep && target._gif && Array.isArray(target._gif.frames)) {
    for (const frame of target._gif.frames) {
      if (!frame || typeof frame !== 'object') continue;
      if (frame._chromaCanvas instanceof HTMLCanvasElement) {
        frame._chromaCanvas.width = frame._chromaCanvas.width;
      }
      releaseImageBitmap(frame._chromaBitmap);
      delete frame._chromaCanvas;
      delete frame._chromaBitmap;
      delete frame._chromaHash;
    }
  }
}

function drawCheckerboard(ctx, width, height, cellSize = 12, colors = ['#101821', '#0b121a']) {
  if (!ctx) return;
  const [light, dark] = Array.isArray(colors) && colors.length >= 2 ? colors : ['#101821', '#0b121a'];
  ctx.save();
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark;
  const size = Math.max(2, Math.floor(cellSize));
  for (let y = 0; y < height; y += size) {
    const offset = ((y / size) | 0) % 2 === 0 ? 0 : size;
    for (let x = offset; x < width; x += size * 2) {
      ctx.fillRect(x, y, size, size);
    }
  }
  ctx.restore();
}

function isDrawableSource(value) {
  if (!value) return false;
  if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return true;
  if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return true;
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return true;
  if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return true;
  if (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas) return true;
  return false;
}

function defaultFxSettings() {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    blur: 0,
    sharpen: 0,
    temperature: 0,
    tint: 0
  };
}

function hydrateFx(target) {
  if (!target) return defaultFxSettings();
  if (!target.fx || typeof target.fx !== 'object') {
    target.fx = defaultFxSettings();
  } else {
    for (const key of Object.keys(DEFAULT_FX)) {
      const val = target.fx[key];
      if (!Number.isFinite(val)) target.fx[key] = DEFAULT_FX[key];
    }
    // Strip any unexpected props so future serialization stays tight
    Object.keys(target.fx).forEach(k => {
      if (!(k in DEFAULT_FX)) delete target.fx[k];
    });
  }
  return target.fx;
}

function cloneFx(fx) {
  if (!fx || typeof fx !== 'object') return defaultFxSettings();
  const fresh = defaultFxSettings();
  for (const key of Object.keys(DEFAULT_FX)) {
    if (Number.isFinite(fx[key])) fresh[key] = fx[key];
  }
  return fresh;
}

function fxEqual(a, b) {
  if (!a || !b) return false;
  return Object.keys(DEFAULT_FX).every(k => {
    const va = Number.isFinite(a[k]) ? a[k] : 0;
    const vb = Number.isFinite(b[k]) ? b[k] : 0;
    return Math.abs(va - vb) < 0.0001;
  });
}

let FX_SVG_ROOT = null;

function ensureFxSvgRoot() {
  if (FX_SVG_ROOT && FX_SVG_ROOT.isConnected) return FX_SVG_ROOT;
  let svg = document.getElementById('fx-filter-defs');
  if (svg && svg instanceof SVGSVGElement) {
    FX_SVG_ROOT = svg;
    return FX_SVG_ROOT;
  }
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'fx-filter-defs';
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;';
  document.body.appendChild(svg);
  FX_SVG_ROOT = svg;
  return FX_SVG_ROOT;
}

function requiresSvgFilter(fx) {
  if (!fx) return false;
  return (
    Math.abs(fx.sharpen || 0) > 0.001 ||
    Math.abs(fx.temperature || 0) > 0.001 ||
    Math.abs(fx.tint || 0) > 0.001
  );
}

function disposeFxFilter(owner) {
  if (!owner?._fxFilterId) return;
  const node = document.getElementById(owner._fxFilterId);
  if (node && node.parentNode) node.parentNode.removeChild(node);
  owner._fxFilterId = null;
}

function ensureSvgFilter(owner, fx) {
  if (!owner) return null;
  if (!requiresSvgFilter(fx)) {
    disposeFxFilter(owner);
    return null;
  }

  const svg = ensureFxSvgRoot();
  const id = owner._fxFilterId || `fx-${owner.id || uid()}`;
  let filter = document.getElementById(id);
  if (!filter) {
    filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('x', '0%');
    filter.setAttribute('y', '0%');
    filter.setAttribute('width', '100%');
    filter.setAttribute('height', '100%');
    svg.appendChild(filter);
  } else {
    while (filter.firstChild) filter.removeChild(filter.firstChild);
  }
  owner._fxFilterId = id;

  const doc = filter.ownerDocument;
  const create = (name) => doc.createElementNS('http://www.w3.org/2000/svg', name);
  let lastResult = 'SourceGraphic';

  const sharpen = clamp(fx.sharpen || 0, 0, 100) / 100;
  if (sharpen > 0) {
    const center = 1 + sharpen * 4;
    const side = -sharpen;
    const fe = create('feConvolveMatrix');
    fe.setAttribute('in', lastResult);
    fe.setAttribute('order', '3');
    fe.setAttribute('kernelMatrix', `0 ${side} 0 ${side} ${center} ${side} 0 ${side} 0`);
    fe.setAttribute('edgeMode', 'duplicate');
    fe.setAttribute('result', 'fxSharpen');
    filter.appendChild(fe);
    lastResult = 'fxSharpen';
  }

  const needColor = Math.abs(fx.temperature || 0) > 0.001 || Math.abs(fx.tint || 0) > 0.001;
  if (needColor) {
    const temp = clamp(fx.temperature || 0, -100, 100) / 100;
    const tint = clamp(fx.tint || 0, -100, 100) / 100;
    const warm = temp * 0.5;
    const tintMix = tint * 0.5;

    const rSlope = clamp(1 + warm - tintMix * 0.25, 0, 2);
    const gSlope = clamp(1 + tintMix, 0, 2);
    const bSlope = clamp(1 - warm - tintMix * 0.25, 0, 2);

    const fe = create('feComponentTransfer');
    fe.setAttribute('in', lastResult);
    fe.setAttribute('result', 'fxColor');

    const feR = create('feFuncR'); feR.setAttribute('type', 'linear'); feR.setAttribute('slope', rSlope.toFixed(4));
    const feG = create('feFuncG'); feG.setAttribute('type', 'linear'); feG.setAttribute('slope', gSlope.toFixed(4));
    const feB = create('feFuncB'); feB.setAttribute('type', 'linear'); feB.setAttribute('slope', bSlope.toFixed(4));
    const feA = create('feFuncA'); feA.setAttribute('type', 'linear'); feA.setAttribute('slope', '1');

    fe.append(feR, feG, feB, feA);
    filter.appendChild(fe);
    lastResult = 'fxColor';
  }

  // If we added any primitives, ensure final result is exposed
  if (filter.childNodes.length === 0) {
    disposeFxFilter(owner);
    return null;
  }

  return owner._fxFilterId;
}

function buildFxCss(owner) {
  if (!owner) return '';
  const fx = hydrateFx(owner);
  const parts = [];

  const bright = clamp(fx.brightness || 0, -100, 200);
  if (Math.abs(bright) > 0.01) {
    parts.push(`brightness(${(100 + bright) / 100})`);
  }

  const contrast = clamp(fx.contrast || 0, -100, 200);
  if (Math.abs(contrast) > 0.01) {
    parts.push(`contrast(${(100 + contrast) / 100})`);
  }

  const saturation = clamp(fx.saturation || 0, -100, 300);
  if (Math.abs(saturation) > 0.01) {
    parts.push(`saturate(${(100 + saturation) / 100})`);
  }

  const hue = clamp(fx.hue || 0, -180, 180);
  if (Math.abs(hue) > 0.01) {
    parts.push(`hue-rotate(${hue}deg)`);
  }

  const blur = clamp(fx.blur || 0, 0, 40);
  if (blur > 0.01) {
    parts.push(`blur(${blur.toFixed(2)}px)`);
  }

  const filterId = ensureSvgFilter(owner, fx);
  if (filterId) parts.push(`url(#${filterId})`);

  return parts.join(' ');
}

function buildCanvasFxFilter(fx) {
  if (!fx) return '';
  const filters = [];
  const brightness = clamp(fx.brightness || 0, -100, 200);
  if (Math.abs(brightness) > 0.01) {
    filters.push(`brightness(${(100 + brightness) / 100})`);
  }
  const contrast = clamp(fx.contrast || 0, -100, 200);
  if (Math.abs(contrast) > 0.01) {
    filters.push(`contrast(${(100 + contrast) / 100})`);
  }
  const saturation = clamp(fx.saturation || 0, -100, 300);
  if (Math.abs(saturation) > 0.01) {
    filters.push(`saturate(${(100 + saturation) / 100})`);
  }
  const hue = clamp(fx.hue || 0, -180, 180);
  if (Math.abs(hue) > 0.01) {
    filters.push(`hue-rotate(${hue}deg)`);
  }
  const blur = clamp(fx.blur || 0, 0, 40);
  if (blur > 0.01) {
    filters.push(`blur(${blur.toFixed(2)}px)`);
  }
  // Canvas 2D filter does not support custom SVG filters (sharpen/temperature/tint)
  return filters.join(' ');
}

function drawImageWithFx(ctx, image, fx, width, height) {
  if (!ctx || !image) return;
  const filter = buildCanvasFxFilter(fx);
  ctx.save();
  if (filter) ctx.filter = filter;
  ctx.drawImage(image, 0, 0, width, height);
  ctx.restore();

  const needsSharpen = fx && Math.abs(fx.sharpen || 0) > 0.001;
  const needsColor = fx && (Math.abs(fx.temperature || 0) > 0.001 || Math.abs(fx.tint || 0) > 0.001);
  if (!needsSharpen && !needsColor) return;

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch (err) {
    console.warn('drawImageWithFx: getImageData failed', err);
    return;
  }

  if (needsSharpen) {
    applySharpenToImageData(imageData, clamp(fx.sharpen || 0, 0, 100) / 100);
  }
  if (needsColor) {
    applyTemperatureTintToImageData(imageData, fx.temperature || 0, fx.tint || 0);
  }

  ctx.putImageData(imageData, 0, 0);
}

function applyTemperatureTintToImageData(imageData, temperature, tint) {
  if (!imageData) return;
  const data = imageData.data;
  const temp = clamp(temperature || 0, -100, 100) / 100;
  const tintNorm = clamp(tint || 0, -100, 100) / 100;
  const warm = temp * 0.5;
  const tintMix = tintNorm * 0.5;

  const rSlope = clamp(1 + warm - tintMix * 0.25, 0, 2);
  const gSlope = clamp(1 + tintMix, 0, 2);
  const bSlope = clamp(1 - warm - tintMix * 0.25, 0, 2);

  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(clamp(data[i] * rSlope, 0, 255));
    data[i + 1] = Math.round(clamp(data[i + 1] * gSlope, 0, 255));
    data[i + 2] = Math.round(clamp(data[i + 2] * bSlope, 0, 255));
  }
}

function applySharpenToImageData(imageData, amount) {
  if (!imageData || amount <= 0) return;
  const { data, width, height } = imageData;
  const src = new Uint8ClampedArray(data);
  const center = 1 + amount * 4;
  const side = -amount;

  const sample = (x, y, channel) => {
    const clampedX = clamp(Math.round(x), 0, width - 1);
    const clampedY = clamp(Math.round(y), 0, height - 1);
    return src[(clampedY * width + clampedX) * 4 + channel];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const value =
          sample(x, y, c) * center +
          sample(x - 1, y, c) * side +
          sample(x + 1, y, c) * side +
          sample(x, y - 1, c) * side +
          sample(x, y + 1, c) * side;
        data[idx + c] = Math.round(clamp(value, 0, 255));
      }
      data[idx + 3] = src[idx + 3];
    }
  }
}

function applyFxStyles(owner, el) {
  if (!owner) return '';
  const css = buildFxCss(owner) || '';
  if (el) {
    if (css) el.style.filter = css;
    else el.style.removeProperty('filter');
  }
  return css;
}

function updateFxPreview(target, state, kind, previewEl = null) {
  if (!target) return;
  const fx = hydrateFx(target);
  Object.keys(DEFAULT_FX).forEach(key => {
    const v = state && Number.isFinite(state[key]) ? state[key] : DEFAULT_FX[key];
    fx[key] = v;
  });

  let css = '';
  if (kind === 'visual') {
    const el = document.querySelector(`.stage-item[data-id="${target.id}"]`);
    css = applyFxStyles(target, el);
  } else if (kind === 'bg') {
    applyBackgroundForTime(currentTime);
  }

  if (previewEl) {
    if (!css) css = applyFxStyles(target, null);
    if (css) previewEl.style.filter = css;
    else previewEl.style.removeProperty('filter');
  }
}

// ---------- Project state ----------
let PATHS = null;
let PROJECT = {
  duration: 20_000, // legacy cap; timeline auto-expands anyway
  items: [],        // visual items (PNG/GIF)  + item.trackIndex
  text: [],         // text layers
  audio: [],        // audio items
  bg: null,         // [{id, path|null, start, end|null}]
  bgTrackName: 'Background',
  bgNonDecreasingOnly: true,
  bgDefaultTail: 5000,
  trackNames: { visual:{}, audio:{}, text:{} }, // custom names per track index
  trackLocks: { visual:{}, audio:{}, bg:{} },
  trackHeights: { visual:{}, audio:{}, bg: null },
  timelineLabels: [], // timeline markers/labels
  timelineCustomEndMs: null,   // user-extended tail
};

// keep signature
function isActiveAt(tMs, startMs, endMs, fps = FRAME_RATE) {
  if (!Number.isFinite(endMs)) return tMs >= startMs; // open-ended clip
  const frame = 1000 / fps;
  const endInclusive = endMs - frame; // include the last frame
  return tMs >= startMs && tMs <= endInclusive + 0.0001;
}


// Keep the old name usable
function clipVisibleAtTime(it, t) {
  const a = it.start ?? 0;
  const b = it.end ?? ((it.start ?? 0) + (it.duration ?? 0));
  return isActiveAt(t, a, b, FRAME_RATE);
}



let currentProjectPath = null;

// ---------- Playback state ----------
let playing = false;
let t0 = 0;
let playheadRAF = null;
let currentTime = 0;
let stagePreviewScale = 1;
let previewVolume = 1;
let stageFullscreenEventsBound = false;

function updateFullscreenPlaybackUI() {
  const wrap = $('#stage-wrap');
  const isFullscreen = wrap && document.fullscreenElement === wrap;
  const fsBtn = $('#btn-stage-fullscreen');
  if (fsBtn) {
    fsBtn.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
    fsBtn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
    fsBtn.setAttribute('title', isFullscreen ? 'Exit fullscreen preview' : 'Fullscreen preview');
  }

  const playToggle = $('#stage-fs-play-toggle');
  if (playToggle) {
    playToggle.textContent = playing ? 'Pause' : 'Play';
    playToggle.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
  }

  const volumeInput = $('#stage-fs-volume');
  const volValue = $('#stage-fs-volume-value');
  const volPercent = Math.round(clamp(previewVolume, 0, 1) * 100);
  if (volumeInput) {
    if (document.activeElement !== volumeInput) {
      volumeInput.value = String(volPercent);
    }
    volumeInput.setAttribute('aria-valuenow', String(volPercent));
  }
  if (volValue) {
    volValue.textContent = `${volPercent}%`;
  }
}

function applyStageFullscreenScale() {
  const wrap = $('#stage-wrap');
  const stage = $('#stage');
  if (!wrap || !stage) return;
  const isFullscreen = document.fullscreenElement === wrap;
  if (!isFullscreen) {
    stagePreviewScale = 1;
    stage.style.transform = '';
    stage.classList.remove('stage-scaled');
    return;
  }

  const margin = 40;
  const availableWidth = Math.max(120, window.innerWidth - margin);
  const availableHeight = Math.max(120, window.innerHeight - margin);
  const scale = Math.max(0.1, Math.min(availableWidth / STAGE_WIDTH, availableHeight / STAGE_HEIGHT));
  stagePreviewScale = scale;
  stage.style.transform = `scale(${scale})`;
  stage.classList.remove('stage-scaled');
}

function applyStagePreviewScale() {
  const wrap = $('#stage-wrap');
  const stage = $('#stage');
  if (!wrap || !stage) return;
  if (document.fullscreenElement === wrap) return;
  const padding = 32;
  const rect = wrap.getBoundingClientRect();
  const availableWidth = Math.max(120, rect.width - padding);
  const availableHeight = Math.max(120, rect.height - padding);
  let scale = Math.min(1, Math.min(availableWidth / STAGE_WIDTH, availableHeight / STAGE_HEIGHT));
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  stagePreviewScale = scale;
  if (Math.abs(scale - 1) < 0.001) {
    stage.style.transform = '';
    stage.classList.remove('stage-scaled');
  } else {
    stage.style.transform = `scale(${scale})`;
    stage.classList.add('stage-scaled');
  }
}

function handleStageFullscreenChange() {
  const wrap = $('#stage-wrap');
  const controls = $('#stage-fullscreen-controls');
  const isFullscreen = wrap && document.fullscreenElement === wrap;
  if (wrap) wrap.classList.toggle('fullscreen-active', !!isFullscreen);
  if (controls) controls.hidden = !isFullscreen;
  if (isFullscreen) applyStageFullscreenScale();
  else applyStagePreviewScale();
  updateFullscreenPlaybackUI();
}

async function toggleStageFullscreen() {
  const wrap = $('#stage-wrap');
  if (!wrap) return;
  try {
    if (document.fullscreenElement === wrap) {
      if (document.exitFullscreen) await document.exitFullscreen();
    } else if (wrap.requestFullscreen) {
      await wrap.requestFullscreen();
    }
  } catch {
    // ignore request errors (user denied, etc.)
  }
}

function setPreviewVolume(value) {
  const normalized = clamp(Number(value) || 0, 0, 1);
  if (Math.abs(previewVolume - normalized) < 0.0001) {
    updateFullscreenPlaybackUI();
    return;
  }
  previewVolume = normalized;
  updateFullscreenPlaybackUI();
}

function handleStageWindowResize() {
  const wrap = $('#stage-wrap');
  if (wrap && document.fullscreenElement === wrap) applyStageFullscreenScale();
  else applyStagePreviewScale();
}

// ---------- Playback timing (ADD) ----------
const FRAME_RATE = 30;
const FRAME_MS   = Math.round(1000 / FRAME_RATE);

// ---------- Selection state ----------
let selectedItemId = null;   // visual item id
// Keep legacy single-selection for compatibility with older code:
let selectedClipId = null;   // clip id (visual/audio/bg)

// Multi-selection
let selectedClipIds = new Set();   // multiple timeline clips
let clipboardClips = null;         // copy/cut buffer (serialized)
let selectedKeyframe = null;       // { itemId, t }
let stageSizePanelEl = null;
let stageSizeXEl = null;
let stageSizeYEl = null;

// Track pointer Y for cross-row dragging
let lastPointerY = 0;
document.addEventListener('mousemove', e => { lastPointerY = e.clientY; }, { passive: true });

// ---------- Context menu handling ----------
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
window.addEventListener('click', closeMenu);
window.addEventListener('contextmenu', (e)=>{ if (!e.target.closest('.context-menu')) closeMenu(); });

// ---------- Utils ----------
function fmtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const totalCs = Math.floor(ms / 10);        // centiseconds
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  const pad2 = n => String(n).padStart(2,'0');
  return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

function updateTimeHUD() {
  const hud = document.querySelector('#timecode, #time-hud, #current-time, .time-hud, [data-role="time-hud"]');
  if (!hud) return;
  hud.textContent = fmtTime(currentTime);
}

function msToLabel(ms) { return fmtTime(ms); }

function drawPlayhead() {
  const tracks = $('#tracks');
  if (!tracks) return;

  // ensure overlay
  let overlay = tracks.querySelector('.playhead-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'playhead-overlay';
    overlay.style.cssText = `
      position: absolute; inset: 0 0 0 0; pointer-events: none;
    `;
    tracks.style.position ||= 'relative';
    tracks.appendChild(overlay);
  }

  let line = overlay.querySelector('.playhead');
  if (!line) {
    line = document.createElement('div');
    line.className = 'playhead';
    line.style.cssText = `
      position:absolute; top:0; bottom:0; width:2px;
      background:#e5534b; box-shadow:0 0 0 1px rgba(0,0,0,.25);
    `;
    overlay.appendChild(line);
  }

   // wide invisible handle for easier dragging
   let handle = overlay.querySelector('.playhead-handle');
   if (!handle) {
     handle = document.createElement('div');
     handle.className = 'playhead-handle';
     handle.style.cssText = 'position:absolute; top:0; bottom:0; width:10px; transform:translateX(-4px); pointer-events:auto; cursor:ew-resize; background:transparent;';
     overlay.appendChild(handle);
     const startDrag = (ev)=>{
       ev.preventDefault();
       ev.stopPropagation();                 // don't trigger marquee/scrub
       document.body.classList.add('no-select');
       window.__draggingPlayhead = true;
       document.body.classList.add('no-select');
       const onMove = (e)=> scrubTimelineAtClientX(e.clientX);
       const onUp = ()=>{ window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); 
       document.body.classList.remove('no-select');
       window.__draggingPlayhead = false;
       };
       window.addEventListener('mousemove', onMove);
       window.addEventListener('mouseup', onUp);
     };
     handle.addEventListener('mousedown', startDrag);
     // allow grabbing the thin line too
     line.style.pointerEvents = 'auto';
     line.style.cursor = 'ew-resize';
     line.addEventListener('mousedown', startDrag);
   }

  const x = lanesOffsetLeft() + timeToPx(currentTime) - tracks.scrollLeft;
  line.style.left = `${x}px`;

  handle.style.left = `${x}px`;

  // keep stage in sync with playhead time (items + text)
  refreshStageVisibility();
  // update HUD above the video
  updateTimeHUD();
}

  // Attach vertical resize to a track row (persistent)
function attachTrackResizer(trackEl, defaultPx, kind, index) {
  const minHeight = getLaneMin(kind);
  const clampHeight = (value) => Math.max(minHeight, Math.min(LANE_MAX, Math.round(value)));
  const init = clampHeight(getRowHeight(kind, index, Math.max(defaultPx, minHeight)));
  trackEl.style.setProperty('--h', `${init}px`);
  // add handle
  const bar = document.createElement('div');
  bar.className = 'track-resize';
  trackEl.appendChild(bar);
  let startY = 0, startH = init, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const next = clampHeight(startH + dy);
    trackEl.style.setProperty('--h', `${next}px`);
    scheduleTimelineLabelGuideUpdate();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const cur = parseInt(getComputedStyle(trackEl).getPropertyValue('--h')) || init;
    setRowHeight(kind, index, cur);
    scheduleTimelineLabelGuideUpdate();
  };
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    const cur = parseInt(getComputedStyle(trackEl).getPropertyValue('--h')) || init;
     startH = clampHeight(cur);
    dragging = true;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ---------- Autosave / Recovery ----------
const AUTOSAVE_KEY = 'su_autosave_backup_v1';
let AUTOSAVE_ENABLED = false;          // disabled during init/restore to avoid false backups
let _autosaveTimer = null;

function autosaveData() {
  return {
    format: 'su-movie-project',
    version: 1,
    savedAt: new Date().toISOString(),
    state: snapshotProject(),
    pathHint: currentProjectPath || null
  };
}

function saveAutosaveNow(reason = '') {
  if (!AUTOSAVE_ENABLED) return;
  try {
    const payload = autosaveData();
    payload._reason = reason || undefined;
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Autosave failed:', e);
  }
}

function scheduleAutosave(reason = '') {
  if (!AUTOSAVE_ENABLED) return;
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(()=>saveAutosaveNow(reason), 400);
}

function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch {}
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.format !== 'su-movie-project') return null;
    return obj;
  } catch { return null; }
}

function rehydrateAudioClips() {
  for (const au of PROJECT.audio) {
    hydrateAudioEffectsObject(au);
    if (!Number.isFinite(au.crossfadePrevMs)) au.crossfadePrevMs = 0;
    if (!Number.isFinite(au.crossfadeNextMs)) au.crossfadeNextMs = 0;
    initializeAudioRuntimeState(au, { waveSource: null });
    ensureWaveform(au).catch(()=>{}); // non-blocking; helps lengths & waveforms
  }
}

function cloneAudioEffectsSettings(from) {
  if (!from?.effects) return cloneAudioEffectDefaults();
  try {
    return JSON.parse(JSON.stringify(from.effects));
  } catch {
    return cloneAudioEffectDefaults();
  }
}

function initializeAudioRuntimeState(au, { waveSource = null } = {}) {
  if (!au) return;
  au._el = new Audio(fileUrl(au.path));
  au._el.preload = 'auto';
  try { au._el.muted = false; } catch {}
  try { au._el.volume = 1; } catch {}
  au._src = null;
  au._gain = null;
  au._connected = false;
  au._revUrl = null;
  au._currentSrcKey = null;
  au._needsSeek = true;
  au._prePrimed = false;
  au._nodes = null;
  au._effectHash = null;
  if (waveSource && waveSource !== au) {
    if (waveSource._wave) au._wave = waveSource._wave;
    if (waveSource._audioBuffer) au._audioBuffer = waveSource._audioBuffer;
    if (Number.isFinite(waveSource.srcDurationMs)) au.srcDurationMs = waveSource.srcDurationMs;
  }
  ensureMediaGraph(au); // creates _src/_gain and connects to destination (silent)
}

function markAllAudioNeedSeek({ pause = false } = {}) {
  for (const au of PROJECT.audio) {
    if (!au) continue;
    au._needsSeek = true;
    au._prePrimed = false;
    if (pause && au._el) {
      try { au._el.pause(); } catch {}
    }
  }
}

function markAllVideosNeedSeek({ pause = false } = {}) {
  for (const it of PROJECT.items) {
    if (!isVideoClip(it)) continue;
    it._videoNeedsSeek = true;
    if (pause && it._videoEl) {
      try { it._videoEl.pause(); } catch {}
      it._videoPlaying = false;
    }
  }
}

function refreshStageVisibility(){
  for (const it of PROJECT.items) positionStageItem(it);
  for (const t of PROJECT.text)  positionTextItem(t);
  renderSubtitlePreviewOverlay();
  updateStageSizePanel();
  driveVideos();
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
// file:// URL (ensure triple slash so Audio() loads reliably, esp. on Windows)
function fileUrl(p) {
  const norm = (p || '').replace(/\\/g, '/');
  const withLeadingSlash = norm.startsWith('/') ? norm : '/' + norm;
  return 'file://' + encodeURI(withLeadingSlash);
}
function uid() { return Math.random().toString(36).slice(2); }
function lerp(a,b,t){ return a+(b-a)*t; }
function approxEqual(a,b,eps=0.5){ return Math.abs(a-b)<=eps; }
function uniqueSorted(arr) { return [...new Set(arr)].sort((a,b)=>a-b); }
function basename(p){ return p?.split(/[\\/]/).pop() || ''; }

// ---------- Lock helpers ----------
function ensureTrackLocks() {
  if (!PROJECT.trackLocks) PROJECT.trackLocks = { visual:{}, audio:{}, text:{}, bg:{} };
  PROJECT.trackLocks.visual = PROJECT.trackLocks.visual || {};
  PROJECT.trackLocks.audio  = PROJECT.trackLocks.audio  || {};
  PROJECT.trackLocks.text   = PROJECT.trackLocks.text   || {};
  PROJECT.trackLocks.bg = PROJECT.trackLocks.bg || {};
  return PROJECT.trackLocks;
}

function isTrackLocked(kind, index = 0) {
  const locks = ensureTrackLocks()[kind] || {};
  return !!locks[index];
}

function setTrackLocked(kind, index, locked) {
  const locks = ensureTrackLocks()[kind] || {};
  if (locked) locks[index] = true;
  else delete locks[index];
}

// ---------- Track height helpers ----------
function ensureTrackHeights() {
  if (!PROJECT.trackHeights) PROJECT.trackHeights = { visual:{}, audio:{}, text:{}, bg:null };
  PROJECT.trackHeights.visual ||= {};
  PROJECT.trackHeights.audio  ||= {};
  PROJECT.trackHeights.text   ||= {};
  return PROJECT.trackHeights;
}
function getLaneMin(kind) {
  if (kind === 'audio') return LANE_MIN_AUDIO;
  if (kind === 'text')  return LANE_MIN_TEXT;
  if (kind === 'bg')    return LANE_MIN_BG;
  return LANE_MIN_DEFAULT;
}
function getRowHeight(kind, idx, fallbackPx) {
  const H = ensureTrackHeights();
  const minPx = getLaneMin(kind);
  let px = fallbackPx;
  if (kind === 'bg') px = H.bg ?? fallbackPx;
  else if (kind === 'visual') px = H.visual[idx] ?? fallbackPx;
  else if (kind === 'audio')  px = H.audio[idx]  ?? fallbackPx;
  else if (kind === 'text')   px = H.text[idx]   ?? fallbackPx;
  return Math.max(minPx, px ?? minPx);
}
function setRowHeight(kind, idx, px) {
  const H = ensureTrackHeights();
  const clamped = Math.max(getLaneMin(kind), Math.min(LANE_MAX, px ?? getLaneMin(kind)));
  if (kind === 'bg') H.bg = clamped;
  else if (kind === 'visual') H.visual[idx] = clamped;
  else if (kind === 'audio')  H.audio[idx]  = clamped;
  else if (kind === 'text')   H.text[idx]   = clamped;
  scheduleAutosave('track-height');
}
function remapTrackHeights(kind, indexMap) {
  const H = ensureTrackHeights();
  if (kind === 'visual') {
    const next = {};
    Object.keys(H.visual).forEach(k=>{
      const ni = indexMap.get(Number(k));
      if (ni !== undefined) next[ni] = H.visual[k];
    });
    H.visual = next;
  } else if (kind === 'audio') {
    const next = {};
    Object.keys(H.audio).forEach(k=>{
      const ni = indexMap.get(Number(k));
      if (ni !== undefined) next[ni] = H.audio[k];
    });
    H.audio = next;
  } else if (kind === 'text') {
    const next = {};
    Object.keys(H.text).forEach(k=>{
      const ni = indexMap.get(Number(k));
      if (ni !== undefined) next[ni] = H.text[k];
    });
    H.text = next;
  }
}

function isClipLocked(id) {
  if (!id) return false;
  const ref = typeof getClipRefById === 'function' ? getClipRefById(id) : null;
  if (!ref) {
    const item = PROJECT.items.find(i => i.id === id);
    if (item) return !!item.locked || isTrackLocked('visual', item.trackIndex ?? 0);
    const au = PROJECT.audio.find(a => a.id === id);
    if (au) return !!au.locked || isTrackLocked('audio', au.trackIndex ?? 0);
    const bg = (PROJECT.bgClips||[]).find(b => b.id === id);
    if (bg) return !!bg.locked || isTrackLocked('bg', 0);
    return false;
  }
  const kind = ref.kind;
  const trackIndex = ref.ref.trackIndex ?? 0;
  return !!ref.ref.locked || isTrackLocked(kind, trackIndex);
}

function setClipLocked(id, locked) {
  if (!id) return;
  const ref = typeof getClipRefById === 'function' ? getClipRefById(id) : null;
  const target = ref ? ref.ref
    : PROJECT.items.find(i => i.id === id)
    || PROJECT.audio.find(a => a.id === id)
    || PROJECT.text.find(t => t.id === id)
    || (PROJECT.bgClips||[]).find(b => b.id === id);
  if (target) target.locked = !!locked;
}

function applyTrackLockStyles(labelEl, rowEl, kind, idx) {
  if (!labelEl) return false;
  const locked = isTrackLocked(kind, idx);
  let baseText;
  if (kind === 'bg') baseText = PROJECT.bgTrackName || 'Background';
  else baseText = getTrackName(kind, idx);
  labelEl.dataset.trackName = baseText;
  const nameEl = labelEl.querySelector('[data-role="track-name"]');
  if (nameEl) nameEl.textContent = baseText;
  else labelEl.textContent = baseText;
  labelEl.classList.toggle('is-locked', locked);
  const lockEl = labelEl.querySelector('[data-role="track-lock"]');
  if (lockEl) lockEl.style.visibility = locked ? 'visible' : 'hidden';
  if (rowEl) rowEl.classList.toggle('is-locked', locked);
  const lane = rowEl?.querySelector('.track-lane');
  if (lane) lane.classList.toggle('is-locked', locked);
  return locked;
}

function timeToPx(ms) {
  return (ms / 1000) * pxPerSecond;
}

function pxToMs(px) {
  return (px / Math.max(pxPerSecond, 0.0001)) * 1000;
}

function timelineViewportEnd() {
  return Math.max(timelineViewMs, TIMELINE_MIN_MS);
}

let _suppressTimelineAutoExtend = false;

function ensureTimelineAutoExtendBindings() {
  const tracks = $('#tracks');
  if (!tracks || tracks.dataset.autoExtendBound) return;
  const onScroll = () => maybeAutoExtendTimeline(tracks);
  tracks.addEventListener('scroll', onScroll, { passive: true });
  tracks.dataset.autoExtendBound = '1';
}

function maybeAutoExtendTimeline(tracks) {
  if (!tracks) return;
  if (_suppressTimelineAutoExtend) return;
  const minMs = Math.max(projectEndMs(), TIMELINE_MIN_MS);
  const hardMax = Math.max(TIMELINE_MAX_MS, minMs);
  if (timelineViewportEnd() >= hardMax - 1) return;
  if (tracks.scrollWidth <= tracks.clientWidth) return;
  const atRight = tracks.scrollLeft + tracks.clientWidth >= tracks.scrollWidth - TIMELINE_AUTO_EXTEND_THRESHOLD_PX;
  if (!atRight) return;
  const pxDelta = Math.max(tracks.clientWidth * 0.4, TIMELINE_AUTO_EXTEND_THRESHOLD_PX + 40);
  const extraMs = Math.max(TIMELINE_AUTO_EXTEND_MIN_STEP_MS, pxToMs(pxDelta));
  extendTimelineViewport(extraMs);
}

function extendTimelineViewport(extraMs) {
  if (!Number.isFinite(extraMs) || extraMs <= 0) return false;
  const minMs = Math.max(projectEndMs(), TIMELINE_MIN_MS);
  const prevEnd = timelineViewportEnd();
  const base = Math.max(PROJECT.timelineCustomEndMs ?? prevEnd, minMs);
  const hardMax = Math.max(TIMELINE_MAX_MS, minMs);
  const next = clamp(Math.round(base + extraMs), minMs, hardMax);
  if (next <= prevEnd) return false;
  PROJECT.timelineCustomEndMs = next > minMs ? next : null;
  timelineViewMs = next;
  renderTimeline();
  scheduleAutosave('timeline-length');
  return true;
}
function clientXToTimelineMs(clientX) {
  const tracksEl = $('#tracks');
  if (!tracksEl) return 0;
  const rect = tracksEl.getBoundingClientRect();
  const laneX = clientX - rect.left + tracksEl.scrollLeft - lanesOffsetLeft();
  const ms = pxToMs(Math.max(0, laneX));
  return clamp(ms, 0, timelineViewportEnd());
}

function seekTimelineTo(ms, { snapToFrame = true } = {}) {
  let target = Number.isFinite(ms) ? ms : 0;
  target = clamp(target, 0, timelineViewportEnd());
  if (snapToFrame) {
    target = Math.round(target / FRAME_MS) * FRAME_MS;
  }
  currentTime = target;
  if (playing) t0 = performance.now() - currentTime;
  markAllAudioNeedSeek({ pause: false });
  markAllVideosNeedSeek({ pause: false });
  drawPlayhead();
  refreshStageVisibility();
  renderActiveGifs();
  applyBackgroundForTime(currentTime);
}

let _pendingTimelineLabelGuideFrame = null;

function scheduleTimelineLabelGuideUpdate() {
  if (_pendingTimelineLabelGuideFrame != null) return;
  _pendingTimelineLabelGuideFrame = requestAnimationFrame(() => {
    _pendingTimelineLabelGuideFrame = null;
    updateTimelineLabelGuides();
  });
}

function updateTimelineLabelGuides() {
  const wrap = $('#tracks');
  if (!wrap) return;
  const markers = $$('.timeline-label-marker');
  if (!markers.length) return;
  for (const marker of markers) {
    const row = marker.closest('.track');
    const nextTrack = row?.nextElementSibling;
    if (!nextTrack) {
      marker.style.setProperty('--guide-height', '0px');
      continue;
    }
    const markerRect = marker.getBoundingClientRect();
    const nextRect = nextTrack.getBoundingClientRect();
    const startY = markerRect.bottom;
    const gap = Math.max(0, nextRect.top - startY);
    marker.style.setProperty('--guide-height', `${gap}px`);
  }
}

function lanesOffsetLeft() {
  const tracks = $('#tracks');
  if (!tracks) return 0;
  const rect = tracks.getBoundingClientRect();
  const lane = tracks.querySelector('.timeline-ruler-lane') || tracks.querySelector('.track .track-lane');
  if (!lane) return tracksPad + labelWidth + trackGap; // fallback to constants
  const laneRect = lane.getBoundingClientRect();
  return (laneRect.left - rect.left); // no scrollLeft baked in
}

function scrubTimelineAtClientX(clientX) {
  const ms = clientXToTimelineMs(clientX);
  const q = Math.round(ms / FRAME_MS) * FRAME_MS;
  seekTimelineTo(q, { snapToFrame: false });
}



const TIMELINE_STEP_SECONDS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];
const imageCache = new Map();
const exportVideoStateCache = new Map();

function computeTimelineSteps() {
  // Target spacing for major labels; keeps default near 5s at pxPerSecondÃ‹Å“80
  const desiredMajorPx = 120;
  const minMajorPx = 48;    // don't let majors get tighter than this
  const maxMajorPx = 220;   // don't let majors get looser than this

  // Make sure your list includes: [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]
  const secs = TIMELINE_STEP_SECONDS.slice(); // ascending

  // 1) Prefer any step that lands between [minMajorPx, maxMajorPx], closest to desired.
  let best = null, bestDiff = Infinity;
  for (const s of secs) {
    const px = s * pxPerSecond;
    if (px >= minMajorPx && px <= maxMajorPx) {
      const diff = Math.abs(px - desiredMajorPx);
      if (diff < bestDiff) { best = s; bestDiff = diff; }
    }
  }

  // 2) If none viable, fall back to extremes (super zoomed-in or out).
  if (!best) {
    // If we're very zoomed in, pick the smallest (e.g., 0.1s).
    // If very zoomed out, pick the largest (e.g., 300s).
    const firstPx = secs[0] * pxPerSecond;
    best = firstPx > maxMajorPx ? secs[0] : secs[secs.length - 1];
  }

  const majorSec = best;
  const minorSec = (majorSec >= 1) ? majorSec / 4 : 0; // no minor ticks under 1s

  return {
    major: majorSec * 1000,
    minor: minorSec ? minorSec * 1000 : 0
  };
}

function decimalsForStep(stepMs) {
  if (stepMs >= 1000) return 0;
  if (stepMs >= 250) return 1;
  return 2;
}

function formatTimeLabel(ms, _majorStepMs) {
  return fmtTime(ms); // uses mm:ss.cs (centiseconds)
}


function buildTimelineRuler(totalMs, laneWidth) {
  const row = document.createElement('div');
  row.className = 'timeline-ruler';
  const label = document.createElement('div');
  label.className = 'track-label timeline-ruler-label';
  label.textContent = 'Time';
  const lane = document.createElement('div');
  lane.className = 'timeline-ruler-lane';
  lane.style.minWidth = `${Math.max(0, Math.round(laneWidth))}px`;
  label.style.pointerEvents = 'none';
  row.append(label, lane);

  const { major, minor } = computeTimelineSteps();
  const frag = document.createDocumentFragment();
  if (minor && minor < major) {
    for (let ms = 0; ms <= totalMs; ms += minor) {
      if (ms % major === 0) continue;
      const tick = document.createElement('div');
      tick.className = 'tick minor';
      tick.style.left = `${timeToPx(ms)}px`;
      frag.appendChild(tick);
    }
  }

  const minLabelSpacing = 40;
  let lastLabelPx = -Infinity;
  for (let ms = 0; ms <= totalMs; ms += major) {
    const px = timeToPx(ms);
    const tick = document.createElement('div');
    tick.className = 'tick major';
    tick.style.left = `${px}px`;
    if (px - lastLabelPx >= minLabelSpacing || ms === 0) {
      const span = document.createElement('span');
      span.className = 'tick-label';
      span.textContent = formatTimeLabel(ms, major);
      tick.appendChild(span);
      lastLabelPx = px;
    }
    frag.appendChild(tick);
  }

  if (totalMs > 0 && totalMs % major !== 0) {
    const px = timeToPx(totalMs);
    const tick = document.createElement('div');
    tick.className = 'tick major tail';
    tick.style.left = `${px}px`;
    if (px - lastLabelPx >= minLabelSpacing) {
      const span = document.createElement('span');
      span.className = 'tick-label';
      span.textContent = formatTimeLabel(totalMs, major);
      tick.appendChild(span);
    }
    frag.appendChild(tick);
  }

  lane.appendChild(frag);
  return row;
}

function ensureTimelineLabels() {
  if (!Array.isArray(PROJECT.timelineLabels)) PROJECT.timelineLabels = [];
  return PROJECT.timelineLabels;
}

function getTimelineLabelById(id) {
  if (!id) return null;
  return ensureTimelineLabels().find(l => l.id === id) || null;
}

function sortTimelineLabels() {
  ensureTimelineLabels().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

async function showTimelineLabelDialog(initial = {}) {
  const state = {
    title: typeof initial.title === 'string' ? initial.title : '',
    color: typeof initial.color === 'string' && initial.color ? initial.color : '#ffd166',
    timeMs: Number.isFinite(initial.timeMs) ? Math.max(0, Math.round(initial.timeMs)) : 0,
    heading: initial.heading || (initial && initial.id ? 'Edit Label' : 'Add Label')
  };

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';

    const box = document.createElement('form');
    box.style.cssText = 'width:min(360px,95vw);background:#0f141a;border:1px solid #2a2f36;border-radius:12px;padding:16px 18px;display:grid;gap:14px;font:14px/1.4 system-ui;color:#e6e6e6;box-shadow:0 16px 48px rgba(0,0,0,0.55);';
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="font-weight:600;font-size:16px;">${state.heading}</div>
        <button type="button" data-role="close" style="background:none;border:none;color:#8fa2b7;font-size:18px;line-height:1;padding:2px 6px;cursor:pointer;">X</button>
      </div>
      <label style="display:grid;gap:6px;">
        <span>Title</span>
        <input type="text" data-field="title" placeholder="Chapter name" style="background:#12161b;border:1px solid #2a2f36;border-radius:8px;padding:8px;color:#e6e6e6;">
      </label>
      <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
        <label style="display:grid;gap:6px;">
          <span>Color</span>
          <input type="color" data-field="color" style="width:64px;height:36px;border:1px solid #2a2f36;border-radius:8px;background:#12161b;padding:0;">
        </label>
        <label style="display:grid;gap:6px;">
          <span>Time (seconds)</span>
          <input type="number" min="0" step="0.01" data-field="time" style="background:#12161b;border:1px solid #2a2f36;border-radius:8px;padding:8px;color:#e6e6e6;">
        </label>
      </div>
      <div data-role="time-preview" style="font-size:12px;color:#9cb0c9;">${fmtTime(state.timeMs)}</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button type="button" data-role="cancel" style="padding:8px 12px;border-radius:8px;border:1px solid #2a2f36;background:#14191f;color:#ccd7eb;cursor:pointer;">Cancel</button>
        <button type="submit" style="padding:8px 14px;border-radius:8px;border:1px solid #3a6df0;background:#2a5be5;color:#fff;font-weight:600;cursor:pointer;">Save Label</button>
      </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const titleInput = box.querySelector('[data-field="title"]');
    const colorInput = box.querySelector('[data-field="color"]');
    const timeInput = box.querySelector('[data-field="time"]');
    const timePreview = box.querySelector('[data-role="time-preview"]');
    titleInput.value = state.title;
    colorInput.value = state.color;
    timeInput.value = (state.timeMs / 1000).toFixed(2);

    let keyHandler = null;
    const closeOverlay = (result = null) => {
      if (keyHandler) {
        document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
      }
      overlay.remove();
      resolve(result);
    };

    const updateTimePreview = () => {
      const secs = parseFloat(timeInput.value);
      const ms = Number.isFinite(secs) ? Math.max(0, Math.round(secs * 1000)) : 0;
      timePreview.textContent = fmtTime(ms);
    };

    updateTimePreview();

    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      const color = colorInput.value || '#ffd166';
      const secs = parseFloat(timeInput.value);
      let timeMs = Number.isFinite(secs) ? Math.round(secs * 1000) : state.timeMs;
      timeMs = Math.max(0, timeMs);
      closeOverlay({
        title,
        color,
        timeMs
      });
    });

    box.querySelector('[data-role="cancel"]').addEventListener('click', () => closeOverlay(null));
    box.querySelector('[data-role="close"]').addEventListener('click', () => closeOverlay(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOverlay(null);
    });
    timeInput.addEventListener('input', updateTimePreview);

    keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeOverlay(null);
      }
    };
    document.addEventListener('keydown', keyHandler);

    requestAnimationFrame(() => {
      titleInput.focus({ preventScroll: true });
      titleInput.select();
    });
  });
}

async function createTimelineLabelAt(timeMs) {
  const res = await showTimelineLabelDialog({ timeMs });
  if (!res) return;
  pushHistory('add-timeline-label');
  const labels = ensureTimelineLabels();
  labels.push({
    id: uid(),
    title: res.title,
    color: res.color || '#ffd166',
    time: Math.max(0, Math.round(res.timeMs))
  });
  sortTimelineLabels();
  renderTimeline();
  scheduleAutosave('add-timeline-label');
}

async function editTimelineLabel(id) {
  const label = getTimelineLabelById(id);
  if (!label) return;
  const res = await showTimelineLabelDialog({
    id: label.id,
    title: label.title || '',
    color: label.color || '#ffd166',
    timeMs: label.time || 0,
    heading: 'Edit Label'
  });
  if (!res) return;
  pushHistory('edit-timeline-label');
  label.title = res.title;
  label.color = res.color || '#ffd166';
  label.time = Math.max(0, Math.round(res.timeMs));
  sortTimelineLabels();
  renderTimeline();
  scheduleAutosave('edit-timeline-label');
}

function deleteTimelineLabel(id) {
  const labels = ensureTimelineLabels();
  const before = labels.length;
  const next = labels.filter(l => l.id !== id);
  if (next.length === before) return;
  pushHistory('delete-timeline-label');
  PROJECT.timelineLabels = next;
  renderTimeline();
  scheduleAutosave('delete-timeline-label');
}

function showTimelineEmptyMenu(x, y) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.addEventListener('mousedown', e => e.stopPropagation());
  menu.addEventListener('click', e => e.stopPropagation());

  const addPlayhead = document.createElement('button');
  addPlayhead.textContent = `Add label at playhead (${fmtTime(currentTime)})...`;
  addPlayhead.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeMenu();
    await createTimelineLabelAt(currentTime);
  });
  menu.appendChild(addPlayhead);

  attachAndFitMenu(menu, x, y);
}

function showTimelineLabelMenu(x, y, id) {
  const label = getTimelineLabelById(id);
  if (!label) return;
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.addEventListener('mousedown', e => e.stopPropagation());
  menu.addEventListener('click', e => e.stopPropagation());

  const gotoBtn = document.createElement('button');
  gotoBtn.textContent = `Go to ${fmtTime(label.time || 0)}`;
  gotoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    seekTimelineTo(label.time || 0);
  });
  menu.appendChild(gotoBtn);

  const editBtn = document.createElement('button');
  editBtn.textContent = 'Edit label...';
  editBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeMenu();
    await editTimelineLabel(label.id);
  });
  menu.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete label';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    deleteTimelineLabel(label.id);
  });
  menu.appendChild(delBtn);

  attachAndFitMenu(menu, x, y);
}

function buildTimelineLabelRow(totalMs, laneWidth) {
  const labels = ensureTimelineLabels();
  const row = document.createElement('div');
  row.className = 'track timeline-label-row';
  row.dataset.kind = 'labels';
  row.style.setProperty('--h', '36px');

  const label = document.createElement('div');
  label.className = 'track-label timeline-labels-label';
  const labelText = document.createElement('span');
  labelText.textContent = 'Labels';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'timeline-label-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add label at playhead';
  addBtn.setAttribute('aria-label', 'Add label at playhead');
  addBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    createTimelineLabelAt(currentTime);
  });
  addBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  addBtn.addEventListener('mouseup', (e) => e.stopPropagation());
  label.append(labelText, addBtn);

  const lane = document.createElement('div');
  lane.className = 'timeline-label-lane';
  lane.style.minWidth = `${Math.max(0, Math.round(laneWidth))}px`;
  lane.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.timeline-label-marker')) return;
    e.preventDefault();
    e.stopPropagation();
    showTimelineEmptyMenu(e.clientX, e.clientY);
  });

  for (const lbl of labels) {
    const timeMs = clamp(Number(lbl.time) || 0, 0, Math.max(totalMs, 0));
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'timeline-label-marker';
    marker.dataset.id = lbl.id;
    marker.style.left = `${timeToPx(timeMs)}px`;
    marker.style.setProperty('--label-color', lbl.color || '#ffd166');
    marker.title = `${lbl.title ? `${lbl.title} • ` : ''}${fmtTime(timeMs)}`;
    const baseColor = lbl.color || '#ffd166';
    marker.style.setProperty('--guide-height', '0px');
    try {
      marker.style.background = formatRgba(baseColor, 0.25);
      marker.style.borderColor = formatRgba(baseColor, 0.6);
    } catch {
      marker.style.borderColor = baseColor;
    }

    const pin = document.createElement('span');
    pin.className = 'timeline-label-pin';

    const text = document.createElement('span');
    text.className = 'timeline-label-text';
    text.textContent = lbl.title || fmtTime(timeMs);

    marker.append(pin, text);

    marker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      seekTimelineTo(timeMs);
    });
    marker.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editTimelineLabel(lbl.id);
    });
    marker.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTimelineLabelMenu(e.clientX, e.clientY, lbl.id);
    });
    marker.addEventListener('mousedown', (e) => e.stopPropagation());
    marker.addEventListener('mouseup', (e) => e.stopPropagation());

    lane.appendChild(marker);
  }

  row.append(label, lane);
  return row;
}

// Make a Windows-safe filename from text
function textToSafeFilename(text, maxLen = 80) {
  let s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return 'tts';
  // remove illegal chars + control chars
  s = s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  // avoid reserved device names
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) s = '_' + s;
  // strip trailing dots/spaces
  s = s.replace(/[. ]+$/g, '');
  // shorten
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'tts';
}

const supportsImageDecoder = (typeof ImageDecoder !== 'undefined');


function isImage(p){ return /\.(png|jpe?g|gif|webp)$/i.test(p || ''); }
function isVideo(p){ return /\.(mp4|webm)$/i.test(p || ''); }
function isVideoClip(item){
  if (!item) return false;
  const kind = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : '';
  if (kind === 'video') return true;
  return isVideo(item.path);
}
function isGifPath(p){ return /\.gif(\?|$)/i.test(p || ''); }
const isGif = isGifPath; // alias for older calls
function isAudio(p){ return /\.(wav|mp3|ogg|m4a)$/i.test(p || ''); }

// ---------- Text modal helpers ----------
const FALLBACK_FONT_LIST = [
  'system-ui, Arial, sans-serif',
  'Arial',
  'Times New Roman',
  'Courier New',
  'Comic Sans MS',
  'Georgia',
  'Verdana',
  'Trebuchet MS',
  'Impact',
  'Helvetica',
];
let cachedFontList = null;
const SUPPORTS_TEXT_STROKE = (() => {
  try {
    if (typeof CSS === 'undefined' || !CSS.supports) return false;
    return CSS.supports('text-stroke: 1px #000') || CSS.supports('-webkit-text-stroke: 1px #000');
  } catch {
    return false;
  }
})();

async function loadInstalledFonts() {
  if (cachedFontList) return cachedFontList;
  let fonts = [];
  try {
    fonts = await window.suAPI?.listFonts?.();
  } catch (err) {
    console.warn('fonts:list failed', err);
  }
  if (!Array.isArray(fonts)) fonts = [];
  fonts = fonts.map(f => String(f || '').trim()).filter(Boolean);
  if (!fonts.length) fonts = [...FALLBACK_FONT_LIST];
  else {
    const merged = new Set([...FALLBACK_FONT_LIST, ...fonts]);
    fonts = Array.from(merged);
  }
  cachedFontList = fonts;
  return cachedFontList;
}

function formatRgba(hex, alpha) {
  const rgb = hexToRgb(hex || '#000000');
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${clamp01(alpha)})`;
}

async function showTextDialog(initial = {}) {
  const fonts = await loadInstalledFonts();
  const style = hydrateTextStyle(initial.style);
  const state = {
    content: initial.content ?? 'New Text',
    style: { ...style }
  };

  let storedStroke = state.style.strokeW > 0 ? state.style.strokeW : 2;
  let storedShadow = {
    x: state.style.shadowX || 2,
    y: state.style.shadowY || 2,
    blur: state.style.shadowBlur || 6
  };

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:grid;place-items:center;';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(620px,95vw);max-height:92vh;overflow:auto;background:#0f141a;border:1px solid #2a2f36;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.6);padding:16px;display:grid;gap:14px;font:14px/1.4 system-ui;';
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
      <div style="font-weight:600;font-size:16px;">${initial && initial.id ? 'Edit Text' : 'Add Text'}</div>
      <button data-act="cancel" style="background:none;border:none;color:#8fa2b7;font-size:18px;padding:2px 6px;cursor:pointer;">X</button>
    </div>
    <div style="display:grid;gap:12px;">
      <label style="display:grid;gap:6px;">
        <span>Text</span>
        <textarea data-field="content" rows="3" style="resize:vertical;min-height:60px;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:8px;"></textarea>
      </label>
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
        <label style="display:grid;gap:6px;">
          <span>Font</span>
          <select data-field="font" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;"></select>
        </label>
        <label style="display:grid;gap:6px;">
          <span>Size (px)</span>
          <input data-field="size" type="number" min="6" max="400" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
        </label>
        <label style="display:grid;gap:6px;">
          <span>Align</span>
          <select data-field="align" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label style="display:grid;gap:6px;">
          <span>Color</span>
          <input data-field="color" type="color" style="height:34px;border:1px solid #2a2f36;border-radius:8px;background:#12161b;padding:0 6px;">
        </label>
        <label style="display:grid;gap:6px;">
          <span>Opacity</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <input data-field="opacity" type="range" min="0" max="100" step="1" style="flex:1;">
            <span data-role="opacity-label" style="width:44px;text-align:right;">100%</span>
          </div>
        </label>
      </div>
      <div style="display:grid;gap:10px;padding:10px;border:1px solid #1f2630;border-radius:10px;background:#0d1117;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input data-field="stroke-enabled" type="checkbox" id="text-stroke-enabled">
          <label for="text-stroke-enabled" style="user-select:none;">Stroke / Outline</label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding-left:24px;">
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Width</span>
            <input data-field="strokeW" type="number" min="0" max="40" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Color</span>
            <input data-field="strokeColor" type="color" style="height:34px;border:1px solid #2a2f36;border-radius:8px;background:#12161b;">
          </label>
        </div>
      </div>

      <div style="display:grid;gap:10px;padding:10px;border:1px solid #1f2630;border-radius:10px;background:#0d1117;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input data-field="shadow-enabled" type="checkbox" id="text-shadow-enabled">
          <label for="text-shadow-enabled" style="user-select:none;">Shadow</label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding-left:24px;">
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Offset X</span>
            <input data-field="shadowX" type="number" min="-100" max="100" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Offset Y</span>
            <input data-field="shadowY" type="number" min="-100" max="100" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Blur</span>
            <input data-field="shadowBlur" type="number" min="0" max="200" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Color</span>
            <input data-field="shadowColor" type="color" style="height:34px;border:1px solid #2a2f36;border-radius:8px;background:#12161b;">
          </label>
        </div>
      </div>

      <div style="display:grid;gap:10px;padding:10px;border:1px solid #1f2630;border-radius:10px;background:#0d1117;">
        <div style="display:flex;align-items:center;gap:8px;">
          <input data-field="bgOn" type="checkbox" id="text-bg-enabled">
          <label for="text-bg-enabled" style="user-select:none;">Background Box</label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding-left:24px;">
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Fill</span>
            <input data-field="bgColor" type="color" style="height:34px;border:1px solid #2a2f36;border-radius:8px;background:#12161b;">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:160px;">
            <span>Opacity</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <input data-field="bgAlpha" type="range" min="0" max="100" step="1" style="flex:1;">
              <span data-role="bg-alpha" style="width:44px;text-align:right;">40%</span>
            </div>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Padding</span>
            <input data-field="bgPad" type="number" min="0" max="200" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
            <span>Corner Radius</span>
            <input data-field="bgRadius" type="number" min="0" max="200" step="1" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;">
          </label>
        </div>
      </div>
    </div>
    <div style="display:grid;gap:10px;">
      <span style="font-weight:600;">Preview</span>
      <div data-role="preview-wrap" style="background:#12161b;border:1px solid #1f2630;border-radius:12px;padding:16px;display:flex;justify-content:center;align-items:center;min-height:160px;">
        <div data-role="preview" style="max-width:100%;word-break:break-word;text-align:center;padding:12px 18px;border-radius:10px;">Sample Text</div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button data-act="cancel" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:8px;padding:8px 14px;">Cancel</button>
      <button data-act="ok" style="background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:8px;padding:8px 16px;font-weight:600;">${initial && initial.id ? 'Save' : 'Add Text'}</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const cleanup = () => {
    overlay.remove();
  };

  const contentEl = box.querySelector('[data-field="content"]');
  const fontSel = box.querySelector('[data-field="font"]');
  const sizeEl = box.querySelector('[data-field="size"]');
  const alignSel = box.querySelector('[data-field="align"]');
  const colorEl = box.querySelector('[data-field="color"]');
  const opacityRange = box.querySelector('[data-field="opacity"]');
  const opacityLabel = box.querySelector('[data-role="opacity-label"]');
  const strokeEnabled = box.querySelector('[data-field="stroke-enabled"]');
  const strokeWidthEl = box.querySelector('[data-field="strokeW"]');
  const strokeColorEl = box.querySelector('[data-field="strokeColor"]');
  const shadowEnabled = box.querySelector('[data-field="shadow-enabled"]');
  const shadowXEl = box.querySelector('[data-field="shadowX"]');
  const shadowYEl = box.querySelector('[data-field="shadowY"]');
  const shadowBlurEl = box.querySelector('[data-field="shadowBlur"]');
  const shadowColorEl = box.querySelector('[data-field="shadowColor"]');
  const bgEnabled = box.querySelector('[data-field="bgOn"]');
  const bgColorEl = box.querySelector('[data-field="bgColor"]');
  const bgAlphaRange = box.querySelector('[data-field="bgAlpha"]');
  const bgAlphaLabel = box.querySelector('[data-role="bg-alpha"]');
  const bgPadEl = box.querySelector('[data-field="bgPad"]');
  const bgRadiusEl = box.querySelector('[data-field="bgRadius"]');
  const previewWrap = box.querySelector('[data-role="preview-wrap"]');
  const previewText = box.querySelector('[data-role="preview"]');

  // Populate fonts
  fontSel.innerHTML = '';
  const ensureOption = (value, label = value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    fontSel.appendChild(opt);
  };
  const existingFont = state.style.font;
  const hasExact = fonts.some(f => f.toLowerCase() === existingFont.toLowerCase());
  fonts.forEach(name => ensureOption(name));
  if (!hasExact) ensureOption(existingFont, `${existingFont} (project)`);
  fontSel.value = existingFont;

  // Seed initial values
  contentEl.value = state.content;
  sizeEl.value = state.style.size;
  alignSel.value = state.style.align;
  opacityRange.value = Math.round((state.style.opacity ?? 1) * 100);
  opacityLabel.textContent = `${opacityRange.value}%`;
  colorEl.value = state.style.color || '#ffffff';
  strokeWidthEl.value = state.style.strokeW;
  strokeColorEl.value = state.style.strokeColor;
  shadowXEl.value = state.style.shadowX;
  shadowYEl.value = state.style.shadowY;
  shadowBlurEl.value = state.style.shadowBlur;
  shadowColorEl.value = state.style.shadowColor;
  bgEnabled.checked = !!state.style.bgOn;
  bgColorEl.value = state.style.bgColor;
  bgAlphaRange.value = Math.round((state.style.bgAlpha ?? 0.4) * 100);
  bgAlphaLabel.textContent = `${bgAlphaRange.value}%`;
  bgPadEl.value = state.style.bgPad;
  bgRadiusEl.value = state.style.bgRadius;

  const strokeIsOn = (state.style.strokeW || 0) > 0;
  strokeEnabled.checked = strokeIsOn;
  strokeWidthEl.disabled = strokeColorEl.disabled = !strokeIsOn;

  const shadowIsOn = Math.abs(state.style.shadowX) + Math.abs(state.style.shadowY) + Math.abs(state.style.shadowBlur) > 0;
  shadowEnabled.checked = shadowIsOn;
  shadowXEl.disabled = shadowYEl.disabled = shadowBlurEl.disabled = shadowColorEl.disabled = !shadowIsOn;

  const toggleBgControls = (on) => {
    bgColorEl.disabled = bgAlphaRange.disabled = bgPadEl.disabled = bgRadiusEl.disabled = !on;
  };
  toggleBgControls(bgEnabled.checked);

  function updatePreview() {
    previewText.textContent = state.content || 'Text';
    previewText.style.fontFamily = state.style.font;
    previewText.style.fontSize = `${state.style.size}px`;
    previewText.style.color = state.style.color;
    previewText.style.textAlign = state.style.align;
    const baseOpacity = clamp01(state.style.opacity ?? 1);
    previewText.style.opacity = String(baseOpacity);

    const sw = Math.max(0, +state.style.strokeW || 0);
    const sc = state.style.strokeColor || '#000000';
    if (SUPPORTS_TEXT_STROKE && sw > 0) {
      previewText.style.setProperty('-webkit-text-stroke', `${sw}px ${sc}`);
      previewText.style.setProperty('text-stroke', `${sw}px ${sc}`);
    } else {
      previewText.style.removeProperty('-webkit-text-stroke');
      previewText.style.removeProperty('text-stroke');
    }

    const shadowParts = [];
    if (!(SUPPORTS_TEXT_STROKE && sw > 0) && sw > 0) {
      shadowParts.push(`0 0 ${Math.max(1, sw)}px ${sc}`);
    }
    const shX = +state.style.shadowX || 0;
    const shY = +state.style.shadowY || 0;
    const shB = +state.style.shadowBlur || 0;
    const shC = state.style.shadowColor || 'transparent';
    if (shX || shY || shB) shadowParts.push(`${shX}px ${shY}px ${shB}px ${shC}`);
    previewText.style.textShadow = shadowParts.join(', ') || 'none';

    if (state.style.bgOn) {
      previewText.style.background = formatRgba(state.style.bgColor || '#000000', state.style.bgAlpha ?? 0.4);
      previewText.style.padding = `${state.style.bgPad ?? 8}px`;
      previewText.style.borderRadius = `${state.style.bgRadius ?? 8}px`;
    } else {
      previewText.style.background = 'transparent';
      previewText.style.padding = '0px';
      previewText.style.borderRadius = '0px';
    }

    previewWrap.style.justifyContent = state.style.align === 'left' ? 'flex-start'
      : state.style.align === 'right' ? 'flex-end'
      : 'center';
  }

  updatePreview();

  const handlers = [];
  const bindInput = (el, cb, eventName = 'input') => {
    if (!el) return;
    const fn = (e) => cb(e.target.value);
    el.addEventListener(eventName, fn);
    handlers.push({ el, eventName, fn });
  };

  bindInput(contentEl, (v)=>{ state.content = v; updatePreview(); });
  bindInput(fontSel, (v)=>{ state.style.font = v; updatePreview(); });
  bindInput(sizeEl, (v)=>{ state.style.size = Math.max(6, Math.min(400, parseInt(v,10)||36)); updatePreview(); });
  bindInput(alignSel, (v)=>{ state.style.align = v; updatePreview(); });
  bindInput(opacityRange, (v)=>{ const pct = clamp01((parseInt(v,10)||0)/100); state.style.opacity = pct; opacityLabel.textContent = `${Math.round(pct*100)}%`; updatePreview(); });

  bindInput(strokeWidthEl, (v)=>{
    const val = Math.max(0, Math.min(40, parseInt(v,10)||0));
    state.style.strokeW = val;
    if (val > 0) storedStroke = val;
    updatePreview();
  });
  bindInput(strokeColorEl, (v)=>{ state.style.strokeColor = v || '#000000'; updatePreview(); });

  strokeEnabled.addEventListener('change', ()=>{
    const on = strokeEnabled.checked;
    strokeWidthEl.disabled = strokeColorEl.disabled = !on;
    if (on) {
      state.style.strokeW = Math.max(1, storedStroke || 2);
    } else {
      storedStroke = state.style.strokeW || storedStroke || 2;
      state.style.strokeW = 0;
    }
    updatePreview();
  });

  bindInput(shadowXEl, (v)=>{ state.style.shadowX = parseInt(v,10)||0; storedShadow.x = state.style.shadowX; updatePreview(); });
  bindInput(shadowYEl, (v)=>{ state.style.shadowY = parseInt(v,10)||0; storedShadow.y = state.style.shadowY; updatePreview(); });
  bindInput(shadowBlurEl, (v)=>{ state.style.shadowBlur = Math.max(0, parseInt(v,10)||0); storedShadow.blur = state.style.shadowBlur; updatePreview(); });
  bindInput(shadowColorEl, (v)=>{ state.style.shadowColor = v || '#000000'; updatePreview(); });

  shadowEnabled.addEventListener('change', ()=>{
    const on = shadowEnabled.checked;
    shadowXEl.disabled = shadowYEl.disabled = shadowBlurEl.disabled = shadowColorEl.disabled = !on;
    if (on) {
      state.style.shadowX = storedShadow.x ?? 2;
      state.style.shadowY = storedShadow.y ?? 2;
      state.style.shadowBlur = storedShadow.blur ?? 6;
    } else {
      storedShadow = {
        x: state.style.shadowX,
        y: state.style.shadowY,
        blur: state.style.shadowBlur
      };
      state.style.shadowX = 0;
      state.style.shadowY = 0;
      state.style.shadowBlur = 0;
    }
    updatePreview();
  });

  bgEnabled.addEventListener('change', ()=>{
    const on = bgEnabled.checked;
    state.style.bgOn = on;
    toggleBgControls(on);
    updatePreview();
  });
  bindInput(bgColorEl, (v)=>{ state.style.bgColor = v || '#000000'; updatePreview(); });
  bindInput(bgAlphaRange, (v)=>{
    const pct = clamp01((parseInt(v,10)||0)/100);
    state.style.bgAlpha = pct;
    bgAlphaLabel.textContent = `${Math.round(pct*100)}%`;
    updatePreview();
  });
  bindInput(bgPadEl, (v)=>{ state.style.bgPad = Math.max(0, Math.min(200, parseInt(v,10)||0)); updatePreview(); });
  bindInput(bgRadiusEl, (v)=>{ state.style.bgRadius = Math.max(0, Math.min(200, parseInt(v,10)||0)); updatePreview(); });

  bindInput(colorEl, (v)=>{ state.style.color = v || '#ffffff'; updatePreview(); });

  const cancelButtons = [...box.querySelectorAll('[data-act="cancel"]')];
  const okBtn = box.querySelector('[data-act="ok"]');
  contentEl.addEventListener('keydown', e => e.stopPropagation());

  return new Promise((resolve) => {
    const detachInputs = () => {
      handlers.forEach(({ el, eventName, fn }) => {
        el.removeEventListener(eventName, fn);
      });
    };

    const finish = (result) => {
      detachInputs();
      document.removeEventListener('keydown', onKey);
      cleanup();
      resolve(result);
    };

    const onCancel = () => finish(null);
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };

    cancelButtons.forEach(btn => btn.addEventListener('click', (e)=>{ e.preventDefault(); onCancel(); }));
    okBtn?.addEventListener('click', ()=>{
      const textVal = (state.content || '').trim();
      if (!textVal) {
        contentEl.focus();
        contentEl.select();
        return;
      }
      const styleOut = hydrateTextStyle(state.style);
      finish({ content: textVal, style: { ...styleOut } });
    });

    document.addEventListener('keydown', onKey);
    const focusEditable = () => {
      if (!document.body.contains(contentEl)) return;
      contentEl.focus({ preventScroll: true });
      contentEl.select();
    };
    requestAnimationFrame(focusEditable);
    setTimeout(focusEditable, 0);
  });
}
// Fit a context menu into viewport and attach it
function attachAndFitMenu(menu, x, y) {
  menu.style.position = 'fixed';
  menu.style.maxWidth = 'min(92vw, 420px)';
  menu.style.maxHeight = '80vh';
  menu.style.overflow = 'auto';
  document.body.appendChild(menu);

  const pad = 8;
  let left = x, top = y;
  let w = menu.offsetWidth || 200;
  let h = menu.offsetHeight || 120;

  if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
  if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
  if (left < pad) left = pad;
  if (top < pad) top = pad;

  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  const refit = () => {
    const rect = menu.getBoundingClientRect();
    let nx = rect.left, ny = rect.top;
    let nw = rect.width, nh = rect.height;
    if (nx + nw > window.innerWidth - pad) nx = Math.max(pad, window.innerWidth - nw - pad);
    if (ny + nh > window.innerHeight - pad) ny = Math.max(pad, window.innerHeight - nh - pad);
    if (nx < pad) nx = pad;
    if (ny < pad) ny = pad;
    menu.style.left = `${nx}px`;
    menu.style.top  = `${ny}px`;
  };
  setTimeout(refit, 0);
  menu._refit = refit;
  openMenuEl = menu;
  return menu;
}

const TTS_CHARACTER_STORE_KEY = 'ttsCharacterNames';
let isAppReady = false;
let appReadyResolve = null;
const appReady = new Promise((resolve) => {
  appReadyResolve = resolve;
});
let ttsLaunchInProgress = false;
let audioMergeInProgress = false;

function markAppReady() {
  if (appReadyResolve) {
    appReadyResolve();
    appReadyResolve = null;
  }
  isAppReady = true;
}

function sanitizeTtsCharacterName(name) {
  if (!name) return '';
  return String(name).replace(/\s+/g, ' ').trim();
}

function loadTtsCharacters() {
  try {
    const raw = localStorage.getItem(TTS_CHARACTER_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const names = [];
    for (const entry of parsed) {
      const cleaned = sanitizeTtsCharacterName(entry);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(cleaned);
    }
    names.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    return names;
  } catch (err) {
    console.warn('loadTtsCharacters failed', err);
    return [];
  }
}

function saveTtsCharacters(list) {
  const cleaned = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const name = sanitizeTtsCharacterName(entry);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(name);
  }
  cleaned.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  try {
    localStorage.setItem(TTS_CHARACTER_STORE_KEY, JSON.stringify(cleaned));
  } catch (err) {
    console.warn('saveTtsCharacters failed', err);
  }
  return cleaned;
}

function rememberTtsCharacter(name) {
  const cleaned = sanitizeTtsCharacterName(name);
  if (!cleaned) return loadTtsCharacters();
  const current = loadTtsCharacters();
  current.push(cleaned);
  return saveTtsCharacters(current);
}

function forgetTtsCharacter(name) {
  const cleaned = sanitizeTtsCharacterName(name);
  if (!cleaned) return loadTtsCharacters();
  const current = loadTtsCharacters();
  const filtered = current.filter(n => n.toLowerCase() !== cleaned.toLowerCase());
  return saveTtsCharacters(filtered);
}

const TTS_SUBTITLE_COLOR_STORE_KEY = 'ttsSubtitleColors';
const TTS_SUBTITLE_PREVIEW_PREF_KEY = 'ttsSubtitlePreviewPrefs';

let assPromptHandler = null;

function setAssPromptHandler(fn) {
  assPromptHandler = typeof fn === 'function' ? fn : null;
}

const ASS_COLOR_DEFAULT = Object.freeze({ alpha: '00', bgr: 'FFFFFF' });

function parseAssColorComponents(value) {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    const hex = raw.slice(1);
    return {
      alpha: '00',
      bgr: `${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase()
    };
  }
  raw = raw.replace(/^&H/i, '');
  raw = raw.replace(/&$/, '');
  raw = raw.replace(/[^0-9a-fA-F]/g, '');
  if (!raw.length) return null;
  if (raw.length > 8) raw = raw.slice(-8);
  if (raw.length === 8) {
    return {
      alpha: raw.slice(0, 2).padStart(2, '0').toUpperCase(),
      bgr: raw.slice(2, 8).padStart(6, '0').toUpperCase()
    };
  }
  if (raw.length === 6) {
    return {
      alpha: '00',
      bgr: raw.toUpperCase()
    };
  }
  return null;
}

function assComponentsToCssHex(components) {
  const comp = components || ASS_COLOR_DEFAULT;
  const bgr = (comp.bgr || 'FFFFFF').padStart(6, '0');
  const bb = bgr.slice(0, 2);
  const gg = bgr.slice(2, 4);
  const rr = bgr.slice(4, 6);
  return `#${rr}${gg}${bb}`.toLowerCase();
}

function cssHexToAssComponents(cssHex, alpha = '00') {
  if (typeof cssHex !== 'string') return null;
  let hex = cssHex.trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const b = hex.slice(4, 6);
  const cleanAlpha = (typeof alpha === 'string' && alpha.trim()) ? alpha.replace(/[^0-9a-fA-F]/g, '').toUpperCase().padStart(2, '0').slice(-2) : '00';
  return {
    alpha: cleanAlpha,
    bgr: `${b}${g}${r}`.toUpperCase()
  };
}

function assComponentsToString(components) {
  const alpha = (components?.alpha || '00').toUpperCase().padStart(2, '0').slice(-2);
  const bgr = (components?.bgr || 'FFFFFF').toUpperCase().padStart(6, '0').slice(-6);
  return `${alpha}${bgr}`;
}

function rgbToHex(r, g, b) {
  const toHex = (v) => {
    const clamped = Math.max(0, Math.min(255, Math.round(v)));
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
        break;
      case gn:
        h = ((bn - rn) / d + 2) * 60;
        break;
      default:
        h = ((rn - gn) / d + 4) * 60;
        break;
    }
  }
  if (!Number.isFinite(h)) h = 0;
  if (!Number.isFinite(s)) s = 0;
  return { h: (h + 360) % 360, s: clamp01(s), l: clamp01(l) };
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const lig = clamp01(l);
  if (sat === 0) {
    const gray = Math.round(lig * 255);
    return { r: gray, g: gray, b: gray };
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const hueToChannel = (t) => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };
  const r = hueToChannel((hue / 360) + 1 / 3);
  const g = hueToChannel(hue / 360);
  const b = hueToChannel((hue / 360) - 1 / 3);
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255)
  };
}

function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      h = (bn - rn) / delta + 2;
    } else {
      h = (rn - gn) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const val = clamp01(v);
  if (sat === 0) {
    const gray = Math.round(val * 255);
    return { r: gray, g: gray, b: gray };
  }
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hue < 60) {
    rn = c; gn = x; bn = 0;
  } else if (hue < 120) {
    rn = x; gn = c; bn = 0;
  } else if (hue < 180) {
    rn = 0; gn = c; bn = x;
  } else if (hue < 240) {
    rn = 0; gn = x; bn = c;
  } else if (hue < 300) {
    rn = x; gn = 0; bn = c;
  } else {
    rn = c; gn = 0; bn = x;
  }
  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255)
  };
}

async function assPromptValue({
  title = 'ASS Override',
  label = 'Value',
  defaultValue = '',
  placeholder = '',
  allowEmpty = false,
  returnRaw = false,
  type = 'text'
} = {}) {
  if (!assPromptHandler) {
    console.warn('ASS prompt handler unavailable');
    return null;
  }
  const result = await assPromptHandler({ title, label, defaultValue, placeholder, allowEmpty, returnRaw, type });
  if (result == null) return null;
  if (returnRaw) return result;
  const trimmed = typeof result === 'string' ? result.trim() : result;
  if (!allowEmpty && (!trimmed && trimmed !== '0')) return null;
  return trimmed;
}

function loadTtsPreviewPrefs() {
  try {
    const raw = localStorage.getItem(TTS_SUBTITLE_PREVIEW_PREF_KEY);
    if (!raw) return { mode: null, srt: false, ass: false };
    const parsed = JSON.parse(raw);
    let mode = null;
    if (parsed && typeof parsed.mode === 'string') {
      if (parsed.mode === 'srt') mode = 'srt';
      else if (parsed.mode === 'ass') mode = 'ass';
    }
    let srt = false;
    let ass = false;
    if (mode === 'srt') {
      srt = true;
    } else if (mode === 'ass') {
      ass = true;
    } else {
      srt = !!(parsed && parsed.srt);
      ass = !!(parsed && parsed.ass);
      if (srt && ass) {
        mode = 'ass';
        srt = false;
        ass = true;
      } else if (srt) {
        mode = 'srt';
      } else if (ass) {
        mode = 'ass';
      }
    }
    return { mode, srt: mode === 'srt', ass: mode === 'ass' };
  } catch (err) {
    console.warn('loadTtsPreviewPrefs failed', err);
    return { mode: null, srt: false, ass: false };
  }
}

function saveTtsPreviewPrefs(prefs) {
  try {
    let mode = null;
    if (prefs && typeof prefs.mode === 'string') {
      mode = prefs.mode === 'ass' ? 'ass' : (prefs.mode === 'srt' ? 'srt' : null);
    }
    if (!mode) {
      if (prefs && prefs.srt) mode = 'srt';
      else if (prefs && prefs.ass) mode = 'ass';
    }
    const payload = {
      mode: mode,
      srt: mode === 'srt',
      ass: mode === 'ass'
    };
    localStorage.setItem(TTS_SUBTITLE_PREVIEW_PREF_KEY, JSON.stringify(payload));
    return payload;
  } catch (err) {
    console.warn('saveTtsPreviewPrefs failed', err);
    return { mode: null, srt: false, ass: false };
  }
}

const INITIAL_TTS_PREVIEW_PREFS = loadTtsPreviewPrefs();
const subtitlePreviewState = {
  mode: INITIAL_TTS_PREVIEW_PREFS.mode || null,
  entries: [],
  colors: {},
  tempPaths: { srt: null, ass: null },
  srtContent: '',
  assContent: '',
  lastMode: null,
  lastSignature: null
};
let subtitlePreviewLayer = null;
let subtitlePreviewRebuildTimer = null;
let subtitlePreviewRebuildPromise = null;

function subtitleCharacterKey(name) {
  const cleaned = sanitizeTtsCharacterName(name);
  return cleaned ? cleaned.toLowerCase() : '';
}

const ASS_EFFECT_DEFINITIONS = Object.freeze([
  {
    id: 'font-name',
    group: 'Text + Font',
    label: 'Font Name (\\fn)',
    async apply() {
      const value = await assPromptValue({ title: 'Font Name', label: 'Enter font name (example: Arial)', defaultValue: 'Arial' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\fn${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'font-size',
    group: 'Text + Font',
    label: 'Font Size (\\fs)',
    async apply() {
      const value = await assPromptValue({ title: 'Font Size', label: 'Enter font size (points)', defaultValue: '48' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\fs${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'font-bold',
    group: 'Text + Font',
    label: 'Bold (\\b)',
    async apply() {
      const value = await assPromptValue({ title: 'Bold', label: 'Enter bold value (0=off, 1=bold, >1 weight)', defaultValue: '1', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\b${value}}`, suffix: '{\\b0}' };
    }
  },
  {
    id: 'font-italic',
    group: 'Text + Font',
    label: 'Italic (\\i)',
    async apply() {
      const value = await assPromptValue({ title: 'Italic', label: 'Enter italic value (0 or 1)', defaultValue: '1', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\i${value}}`, suffix: '{\\i0}' };
    }
  },
  {
    id: 'font-underline',
    group: 'Text + Font',
    label: 'Underline (\\u)',
    async apply() {
      const value = await assPromptValue({ title: 'Underline', label: 'Enter underline value (0 or 1)', defaultValue: '1', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\u${value}}`, suffix: '{\\u0}' };
    }
  },
  {
    id: 'font-strikeout',
    group: 'Text + Font',
    label: 'Strikeout (\\s)',
    async apply() {
      const value = await assPromptValue({ title: 'Strikeout', label: 'Enter strikeout value (0 or 1)', defaultValue: '1', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\s${value}}`, suffix: '{\\s0}' };
    }
  },
  {
    id: 'font-spacing',
    group: 'Text + Font',
    label: 'Letter Spacing (\\fsp)',
    async apply() {
      const value = await assPromptValue({ title: 'Letter Spacing', label: 'Enter letter spacing (pixels)', defaultValue: '2', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\fsp${value}}`, suffix: '{\\fsp0}' };
    }
  },
  
  {
    id: 'color-primary',
    group: 'Color + Alpha',
    label: 'Primary Color (\\1c)',
    async apply() {
      const value = await assPromptValue({
        title: 'Primary Color',
        label: 'Pick a primary color',
        defaultValue: '00FFFFFF',
        type: 'color'
      });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\1c&H${value}&}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'color-secondary',
    group: 'Color + Alpha',
    label: 'Secondary Color (\\2c)',
    async apply() {
      const value = await assPromptValue({
        title: 'Secondary Color',
        label: 'Pick a secondary color',
        defaultValue: '000000FF',
        type: 'color'
      });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\2c&H${value}&}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'color-outline',
    group: 'Color + Alpha',
    label: 'Outline Color (\\3c)',
    async apply() {
      const value = await assPromptValue({
        title: 'Outline Color',
        label: 'Pick an outline color',
        defaultValue: '00000000',
        type: 'color'
      });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\3c&H${value}&}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'color-shadow',
    group: 'Color + Alpha',
    label: 'Shadow Color (\\4c)',
    async apply() {
      const value = await assPromptValue({
        title: 'Shadow Color',
        label: 'Pick a shadow color (alpha preserved)',
        defaultValue: '64000000',
        type: 'color'
      });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\4c&H${value}&}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'alpha-global',
    group: 'Color + Alpha',
    label: 'Global Alpha (\\alpha)',
    async apply() {
      const value = await assPromptValue({ title: 'Global Alpha', label: 'Enter alpha hex (AA)', defaultValue: '00' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\alpha&H${value}&}`, suffix: '{\\r}' };
    }
  },
  
  
  {
    id: 'alpha-outline',
    group: 'Color + Alpha',
    label: 'Outline Alpha (\\3a)',
    async apply() {
      const value = await assPromptValue({ title: 'Outline Alpha', label: 'Enter alpha hex (AA)', defaultValue: '00' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\3a&H${value}&}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'alpha-shadow',
    group: 'Color + Alpha',
    label: 'Shadow Alpha (\\4a)',
    async apply() {
      const value = await assPromptValue({ title: 'Shadow Alpha', label: 'Enter alpha hex (AA)', defaultValue: '00' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\4a&H${value}&}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'outline-uniform',
    group: 'Outline + Shadow',
    label: 'Outline Width (\\bord)',
    async apply() {
      const value = await assPromptValue({ title: 'Outline Width', label: 'Enter outline width', defaultValue: '2', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\bord${value}}`, suffix: '{\\bord0}' };
    }
  },
  
  
  
  
  
  {
    id: 'blur-gaussian',
    group: 'Outline + Shadow',
    label: 'Gaussian Blur (\\blur)',
    async apply() {
      const value = await assPromptValue({ title: 'Gaussian Blur', label: 'Enter blur amount (float)', defaultValue: '0.5', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\blur${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'blur-box',
    group: 'Outline + Shadow',
    label: 'Box Blur (\\be)',
    async apply() {
      const value = await assPromptValue({ title: 'Box Blur', label: 'Enter box blur passes (integer)', defaultValue: '1', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\be${value}}`, suffix: '{\\be0}' };
    }
  },
  {
    id: 'scale-x',
    group: 'Geometry',
    label: 'Scale X% (\\fscx)',
    async apply() {
      const value = await assPromptValue({ title: 'Scale X', label: 'Enter scale X percent', defaultValue: '100', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\fscx${value}}`, suffix: '{\\fscx100}' };
    }
  },
  {
    id: 'scale-y',
    group: 'Geometry',
    label: 'Scale Y% (\\fscy)',
    async apply() {
      const value = await assPromptValue({ title: 'Scale Y', label: 'Enter scale Y percent', defaultValue: '100', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\fscy${value}}`, suffix: '{\\fscy100}' };
    }
  },
  {
    id: 'rotate-z',
    group: 'Geometry',
    label: 'Rotate Z (\\frz)',
    async apply() {
      const value = await assPromptValue({ title: 'Rotate Z', label: 'Enter Z rotation (degrees)', defaultValue: '0', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\frz${value}}`, suffix: '{\\frz0}' };
    }
  },
  {
    id: 'rotate-x',
    group: 'Geometry',
    label: 'Rotate X (\\frx)',
    async apply() {
      const value = await assPromptValue({ title: 'Rotate X', label: 'Enter X rotation (degrees)', defaultValue: '0', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\frx${value}}`, suffix: '{\\frx0}' };
    }
  },
  {
    id: 'rotate-y',
    group: 'Geometry',
    label: 'Rotate Y (\\fry)',
    async apply() {
      const value = await assPromptValue({ title: 'Rotate Y', label: 'Enter Y rotation (degrees)', defaultValue: '0', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\fry${value}}`, suffix: '{\\fry0}' };
    }
  },
  {
    id: 'shear-x',
    group: 'Geometry',
    label: 'Shear X (\\fax)',
    async apply() {
      const value = await assPromptValue({ title: 'Shear X', label: 'Enter X shear factor', defaultValue: '0', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\fax${value}}`, suffix: '{\\fax0}' };
    }
  },
  {
    id: 'shear-y',
    group: 'Geometry',
    label: 'Shear Y (\\fay)',
    async apply() {
      const value = await assPromptValue({ title: 'Shear Y', label: 'Enter Y shear factor', defaultValue: '0', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\fay${value}}`, suffix: '{\\fay0}' };
    }
  },
  {
    id: 'position-fixed',
    group: 'Position + Alignment',
    label: 'Fixed Position (\\pos)',
    async apply() {
      const value = await assPromptValue({ title: 'Fixed Position', label: 'Enter coordinates x,y', defaultValue: '320,240' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\pos(${value})}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'position-move',
    group: 'Position + Alignment',
    label: 'Move (\\move)',
    async apply() {
      const value = await assPromptValue({ title: 'Move', label: 'Enter move args x1,y1,x2,y2[,t1,t2]', defaultValue: '0,0,320,240' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\move(${value})}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'position-origin',
    group: 'Position + Alignment',
    label: 'Origin (\\org)',
    async apply() {
      const value = await assPromptValue({ title: 'Origin', label: 'Enter origin x,y', defaultValue: '320,240' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\org(${value})}`, suffix: '{\\r}' };
    }
  },
  
  
  {
    id: 'timed-transform',
    group: 'Time + Animation',
    label: 'Timed Transform (\\t)',
    async apply() {
      const value = await assPromptValue({ title: 'Timed Transform', label: 'Enter \\t arguments ([t1,t2[,accel]], tags)', defaultValue: '0,1000,\\bord5' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\t(${value})}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'fade-simple',
    group: 'Time + Animation',
    label: 'Fade In/Out (\\fad)',
    async apply() {
      const value = await assPromptValue({ title: 'Fade In/Out', label: 'Enter fade in/out ms (tin,tout)', defaultValue: '200,200' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\fad(${value})}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'fade-advanced',
    group: 'Time + Animation',
    label: 'Advanced Fade (\\fade)',
    async apply() {
      const value = await assPromptValue({ title: 'Advanced Fade', label: 'Enter fade args (a1,a2,a3,t1,t2,t3,t4)', defaultValue: '0,255,0,0,500,1500,2000' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\fade(${value})}`, suffix: '{\\r}' };
    }
  },
  
  
  
  
  
  
  {
    id: 'karaoke-k',
    group: 'Karaoke Timing',
    label: 'Karaoke Fill (\\k)',
    async apply() {
      const value = await assPromptValue({ title: 'Karaoke Fill', label: 'Enter centiseconds', defaultValue: '50', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\k${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'karaoke-K',
    group: 'Karaoke Timing',
    label: 'K (\\K)',
    async apply() {
      const value = await assPromptValue({ title: 'K (\\K)', label: 'Enter centiseconds', defaultValue: '50', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\K${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'karaoke-kf',
    group: 'Karaoke Timing',
    label: 'Karaoke Fill Gradual (\\kf)',
    async apply() {
      const value = await assPromptValue({ title: 'Karaoke Fill Gradual', label: 'Enter centiseconds', defaultValue: '50', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\kf${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'karaoke-ko',
    group: 'Karaoke Timing',
    label: 'Karaoke Outline (\\ko)',
    async apply() {
      const value = await assPromptValue({ title: 'Karaoke Outline', label: 'Enter centiseconds', defaultValue: '50', allowEmpty: false });
      if (value === null) return null;
      return { type: 'wrap', prefix: `{\\ko${value}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'wrap-mode',
    group: 'Wrapping + Line Control',
    label: 'Wrap Mode (\\q)',
    async apply() {
      const value = await assPromptValue({ title: 'Wrap Mode', label: 'Enter wrap mode (0,1,2,3)', defaultValue: '0' });
      if (!value) return null;
      return { type: 'wrap', prefix: `{\\q${value}}`, suffix: '{\\q0}' };
    }
  },
  {
    id: 'line-break-hard',
    group: 'Wrapping + Line Control',
    label: 'Hard Line Break (\\N)',
    apply() {
      return { type: 'insert', content: '\\N', replaceSelection: true };
    }
  },
  {
    id: 'line-break-soft',
    group: 'Wrapping + Line Control',
    label: 'Soft Line Break (\\n)',
    apply() {
      return { type: 'insert', content: '\\n', replaceSelection: true };
    }
  },
  {
    id: 'non-breaking-space',
    group: 'Wrapping + Line Control',
    label: 'Non-breaking Space (\\h)',
    apply() {
      return { type: 'insert', content: '\\h', replaceSelection: true };
    }
  },
  
  
  
  
  
  
  {
    id: 'custom-override',
    group: 'Advanced',
    label: 'Custom Override Tag',
    async apply() {
      const value = await assPromptValue({ title: 'Custom Override', label: 'Enter override tags (without braces)', defaultValue: '\\blur1', returnRaw: true });
      if (!value) return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return { type: 'wrap', prefix: `{${trimmed.startsWith('\\') ? trimmed : `\\${trimmed}`}}`, suffix: '{\\r}' };
    }
  },
  {
    id: 'custom-raw',
    group: 'Advanced',
    label: 'Insert Raw Text',
    async apply() {
      const value = await assPromptValue({ title: 'Insert Raw Text', label: 'Enter raw text to insert', defaultValue: '', allowEmpty: true, returnRaw: true });
      if (value === null) return null;
      return { type: 'insert', content: value };
    }
  }
]);

function normalizeSubtitleColor(hex) {
  if (typeof hex !== 'string') return null;
  const value = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value.toLowerCase()}`;
  return null;
}

function loadSubtitleColorPrefs() {
  try {
    const raw = localStorage.getItem(TTS_SUBTITLE_COLOR_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    Object.entries(parsed).forEach(([key, val]) => {
      const color = normalizeSubtitleColor(val);
      if (!color) return;
      if (typeof key !== 'string' || !key) return;
      out[key.toLowerCase()] = color;
    });
    return out;
  } catch (err) {
    console.warn('loadSubtitleColorPrefs failed', err);
    return {};
  }
}

function saveSubtitleColorPrefs(map) {
  if (!map || typeof map !== 'object') {
    localStorage.removeItem(TTS_SUBTITLE_COLOR_STORE_KEY);
    return {};
  }
  const cleaned = {};
  Object.entries(map).forEach(([key, val]) => {
    if (typeof key !== 'string' || !key) return;
    const color = normalizeSubtitleColor(val);
    if (!color) return;
    cleaned[key.toLowerCase()] = color;
  });
  try {
    localStorage.setItem(TTS_SUBTITLE_COLOR_STORE_KEY, JSON.stringify(cleaned));
  } catch (err) {
    console.warn('saveSubtitleColorPrefs failed', err);
  }
  scheduleSubtitlePreviewRebuild();
  return cleaned;
}

function defaultSubtitleColorFor(name) {
  const key = subtitleCharacterKey(name);
  if (!key) return '#ffffff';
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  const sat = 70;
  const light = 60;
  const toHex = (c) => {
    const hex = Math.round(c * 255).toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  };
  const h = hue / 360;
  const s = sat / 100;
  const l = light / 100;
  const hueToRgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1/6) return p + (q - p) * 6 * tt;
    if (tt < 1/2) return q;
    if (tt < 2/3) return p + (q - p) * (2/3 - tt) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1/3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1/3);
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function subtitleColorForCharacter(name, colorPrefs) {
  const key = subtitleCharacterKey(name);
  if (!key) return '#ffffff';
  const stored = colorPrefs?.[key];
  return normalizeSubtitleColor(stored) || defaultSubtitleColorFor(name);
}

// ---------- Tiny TTS modal (replaces window.prompt) ----------
async function showTTSDialog() {
  // fetch voices
  let voices = [];
  try { voices = await window.suAPI.ttsList(); } catch {}

  // overlay
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:grid;place-items:center;';
  const box = document.createElement('div');
  box.style.cssText = 'width:min(520px,90vw);background:#0f141a;border:1px solid #2a2f36;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);padding:14px;display:grid;gap:10px;font:14px/1.4 system-ui;';
  box.innerHTML = `
    <div style="font-weight:600">Generate TTS</div>
    <div data-role="char-field" style="display:flex;flex-direction:column;gap:6px;position:relative;">
      <label style="display:flex;flex-direction:column;gap:6px;color:#c8d1da;font-size:13px;">
        <span style="font-weight:500;">Character</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <input data-role="character" placeholder="Enter character name..." style="flex:1;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:6px 8px;">
          <button data-act="toggle-char-list" title="Saved characters" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:6px;padding:6px 10px;cursor:pointer;">&#9662;</button>
        </div>
      </label>
      <div data-role="character-list" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#0f141a;border:1px solid #2a2f36;border-radius:8px;padding:4px;max-height:180px;overflow:auto;z-index:20;box-shadow:0 10px 30px rgba(0,0,0,.45);"></div>
    </div>
    <textarea data-role="tts-text" rows="4" placeholder="Type what to say..." style="width:100%;resize:vertical;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:8px;"></textarea>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;gap:6px;align-items:center">Voice
        <select data-role="voice" style="background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:4px 6px;min-width:220px"></select>
      </label>
      <label style="display:flex;gap:6px;align-items:center">Rate
        <input data-role="rate" type="number" min="-10" max="10" value="0" style="width:70px;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:4px 6px;">
      </label>
      <label style="display:flex;gap:6px;align-items:center">Volume
        <input data-role="volume" type="number" min="0" max="100" value="100" style="width:80px;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:4px 6px;">
      </label>
    </div>
    <div style="display:grid;gap:10px;">
      <div data-role="srt-container" style="display:none;gap:6px;">
        <label style="display:flex;flex-direction:column;gap:6px;color:#c8d1da;font-size:13px;">
          <span style="font-weight:500;">Subtitle Text (used for .srt and burn-in)</span>
          <textarea data-role="subtitle-text" rows="3" placeholder="Defaults to the spoken text" style="width:100%;resize:vertical;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:8px;"></textarea>
        </label>
        <div data-role="srt-preview-wrap" style="display:none;background:#10161f;border:1px solid #2a2f36;border-radius:8px;padding:12px;">
          <div data-role="subtitle-preview" style="min-height:56px;color:#f7f9ff;font-size:18px;line-height:1.35;text-align:center;white-space:pre-wrap;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;opacity:0.6;">Subtitle preview appears here.</div>
        </div>
      </div>
      <div data-role="ass-container" style="display:none;gap:6px;border:1px solid #2a2f36;border-radius:8px;padding:10px;background:#101620;">
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:space-between;">
          <span style="font-weight:500;color:#d3dcf0;">ASS Preview & Overrides</span>
          <div style="display:flex;gap:6px;">
            <button data-act="ass-reset" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:6px;padding:4px 8px;cursor:pointer;">Reset to Plain Text</button>
            <button data-act="ass-strip" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:6px;padding:4px 8px;cursor:pointer;">Remove Override Tags</button>
          </div>
        </div>
        <textarea data-role="subtitle-ass" rows="4" placeholder="ASS-formatted text. Highlight text here to apply effects." style="width:100%;resize:vertical;background:#0f141a;border:1px solid #2a2f36;color:#f3f6ff;border-radius:8px;padding:8px;font-family:'Fira Code',Consolas,monospace;font-size:13px;line-height:1.5;"></textarea>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <select data-role="ass-effect" style="flex:1;min-width:220px;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:6px;">
            <option value="">Select ASS effect...</option>
          </select>
          <button data-act="ass-apply" style="background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;">Apply Effect</button>
          <button data-act="ass-clear-meta" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:6px;padding:6px 10px;cursor:pointer;">Clear Line Overrides</button>
        </div>
        <div data-role="ass-meta-summary" style="font-size:12px;color:#9aa6b8;">No line overrides applied.</div>
        <div data-role="ass-warning" style="font-size:12px;color:#ff9f43;background:#2b1a00;border:1px solid #684015;border-radius:6px;padding:6px;display:none;">
          ASS effects only appear when you export a .ass subtitle file. .srt and burn-in exports ignore override tags.
        </div>
      </div>
    </div>
    <div data-role="preview-toggle-row" style="display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-end;align-items:center;font-size:13px;color:#c8d1da;">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" data-role="toggle-srt-preview" style="accent-color:#2a6df6;"> Preview SRT/Burn-in subtitles
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" data-role="toggle-ass-preview" style="accent-color:#2a6df6;"> Preview ASS subtitles
      </label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button data-act="cancel" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:8px;padding:6px 10px;">Cancel</button>
      <button data-act="ok" style="background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:8px;padding:6px 12px;">Generate</button>
    </div>
  `;
  ov.appendChild(box);
  document.body.appendChild(ov);

  const ttsInput = box.querySelector('[data-role="tts-text"]');
  const subtitleInput = box.querySelector('[data-role="subtitle-text"]');
  const srtContainer = box.querySelector('[data-role="srt-container"]');
  const subtitleAssInput = box.querySelector('[data-role="subtitle-ass"]');
  const subtitlePreviewWrap = box.querySelector('[data-role="srt-preview-wrap"]');
  const subtitlePreview = box.querySelector('[data-role="subtitle-preview"]');
  const assContainer = box.querySelector('[data-role="ass-container"]');
  const assEffectSelect = box.querySelector('[data-role="ass-effect"]');
  const assApplyBtn = box.querySelector('[data-act="ass-apply"]');
  const assResetBtn = box.querySelector('[data-act="ass-reset"]');
  const assStripBtn = box.querySelector('[data-act="ass-strip"]');
  const assClearMetaBtn = box.querySelector('[data-act="ass-clear-meta"]');
  const assWarning = box.querySelector('[data-role="ass-warning"]');
  const assMetaSummary = box.querySelector('[data-role="ass-meta-summary"]');
  const srtPreviewToggle = box.querySelector('[data-role="toggle-srt-preview"]');
  const assPreviewToggle = box.querySelector('[data-role="toggle-ass-preview"]');
  const voiceSel = box.querySelector('[data-role="voice"]');
  const rateIn   = box.querySelector('[data-role="rate"]');
  const volIn    = box.querySelector('[data-role="volume"]');
  const charField = box.querySelector('[data-role="char-field"]');
  const charInput = box.querySelector('[data-role="character"]');
  const charMenu  = box.querySelector('[data-role="character-list"]');
  const charToggle = box.querySelector('[data-act="toggle-char-list"]');

  if (ttsInput) ttsInput.addEventListener('keydown', e => e.stopPropagation());
  if (subtitleInput) subtitleInput.addEventListener('keydown', e => e.stopPropagation());
  if (subtitleAssInput) subtitleAssInput.addEventListener('keydown', e => e.stopPropagation());

  const subtitlePlaceholder = 'Subtitle preview appears here.';
  let subtitleManuallyEdited = !!(subtitleInput && subtitleInput.value);
  let assManuallyEdited = !!(subtitleAssInput && subtitleAssInput.value);
  let assMeta = {};
  let assLayoutPreview = null;

  const promptAssInput = ({
    title = 'ASS Override',
    label = 'Value',
    defaultValue = '',
    placeholder = '',
    allowEmpty = false,
    returnRaw = false,
    type = 'text'
  } = {}) => {
    return new Promise((resolve) => {
      if (type === 'color') {
        const overlay = document.createElement('div');
        overlay.dataset.role = 'ass-prompt-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,20,0.7);z-index:11000;display:grid;place-items:center;';

        const panel = document.createElement('div');
        panel.style.cssText = 'width:min(520px,95vw);background:#0f141a;border:1px solid #2a2f36;border-radius:12px;padding:18px;display:grid;gap:16px;font:14px/1.4 system-ui;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight:600;color:#d9e2f5;';
        titleEl.textContent = title || 'Select Color';
        panel.appendChild(titleEl);

        const pickerWrap = document.createElement('div');
        pickerWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start;';

        const svContainer = document.createElement('div');
        svContainer.style.cssText = 'position:relative;width:240px;height:220px;border-radius:10px;overflow:hidden;cursor:crosshair;';

        const svBase = document.createElement('div');
        svBase.style.cssText = 'position:absolute;inset:0;';
        const svWhite = document.createElement('div');
        svWhite.style.cssText = 'position:absolute;inset:0;background:linear-gradient(90deg,#ffffff 0%,rgba(255,255,255,0) 100%);';
        const svBlack = document.createElement('div');
        svBlack.style.cssText = 'position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,#000000 100%);';
        const svIndicator = document.createElement('div');
        svIndicator.style.cssText = 'position:absolute;width:14px;height:14px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,0.45);pointer-events:none;transform:translate(-50%, -50%);';
        svContainer.append(svBase, svWhite, svBlack, svIndicator);

        const hueContainer = document.createElement('div');
        hueContainer.style.cssText = 'position:relative;height:220px;width:28px;border-radius:999px;overflow:hidden;cursor:pointer;background:linear-gradient(0deg,#ff0000 0%,#ff00ff 16%,#0000ff 33%,#00ffff 50%,#00ff00 66%,#ffff00 83%,#ff0000 100%);';
        const hueHandle = document.createElement('div');
        hueHandle.style.cssText = 'position:absolute;left:50%;width:34px;height:10px;background:rgba(9,14,20,0.85);border:1px solid rgba(255,255,255,0.55);border-radius:999px;transform:translate(-50%, -50%);box-shadow:0 2px 4px rgba(0,0,0,0.45);pointer-events:none;';
        hueContainer.appendChild(hueHandle);

        pickerWrap.append(svContainer, hueContainer);

        const controls = document.createElement('div');
        controls.style.cssText = 'flex:1;min-width:200px;display:grid;gap:12px;';

        const labelHeader = document.createElement('div');
        labelHeader.style.cssText = 'font-size:13px;font-weight:500;color:#c8d1da;';
        labelHeader.textContent = label || 'Color';
        controls.appendChild(labelHeader);

        const hexLabel = document.createElement('label');
        hexLabel.style.cssText = 'display:grid;gap:6px;color:#c8d1da;font-size:12px;';
        const hexSpan = document.createElement('span');
        hexSpan.textContent = 'ASS hex (AABBGGRR)';
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.style.cssText = 'background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:6px;';
        hexLabel.append(hexSpan, hexInput);
        controls.appendChild(hexLabel);

        const preview = document.createElement('div');
        preview.style.cssText = 'height:52px;border-radius:8px;border:1px solid #2a2f36;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:20px;letter-spacing:0.02em;';
        preview.textContent = 'Aa';
        controls.appendChild(preview);

        const cssHexLabel = document.createElement('div');
        cssHexLabel.style.cssText = 'font-size:12px;color:#9aa6b8;font-family:"Fira Code",monospace;';
        controls.appendChild(cssHexLabel);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:12px;color:#8fa2b7;';
        hint.textContent = 'Tip: Drag the square for saturation/value, the bar for hue, or paste values like #RRGGBB or &H00BBGGRR&.';
        controls.appendChild(hint);

        pickerWrap.appendChild(controls);
        panel.appendChild(pickerWrap);

        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:6px;padding:6px 12px;cursor:pointer;';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = 'Apply';
        okBtn.style.cssText = 'background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:6px;padding:6px 16px;cursor:pointer;';
        buttonRow.append(cancelBtn, okBtn);
        panel.appendChild(buttonRow);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const initialComponents = parseAssColorComponents(String(defaultValue ?? '')) || ASS_COLOR_DEFAULT;
        const defaultWasBlank = !defaultValue || !defaultValue.trim();
        const defaultWasWhite = initialComponents.bgr?.toUpperCase() === 'FFFFFF';
        const initialCss = assComponentsToCssHex(initialComponents);
        const initialRgb = hexToRgb(initialCss || '#ffffff');
        const initialHsv = rgbToHsv(initialRgb.r, initialRgb.g, initialRgb.b);

        const state = {
          alpha: initialComponents.alpha || '00',
          h: (initialHsv.s < 0.001 && (defaultWasBlank || defaultWasWhite)) ? 210 : initialHsv.h || 0,
          s: defaultWasBlank ? 0.9 : (defaultWasWhite && initialHsv.s < 0.001 ? 0.9 : clamp01(initialHsv.s)),
          v: defaultWasBlank ? 0.5 : (defaultWasWhite && initialHsv.v > 0.95 ? 0.5 : clamp01(initialHsv.v || 0.5))
        };

        const updateSvIndicator = () => {
          svIndicator.style.left = `${state.s * 100}%`;
          svIndicator.style.top = `${(1 - state.v) * 100}%`;
        };

        const updateHueIndicator = () => {
          hueHandle.style.top = `${(1 - state.h / 360) * 100}%`;
        };

        const updateGradients = () => {
          svBase.style.background = `hsl(${Math.round(state.h)}, 100%, 50%)`;
        };

        const applyStateToOutputs = () => {
          const rgb = hsvToRgb(state.h, state.s, state.v);
          const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
          const comps = cssHexToAssComponents(hex, state.alpha) || ASS_COLOR_DEFAULT;
          hexInput.value = assComponentsToString(comps);
          preview.style.background = hex;
          const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
          preview.style.color = luminance > 0.65 ? '#0f141a' : '#f5f9ff';
          cssHexLabel.textContent = `CSS: ${hex.toUpperCase()}`;
          updateSvIndicator();
          updateHueIndicator();
        };

        let svDragging = false;
        let svPointerId = null;
        const handleSvPointerMove = (evt) => {
          if (!svDragging) return;
          const rect = svContainer.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const sRaw = (evt.clientX - rect.left) / rect.width;
          const vRaw = (rect.bottom - evt.clientY) / rect.height;
          state.s = clamp01(sRaw);
          state.v = clamp01(vRaw);
          applyStateToOutputs();
        };
        const stopSvDrag = () => {
          if (!svDragging) return;
          svDragging = false;
          if (svPointerId != null && svContainer.hasPointerCapture?.(svPointerId)) {
            try { svContainer.releasePointerCapture(svPointerId); } catch {}
          }
          svPointerId = null;
          window.removeEventListener('pointermove', handleSvPointerMove);
          window.removeEventListener('pointerup', stopSvDrag);
          window.removeEventListener('pointercancel', stopSvDrag);
        };
        const startSvDrag = (evt) => {
          evt.preventDefault();
          svDragging = true;
          svPointerId = evt.pointerId;
          if (svContainer.setPointerCapture) {
            try { svContainer.setPointerCapture(evt.pointerId); } catch {}
          }
          handleSvPointerMove(evt);
          window.addEventListener('pointermove', handleSvPointerMove);
          window.addEventListener('pointerup', stopSvDrag);
          window.addEventListener('pointercancel', stopSvDrag);
        };
        svContainer.addEventListener('pointerdown', startSvDrag);

        let hueDragging = false;
        let huePointerId = null;
        const handleHuePointerMove = (evt) => {
          if (!hueDragging) return;
          const rect = hueContainer.getBoundingClientRect();
          if (!rect.height) return;
          const ratio = clamp01((rect.bottom - evt.clientY) / rect.height);
          state.h = ratio * 360;
          updateGradients();
          applyStateToOutputs();
        };
        const stopHueDrag = () => {
          if (!hueDragging) return;
          hueDragging = false;
          if (huePointerId != null && hueContainer.hasPointerCapture?.(huePointerId)) {
            try { hueContainer.releasePointerCapture(huePointerId); } catch {}
          }
          huePointerId = null;
          window.removeEventListener('pointermove', handleHuePointerMove);
          window.removeEventListener('pointerup', stopHueDrag);
          window.removeEventListener('pointercancel', stopHueDrag);
        };
        const startHueDrag = (evt) => {
          evt.preventDefault();
          hueDragging = true;
          huePointerId = evt.pointerId;
          if (hueContainer.setPointerCapture) {
            try { hueContainer.setPointerCapture(evt.pointerId); } catch {}
          }
          handleHuePointerMove(evt);
          window.addEventListener('pointermove', handleHuePointerMove);
          window.addEventListener('pointerup', stopHueDrag);
          window.addEventListener('pointercancel', stopHueDrag);
        };
        hueContainer.addEventListener('pointerdown', startHueDrag);

        const close = (value) => {
          stopSvDrag();
          stopHueDrag();
          overlay.remove();
          document.removeEventListener('keydown', onKey, true);
          resolve(value);
        };

        const submit = () => {
          const raw = (hexInput.value || '').trim();
          if (!raw && allowEmpty) {
            close(returnRaw ? raw : raw);
            return;
          }
          const parsed = parseAssColorComponents(raw);
          if (!parsed) {
            hexInput.focus({ preventScroll: true });
            hexInput.select();
            return;
          }
          const finalString = assComponentsToString(parsed);
          close(returnRaw ? finalString : finalString);
        };

        const onKey = (ev) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            close(null);
          } else if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            submit();
          }
        };

        hexInput.addEventListener('input', () => {
          const parsed = parseAssColorComponents(hexInput.value);
          if (!parsed) return;
          const css = assComponentsToCssHex(parsed);
          const rgb = hexToRgb(css || '#ffffff');
          const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
          state.alpha = parsed.alpha;
          if (Number.isFinite(hsv.h)) state.h = hsv.h;
          state.s = clamp01(hsv.s);
          state.v = clamp01(hsv.v);
          updateGradients();
          applyStateToOutputs();
        });
        hexInput.addEventListener('blur', () => {
          const parsed = parseAssColorComponents(hexInput.value);
          if (parsed) {
            hexInput.value = assComponentsToString(parsed);
          } else {
            const rgb = hsvToRgb(state.h, state.s, state.v);
            const fallbackHex = rgbToHex(rgb.r, rgb.g, rgb.b);
            const fallbackComps = cssHexToAssComponents(fallbackHex, state.alpha) || ASS_COLOR_DEFAULT;
            hexInput.value = assComponentsToString(fallbackComps);
          }
          updateGradients();
          applyStateToOutputs();
        });
        hexInput.addEventListener('keydown', (ev) => ev.stopPropagation());

        cancelBtn.addEventListener('click', () => close(null));
        okBtn.addEventListener('click', submit);
        overlay.addEventListener('click', (ev) => {
          if (ev.target === overlay) close(null);
        });

        document.addEventListener('keydown', onKey, true);

        updateGradients();
        applyStateToOutputs();
        setTimeout(() => {
          hexInput.focus({ preventScroll: true });
          hexInput.select();
        }, 0);

        return;
      }

      const overlay = document.createElement('div');
      overlay.dataset.role = 'ass-prompt-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,20,0.7);z-index:11000;display:grid;place-items:center;';
      const panel = document.createElement('div');
      panel.style.cssText = 'width:min(360px,90vw);background:#0f141a;border:1px solid #2a2f36;border-radius:10px;padding:14px;display:grid;gap:10px;font:14px/1.4 system-ui;';
      const titleEl = document.createElement('div');
      titleEl.style.fontWeight = '600';
      titleEl.textContent = title;
      const labelWrap = document.createElement('label');
      labelWrap.style.cssText = 'display:grid;gap:6px;color:#c8d1da;font-size:13px;';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue ?? '';
      if (placeholder) input.placeholder = placeholder;
      input.style.cssText = 'background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:6px;padding:6px;';
      labelWrap.append(labelSpan, input);
      const buttonRow = document.createElement('div');
      buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:6px;padding:6px 10px;cursor:pointer;';
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.textContent = 'Apply';
      okBtn.style.cssText = 'background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;';
      buttonRow.append(cancelBtn, okBtn);
      panel.append(titleEl, labelWrap, buttonRow);
      overlay.appendChild(panel);

      const close = (value) => {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };

      const submit = () => {
        const raw = input.value ?? '';
        const processed = returnRaw ? raw : raw.trim();
        const isEmpty = returnRaw ? (raw.length === 0) : (processed.length === 0);
        if (!allowEmpty && isEmpty) {
          input.focus({ preventScroll: true });
          return;
        }
        close(returnRaw ? raw : processed);
      };

      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          close(null);
        } else if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          submit();
        }
      };

      cancelBtn.addEventListener('click', () => close(null));
      okBtn.addEventListener('click', submit);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) close(null);
      });
      input.addEventListener('keydown', (ev) => ev.stopPropagation());
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(overlay);
      setTimeout(() => {
        input.focus({ preventScroll: true });
        input.select();
      }, 0);
    });
  };

  setAssPromptHandler(promptAssInput);

  let previewMode = getSubtitlePreviewMode() ?? INITIAL_TTS_PREVIEW_PREFS.mode ?? null;
  let srtPreviewEnabled = previewMode === 'srt';
  let assPreviewEnabled = previewMode === 'ass';

  const syncPreviewToggles = () => {
    if (srtPreviewToggle) srtPreviewToggle.checked = srtPreviewEnabled;
    if (assPreviewToggle) assPreviewToggle.checked = assPreviewEnabled;
  };

  const applyPreviewMode = (mode) => {
    const normalized = mode === 'ass' ? 'ass' : (mode === 'srt' ? 'srt' : null);
    previewMode = normalized;
    srtPreviewEnabled = normalized === 'srt';
    assPreviewEnabled = normalized === 'ass';
    syncPreviewToggles();
    setSubtitlePreviewMode(normalized, { persist: true });
    updatePreviewVisibility();
  };

  const updateSubtitlePreview = () => {
    if (!subtitlePreview) return;
    const spokenVal = (ttsInput?.value || '').trim();
    const subtitleValRaw = subtitleInput?.value ?? '';
    const subtitleVal = subtitleValRaw.trim();
    const display = subtitleVal || spokenVal;
    if (display) {
      subtitlePreview.textContent = display;
      subtitlePreview.style.opacity = '1';
    } else {
      subtitlePreview.textContent = subtitlePlaceholder;
      subtitlePreview.style.opacity = '0.6';
    }
  };

  const updateAssMetaSummary = () => {
    if (!assMetaSummary) return;
    const parts = [];
    if (assMeta.styleName) parts.push(`Style: ${assMeta.styleName}`);
    if (assMeta.marginL != null) parts.push(`MarginL=${assMeta.marginL}`);
    if (assMeta.marginR != null) parts.push(`MarginR=${assMeta.marginR}`);
    if (assMeta.marginV != null) parts.push(`MarginV=${assMeta.marginV}`);
    if (!parts.length) {
      assMetaSummary.textContent = 'No line overrides applied.';
    } else {
      assMetaSummary.textContent = `Line overrides: ${parts.join(', ')}`;
    }
  };

  const hasAssFormatting = () => {
    const text = subtitleAssInput?.value || '';
    const hasOverrides = /{\s*\\/.test(text);
    const hasSpecialEscapes = /\\[NnhkKo]/.test(text);
    const hasDrawing = /{\\p\d/.test(text);
    const hasMeta = assMeta && Object.keys(assMeta).length > 0;
    return hasOverrides || hasSpecialEscapes || hasDrawing || hasMeta;
  };

  const updateAssWarning = () => {
    if (!assWarning) return;
    assWarning.style.display = assPreviewEnabled && hasAssFormatting() ? 'block' : 'none';
  };

  const updatePreviewVisibility = () => {
    if (srtContainer) {
      srtContainer.style.display = srtPreviewEnabled ? 'grid' : 'none';
    }
    if (subtitlePreviewWrap) {
      subtitlePreviewWrap.style.display = srtPreviewEnabled ? '' : 'none';
    }
    if (assContainer) {
      assContainer.style.display = assPreviewEnabled ? 'grid' : 'none';
    }
    updateAssWarning();
    if (srtPreviewEnabled) updateSubtitlePreview();
    if (assPreviewEnabled) renderAssPreview();
  };

  if (subtitleInput) {
    subtitleInput.addEventListener('input', () => {
      subtitleManuallyEdited = subtitleInput.value.length > 0;
      if (!assManuallyEdited && subtitleAssInput) {
        subtitleAssInput.value = subtitleInput.value;
      }
      if (srtPreviewEnabled) updateSubtitlePreview();
      updateAssWarning();
    });
  }

  const renderAssPreview = () => {
    if (!assContainer) return;
    if (!assPreviewEnabled) {
      if (assLayoutPreview) {
        assLayoutPreview.remove();
        assLayoutPreview = null;
      }
      return;
    }

    if (!assLayoutPreview) {
      assLayoutPreview = document.createElement('div');
      assLayoutPreview.dataset.role = 'ass-live-preview';
      assLayoutPreview.style.cssText = [
        'margin-top:6px',
        'padding:12px',
        'border:1px solid #2a2f36',
        'border-radius:8px',
        'background:#10161f',
        'color:#f7f9ff',
        'font:16px/1.45 "Inter", "Segoe UI", sans-serif',
        'display:flex',
        'flex-direction:column',
        'gap:10px',
        'max-height:260px',
        'overflow:auto'
      ].join(';');
      assContainer.appendChild(assLayoutPreview);
    }

    assLayoutPreview.innerHTML = '';

    const stageWidth = 640;
    const stageHeight = 360;
    const rawText = (subtitleAssInput?.value || subtitleInput?.value || ttsInput?.value || '').replace(/\r\n/g, '\n');

    const baseStyle = {
      fontFamily: 'Arial, sans-serif',
      fontSize: 28,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      color: '#f7f9ff',
      alpha: 1,
      secondaryColor: null,
      secondaryAlpha: 0.45,
      letterSpacing: 0,
      outlineColor: '#000000',
      outlineAlpha: 1,
      outlineWidth: 0,
      shadowColor: '#000000',
      shadowAlpha: 1,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowBlur: 0,
      karaoke: null
    };

    let currentStyle = { ...baseStyle };
    const tagSummary = new Set();
    const metaSummary = [];
    const effectNotes = [];
    let positionInfo = null;
    let wrapModeValue = null;
    let fadeInfo = null;

    if (assMeta?.styleName) metaSummary.push(`Style=${assMeta.styleName}`);
    if (assMeta?.marginL) metaSummary.push(`MarginL=${assMeta.marginL}`);
    if (assMeta?.marginR) metaSummary.push(`MarginR=${assMeta.marginR}`);
    if (assMeta?.marginV) metaSummary.push(`MarginV=${assMeta.marginV}`);

    const parseAssColor = (value) => {
      if (!value) return null;
      const match = value.match(/&H([0-9a-fA-F]{6,8})/);
      if (!match) return null;
      let hexRaw = match[1];
      if (hexRaw.length > 8) hexRaw = hexRaw.slice(-8);
      if (hexRaw.length < 6) hexRaw = hexRaw.padStart(6, '0');
      if (hexRaw.length === 7) hexRaw = `0${hexRaw}`;
      if (hexRaw.length === 6) {
        const bb = hexRaw.slice(0, 2);
        const gg = hexRaw.slice(2, 4);
        const rr = hexRaw.slice(4, 6);
        return { color: `#${rr}${gg}${bb}`.toLowerCase(), alpha: null };
      }
      if (hexRaw.length === 8) {
        const aa = hexRaw.slice(0, 2);
        const bb = hexRaw.slice(2, 4);
        const gg = hexRaw.slice(4, 6);
        const rr = hexRaw.slice(6, 8);
        const alpha = 1 - Math.min(255, Math.max(0, parseInt(aa, 16))) / 255;
        return { color: `#${rr}${gg}${bb}`.toLowerCase(), alpha };
      }
      return null;
    };

    const hexToRgba = (value, alpha = 1) => {
      if (!value || typeof value !== 'string') return value;
      if (/^rgba\(/i.test(value)) return value;
      const hex = value.startsWith('#') ? value.slice(1) : value;
      if (hex.length !== 6 && hex.length !== 8) return value;
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      let a = alpha;
      if (hex.length === 8) {
        a = Math.min(1, Math.max(0, parseInt(hex.slice(6, 8), 16) / 255));
      } else {
        a = Math.min(1, Math.max(0, alpha));
      }
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    };

    const resolveColor = (color, alphaOverride = null) => {
      if (!color) return color;
      if (alphaOverride == null || alphaOverride >= 0.999) return color;
      return hexToRgba(color, alphaOverride);
    };

    const stage = document.createElement('div');
    stage.dataset.role = 'ass-preview-stage';
    stage.style.cssText = [
      'position:relative',
      'width:100%',
      'aspect-ratio:16/9',
      'background:linear-gradient(180deg,#131a24 0%,#0c1119 100%)',
      'border-radius:6px',
      'border:1px solid rgba(255,255,255,0.07)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:18px',
      'box-sizing:border-box',
      'overflow:hidden'
    ].join(';');

    const content = document.createElement('div');
    content.dataset.role = 'ass-preview-line';
    content.style.cssText = [
      'display:inline-block',
      'max-width:100%',
      'text-align:center',
      'white-space:pre-wrap',
      'word-break:normal'
    ].join(';');

    stage.appendChild(content);

    const applyTag = (tag) => {
      const parts = tag.split(/\\+/).filter(Boolean);
      for (const partRaw of parts) {
        const part = partRaw.trim();
        if (!part) continue;
        const lower = part.toLowerCase();
        if (lower === 'r' || lower === 'r0') {
          currentStyle = { ...baseStyle };
          continue;
        }
        if (lower.startsWith('r')) {
          currentStyle = { ...baseStyle };
          continue;
        }
        if (lower.startsWith('b')) {
          const val = part.slice(1);
          currentStyle.bold = val !== '0';
          tagSummary.add('Bold');
          continue;
        }
        if (lower.startsWith('i')) {
          const val = part.slice(1);
          currentStyle.italic = val !== '0';
          tagSummary.add('Italic');
          continue;
        }
        if (lower.startsWith('u')) {
          const val = part.slice(1);
          currentStyle.underline = val !== '0';
          tagSummary.add('Underline');
          continue;
        }
        if (lower.startsWith('s')) {
          const val = part.slice(1);
          currentStyle.strike = val !== '0';
          tagSummary.add('Strikeout');
          continue;
        }
        if (lower.startsWith('fn')) {
          currentStyle.fontFamily = part.slice(2) || baseStyle.fontFamily;
          tagSummary.add('Font');
          continue;
        }
        if (lower.startsWith('fs')) {
          const val = parseInt(part.slice(2), 10);
          if (Number.isFinite(val) && val > 0) {
            currentStyle.fontSize = Math.max(8, Math.min(96, Math.round(val / 2)));
            tagSummary.add('Size');
          }
          continue;
        }
        if (/^[1234]?c/i.test(part)) {
          const parsed = parseAssColor(part.replace(/^[1234]?c/i, ''));
          if (parsed) {
            if (lower.startsWith('3c')) {
              currentStyle.outlineColor = parsed.color;
              if (parsed.alpha != null) currentStyle.outlineAlpha = parsed.alpha;
              tagSummary.add('Outline Color');
            } else if (lower.startsWith('4c')) {
              currentStyle.shadowColor = parsed.color;
              if (parsed.alpha != null) currentStyle.shadowAlpha = parsed.alpha;
              tagSummary.add('Shadow Color');
            } else if (lower.startsWith('2c')) {
              currentStyle.secondaryColor = parsed.color;
              if (parsed.alpha != null) currentStyle.secondaryAlpha = parsed.alpha;
              tagSummary.add('Secondary Color');
            } else {
              currentStyle.color = parsed.color;
              if (parsed.alpha != null) currentStyle.alpha = parsed.alpha;
              tagSummary.add('Primary Color');
            }
          }
          continue;
        }
        if (/^[1234]a/i.test(part) || lower.startsWith('alpha')) {
          const match = part.match(/&H([0-9a-fA-F]{2})/);
          if (match) {
            const aa = parseInt(match[1], 16);
            const alpha = 1 - Math.min(255, Math.max(0, aa)) / 255;
            if (lower.startsWith('3a')) {
              currentStyle.outlineAlpha = alpha;
              tagSummary.add('Outline Alpha');
            } else if (lower.startsWith('4a')) {
              currentStyle.shadowAlpha = alpha;
              tagSummary.add('Shadow Alpha');
            } else {
              currentStyle.alpha = alpha;
              tagSummary.add('Alpha');
            }
          }
          continue;
        }
        if (lower.startsWith('fsp')) {
          const val = parseInt(part.slice(3), 10);
          if (Number.isFinite(val)) {
            currentStyle.letterSpacing = val;
            tagSummary.add('Letter Spacing');
          }
          continue;
        }
        if (lower.startsWith('bord')) {
          const val = parseFloat(part.slice(4));
          if (Number.isFinite(val)) {
            currentStyle.outlineWidth = Math.max(0, val);
            tagSummary.add('Outline Width');
          }
          continue;
        }
        if (lower.startsWith('shad')) {
          const val = parseFloat(part.slice(4));
          if (Number.isFinite(val)) {
            currentStyle.shadowOffsetX = val;
            currentStyle.shadowOffsetY = val;
            tagSummary.add('Shadow Offset');
          }
          continue;
        }
        if (lower.startsWith('xshad')) {
          const val = parseFloat(part.slice(5));
          if (Number.isFinite(val)) {
            currentStyle.shadowOffsetX = val;
            tagSummary.add('Shadow Offset');
          }
          continue;
        }
        if (lower.startsWith('yshad')) {
          const val = parseFloat(part.slice(5));
          if (Number.isFinite(val)) {
            currentStyle.shadowOffsetY = val;
            tagSummary.add('Shadow Offset');
          }
          continue;
        }
        if (lower.startsWith('blur')) {
          const val = parseFloat(part.slice(4));
          if (Number.isFinite(val)) {
            currentStyle.shadowBlur = Math.max(0, val);
            tagSummary.add('Blur');
          }
          continue;
        }
        if (lower.startsWith('fr') || lower.startsWith('fax') || lower.startsWith('fay')) {
          tagSummary.add('Transform');
          continue;
        }
        if (/^k[fFoO]?/i.test(part) || /^K/.test(part)) {
          const firstChar = part[0] || '';
          const type = lower.startsWith('kf')
            ? 'KF'
            : lower.startsWith('ko')
            ? 'KO'
            : firstChar === 'K'
            ? 'K'
            : 'k';
          const valMatch = part.match(/\d+/);
          const duration = valMatch ? parseInt(valMatch[0], 10) : 0;
          currentStyle.karaoke = duration > 0 ? { type, duration } : null;
          if (valMatch) effectNotes.push(`Karaoke ${type.toUpperCase()}: ${valMatch[0]}`);
          tagSummary.add('Karaoke');
          continue;
        }
        if (lower.startsWith('fad')) {
          const args = part.match(/\\fad\(([^)]+)\)/i);
          if (args) {
            effectNotes.push(`Fade in/out: ${args[1]}`);
            tagSummary.add('Fade');
            fadeInfo = { type: 'fad', value: args[1] };
          }
          continue;
        }
        if (lower.startsWith('fade')) {
          const args = part.match(/\\fade\(([^)]+)\)/i);
          if (args) {
            effectNotes.push(`Fade: ${args[1]}`);
            tagSummary.add('Fade');
            fadeInfo = { type: 'fade', value: args[1] };
          }
          continue;
        }
        if (lower.startsWith('pos')) {
          const args = part.match(/\\pos\(([^)]+)\)/i);
          if (args) {
            effectNotes.push(`Position: ${args[1]}`);
            tagSummary.add('Position');
            const coords = args[1].split(',').map((n) => parseFloat(n.trim()));
            if (coords.length >= 2 && coords.every((n) => Number.isFinite(n))) {
              positionInfo = { x: coords[0], y: coords[1] };
            }
          }
          continue;
        }
        if (lower.startsWith('move')) {
          const args = part.match(/\\move\(([^)]+)\)/i);
          if (args) {
            effectNotes.push(`Move: ${args[1]}`);
            tagSummary.add('Move');
            const coords = args[1].split(',').map((n) => parseFloat(n.trim()));
            if (coords.length >= 4 && coords.slice(0, 4).every((n) => Number.isFinite(n))) {
              positionInfo = { x: coords[2], y: coords[3] };
            }
          }
          continue;
        }
        if (lower.startsWith('org')) {
          const args = part.match(/\\org\(([^)]+)\)/i);
          if (args) effectNotes.push(`Origin: ${args[1]}`);
          continue;
        }
        if (lower.startsWith('q')) {
          const mode = part.slice(1) || '0';
          effectNotes.push(`Wrap mode: ${mode}`);
          tagSummary.add('Wrap Mode');
          wrapModeValue = mode;
          continue;
        }
      }
    };

    const pushText = (text) => {
      if (!text) return;
      const segments = text.split(/(\\N|\\n|\\h)/);
      segments.forEach((segment) => {
        if (!segment) return;
        if (segment === '\\N' || segment === '\\n') {
          content.appendChild(document.createElement('br'));
          return;
        }
        if (segment === '\\h') {
          const span = document.createElement('span');
          span.innerHTML = '&nbsp;';
          content.appendChild(span);
          return;
        }
        const span = document.createElement('span');
        span.textContent = segment;
        span.style.display = 'inline';
        span.style.fontFamily = currentStyle.fontFamily;
        span.style.fontSize = `${currentStyle.fontSize}px`;
        span.style.fontWeight = currentStyle.bold ? '700' : '400';
        span.style.fontStyle = currentStyle.italic ? 'italic' : 'normal';
        span.style.color = resolveColor(currentStyle.color, currentStyle.alpha);
        if (currentStyle.alpha < 1) span.style.opacity = currentStyle.alpha.toFixed(2);
        else span.style.removeProperty('opacity');
        if (currentStyle.letterSpacing) span.style.letterSpacing = `${currentStyle.letterSpacing}px`;
        const decorations = [];
        if (currentStyle.underline) decorations.push('underline');
        if (currentStyle.strike) decorations.push('line-through');
        span.style.textDecoration = decorations.length ? decorations.join(' ') : 'none';

        const karaokeActive = currentStyle.karaoke && currentStyle.karaoke.duration > 0;
        if (karaokeActive) {
          const fill = hexToRgba(
            currentStyle.secondaryColor || currentStyle.color || '#ffd166',
            currentStyle.secondaryColor ? (currentStyle.secondaryAlpha ?? 0.6) : 0.45
          );
          span.style.backgroundImage = `linear-gradient(90deg, ${fill} 0%, ${fill} 70%, transparent 100%)`;
          span.style.padding = '0 3px';
          span.style.borderRadius = '3px';
        } else if (currentStyle.secondaryColor) {
          const sc = hexToRgba(currentStyle.secondaryColor, currentStyle.secondaryAlpha ?? 0.5);
          span.style.backgroundColor = sc;
          span.style.padding = '0 3px';
          span.style.borderRadius = '3px';
        }

        const shadows = [];
        if (currentStyle.outlineWidth > 0) {
          const w = currentStyle.outlineWidth;
          const oc = hexToRgba(currentStyle.outlineColor || '#000000', currentStyle.outlineAlpha ?? 1);
          shadows.push(
            `${w}px 0 ${oc}`,
            `-${w}px 0 ${oc}`,
            `0 ${w}px ${oc}`,
            `0 -${w}px ${oc}`,
            `${w}px ${w}px ${oc}`,
            `${-w}px ${w}px ${oc}`,
            `${w}px ${-w}px ${oc}`,
            `${-w}px ${-w}px ${oc}`
          );
        }
        if (currentStyle.shadowColor && (currentStyle.shadowOffsetX || currentStyle.shadowOffsetY || currentStyle.shadowBlur)) {
          const sc = hexToRgba(currentStyle.shadowColor, currentStyle.shadowAlpha ?? 1);
          shadows.push(`${currentStyle.shadowOffsetX}px ${currentStyle.shadowOffsetY}px ${currentStyle.shadowBlur}px ${sc}`);
        }
        if (shadows.length) span.style.textShadow = shadows.join(', ');
        else span.style.removeProperty('text-shadow');

        content.appendChild(span);
      });
    };

    const tagRegex = /\{([^}]*)\}/g;
    let lastIndex = 0;
    let match;
    while ((match = tagRegex.exec(rawText))) {
      const preceding = rawText.slice(lastIndex, match.index);
      pushText(preceding);
      applyTag(match[1]);
      lastIndex = match.index + match[0].length;
    }
    pushText(rawText.slice(lastIndex));

    switch (wrapModeValue) {
      case '2':
        content.style.whiteSpace = 'nowrap';
        content.style.wordBreak = 'normal';
        break;
      case '3':
        content.style.whiteSpace = 'pre-wrap';
        content.style.wordBreak = 'break-all';
        break;
      default:
        content.style.whiteSpace = 'pre-wrap';
        content.style.wordBreak = 'normal';
        break;
    }

    if (positionInfo) {
      const xRatio = Math.max(0, Math.min(1, positionInfo.x / stageWidth));
      const yRatio = Math.max(0, Math.min(1, positionInfo.y / stageHeight));
      content.style.position = 'absolute';
      content.style.left = `${(xRatio * 100).toFixed(2)}%`;
      content.style.top = `${(yRatio * 100).toFixed(2)}%`;
      content.style.transform = 'translate(-50%, -50%)';
      content.style.textAlign = xRatio < 0.33 ? 'left' : xRatio > 0.66 ? 'right' : 'center';
      stage.style.alignItems = 'stretch';
      stage.style.justifyContent = 'flex-start';
    } else {
      content.style.position = 'relative';
      content.style.transform = 'none';
      content.style.left = 'auto';
      content.style.top = 'auto';
      content.style.textAlign = 'center';
    }

    if (!content.hasChildNodes()) {
      const placeholder = document.createElement('div');
      placeholder.textContent = '(ASS preview empty)';
      placeholder.style.cssText = 'color:#8a94a3;font-size:14px;text-align:center;';
      content.appendChild(placeholder);
    }

    if (fadeInfo) {
      const fadeOverlay = document.createElement('div');
      fadeOverlay.style.cssText = [
        'position:absolute',
        'inset:0',
        'pointer-events:none',
        'background:linear-gradient(180deg,rgba(9,12,18,0.65) 0%,rgba(9,12,18,0) 35%,rgba(9,12,18,0) 65%,rgba(9,12,18,0.65) 100%)'
      ].join(';');
      stage.appendChild(fadeOverlay);
      content.style.opacity = '0.82';
    } else {
      content.style.removeProperty('opacity');
    }

    assLayoutPreview.appendChild(stage);

    if (tagSummary.size || metaSummary.length || effectNotes.length) {
      const footer = document.createElement('div');
      footer.style.cssText = 'font-size:12px;color:#9aa6b8;';
      const infoParts = [];
      const tagList = Array.from(tagSummary);
      if (tagList.length) infoParts.push(`Tags: ${tagList.join(', ')}`);
      if (metaSummary.length) infoParts.push(metaSummary.join(', '));
      if (effectNotes.length) infoParts.push(effectNotes.join(' | '));
      footer.textContent = infoParts.join(' | ');
      assLayoutPreview.appendChild(footer);
    }
  };
  if (subtitleAssInput) {
    subtitleAssInput.addEventListener('input', () => {
      assManuallyEdited = true;
      updateAssWarning();
      if (assPreviewEnabled) renderAssPreview();
    });
  }

  if (srtPreviewToggle) {
    syncPreviewToggles();
    srtPreviewToggle.addEventListener('change', () => {
      if (srtPreviewToggle.checked) {
        applyPreviewMode('srt');
      } else if (previewMode === 'srt') {
        applyPreviewMode(null);
      }
    });
  }

  if (assPreviewToggle) {
    syncPreviewToggles();
    assPreviewToggle.addEventListener('change', () => {
      if (assPreviewToggle.checked) {
        applyPreviewMode('ass');
      } else if (previewMode === 'ass') {
        applyPreviewMode(null);
      } else {
        updatePreviewVisibility();
      }
      if (assPreviewEnabled) renderAssPreview();
    });
  }

  syncPreviewToggles();
  updatePreviewVisibility();

  const buildAssEffectOptions = () => {
    if (!assEffectSelect) return;
    assEffectSelect.innerHTML = '';
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = 'Select ASS effect...';
    assEffectSelect.appendChild(placeholderOpt);
    const groups = new Map();
    for (const def of ASS_EFFECT_DEFINITIONS) {
      const groupName = def.group || 'Effects';
      let groupEl = groups.get(groupName);
      if (!groupEl) {
        groupEl = document.createElement('optgroup');
        groupEl.label = groupName;
        groups.set(groupName, groupEl);
        assEffectSelect.appendChild(groupEl);
      }
      const opt = document.createElement('option');
      opt.value = def.id;
      opt.textContent = def.label;
      groupEl.appendChild(opt);
    }
  };
  buildAssEffectOptions();

  const applyWrap = (prefix, suffix, { placeholder = '' } = {}) => {
    if (!subtitleAssInput) return;
    const value = subtitleAssInput.value;
    const start = subtitleAssInput.selectionStart ?? 0;
    const end = subtitleAssInput.selectionEnd ?? start;
    const before = value.slice(0, start);
    const selection = value.slice(start, end);
    const middle = selection || placeholder;
    const after = value.slice(end);
    subtitleAssInput.value = `${before}${prefix}${middle}${suffix}${after}`;
    const cursorStart = before.length + prefix.length;
    const cursorEnd = cursorStart + middle.length;
    subtitleAssInput.focus({ preventScroll: true });
    subtitleAssInput.setSelectionRange(cursorStart, cursorEnd);
    assManuallyEdited = true;
    updateAssWarning();
    if (assPreviewEnabled) renderAssPreview();
  };

  const applyInsert = (content, { replaceSelection = false } = {}) => {
    if (!subtitleAssInput) return;
    const value = subtitleAssInput.value;
    const start = subtitleAssInput.selectionStart ?? 0;
    const end = replaceSelection ? (subtitleAssInput.selectionEnd ?? start) : start;
    const before = value.slice(0, start);
    const selection = value.slice(start, end);
    const after = value.slice(replaceSelection ? (subtitleAssInput.selectionEnd ?? end) : end);
    const inserted = replaceSelection ? content : `${content}`;
    const newText = replaceSelection
      ? `${before}${inserted}${value.slice(subtitleAssInput.selectionEnd ?? end)}`
      : `${before}${inserted}${selection}${after}`;
    subtitleAssInput.value = newText;
    const cursor = replaceSelection
      ? before.length + inserted.length
      : before.length + inserted.length;
    subtitleAssInput.focus({ preventScroll: true });
    subtitleAssInput.setSelectionRange(cursor, cursor);
    assManuallyEdited = true;
    updateAssWarning();
    if (assPreviewEnabled) renderAssPreview();
  };

  const applyAssEffectById = async (effectId) => {
    if (!effectId) return;
    if (!assPreviewEnabled) {
      applyPreviewMode('ass');
    }
    const def = ASS_EFFECT_DEFINITIONS.find(item => item.id === effectId);
    if (!def || !subtitleAssInput) return;
    let result = def.apply({ selectedText: subtitleAssInput.value.slice(subtitleAssInput.selectionStart ?? 0, subtitleAssInput.selectionEnd ?? 0) });
    if (result && typeof result.then === 'function') {
      try { result = await result; } catch (err) { console.warn('ASS effect apply cancelled/failed', err); result = null; }
    }
    if (!result) return;
    if (result.type === 'wrap') {
      applyWrap(result.prefix, result.suffix, { placeholder: result.placeholder || '' });
    } else if (result.type === 'insert') {
      applyInsert(result.content, { replaceSelection: !!result.replaceSelection });
    } else if (result.type === 'meta' && typeof result.applyMeta === 'function') {
      assMeta = { ...assMeta };
      result.applyMeta(assMeta);
      assManuallyEdited = true;
      updateAssMetaSummary();
      updateAssWarning();
    }
    if (assEffectSelect) assEffectSelect.value = '';
  };

  if (assApplyBtn) {
    assApplyBtn.addEventListener('click', async () => {
      if (!assEffectSelect) return;
      if (!assEffectSelect.value) {
        alert('Choose an ASS effect to apply.');
        return;
      }
      await applyAssEffectById(assEffectSelect.value);
    });
  }

  if (assEffectSelect) {
    assEffectSelect.addEventListener('keydown', (evt) => evt.stopPropagation());
    assEffectSelect.addEventListener('dblclick', async () => {
      if (assEffectSelect.value) await applyAssEffectById(assEffectSelect.value);
    });
  }

  if (assResetBtn) {
    assResetBtn.addEventListener('click', () => {
      if (!subtitleAssInput) return;
      subtitleAssInput.value = subtitleInput?.value || '';
      assManuallyEdited = false;
      assMeta = {};
      updateAssMetaSummary();
      updateAssWarning();
      subtitleAssInput.focus({ preventScroll: true });
    });
  }

  if (assStripBtn) {
    assStripBtn.addEventListener('click', () => {
      if (!subtitleAssInput) return;
      const original = subtitleAssInput.value;
      const stripped = original.replace(/\{\\[^{}]*\}/g, '');
      subtitleAssInput.value = stripped;
      assManuallyEdited = true;
      updateAssWarning();
      subtitleAssInput.focus({ preventScroll: true });
    });
  }

  if (assClearMetaBtn) {
    assClearMetaBtn.addEventListener('click', () => {
      assMeta = {};
      updateAssMetaSummary();
      updateAssWarning();
    });
  }

  if (ttsInput) {
    const syncSubtitleToSpeech = () => {
      if (subtitleInput && !subtitleManuallyEdited) {
        subtitleInput.value = ttsInput.value;
        if (srtPreviewEnabled) updateSubtitlePreview();
      }
      if (!assManuallyEdited && subtitleAssInput) {
        subtitleAssInput.value = subtitleInput?.value || ttsInput.value || '';
      }
      updateAssWarning();
    };
    ttsInput.addEventListener('input', syncSubtitleToSpeech);
    syncSubtitleToSpeech();
  } else {
    updateSubtitlePreview();
    updateAssWarning();
  }

  if (subtitleAssInput && !subtitleAssInput.value && subtitleInput) {
    subtitleAssInput.value = subtitleInput.value;
  }
  if (srtPreviewEnabled) updateSubtitlePreview();
  updateAssMetaSummary();
  updateAssWarning();
  updatePreviewVisibility();
  if (assPreviewEnabled) renderAssPreview();

  let charMenuOpen = false;

  const focusPrimaryInput = (preferChar = true) => {
    if (!document.body.contains(box)) return;
    let target = null;
    if (preferChar && charInput) target = charInput;
    else if (!preferChar && ttsInput) target = ttsInput;
    else target = charInput || ttsInput;
    if (!target) return;
    target.focus({ preventScroll: true });
    if (typeof target.select === 'function') {
      target.select();
    }
  };

  const ensureFocus = () => {
    if (!box.contains(document.activeElement)) focusPrimaryInput(true);
  };

  requestAnimationFrame(() => focusPrimaryInput(true));
  setTimeout(() => focusPrimaryInput(true), 0);
  setTimeout(ensureFocus, 120);

  const onWindowFocus = () => setTimeout(ensureFocus, 0);
  const onVisibility = () => {
    if (document.visibilityState === 'visible') setTimeout(ensureFocus, 0);
  };
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', onVisibility);

  const renderCharMenu = () => {
    if (!charMenu) return;
    const names = loadTtsCharacters();
    charMenu.innerHTML = '';
    if (!names.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 6px;color:#8a94a3;font-size:12px;text-align:center;';
      empty.textContent = 'No saved characters yet.';
      charMenu.appendChild(empty);
      return;
    }
    for (const name of names) {
      const item = document.createElement('div');
      item.style.cssText = 'position:relative;padding:8px 26px 8px 10px;margin:2px 0;border-radius:6px;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;font-size:13px;cursor:pointer;';
      item.textContent = name;
      item.addEventListener('click', () => {
        if (charInput) charInput.value = name;
        closeCharMenu();
      });

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '?';
      removeBtn.title = 'Remove';
      removeBtn.style.cssText = 'position:absolute;top:4px;right:6px;background:none;border:none;color:#ff5d5d;font-size:14px;line-height:1;padding:0;cursor:pointer;';
      removeBtn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        forgetTtsCharacter(name);
        renderCharMenu();
      });

      item.appendChild(removeBtn);
      charMenu.appendChild(item);
    }
  };

  const openCharMenu = () => {
    if (!charMenu || charMenuOpen) return;
    renderCharMenu();
    charMenu.style.display = 'block';
    charMenuOpen = true;
  };

  function closeCharMenu() {
    if (!charMenu || !charMenuOpen) return;
    charMenu.style.display = 'none';
    charMenuOpen = false;
  }

  if (charToggle) {
    charToggle.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (charMenuOpen) closeCharMenu();
      else openCharMenu();
    });
  }

  if (charInput) {
    charInput.addEventListener('focus', () => closeCharMenu());
    charInput.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'ArrowDown' && charToggle) {
        evt.preventDefault();
        openCharMenu();
      }
    });
  }

  const onOverlayPointerDown = (evt) => {
    if (!charMenuOpen) return;
    if (charField && charField.contains(evt.target)) return;
    closeCharMenu();
  };
  ov.addEventListener('pointerdown', onOverlayPointerDown);

  // populate voices
  voiceSel.innerHTML = '';
  if (voices.length) {
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.id; opt.textContent = v.desc || v.id;
      voiceSel.appendChild(opt);
    }
  } else {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(default SAPI voice)';
    voiceSel.appendChild(opt);
  }

  return new Promise(resolve => {
    const done = (val) => {
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      ov.removeEventListener('pointerdown', onOverlayPointerDown);
      closeCharMenu();
      setAssPromptHandler(null);
      document.querySelectorAll('[data-role="ass-prompt-overlay"]').forEach(node => node.remove());
      ov.remove();
      resolve(val);
    };
    box.querySelector('[data-act="cancel"]').onclick = () => done(null);
    box.querySelector('[data-act="ok"]').onclick = () => {
      const text = (ttsInput?.value || '').trim();
      if (!text) { if (ttsInput) ttsInput.focus(); return; }
      const rate   = Number(rateIn?.value ?? 0);
      const volume = Math.max(0, Math.min(100, Number(volIn?.value ?? 100)));
      const voiceId = voiceSel?.value ? String(voiceSel.value) : null;
      const character = sanitizeTtsCharacterName(charInput?.value || '');
      const subtitleRaw = (subtitleInput?.value || '').trim();
      const subtitleText = subtitleRaw || text;
      const subtitleAssText = subtitleAssInput ? subtitleAssInput.value : subtitleText;
      const subtitleAssMeta = assMeta && Object.keys(assMeta).length ? { ...assMeta } : null;
      done({ text, subtitleText, subtitleAssText, subtitleAssMeta, voiceId, rate, volume, character });
    };
    document.addEventListener('keydown', function esc(e){
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done(null); }
    }, { once:true });
    const focusTts = () => {
      if (!document.body.contains(ttsInput)) return;
      ttsInput.focus({ preventScroll: true });
      ttsInput.select();
    };
    requestAnimationFrame(focusTts);
    setTimeout(focusTts, 0);
  });
}


// ---------- Dynamic extent ----------
function projectEndMs() {
  const visEnd = PROJECT.items.reduce((m,i)=>Math.max(m, i.end||0), 0);
  const audEnd = PROJECT.audio.reduce((m,a)=>Math.max(m, a.end||0), 0);
  const bgEnd  = (PROJECT.bgClips||[]).reduce((m,c)=>{
    const e = (c.end != null) ? c.end : (Math.max(visEnd, audEnd, c.start + PROJECT.bgDefaultTail));
    return Math.max(m, e);
  }, 0);
  const labelEnd = (PROJECT.timelineLabels || []).reduce((m, l) => Math.max(m, Number.isFinite(l.time) ? l.time : 0), 0);
  const maxEnd = Math.max(visEnd, audEnd, bgEnd, labelEnd);
  return Math.max(maxEnd, TIMELINE_MIN_MS); // no growth from scroll/scrub
}


// ---------- Init ----------
(async function init() {
  try {
    PATHS = await window.suAPI.getPaths();
    await loadPalettes();
    hookUI();
    clearHistory();
    // Recovery prompt
    try {
      const chk = await window.autosaveAPI?.check();
      if (chk?.exists) {
        const yes = confirm('It seems Sonic Underground Movie Maker closed without you saving a project file or exporting your video first, would you like to continue where you left off?');
        if (yes) {
          const res = await window.autosaveAPI.load();
          if (res?.ok && res.data) {
            const state = deriveLoadedState(res.data);
            if (state) {
              clearHistory();
              restoreProject(state);
            }
          }
        } else {
          await window.autosaveAPI.clear();
        }
      }
    } catch {}
    setProjectTitle(currentProjectPath);
    playing = false;
    stopAllAudios({ pauseOnly: true });
    stopAllVideos({ pauseOnly: true });
    currentTime = 0;
        // Temporarily disable autosave during first render and possible recovery prompt
    AUTOSAVE_ENABLED = false;

    drawPlayhead();
    refreshStageVisibility();
    renderActiveGifs();
    applyBackgroundForTime(currentTime);
    const tracks = $('#tracks');
    if (tracks) {
      _suppressTimelineAutoExtend = true;
      try {
        tracks.scrollLeft = 0;
        tracks.scrollTop = 0;
      } finally {
        _suppressTimelineAutoExtend = false;
      }
    }
    renderTimeline();
    renderBackgroundOptions();
    applyBackgroundForTime(0);
    drawPlayhead();
    scheduleSubtitlePreviewRebuild({ immediate: true });

    // Recovery offer
    const backup = loadAutosave();
    if (backup && backup.state && !currentProjectPath) {
      const want = confirm(
        'It seems Sonic Underground Movie Maker closed without you saving a project file or exporting your video first, would you like to continue where you left off?'
      );
      if (want) {
        const recovered = deriveLoadedState(backup);
        if (recovered) {
          clearHistory();
          restoreProject(recovered);
          setProjectTitle(backup.pathHint || null);
        }
      } else {
        clearAutosave();
      }
    }

    // Enable autosave for subsequent edits
    AUTOSAVE_ENABLED = true;
  } catch (e) {
    console.error('Init error:', e);
  } finally {
    markAppReady();
  }
})();

// ---------- Asset palette ----------
const cssEscape = (window.CSS && typeof window.CSS.escape === 'function')
  ? (value) => window.CSS.escape(value)
  : (value) => String(value).replace(/[^a-zA-Z0-9_\-]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `);

function canonicalPath(p) {
  if (!p) return '';
  let norm = String(p).trim().replace(/\\/g, '/');
  if (norm.startsWith('//')) {
    norm = '//' + norm.slice(2).replace(/\/+$/, '');
    return norm || '//';
  }
  if (/^[A-Za-z]:$/.test(norm)) return norm;
  norm = norm.replace(/\/+$/, '');
  return norm;
}

function parentDirPath(p) {
  const canon = canonicalPath(p);
  if (!canon) return '';
  const parts = canon.split('/');
  if (parts.length <= 1) return '';
  parts.pop();
  return parts.join('/');
}

function setFolderOpen(folderEl, open = true) {
  if (!folderEl) return;
  const header = folderEl.querySelector('.folder-header');
  const contents = folderEl.querySelector('.folder-contents');
  if (!header || !contents) return;
  header.setAttribute('aria-expanded', String(open));
  const chev = header.querySelector('.chev');
  if (chev) chev.textContent = open ? 'v' : '>';
  contents.style.display = open ? 'grid' : 'none';
}

const paletteSearchState = {
  lastQuery: '',
  prevExpanded: new WeakMap()
};

function setupPaletteSearch() {
  const input = $('#library-search');
  if (!input) return;
  const clearBtn = $('#library-search-clear');

  const applyFilter = () => {
    filterPaletteAssets(input.value || '');
    if (clearBtn) {
      const hasValue = (input.value || '').trim().length > 0;
      if (hasValue) clearBtn.removeAttribute('hidden');
      else clearBtn.setAttribute('hidden', '');
    }
  };

  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      applyFilter();
      input.blur();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      applyFilter();
      input.focus({ preventScroll: true });
    });
  }

  requestAnimationFrame(applyFilter);
}

function filterPaletteAssets(rawQuery) {
  const query = (rawQuery || '').trim().toLowerCase();
  const lists = $$('#palette .list');
  if (!lists.length) return;

  if (!query) {
    for (const list of lists) {
      restorePaletteContainer(list);
      const heading = list.previousElementSibling;
      if (heading && heading.tagName === 'H3') heading.style.display = '';
      list.style.display = '';
    }
    paletteSearchState.prevExpanded = new WeakMap();
    paletteSearchState.lastQuery = '';
    return;
  }

  if (!paletteSearchState.lastQuery) {
    paletteSearchState.prevExpanded = new WeakMap();
  }

  for (const list of lists) {
    const matches = filterPaletteContainer(list, query);
    const heading = list.previousElementSibling;
    list.style.display = matches ? '' : 'none';
    if (heading && heading.tagName === 'H3') heading.style.display = matches ? '' : 'none';
  }

  paletteSearchState.lastQuery = query;
}

function applyCurrentPaletteFilter() {
  const input = $('#library-search');
  filterPaletteAssets(input ? input.value || '' : '');
}

function filterPaletteContainer(container, query) {
  let anyMatch = false;
  for (const child of container.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains('folder')) {
      const hasMatch = filterPaletteFolder(child, query);
      child.style.display = hasMatch ? '' : 'none';
      if (hasMatch) anyMatch = true;
      continue;
    }
    if (child.classList.contains('asset')) {
      const label = (child.dataset?.name || child.querySelector('.asset-label')?.textContent || '').toLowerCase();
      const hasMatch = label.includes(query);
      child.style.display = hasMatch ? '' : 'none';
      if (hasMatch) anyMatch = true;
      continue;
    }
    const textMatch = (child.textContent || '').toLowerCase().includes(query);
    child.style.display = textMatch ? '' : 'none';
    if (textMatch) anyMatch = true;
  }
  return anyMatch;
}

function filterPaletteFolder(folder, query) {
  const header = folder.querySelector(':scope > .folder-header');
  const contents = folder.querySelector(':scope > .folder-contents');
  let folderName = folder.dataset?.name || '';
  if (!folderName && header) {
    folderName = header.querySelector('.fname')?.textContent || header.textContent || '';
  }
  const nameMatch = (folderName || '').toLowerCase().includes(query);
  let childMatch = false;
  if (contents) childMatch = filterPaletteContainer(contents, query);
  const hasMatch = nameMatch || childMatch;
  if (header && contents) {
    if (!paletteSearchState.prevExpanded.has(header)) {
      paletteSearchState.prevExpanded.set(header, header.getAttribute('aria-expanded') === 'true');
    }
    setFolderOpen(folder, hasMatch);
  }
  return hasMatch;
}

function restorePaletteContainer(container) {
  for (const child of container.children) {
    if (!(child instanceof HTMLElement)) continue;
    child.style.display = '';
    if (child.classList.contains('folder')) {
      restorePaletteFolder(child);
    }
  }
}

function restorePaletteFolder(folder) {
  const header = folder.querySelector(':scope > .folder-header');
  const contents = folder.querySelector(':scope > .folder-contents');
  if (header && contents) {
    const wasOpen = paletteSearchState.prevExpanded.has(header)
      ? paletteSearchState.prevExpanded.get(header)
      : header.getAttribute('aria-expanded') === 'true';
    setFolderOpen(folder, wasOpen);
  }
  if (contents) restorePaletteContainer(contents);
}

function buildSkippedMessage(skipped = []) {
  if (!Array.isArray(skipped) || !skipped.length) return '';
  const counts = { missing: 0, notFile: 0, type: 0, copy: 0, buffer: 0, write: 0, category: 0, other: 0 };
  const copyDetails = [];
  for (const item of skipped) {
    const reason = item?.reason || 'other';
    if (reason === 'copy' && item?.detail) copyDetails.push(item.detail);
    if (reason === 'bufferDecode' || reason === 'bufferEmpty') {
      counts.buffer += 1;
      continue;
    }
    if (reason === 'write') {
      counts.write += 1;
      continue;
    }
    if (reason === 'category') {
      counts.category += 1;
      continue;
    }
    if (reason === 'missingPath') {
      counts.missing += 1;
      continue;
    }
    if (counts.hasOwnProperty(reason)) counts[reason] += 1;
    else counts.other += 1;
  }
  const lines = [];
  if (counts.type) lines.push(`${counts.type} file(s) had unsupported formats.`);
  if (counts.missing) lines.push(`${counts.missing} file(s) could not be found.`);
  if (counts.notFile) lines.push(`${counts.notFile} item(s) were not files.`);
  if (counts.copy) lines.push(`${counts.copy} file(s) could not be copied.`);
  if (counts.buffer) lines.push(`${counts.buffer} file(s) could not be read from the drop.`);
  if (counts.write) lines.push(`${counts.write} file(s) could not be written to disk.`);
  if (counts.category) lines.push(`${counts.category} file(s) could not be placed because their category was unknown.`);
  if (counts.other) lines.push(`${counts.other} file(s) could not be imported.`);
  if (copyDetails.length) {
    lines.push(`Details: ${copyDetails.slice(0, 2).join('; ')}`);
    if (copyDetails.length > 2) lines.push(`(+${copyDetails.length - 2} more)`);
  }
  return lines.join('\n');
}

async function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function highlightImportedAssets(paths = []) {
  if (!Array.isArray(paths) || !paths.length) return;
  const canonicalTargets = paths
    .map((p) => canonicalPath(p))
    .filter(Boolean);
  if (!canonicalTargets.length) return;

  const foldersToOpen = new Set();
  for (const target of canonicalTargets) {
    foldersToOpen.add(target);
    let dir = parentDirPath(target);
    while (dir) {
      foldersToOpen.add(dir);
      dir = parentDirPath(dir);
    }
  }

  const folderEls = document.querySelectorAll('.folder[data-path], .folder[data-canon-path]');
  for (const folder of folderEls) {
    const stored = folder.dataset.canonPath || canonicalPath(folder.dataset.path);
    if (!stored) continue;
    if (foldersToOpen.has(stored) || canonicalTargets.some((p) => p.startsWith(stored + '/'))) {
      setFolderOpen(folder, true);
    }
  }

  for (const target of canonicalTargets) {
    const asset = document.querySelector(`.asset[data-canon-path="${cssEscape(target)}"]`);
    if (asset) {
      asset.classList.add('recent-import');
      asset.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(() => asset.classList.remove('recent-import'), 1800);
      continue;
    }
    const folderHeader = document.querySelector(`.folder[data-canon-path="${cssEscape(target)}"] > .folder-header`);
    if (folderHeader) {
      folderHeader.classList.add('recent-import');
      folderHeader.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(() => folderHeader.classList.remove('recent-import'), 1800);
    }
  }
}

let selectedAssetEl = null;
let selectedAssetCanonPath = null;
let folderDragState = { folder: null, parentPath: null };
let folderDropState = { container: null, target: null, position: null };

function setSelectedAsset(el, { scrollIntoView = false } = {}) {
  if (el && !el.dataset?.path) el = null;
  if (selectedAssetEl === el) {
    if (scrollIntoView && el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return;
  }
  if (selectedAssetEl) selectedAssetEl.classList.remove('asset-selected');
  selectedAssetEl = el || null;
  if (selectedAssetEl) {
    selectedAssetEl.classList.add('asset-selected');
    selectedAssetCanonPath = selectedAssetEl.dataset?.canonPath || canonicalPath(selectedAssetEl.dataset?.path);
    if (scrollIntoView) {
      selectedAssetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } else {
    selectedAssetCanonPath = null;
  }
}

function restoreSelectedAsset() {
  if (!selectedAssetCanonPath) return;
  const el = document.querySelector(`.asset[data-canon-path="${cssEscape(selectedAssetCanonPath)}"]`);
  if (el) {
    setSelectedAsset(el);
  } else {
    setSelectedAsset(null);
  }
}

function isFolderReorderActive() {
  return !!folderDragState.folder;
}

function clearFolderDropIndicator() {
  if (folderDropState.target) {
    folderDropState.target.classList.remove('folder-drop-before', 'folder-drop-after');
  }
  if (folderDropState.container) {
    folderDropState.container.classList.remove('folder-drop-end');
  }
  folderDropState = { container: null, target: null, position: null };
}

function applyFolderDropIndicator(container, target, position) {
  clearFolderDropIndicator();
  folderDropState = { container, target, position };
  if (target) {
    target.classList.add(position === 'before' ? 'folder-drop-before' : 'folder-drop-after');
  } else if (container && position === 'end') {
    container.classList.add('folder-drop-end');
  }
}

function onFolderDragStart(e) {
  const handle = e.currentTarget;
  const folder = handle?.closest('.folder');
  if (!folder) return;
  folderDragState = {
    folder,
    parentPath: folder.dataset?.parentPath || folder.parentElement?.dataset?.dirPath || ''
  };
  folder.classList.add('folder-dragging');
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', folder.dataset?.path || '');
  } catch {}
}

function onFolderDragEnd() {
  if (folderDragState.folder) {
    folderDragState.folder.classList.remove('folder-dragging');
  }
  folderDragState = { folder: null, parentPath: null };
  clearFolderDropIndicator();
}

function onFolderListDragOver(e) {
  if (!folderDragState.folder) return;
  const container = e.currentTarget;
  const dirPath = container?.dataset?.dirPath || '';
  if (!dirPath || dirPath !== folderDragState.parentPath) return;
  if (folderDragState.folder === container) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const targetFolder = e.target.closest('.folder');
  const draggingFolder = folderDragState.folder;
  const folders = Array.from(container.children).filter((node) => node.classList?.contains('folder'));
  if (targetFolder && targetFolder.parentElement === container) {
    if (targetFolder === draggingFolder) {
      clearFolderDropIndicator();
      folderDropState = { container: null, target: null, position: null };
      return;
    }
    const rect = targetFolder.getBoundingClientRect();
    const position = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
    applyFolderDropIndicator(container, targetFolder, position);
    return;
  }
  if (!folders.length) {
    applyFolderDropIndicator(container, null, 'end');
    return;
  }
  const first = folders[0];
  const last = folders[folders.length - 1];
  const firstRect = first.getBoundingClientRect();
  if (e.clientY < firstRect.top + firstRect.height / 2) {
    applyFolderDropIndicator(container, first, 'before');
    return;
  }
  const lastRect = last.getBoundingClientRect();
  if (e.clientY > lastRect.bottom - lastRect.height / 2) {
    applyFolderDropIndicator(container, null, 'end');
    return;
  }
  // find nearest folder by vertical distance
  let best = null;
  let bestDist = Infinity;
  for (const folder of folders) {
    if (folder === draggingFolder) continue;
    const rect = folder.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;
    const dist = Math.abs(e.clientY - middle);
    if (dist < bestDist) {
      best = { folder, rect };
      bestDist = dist;
    }
  }
  if (best) {
    const position = (e.clientY - best.rect.top) < best.rect.height / 2 ? 'before' : 'after';
    applyFolderDropIndicator(container, best.folder, position);
  } else {
    applyFolderDropIndicator(container, null, 'end');
  }
}

function onFolderListDragLeave(e) {
  if (!folderDragState.folder) return;
  const container = e.currentTarget;
  if (!folderDropState.container || folderDropState.container !== container) return;
  if (container.contains(e.relatedTarget)) return;
  clearFolderDropIndicator();
}

async function finalizeFolderReorder(container) {
  const dirPath = container?.dataset?.dirPath;
  if (!dirPath) return;
  const folders = Array.from(container.children).filter((node) => node.classList?.contains('folder'));
  const names = folders.map((node) => node.dataset?.name).filter(Boolean);
  if (window.suAPI?.assetSetOrder) {
    try {
      const res = await window.suAPI.assetSetOrder(dirPath, names);
      if (!res?.ok) {
        alert(res?.error || 'Unable to update folder order.');
      }
    } catch (err) {
      console.error('assetSetOrder error', err);
    }
  }
  await loadPalettes();
}

function onFolderListDrop(e) {
  if (!folderDragState.folder) return;
  const container = e.currentTarget;
  const dirPath = container?.dataset?.dirPath || '';
  if (!dirPath || dirPath !== folderDragState.parentPath) return;
  e.preventDefault();
  const state = folderDropState;
  if (!state.container || state.container !== container) {
    onFolderDragEnd();
    return;
  }
  const { target, position } = state;
  const folder = folderDragState.folder;
  if (target && target !== folder) {
    if (position === 'before') {
      container.insertBefore(folder, target);
    } else {
      container.insertBefore(folder, target.nextSibling);
    }
  } else {
    container.appendChild(folder);
  }
  onFolderDragEnd();
  finalizeFolderReorder(container).catch((err) => console.error('Folder reorder error', err));
}

function setupReorderContainer(containerEl) {
  if (!containerEl || containerEl._folderReorderReady) return;
  containerEl.addEventListener('dragover', onFolderListDragOver);
  containerEl.addEventListener('dragleave', onFolderListDragLeave);
  containerEl.addEventListener('drop', onFolderListDrop);
  containerEl._folderReorderReady = true;
}

const ASSET_KIND_LABELS = {
  character: 'Character',
  background: 'Background',
  object: 'Object',
  audio: 'Audio'
};
const ASSET_KIND_ACCEPT_DESC = {
  character: 'PNG, JPG, GIF, or WEBP image',
  background: 'PNG, JPG, GIF, or WEBP image',
  object: 'PNG, JPG, GIF, WEBP image, or MP4/WEBM video',
  audio: 'WAV, MP3, OGG, or M4A audio'
};
const ASSET_INVALID_FOLDER_CHARS = /[<>:"/\\|?*\x00-\x1F]/;
const FILE_DRAG_TYPES = ['Files', 'text/plain', 'text/uri-list', 'application/x-moz-file', 'text/x-moz-url', 'application/octet-stream'];

function hasFileDragData(ev) {
  const types = ev?.dataTransfer?.types;
  if (!types) return false;
  const arr = typeof types.includes === 'function' ? types : Array.from(types);
  return FILE_DRAG_TYPES.some((type) => (typeof arr.includes === 'function' ? arr.includes(type) : arr.indexOf(type) >= 0));
}

const AssetContextMenu = (() => {
  let menuEl = null;

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'asset-context-menu';
    menuEl.style.display = 'none';
    menuEl.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function hide() {
    if (!menuEl) return;
    menuEl.style.display = 'none';
    menuEl.innerHTML = '';
  }

  function show(items, x, y) {
    if (!items || !items.length) return;
    const menu = ensureMenu();
    menu.innerHTML = '';
    for (const item of items) {
      if (!item || item.hidden) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'asset-context-item';
      if (item.danger) btn.classList.add('danger');
      btn.textContent = item.label || '';
      if (item.disabled) btn.disabled = true;
      btn.addEventListener('click', () => {
        hide();
        if (!item.disabled && typeof item.onSelect === 'function') {
          item.onSelect();
        }
      });
      menu.appendChild(btn);
    }
    if (!menu.children.length) {
      hide();
      return;
    }
    menu.style.display = 'flex';
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    const posX = Math.min(Math.max(8, x), maxX);
    const posY = Math.min(Math.max(8, y), maxY);
    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;
    menu.style.visibility = 'visible';
  }

  document.addEventListener('click', (evt) => {
    if (!menuEl || menuEl.style.display === 'none') return;
    if (menuEl.contains(evt.target)) return;
    hide();
  });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);

  return { show, hide };
})();

function confirmYesNo(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'asset-confirm-overlay';
    const box = document.createElement('div');
    box.className = 'asset-confirm-box';
    const msg = document.createElement('p');
    msg.className = 'asset-confirm-message';
    msg.textContent = message;
    const btnRow = document.createElement('div');
    btnRow.className = 'asset-confirm-buttons';
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.textContent = 'No';
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'primary';
    yesBtn.textContent = 'Yes';
    btnRow.append(noBtn, yesBtn);
    box.append(msg, btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let finished = false;
    const cleanup = (value) => {
      if (finished) return;
      finished = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cleanup(false);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        cleanup(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) cleanup(false);
    });
    noBtn.addEventListener('click', () => cleanup(false));
    yesBtn.addEventListener('click', () => cleanup(true));
    setTimeout(() => yesBtn.focus({ preventScroll: true }), 0);
  });
}

function promptForAssetFolderName(kind) {
  const label = ASSET_KIND_LABELS[kind] || 'Asset';
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'asset-confirm-overlay asset-prompt-overlay';
    const box = document.createElement('div');
    box.className = 'asset-prompt-box';

    const title = document.createElement('h3');
    title.textContent = `Create New ${label} Folder`;

    const promptMsg = document.createElement('p');
    promptMsg.className = 'asset-prompt-message';
    promptMsg.textContent = 'Enter a folder name:';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'asset-prompt-input';
    input.placeholder = 'My folder';

    const error = document.createElement('div');
    error.className = 'asset-prompt-error';
    error.style.display = 'none';

    const btnRow = document.createElement('div');
    btnRow.className = 'asset-prompt-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'primary';
    okBtn.textContent = 'Create';

    btnRow.append(cancelBtn, okBtn);
    box.append(title, promptMsg, input, error, btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };

    const setError = (msg) => {
      if (!msg) {
        error.style.display = 'none';
        error.textContent = '';
      } else {
        error.style.display = 'block';
        error.textContent = msg;
      }
    };

    const validate = () => {
      const raw = input.value.trim();
      if (!raw) {
        setError('Folder name cannot be empty.');
        return null;
      }
      if (raw === '.' || raw === '..') {
        setError('That folder name is not allowed.');
        return null;
      }
      if (ASSET_INVALID_FOLDER_CHARS.test(raw)) {
        setError('Folder name has invalid characters.');
        return null;
      }
      setError('');
      return raw;
    };

    const submit = () => {
      const value = validate();
      if (value) finish(value);
    };

    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(null);
      } else if (ev.key === 'Enter') {
        if (document.activeElement === input) {
          ev.preventDefault();
          submit();
        }
      }
    };

    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) finish(null);
    });
    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (ev) => ev.stopPropagation());
    input.addEventListener('input', () => setError(''));
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  });
}

function collectDroppedFilePaths(ev) {
  const dt = ev?.dataTransfer;
  if (!dt) return [];
  const found = new Set();
  const paths = [];
  const addPath = (p) => {
    if (!p || typeof p !== 'string') return;
    let normalized = normalizeDroppedPath(p);
    if (!normalized) return;
    if (found.has(normalized)) return;
    found.add(normalized);
    paths.push(normalized);
  };

  const fileList = dt.files;
  if (fileList && fileList.length) {
    for (const file of Array.from(fileList)) {
      if (file?.path) addPath(file.path);
    }
    if (paths.length) return paths;
  }
  if (!paths.length) {
    const itemList = dt.items;
    if (itemList && itemList.length) {
      for (const item of Array.from(itemList)) {
        if (!item) continue;
        if (item.kind === 'file') {
          const file = item.getAsFile && item.getAsFile();
          if (file?.path) {
            addPath(file.path);
            continue;
          }
          if (item.webkitGetAsEntry) {
            try {
              const entry = item.webkitGetAsEntry();
              if (entry?.isFile && entry.fullPath) addPath(entry.fullPath);
            } catch { /* ignore */ }
          }
        }
        if (item.type === 'text/plain') {
          try {
            const txt = dt.getData('text/plain');
            if (txt) parsePotentialPaths(txt, addPath);
          } catch { /* ignore */ }
        }
      }
    }
  }
  if (!paths.length && typeof dt.getData === 'function') {
    let uriList = '';
    let plain = '';
    let download = '';
    let moz = '';
    try { uriList = dt.getData('text/uri-list') || ''; } catch {}
    try { plain = dt.getData('text/plain') || ''; } catch {}
    try { download = dt.getData('DownloadURL') || ''; } catch {}
    try { moz = dt.getData('text/x-moz-url') || ''; } catch {}
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        addUrlMaybe(line, addPath);
      }
    }
    if (plain) parsePotentialPaths(plain, addPath);
    if (download) {
      const match = download.match(/file:[^\s]+$/i);
      if (match) addUrlMaybe(match[0], addPath);
    }
    if (moz) parsePotentialPaths(moz, addPath);
  }
  return paths;
}

function parsePotentialPaths(blob, addFn) {
  if (!blob) return;
  for (const rawLine of blob.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw) continue;
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
      addFn(raw);
      continue;
    }
    if (raw.startsWith('file://')) {
      addUrlMaybe(raw, addFn);
      continue;
    }
  }
}

function addUrlMaybe(value, addFn) {
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') {
      let pathname = decodeURIComponent(url.pathname || '');
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
      if (!pathname && url.host) {
        pathname = `\\\\${url.host}${url.pathname ? decodeURIComponent(url.pathname) : ''}`;
      }
      addFn(pathname || url.pathname);
    }
  } catch {
    // ignore parse failures
  }
}

function normalizeDroppedPath(input) {
  if (!input) return '';
  let value = String(input).trim();
  if (!value) return '';
  value = value.replace(/^"+|"+$/g, '');
  value = value.replace(/\u0000/g, '');
  try {
    value = decodeURIComponent(value);
  } catch {
    // ignore decoding errors
  }
  if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'file:') {
        let pathname = decodeURIComponent(url.pathname || '');
        if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
        if (!pathname && url.host) pathname = `\\\\${url.host}${decodeURIComponent(url.pathname || '')}`;
        value = pathname || decodeURIComponent(url.pathname || '');
      } else {
        value = value.replace(/^file:\/\//i, '');
      }
    } catch {
      value = value.replace(/^file:\/\//i, '');
    }
  }
  value = value.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\/.test(value)) return value;
  if (value.startsWith('\\\\')) return value;
  return '';
}

function bufferToBase64(buffer) {
  if (!buffer) return '';
  let bytes;
  if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer);
  } else if (ArrayBuffer.isView(buffer)) {
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else {
    return '';
  }
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function prepareDropTarget(el, { kind, path }) {
  if (!el) return;
  el.dataset.dropKind = kind || '';
  if (path) {
    el.dataset.dropPath = path;
    const canon = canonicalPath(path);
    if (canon) el.dataset.dropCanonPath = canon;
  } else {
    el.dataset.dropPath = '';
    delete el.dataset.dropCanonPath;
  }
  if (!el.dataset.dropDepth) el.dataset.dropDepth = '0';
  if (el._assetDropReady) return;
  const enter = (ev) => {
    if (isFolderReorderActive()) return;
    if (!hasFileDragData(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const next = Number(ev.currentTarget.dataset.dropDepth || '0') + 1;
    ev.currentTarget.dataset.dropDepth = String(next);
    ev.currentTarget.classList.add('drop-target');
  };
  const over = (ev) => {
    if (isFolderReorderActive()) return;
    if (!hasFileDragData(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'copy';
  };
  const leave = (ev) => {
    if (isFolderReorderActive()) return;
    if (!hasFileDragData(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const cur = Number(ev.currentTarget.dataset.dropDepth || '0') - 1;
    if (cur <= 0) {
      ev.currentTarget.dataset.dropDepth = '0';
      ev.currentTarget.classList.remove('drop-target');
    } else {
      ev.currentTarget.dataset.dropDepth = String(cur);
    }
  };
  const drop = (ev) => {
    if (isFolderReorderActive()) return;
    if (!hasFileDragData(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const elTarget = ev.currentTarget;
    elTarget.dataset.dropDepth = '0';
    elTarget.classList.remove('drop-target');
    const targetDir = elTarget.dataset.dropPath;
    if (!targetDir) return;
    const dropKind = elTarget.dataset.dropKind || elTarget.dataset.kind || '';
    const fileObjects = Array.from(ev.dataTransfer?.files || []);
    let fallbackPaths = [];
    if (!fileObjects.length) {
      fallbackPaths = collectDroppedFilePaths(ev);
      if (!fallbackPaths.length) {
        const typeList = ev?.dataTransfer?.types;
        const arr = typeList ? (typeof typeList.includes === 'function' ? Array.from(typeList) : Array.prototype.slice.call(typeList)) : [];
        console.warn('Asset drop contained no readable file data', { types: arr });
        const maybePlainTextOnly = arr.length && arr.every((type) => type === 'text/plain');
        if (!maybePlainTextOnly) {
          alert(`We could not read any files from that drop.\nDetected data types: ${arr.join(', ') || '(none)'}\nPlease drop files directly from your file explorer.`);
        }
        return;
      }
    }
    importFilesIntoAssetFolder(targetDir, dropKind, fileObjects, fallbackPaths).catch((err) => {
      console.error('Failed to import dropped assets', err);
      alert('We hit an unexpected error importing those files.');
    });
  };
  el.addEventListener('dragenter', enter);
  el.addEventListener('dragover', over);
  el.addEventListener('dragleave', leave);
  el.addEventListener('drop', drop);
  el._assetDropReady = true;
}

async function importFilesIntoAssetFolder(targetDir, kind, fileObjects = [], fallbackPaths = []) {
  if (!targetDir) return;
  const rejected = [];
  const entries = [];

  function extAllowed(nameOrPath) {
    if (!nameOrPath) return false;
    if (kind === 'audio') return isAudio(nameOrPath);
    if (kind === 'object') return isImage(nameOrPath) || isVideo(nameOrPath);
    return isImage(nameOrPath);
  }

  if (Array.isArray(fileObjects) && fileObjects.length) {
    for (const file of fileObjects) {
      if (!file) continue;
      const name = file.name || file.path || '';
      const candidate = file.path || file.name || '';
      if (!extAllowed(candidate)) {
        rejected.push(name || candidate || '(unnamed)');
        continue;
      }
      const filePath = file.path ? normalizeDroppedPath(file.path) : '';
      if (filePath) {
        entries.push({
          source: 'path',
          path: filePath,
          name: name || basename(filePath),
          lastModified: file.lastModified || Date.now()
        });
        continue;
      }
      try {
        const buffer = await file.arrayBuffer();
        const base64 = bufferToBase64(buffer);
        entries.push({
          source: 'buffer',
          name: name || `import${Date.now()}`,
          data: base64,
          lastModified: file.lastModified || Date.now()
        });
      } catch (err) {
        console.warn('Failed to read dropped file buffer', err);
        rejected.push(name || candidate || '(unnamed)');
      }
    }
  }

  if ((!entries.length) && Array.isArray(fallbackPaths) && fallbackPaths.length) {
    for (const rawPath of fallbackPaths) {
      if (!rawPath) continue;
      if (!extAllowed(rawPath)) {
        rejected.push(rawPath);
        continue;
      }
      const normalized = normalizeDroppedPath(rawPath);
      if (!normalized) {
        rejected.push(rawPath);
        continue;
      }
      entries.push({
        source: 'path',
        path: normalized,
        name: basename(normalized)
      });
    }
  }

  if (!entries.length) {
    const desc = ASSET_KIND_ACCEPT_DESC[kind] || 'supported files';
    const lines = [`No supported files were dropped. Please drop a ${desc}.`];
    if (rejected.length) lines.push(`${rejected.length} file(s) were skipped.`);
    alert(lines.join('\n'));
    return;
  }

  let result;
  try {
    result = await window.suAPI.assetImportFiles({
      targetDir,
      files: entries,
      kind
    });
  } catch (e) {
    console.error('assetImportFiles error', e);
    alert('We could not import those files.');
    return;
  }
  if (!result || !result.ok) {
    const skipMsg = buildSkippedMessage(result?.skipped);
    const parts = [result?.error || 'We could not import those files.'];
    if (skipMsg) parts.push(skipMsg);
    if (rejected.length) parts.push(`${rejected.length} file(s) had unsupported formats or failed to read.`);
    alert(parts.filter(Boolean).join('\n'));
    return;
  }
  const infoLines = [];
  if (rejected.length) infoLines.push(`${rejected.length} file(s) had unsupported formats or failed to read.`);
  const skipMsg = buildSkippedMessage(result.skipped);
  if (skipMsg) infoLines.push(skipMsg);
  if (infoLines.length) alert(infoLines.join('\n'));
  const addedPaths = Array.isArray(result.added) ? result.added : [];
  await loadPalettes();
  await nextAnimationFrame();
  highlightImportedAssets(addedPaths);
}

async function handleCreateAssetFolder(parentDir, kind) {
  if (!parentDir) return;
  const trimmed = await promptForAssetFolderName(kind);
  if (!trimmed) return;
  let res;
  try {
    res = await window.suAPI.assetCreateFolder(parentDir, trimmed);
  } catch (e) {
    console.error('assetCreateFolder error', e);
    res = { ok: false, error: 'Unable to create folder.' };
  }
  if (!res?.ok) {
    alert(res?.error || 'Unable to create folder.');
    return;
  }
  const createdPath = res?.path || null;
  await loadPalettes();
  if (createdPath) {
    await nextAnimationFrame();
    highlightImportedAssets([createdPath]);
  }
}

async function handleDeleteAssetFolder(folderPath) {
  if (!folderPath) return;
  const yes = await confirmYesNo('Are you really sure you want to delete this?');
  if (!yes) return;
  let res;
  try {
    res = await window.suAPI.assetDeleteFolder(folderPath);
  } catch (e) {
    console.error('assetDeleteFolder error', e);
    res = { ok: false, error: 'Unable to delete folder.' };
  }
  if (!res?.ok) {
    alert(res?.error || 'Unable to delete folder.');
    return;
  }
  await loadPalettes();
}

async function handleDeleteAssetFile(assetPath, assetName) {
  if (!assetPath) return;
  const display = assetName || basename(assetPath);
  const yes = await confirmYesNo(`Are you really sure you want to delete "${display}"?`);
  if (!yes) return;
  let res;
  try {
    res = await window.suAPI.assetDeleteFile(assetPath);
  } catch (e) {
    console.error('assetDeleteFile error', e);
    res = { ok: false, error: 'Unable to delete asset.' };
  }
  if (!res?.ok) {
    alert(res?.error || 'Unable to delete asset.');
    return;
  }
  setSelectedAsset(null);
  await loadPalettes();
}

function setupAssetRootInteractions(rootEl, { kind, path }) {
  if (!rootEl) return;
  if (kind) rootEl.dataset.kind = kind;
  rootEl.dataset.path = path || '';
  rootEl.dataset.dirPath = path || '';
  const canon = canonicalPath(path);
  if (canon) rootEl.dataset.canonPath = canon;
  else delete rootEl.dataset.canonPath;
  prepareDropTarget(rootEl, { kind, path });
  if (rootEl._assetCtxReady) return;
  rootEl.addEventListener('contextmenu', (ev) => {
    const assetEl = ev.target.closest('.asset');
    if (assetEl && rootEl.contains(assetEl)) {
      const assetPath = assetEl.dataset?.path;
      const assetName = assetEl.dataset?.name;
      if (!assetPath) return;
      ev.preventDefault();
      setSelectedAsset(assetEl);
      AssetContextMenu.show([
        {
          label: 'Delete Asset',
          danger: true,
          onSelect: () => handleDeleteAssetFile(assetPath, assetName)
        }
      ], ev.pageX, ev.pageY);
      return;
    }
    const folderEl = ev.target.closest('.folder');
    const listRoot = ev.currentTarget;
    const rootPath = listRoot.dataset.path;
    const rootKind = listRoot.dataset.kind || kind;
    if (folderEl && listRoot.contains(folderEl)) {
      ev.preventDefault();
      const folderPath = folderEl.dataset.path;
      if (!folderPath) return;
      AssetContextMenu.show([
        {
          label: 'New Folder',
          onSelect: () => handleCreateAssetFolder(folderPath, rootKind)
        },
        {
          label: 'Delete Folder',
          danger: true,
          onSelect: () => handleDeleteAssetFolder(folderPath)
        }
      ], ev.pageX, ev.pageY);
      return;
    }
    if (!rootPath) return;
    ev.preventDefault();
    AssetContextMenu.show([
      {
        label: 'New Folder',
        onSelect: () => handleCreateAssetFolder(rootPath, rootKind)
      }
    ], ev.pageX, ev.pageY);
  });
  rootEl.addEventListener('click', (ev) => {
    if (!ev.target.closest('.asset')) setSelectedAsset(null);
  });
  setupReorderContainer(rootEl);
  rootEl._assetCtxReady = true;
}

const SUMMPACK_CATEGORY_ORDER = ['character', 'background', 'object', 'audio'];
const SUMMPACK_FILE_FILTERS = {
  character: (p) => isImage(p),
  background: (p) => isImage(p),
  object: (p) => isImage(p) || isVideo(p),
  audio: (p) => isAudio(p)
};

function canonicalAssetKeyForPack(p) {
  const canon = canonicalPath(p);
  return canon ? canon.toLowerCase() : String(p || '').toLowerCase();
}

function normalizePackPathInput(raw, fallback = '') {
  const fallbackText = String(fallback || '').replace(/\\/g, '/');
  let text = String(raw || '').replace(/\\/g, '/').trim();
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\/+/g, '/');
  text = text.replace(/^\/+/, '');
  const parts = text.split('/').map((part) => part.trim()).filter((part) => part && part !== '.' && part !== '..');
  if (!parts.length) {
    return fallbackText
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part && part !== '.' && part !== '..')
      .join('/');
  }
  return parts.join('/');
}

function relativeAssetPathForPack(absPath, rootPath) {
  if (!absPath) return '';
  const assetCanon = canonicalPath(absPath);
  const rootCanon = canonicalPath(rootPath);
  if (!assetCanon || !rootCanon) return basename(absPath);
  const assetLower = assetCanon.toLowerCase();
  const rootLower = rootCanon.toLowerCase();
  if (assetLower === rootLower) return '';
  if (assetLower.startsWith(`${rootLower}/`)) {
    return assetCanon.slice(rootCanon.length + 1);
  }
  return basename(absPath);
}

async function showSummpackExportDialog() {
  if (!PATHS) return;
  const overlay = document.createElement('div');
  overlay.className = 'asset-confirm-overlay summpack-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'summpack-dialog';
  overlay.appendChild(dialog);

  const title = document.createElement('h2');
  title.textContent = 'Export Asset Pack';
  dialog.appendChild(title);

  const intro = document.createElement('p');
  intro.className = 'summpack-intro';
  intro.textContent = 'Select the assets you want to include. You can adjust their pack path or category before exporting.';
  dialog.appendChild(intro);

  const nameRow = document.createElement('div');
  nameRow.className = 'summpack-name-row';
  const nameLabel = document.createElement('label');
  nameLabel.htmlFor = 'summpack-name-input';
  nameLabel.textContent = 'Pack file name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'summpack-name-input';
  nameInput.placeholder = 'e.g. my-assets';
  nameInput.value = 'my-assets';
  nameRow.append(nameLabel, nameInput);
  dialog.appendChild(nameRow);

  const loading = document.createElement('div');
  loading.className = 'summpack-loading';
  loading.textContent = 'Loading assets...';
  dialog.appendChild(loading);

  document.body.appendChild(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  };

  document.addEventListener('keydown', onKey, true);

  let assetTrees;
  try {
    assetTrees = await Promise.all([
      window.suAPI.readAssetTree(PATHS.characters),
      window.suAPI.readAssetTree(PATHS.backgrounds),
      window.suAPI.readAssetTree(PATHS.objects),
      window.suAPI.readAssetTree(PATHS.audio)
    ]);
  } catch (err) {
    console.error('summpack export load error', err);
    loading.textContent = 'We could not load your asset folders.';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.className = 'primary';
    closeBtn.addEventListener('click', close);
    dialog.appendChild(closeBtn);
    return;
  }

  loading.remove();

  const categoryData = {
    character: { label: 'Characters', tree: assetTrees[0] || [], root: PATHS.characters },
    background: { label: 'Backgrounds', tree: assetTrees[1] || [], root: PATHS.backgrounds },
    object: { label: 'Objects', tree: assetTrees[2] || [], root: PATHS.objects },
    audio: { label: 'Audio', tree: assetTrees[3] || [], root: PATHS.audio }
  };

  const columns = document.createElement('div');
  columns.className = 'summpack-columns';
  dialog.appendChild(columns);

  const treeColumn = document.createElement('div');
  treeColumn.className = 'summpack-tree';
  columns.appendChild(treeColumn);

  const selectedColumn = document.createElement('div');
  selectedColumn.className = 'summpack-selected';
  columns.appendChild(selectedColumn);

  const selectedHeader = document.createElement('div');
  selectedHeader.className = 'summpack-selected-header';
  selectedHeader.textContent = 'Selected assets';
  selectedColumn.appendChild(selectedHeader);

  const selectedList = document.createElement('div');
  selectedList.className = 'summpack-selected-list';
  selectedColumn.appendChild(selectedList);

  const selectedEmpty = document.createElement('div');
  selectedEmpty.className = 'summpack-selected-empty';
  selectedEmpty.textContent = 'No assets selected yet.';
  selectedColumn.appendChild(selectedEmpty);

  const footer = document.createElement('div');
  footer.className = 'summpack-footer';
  dialog.appendChild(footer);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  footer.appendChild(cancelBtn);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'primary';
  exportBtn.textContent = 'Export Pack';
  exportBtn.disabled = true;
  footer.appendChild(exportBtn);

  const checkboxByKey = new Map();
  const cachedSettings = new Map();
  const selection = new Map();

  const refreshSelectedList = () => {
    selectedList.innerHTML = '';
    const entries = Array.from(selection.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    exportBtn.disabled = entries.length === 0;
    selectedList.hidden = entries.length === 0;
    selectedEmpty.hidden = entries.length !== 0;
    if (!entries.length) return;

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'summpack-selected-item';
      row.dataset.key = entry.key;

      const label = document.createElement('div');
      label.className = 'summpack-selected-label';
      label.textContent = entry.name;
      row.appendChild(label);

      const fields = document.createElement('div');
      fields.className = 'summpack-selected-fields';

      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.className = 'summpack-pack-path';
      pathInput.value = entry.packPath || entry.relPath || entry.name;
      pathInput.addEventListener('change', () => {
        entry.packPath = normalizePackPathInput(pathInput.value, entry.relPath || entry.name);
        pathInput.value = entry.packPath;
        cachedSettings.set(entry.key, { packPath: entry.packPath, category: entry.category });
      });
      fields.appendChild(pathInput);

      const categorySelect = document.createElement('select');
      categorySelect.className = 'summpack-pack-category';
      for (const cat of SUMMPACK_CATEGORY_ORDER) {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = ASSET_KIND_LABELS[cat] || cat;
        if (cat === entry.category) opt.selected = true;
        categorySelect.appendChild(opt);
      }
      categorySelect.addEventListener('change', () => {
        entry.category = categorySelect.value;
        cachedSettings.set(entry.key, { packPath: entry.packPath, category: entry.category });
      });
      fields.appendChild(categorySelect);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'summpack-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        selection.delete(entry.key);
        cachedSettings.set(entry.key, { packPath: entry.packPath, category: entry.category });
        const box = checkboxByKey.get(entry.key);
        if (box) box.checked = false;
        refreshSelectedList();
      });
      fields.appendChild(removeBtn);

      row.appendChild(fields);

      const hint = document.createElement('div');
      hint.className = 'summpack-selected-hint';
      hint.textContent = entry.relPath ? `Original path: ${entry.relPath}` : 'Original path: (root)';
      row.appendChild(hint);

      selectedList.appendChild(row);
    }
  };

  const toggleSelection = (checkbox, forcedState = null, shouldRefresh = true) => {
    if (!checkbox) return false;
    const key = checkbox.dataset.key;
    if (!key) return false;
    const targetState = forcedState != null ? !!forcedState : !!checkbox.checked;
    checkbox.checked = targetState;
    let changed = false;
    if (targetState) {
      if (!selection.has(key)) {
        const relPath = checkbox.dataset.relPath || checkbox.dataset.name || '';
        const cached = cachedSettings.get(key) || {};
        const entry = {
          key,
          absPath: checkbox.dataset.absPath,
          relPath,
          packPath: cached.packPath || relPath,
          category: cached.category || checkbox.dataset.category,
          originalCategory: checkbox.dataset.category,
          name: checkbox.dataset.name || relPath || key
        };
        selection.set(key, entry);
        changed = true;
      }
    } else if (selection.has(key)) {
      const existing = selection.get(key);
      cachedSettings.set(key, { packPath: existing.packPath, category: existing.category });
      selection.delete(key);
      changed = true;
    }
    if (changed && shouldRefresh) refreshSelectedList();
    return changed;
  };

  const buildTreeNodes = (container, nodes, rootPath, category) => {
    for (const node of nodes || []) {
      if (node.type === 'dir') {
        const details = document.createElement('details');
        details.className = 'summpack-folder';
        const summary = document.createElement('summary');
        summary.textContent = node.name;
        details.appendChild(summary);
        const inner = document.createElement('div');
        inner.className = 'summpack-folder-contents';
        details.appendChild(inner);
        container.appendChild(details);
        buildTreeNodes(inner, node.children || [], rootPath, category);
        continue;
      }
      if (node.type !== 'file') continue;
      const acceptFn = SUMMPACK_FILE_FILTERS[category] || (() => true);
      if (!acceptFn(node.path)) continue;
      const key = canonicalAssetKeyForPack(node.path);
      const relPath = relativeAssetPathForPack(node.path, rootPath) || node.name;
      const label = document.createElement('label');
      label.className = 'summpack-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.category = category;
      checkbox.dataset.absPath = node.path;
      checkbox.dataset.relPath = relPath;
      checkbox.dataset.key = key;
      checkbox.dataset.name = node.name;
      checkbox.addEventListener('change', () => toggleSelection(checkbox));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'summpack-item-name';
      nameSpan.textContent = node.name;
      const pathSpan = document.createElement('span');
      pathSpan.className = 'summpack-item-path';
      pathSpan.textContent = relPath;
      label.append(checkbox, nameSpan, pathSpan);
      container.appendChild(label);
      checkboxByKey.set(key, checkbox);
    }
  };

  const buildCategorySection = (category) => {
    const info = categoryData[category];
    if (!info) return null;
    const section = document.createElement('section');
    section.className = 'summpack-tree-section';
    section.dataset.category = category;

    const header = document.createElement('div');
    header.className = 'summpack-tree-header';
    const heading = document.createElement('h3');
    heading.textContent = info.label;
    header.appendChild(heading);

    const controls = document.createElement('div');
    controls.className = 'summpack-tree-controls';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.textContent = 'Select all';
    selectAllBtn.addEventListener('click', () => {
      const boxes = section.querySelectorAll('input[type="checkbox"][data-key]');
      let changed = false;
      boxes.forEach((box) => {
        if (toggleSelection(box, true, false)) changed = true;
      });
      if (changed) refreshSelectedList();
    });
    controls.appendChild(selectAllBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      const boxes = section.querySelectorAll('input[type="checkbox"][data-key]');
      let changed = false;
      boxes.forEach((box) => {
        if (toggleSelection(box, false, false)) changed = true;
      });
      if (changed) refreshSelectedList();
    });
    controls.appendChild(clearBtn);

    header.appendChild(controls);
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'summpack-tree-body';
    const list = document.createElement('div');
    list.className = 'summpack-tree-list';
    body.appendChild(list);
    section.appendChild(body);

    buildTreeNodes(list, info.tree || [], info.root, category);
    return section;
  };

  for (const category of SUMMPACK_CATEGORY_ORDER) {
    const section = buildCategorySection(category);
    if (section) treeColumn.appendChild(section);
  }

  refreshSelectedList();

  exportBtn.addEventListener('click', async () => {
    if (!selection.size) return;
    const items = [];
    for (const entry of selection.values()) {
      entry.packPath = normalizePackPathInput(entry.packPath, entry.relPath || entry.name);
      items.push({
        sourcePath: entry.absPath,
        category: entry.category,
        originalCategory: entry.originalCategory,
        packPath: entry.packPath
      });
    }
    const defaultName = (nameInput.value || '').trim() || 'asset-pack';
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';
    try {
      const res = await window.suAPI.summpackExport({ items, defaultName });
      if (!res || res.canceled) {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export Pack';
        return;
      }
      if (!res.ok) {
        throw new Error(res.error || 'Unable to export that pack.');
      }
      close();
      alert(`Exported ${res.count || items.length} asset(s).`);
    } catch (err) {
      console.error('summpackExport error', err);
      alert(err?.message || 'Unable to export that pack.');
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export Pack';
    }
  });
}

async function handleSummpackImport() {
  try {
    const res = await window.suAPI.summpackImport({});
    if (!res || res.canceled) return;
    if (!res.ok) {
      alert(res?.error || 'We could not import that pack.');
      return;
    }
    await loadPalettes();
    await renderBackgroundOptions();
    await nextAnimationFrame();
    if (Array.isArray(res.added) && res.added.length) {
      highlightImportedAssets(res.added);
    }
    const messages = [`Imported ${Array.isArray(res.added) ? res.added.length : 0} asset(s).`];
    const skipMsg = buildSkippedMessage(res.skipped);
    if (skipMsg) messages.push(skipMsg);
    alert(messages.filter(Boolean).join('\n'));
  } catch (err) {
    console.error('summpackImport error', err);
    alert('We could not import that pack.');
  }
}

function setupAssetHeading(headingEl, { kind, path }) {
  if (!headingEl) return;
  headingEl.dataset.kind = kind || '';
  headingEl.dataset.path = path || '';
  const canon = canonicalPath(path);
  if (canon) headingEl.dataset.canonPath = canon;
  else delete headingEl.dataset.canonPath;
  if (headingEl._assetHeadingReady) return;
  headingEl.addEventListener('contextmenu', (ev) => {
    const basePath = headingEl.dataset.path;
    const baseKind = headingEl.dataset.kind || kind;
    if (!basePath) return;
    ev.preventDefault();
    AssetContextMenu.show([
      {
        label: 'New Folder',
        onSelect: () => handleCreateAssetFolder(basePath, baseKind)
      }
    ], ev.pageX, ev.pageY);
  });
  headingEl._assetHeadingReady = true;
}

function setupAssetFolder(folderEl, headerEl, contentsEl, { kind, path, parentPath }) {
  if (!folderEl) return;
  folderEl.dataset.kind = kind || '';
  folderEl.dataset.path = path || '';
  folderEl.dataset.parentPath = parentPath || folderEl.dataset.parentPath || folderEl.parentElement?.dataset?.dirPath || '';
  const canon = canonicalPath(path);
  if (canon) folderEl.dataset.canonPath = canon;
  else delete folderEl.dataset.canonPath;
  const canReorder = Boolean(folderEl.dataset.parentPath);
  if (headerEl) {
    headerEl.dataset.kind = kind || '';
    headerEl.dataset.dropPath = path || '';
    headerEl.dataset.parentPath = folderEl.dataset.parentPath || '';
    if (canon) headerEl.dataset.canonPath = canon;
    else delete headerEl.dataset.canonPath;
    headerEl.draggable = canReorder;
    if (canReorder) {
      headerEl.addEventListener('dragstart', onFolderDragStart);
      headerEl.addEventListener('dragend', onFolderDragEnd);
    }
  }
  if (contentsEl) {
    contentsEl.dataset.kind = kind || '';
    contentsEl.dataset.dropPath = path || '';
    contentsEl.dataset.dirPath = path || '';
    if (canon) contentsEl.dataset.canonPath = canon;
    else delete contentsEl.dataset.canonPath;
  }
  prepareDropTarget(folderEl, { kind, path });
  if (headerEl) prepareDropTarget(headerEl, { kind, path });
  if (contentsEl) prepareDropTarget(contentsEl, { kind, path });
  if (contentsEl) setupReorderContainer(contentsEl);
}

async function loadPalettes() {
  AssetContextMenu.hide();
  const charTree  = await window.suAPI.readAssetTree(PATHS.characters);
  const objTree   = await window.suAPI.readAssetTree(PATHS.objects);
  const audioTree = await window.suAPI.readAssetTree(PATHS.audio);

  buildCharacterTree('#characters-list', charTree);
  buildObjectTree('#objects-list', objTree);
  buildAudioTree('#audio-list',   audioTree);
  restoreSelectedAsset();
  applyCurrentPaletteFilter();
}

function buildAssetTree(containerSel, tree, {
  kind = 'object',
  rootPath = null,
  acceptFile = (node) => node.type === 'file',
  renderThumb = null,
  extraTopFactory = null
} = {}) {
  const rootEl = $(containerSel);
  if (!rootEl) return;
  rootEl.innerHTML = '';
  setupAssetRootInteractions(rootEl, { kind, path: rootPath });
  const heading = rootEl.previousElementSibling;
  if (heading && heading.tagName === 'H3') {
    setupAssetHeading(heading, { kind, path: rootPath });
  }

  const extras = extraTopFactory ? extraTopFactory() : null;
  if (extras) {
    const nodes = Array.isArray(extras) ? extras : [extras];
    for (const node of nodes) {
      if (node) rootEl.appendChild(node);
    }
  }

  function makeFolder(info, parentDirPath) {
    const folder = document.createElement('div');
    folder.className = 'folder';
    folder.dataset.name = info?.name || '';
    folder.dataset.path = info?.path || '';
    folder.dataset.parentPath = parentDirPath || rootPath || '';
    const folderCanon = canonicalPath(info?.path);
    if (folderCanon) folder.dataset.canonPath = folderCanon;

    const header = document.createElement('button');
    header.className = 'folder-header';
    header.type = 'button';
    header.setAttribute('aria-expanded', 'false');
    header.innerHTML = `<span class="chev">></span><span class="fname">${info?.name || ''}</span>`;
    folder.appendChild(header);

    const contents = document.createElement('div');
    contents.className = 'folder-contents';
    contents.style.display = 'none';
    folder.appendChild(contents);

    header.addEventListener('click', () => {
      const open = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', String(!open));
      const chev = header.querySelector('.chev');
      if (chev) chev.textContent = open ? '>' : 'v';
      contents.style.display = open ? 'none' : 'grid';
    });

    setupAssetFolder(folder, header, contents, { kind, path: info?.path, parentPath: parentDirPath || rootPath || '' });

    return { folder, contents };
  }

  function walk(nodes, parentEl, parentDirPath) {
    for (const n of nodes || []) {
      if (n.type === 'dir') {
        const { folder, contents } = makeFolder(n, parentDirPath);
        parentEl.appendChild(folder);
        walk(n.children, contents, n.path);
        continue;
      }

      if (!acceptFile(n)) continue;

      const row = document.createElement('div');
      row.className = 'asset';
      row.draggable = true;
      row.dataset.kind = kind;
      row.dataset.path = n.path;
      const canonAssetPath = canonicalPath(n.path);
      if (canonAssetPath) row.dataset.canonPath = canonAssetPath;
      row.dataset.name = n.name;

      const thumb = renderThumb ? renderThumb(n) : null;
      if (thumb) row.appendChild(thumb);

      const label = document.createElement('div');
      label.className = 'asset-label';
      label.textContent = n.name;
      row.appendChild(label);

      row.addEventListener('click', () => setSelectedAsset(row));
      row.addEventListener('dragstart', onPaletteDragStart);
      parentEl.appendChild(row);
    }
  }

  walk(tree || [], rootEl, rootPath);
}

// Collapsible, recursive folders for Characters
function buildCharacterTree(containerSel, tree) {
  buildAssetTree(containerSel, tree, {
    kind: 'character',
    rootPath: PATHS?.characters || null,
    acceptFile: (n) => n.type === 'file' && isImage(n.path),
    renderThumb: (n) => {
      const img = document.createElement('img');
      img.src = fileUrl(n.path);
      return img;
    }
  });
}

function buildObjectTree(containerSel, tree) {
  buildAssetTree(containerSel, tree, {
    kind: 'object',
    rootPath: PATHS?.objects || null,
    acceptFile: (n) => n.type === 'file' && (isImage(n.path) || isVideo(n.path)),
    renderThumb: (n) => {
      if (isImage(n.path)) {
        const img = document.createElement('img');
        img.src = fileUrl(n.path);
        return img;
      }
      if (isVideo(n.path)) {
        const badge = document.createElement('div');
        badge.style.cssText = 'width:32px;height:32px;display:grid;place-items:center;background:#0b0e12;border:1px solid #2a2f36;border-radius:6px;font-size:11px;';
        badge.textContent = 'VID';
        return badge;
      }
      return null;
    }
  });
}

function createAudioTtsButton() {
  const gen = document.createElement('div');
  gen.className = 'asset';
  gen.dataset.kind = 'audio';
  gen.dataset.name = 'Generate TTS';
  gen.style.border = '1px dashed #2a2f36';
  gen.style.justifyContent = 'center';
  gen.style.cursor = 'pointer';
  gen.style.marginBottom = '6px';
  gen.innerHTML = `
    <div style="width:32px;height:32px;display:grid;place-items:center;background:#0b0e12;border:1px solid #2a2f36;border-radius:6px;font-size:16px;">+</div>
    <div class="asset-label">Generate TTS...</div>`;
  gen.addEventListener('click', generateTTSIntoTimeline);
  return gen;
}

function buildAudioTree(containerSel, tree) {
  buildAssetTree(containerSel, tree, {
    kind: 'audio',
    rootPath: PATHS?.audio || null,
    acceptFile: (n) => n.type === 'file' && isAudio(n.path),
    renderThumb: () => {
      const badge = document.createElement('div');
      badge.style.cssText = 'width:32px;height:32px;display:grid;place-items:center;background:#0b0e12;border:1px solid #2a2f36;border-radius:6px;font-size:12px;';
      badge.textContent = 'AUD';
      return badge;
    },
    extraTopFactory: () => createAudioTtsButton()
  });
}

function onPaletteDragStart(e) {
  const { kind, path, name } = e.currentTarget.dataset;
  e.dataTransfer.setData('text/plain', JSON.stringify({ kind, path, name }));
}

// ---------- TTS generate ----------
async function generateTTSIntoTimeline() {
  if (ttsLaunchInProgress) return;
  ttsLaunchInProgress = true;
  try {
    if (!isAppReady) await appReady;
    const params = await showTTSDialog();
    if (!params) return; // cancelled

    const spokenText = params.text;
    const subtitleTextRaw = typeof params.subtitleText === 'string' ? params.subtitleText.trim() : '';
    const subtitleText = subtitleTextRaw || spokenText;
    const subtitleAssText = typeof params.subtitleAssText === 'string' ? params.subtitleAssText : subtitleText;
    const subtitleAssMeta = (params.subtitleAssMeta && typeof params.subtitleAssMeta === 'object' && !Array.isArray(params.subtitleAssMeta))
      ? { ...params.subtitleAssMeta }
      : null;
    const characterName = sanitizeTtsCharacterName(params.character || '');

    // filename from spoken text
    const baseName = textToSafeFilename(spokenText, 80);
    const fname = `${baseName}.wav`;

    // output path (prefer app's writable folder)
    const dir = (PATHS.userAudioOut || PATHS.audio || PATHS.base || '').replace(/[\\/]+$/,'');
    const outPath = dir ? (dir + '\\' + fname) : fname; // Windows join

    // synthesize (note: uses ttsAPI, not suAPI)
    await window.ttsAPI.synthesize({
      text: spokenText,
      isXml: false,
      voiceId: params.voiceId || null,
      rate: params.rate,
      volume: params.volume,
      outputPath: outPath,
    });

    if (characterName) rememberTtsCharacter(characterName);

    const labelBody = subtitleText || spokenText || fname;
    const clipLabel = characterName ? `${characterName}: ${labelBody}` : labelBody;

    // drop the new audio at playhead; update length after metadata loads
    const trackIdx = getNextTrackIndex('audio');
    const au = {
      id: uid(),
      kind: 'audio',
      name: clipLabel || fname,          // label shows character and subtitle text
      path: outPath,
      start: currentTime,
      end: currentTime + 3000, // temp; corrected below
      type: 'audio',
      trackIndex: trackIdx,
      volume: 1,
      muted: false,
      playbackRate: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      crossfadePrevMs: 0,
      crossfadeNextMs: 0,
      effects: cloneAudioEffectDefaults(),
      characterName: characterName || null,
      dialogText: subtitleText,
      ttsSpokenText: spokenText,
      subtitleAssText,
      subtitleAssMeta,
    };
    PROJECT.audio.push(au);
    scheduleAutosave('add-audio-tts');

    initializeAudioRuntimeState(au, { waveSource: null });
    au._el.addEventListener('loadedmetadata', () => {
      if (isFinite(au._el.duration) && au._el.duration > 0) {
        const durMs = Math.round(au._el.duration * 1000);
        au.end = au.start + durMs;
        renderTimeline();
      }
    }, { once: true });

    renderTimeline();
    scheduleSubtitlePreviewRebuild({ immediate: true });
  } catch (e) {
    console.error('TTS error:', e);
  } finally {
    ttsLaunchInProgress = false;
  }
}

// ---------- Text helpers ----------
const TEXT_DEFAULT_STYLE = Object.freeze({
  size: 36,
  color: '#ffffff',
  font: 'system-ui, Arial, sans-serif',
  align: 'center',
  strokeW: 2,
  strokeColor: '#000000',
  shadowX: 2,
  shadowY: 2,
  shadowBlur: 4,
  shadowColor: '#000000',
  bgOn: true,
  bgColor: '#000000',
  bgAlpha: 0.4,
  bgPad: 8,
  bgRadius: 8,
  opacity: 1
});

function hydrateTextStyle(raw) {
  const base = { ...TEXT_DEFAULT_STYLE };
  if (!raw) return base;
  const merged = { ...base, ...raw };
  merged.size = Number.isFinite(+merged.size) ? Math.max(6, Math.min(400, +merged.size)) : base.size;
  merged.strokeW = Number.isFinite(+merged.strokeW) ? Math.max(0, Math.min(40, +merged.strokeW)) : base.strokeW;
  merged.shadowX = Number.isFinite(+merged.shadowX) ? +merged.shadowX : base.shadowX;
  merged.shadowY = Number.isFinite(+merged.shadowY) ? +merged.shadowY : base.shadowY;
  merged.shadowBlur = Number.isFinite(+merged.shadowBlur) ? Math.max(0, Math.min(200, +merged.shadowBlur)) : base.shadowBlur;
  merged.bgAlpha = Number.isFinite(+merged.bgAlpha) ? clamp01(+merged.bgAlpha) : base.bgAlpha;
  merged.bgPad = Number.isFinite(+merged.bgPad) ? Math.max(0, Math.min(200, +merged.bgPad)) : base.bgPad;
  merged.bgRadius = Number.isFinite(+merged.bgRadius) ? Math.max(0, Math.min(200, +merged.bgRadius)) : base.bgRadius;
  merged.opacity = Number.isFinite(+merged.opacity) ? clamp01(+merged.opacity) : base.opacity;
  merged.align = ['left','center','right'].includes(merged.align) ? merged.align : base.align;
  if (typeof merged.bgOn !== 'boolean') merged.bgOn = !!base.bgOn;
  merged.color = merged.color || base.color;
  merged.strokeColor = merged.strokeColor || base.strokeColor;
  merged.shadowColor = merged.shadowColor || base.shadowColor;
  merged.bgColor = merged.bgColor || base.bgColor;
  merged.font = merged.font || base.font;
  return merged;
}

const WATERMARK_POSITION_OPTIONS = Object.freeze([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
]);

function watermarkPositionLabel(value) {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeWatermarkConfig(raw) {
  if (!raw) return null;
  const mode = raw.mode === 'image' ? 'image' : raw.mode === 'text' ? 'text' : null;
  if (!mode) return null;

  if (mode === 'image') {
    const imagePath = raw.imagePath || raw.path || null;
    if (!imagePath) return null;
    return {
      mode,
      imagePath,
      imageName: raw.imageName || basename(imagePath),
      size: Number.isFinite(+raw.size) ? clamp(+raw.size, 0.05, 0.6) : 0.2,
      opacity: Number.isFinite(+raw.opacity) ? clamp01(+raw.opacity) : 0.7,
      position: WATERMARK_POSITION_OPTIONS.includes(raw.position) ? raw.position : 'bottom-right'
    };
  }

  const content = (raw.text?.content ?? raw.content ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) return null;
  const styleSource = raw.text?.style || raw.style || null;
  const style = hydrateTextStyle(styleSource || {});
  return {
    mode: 'text',
    text: {
      content,
      style
    },
    size: Number.isFinite(+raw.size) ? clamp(+raw.size, 0.05, 0.6) : 0.2,
    opacity: Number.isFinite(+raw.opacity) ? clamp01(+raw.opacity) : 0.7,
    position: WATERMARK_POSITION_OPTIONS.includes(raw.position) ? raw.position : 'bottom-right'
  };
}

async function prepareWatermarkRenderState(config) {
  if (!config) return null;
  if (config.mode === 'image') {
    const img = await loadImageElement(config.imagePath);
    if (!img) return null;
    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    if (!iw || !ih) return null;
    return {
      mode: 'image',
      image: img,
      imagePath: config.imagePath,
      imageName: config.imageName || basename(config.imagePath),
      baseWidth: iw,
      baseHeight: ih,
      size: Number.isFinite(+config.size) ? clamp(+config.size, 0.05, 0.6) : 0.2,
      opacity: Number.isFinite(+config.opacity) ? clamp01(+config.opacity) : 0.7,
      position: WATERMARK_POSITION_OPTIONS.includes(config.position) ? config.position : 'bottom-right'
    };
  }

  if (config.mode !== 'text' || !config.text) return null;
  const content = (config.text.content || '').replace(/\r\n/g, '\n');
  const linesRaw = content.split('\n');
  const lines = linesRaw.length ? linesRaw : [''];
  const style = hydrateTextStyle(config.text.style || {});
  const fontFamily = style.font || 'system-ui, Arial, sans-serif';
  const baseFontSize = style.size ?? 36;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = `${baseFontSize}px ${fontFamily}`;
  measureCtx.textAlign = 'left';
  measureCtx.textBaseline = 'alphabetic';

  let maxWidth = 0;
  let maxAscent = 0;
  let maxDescent = 0;
  const sanitizedLines = lines.map(line => {
    const value = line || '';
    const metrics = measureCtx.measureText(value || ' ');
    const width = metrics.width || 0;
    if (width > maxWidth) maxWidth = width;
    const ascent = metrics.actualBoundingBoxAscent ?? baseFontSize * 0.78;
    const descent = metrics.actualBoundingBoxDescent ?? baseFontSize * 0.22;
    if (ascent > maxAscent) maxAscent = ascent;
    if (descent > maxDescent) maxDescent = descent;
    return value;
  });

  const baseLineHeight = Math.max(baseFontSize * 1.1, (maxAscent + maxDescent) || baseFontSize * 1.2);
  const basePad = style.bgOn ? (style.bgPad ?? 8) : 0;
  const baseWidth = (maxWidth || baseFontSize) + (style.bgOn ? basePad * 2 : 0);
  const baseHeight = sanitizedLines.length * baseLineHeight + (style.bgOn ? basePad * 2 : 0);

  return {
    mode: 'text',
    text: {
      content,
      lines: sanitizedLines,
      style,
      fontFamily,
      baseFontSize,
      baseLineHeight,
      basePad,
      maxLineWidth: maxWidth || baseFontSize
    },
    baseWidth: Math.max(1, baseWidth),
    baseHeight: Math.max(1, baseHeight),
    size: Number.isFinite(+config.size) ? clamp(+config.size, 0.05, 0.6) : 0.2,
    opacity: Number.isFinite(+config.opacity) ? clamp01(+config.opacity) : 0.7,
    position: WATERMARK_POSITION_OPTIONS.includes(config.position) ? config.position : 'bottom-right'
  };
}

function computeWatermarkPlacement(width, height, boxWidth, boxHeight, position, marginBase) {
  const margin = Math.max(8, Number.isFinite(marginBase) ? marginBase : Math.min(width, height) * 0.035);
  const availW = Math.max(0, width - boxWidth);
  const availH = Math.max(0, height - boxHeight);
  const safeMarginX = Math.min(margin, availW / 2);
  const safeMarginY = Math.min(margin, availH / 2);

  const pos = WATERMARK_POSITION_OPTIONS.includes(position) ? position : 'bottom-right';
  let x = (width - boxWidth) / 2;
  let y = (height - boxHeight) / 2;

  switch (pos) {
    case 'top-left':
      x = safeMarginX;
      y = safeMarginY;
      break;
    case 'top-center':
      x = (width - boxWidth) / 2;
      y = safeMarginY;
      break;
    case 'top-right':
      x = width - boxWidth - safeMarginX;
      y = safeMarginY;
      break;
    case 'middle-left':
      x = safeMarginX;
      y = (height - boxHeight) / 2;
      break;
    case 'middle-right':
      x = width - boxWidth - safeMarginX;
      y = (height - boxHeight) / 2;
      break;
    case 'bottom-left':
      x = safeMarginX;
      y = height - boxHeight - safeMarginY;
      break;
    case 'bottom-center':
      x = (width - boxWidth) / 2;
      y = height - boxHeight - safeMarginY;
      break;
    case 'bottom-right':
      x = width - boxWidth - safeMarginX;
      y = height - boxHeight - safeMarginY;
      break;
    default:
      x = (width - boxWidth) / 2;
      y = (height - boxHeight) / 2;
      break;
  }

  const clampX = clamp(x, 0, Math.max(0, width - boxWidth));
  const clampY = clamp(y, 0, Math.max(0, height - boxHeight));
  return { x: clampX, y: clampY };
}

function drawPreparedTextWatermark(ctx, state, info) {
  const textState = state?.text;
  if (!ctx || !textState || !Array.isArray(textState.lines) || !textState.lines.length) return;

  const style = textState.style || {};
  const combinedAlpha = clamp01(info.alpha ?? state.opacity ?? 1) * clamp01(style.opacity ?? 1);
  if (combinedAlpha <= 0.001) return;

  const pad = style.bgOn ? (textState.basePad || 0) * info.scale : 0;
  const drawWidth = info.width;
  const drawHeight = info.height;
  const fontSize = textState.baseFontSize * info.scale;
  const lineHeight = textState.baseLineHeight * info.scale;
  const align = style.align || 'center';
  const textX = align === 'left'
    ? info.x + pad
    : align === 'right'
      ? info.x + drawWidth - pad
      : info.x + drawWidth / 2;
  let textY = info.y + (style.bgOn ? pad : 0);

  ctx.save();
  ctx.globalAlpha *= combinedAlpha;

  if (style.bgOn) {
    const rgb = hexToRgb(style.bgColor || '#000000');
    const bgAlpha = clamp01(style.bgAlpha ?? 0.4);
    const radius = (style.bgRadius ?? 8) * info.scale;
    const prevShadowColor = ctx.shadowColor;
    const prevShadowBlur = ctx.shadowBlur;
    const prevShadowOffsetX = ctx.shadowOffsetX;
    const prevShadowOffsetY = ctx.shadowOffsetY;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${bgAlpha})`;
    drawRoundedRectPath(ctx, info.x, info.y, drawWidth, drawHeight, radius);
    ctx.fill();
    ctx.shadowColor = prevShadowColor;
    ctx.shadowBlur = prevShadowBlur;
    ctx.shadowOffsetX = prevShadowOffsetX;
    ctx.shadowOffsetY = prevShadowOffsetY;
  }

  ctx.font = `${fontSize}px ${textState.fontFamily}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillStyle = style.color || '#ffffff';
  ctx.shadowColor = style.shadowColor || 'transparent';
  ctx.shadowBlur = Math.max(0, style.shadowBlur || 0) * info.scale;
  ctx.shadowOffsetX = (style.shadowX || 0) * info.scale;
  ctx.shadowOffsetY = (style.shadowY || 0) * info.scale;

  const strokeW = Math.max(0, style.strokeW || 0) * info.scale;
  if (strokeW > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, strokeW * 2);
    ctx.strokeStyle = style.strokeColor || '#000000';
  }

  for (const line of textState.lines) {
    const text = line || ' ';
    if (strokeW > 0) ctx.strokeText(text, textX, textY);
    ctx.fillText(text, textX, textY);
    textY += lineHeight;
  }

  ctx.restore();
}

function drawWatermarkOnCanvas(ctx, width, height, state) {
  if (!ctx || !state) return;
  const baseAlpha = clamp01(state.opacity ?? 1);
  if (baseAlpha <= 0.001) return;

  const margin = Math.min(width, height) * 0.035;
  const maxWidth = Math.max(1, width - margin * 2);
  const maxHeight = Math.max(1, height - margin * 2);

  let scale = Math.max(0.01, Number(state.size) || 0.2);
  let targetWidth = width * scale;
  const minWidth = Math.max(1, width * 0.05);
  targetWidth = clamp(targetWidth, minWidth, maxWidth);

  let drawScale = targetWidth / Math.max(1, state.baseWidth || 1);
  if ((state.baseHeight || 1) * drawScale > maxHeight) {
    drawScale = Math.min(drawScale, maxHeight / Math.max(1, state.baseHeight || 1));
  }
  drawScale = clamp(drawScale, 0.05, 10);

  const drawWidth = Math.max(1, (state.baseWidth || 1) * drawScale);
  const drawHeight = Math.max(1, (state.baseHeight || 1) * drawScale);
  const { x, y } = computeWatermarkPlacement(width, height, drawWidth, drawHeight, state.position, margin);

  if (state.mode === 'image' && state.image) {
    ctx.save();
    ctx.globalAlpha *= baseAlpha;
    ctx.drawImage(state.image, x, y, drawWidth, drawHeight);
    ctx.restore();
    return;
  }

  if (state.mode === 'text') {
    drawPreparedTextWatermark(ctx, state, {
      x,
      y,
      width: drawWidth,
      height: drawHeight,
      scale: drawScale,
      alpha: baseAlpha
    });
  }
}

async function buildWatermarkRenderState(rawConfig) {
  const normalized = normalizeWatermarkConfig(rawConfig);
  if (!normalized) return null;
  return await prepareWatermarkRenderState(normalized);
}

const CREDITS_MIN_DURATION_SEC = 4;
const CREDITS_MAX_DURATION_SEC = 180;
const CREDITS_MIN_INTERVAL_SEC = 1;
const CREDITS_MAX_INTERVAL_SEC = 30;

function clampCreditsDurationSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return CREDITS_MIN_DURATION_SEC;
  return clamp(num, CREDITS_MIN_DURATION_SEC, CREDITS_MAX_DURATION_SEC);
}

function clampCreditsIntervalSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 4;
  return clamp(num, CREDITS_MIN_INTERVAL_SEC, CREDITS_MAX_INTERVAL_SEC);
}

function clampCreditsFadeSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return clamp(num, 0, 30);
}

function normalizeCreditsConfig(raw) {
  if (!raw) return null;
  const text = (raw.text || raw.content || '').replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  const style = hydrateTextStyle(raw.style || {});
  const durationSec = clampCreditsDurationSec(raw.durationSec ?? raw.durationSeconds ?? raw.duration ?? 12);
  const direction = raw.direction === 'down' ? 'down' : 'up';
  const backgroundRaw = typeof raw.background === 'object' && raw.background !== null ? raw.background : {};
  const source = backgroundRaw.source === 'frames' ? 'frames' : 'assets';
  const assetPaths = Array.isArray(backgroundRaw.assetPaths)
    ? backgroundRaw.assetPaths.map(path => String(path || '')).filter(Boolean)
    : [];
  let frameTimesMs = [];
  if (Array.isArray(backgroundRaw.frameTimesMs)) {
    const unique = new Set();
    for (const value of backgroundRaw.frameTimesMs) {
      const ms = Math.max(0, Math.round(Number(value) || 0));
      if (unique.has(ms)) continue;
      unique.add(ms);
      frameTimesMs.push(ms);
    }
    frameTimesMs.sort((a, b) => a - b);
  }
  const imageIntervalSec = clampCreditsIntervalSec(backgroundRaw.imageIntervalSec ?? backgroundRaw.intervalSec ?? 4);
  const blur = !!backgroundRaw.blur;
  let audio = null;
  const audioRaw = typeof raw.audio === 'object' && raw.audio !== null ? raw.audio : null;
  if (audioRaw) {
    const path = audioRaw.path || audioRaw.audioPath || null;
    if (path) {
      audio = {
        path,
        name: audioRaw.name || basename(path),
        volume: clamp01(Number(audioRaw.volume ?? 1)),
        fadeInSec: clampCreditsFadeSec(audioRaw.fadeInSec ?? audioRaw.fadeInSeconds ?? 0),
        fadeOutSec: clampCreditsFadeSec(audioRaw.fadeOutSec ?? audioRaw.fadeOutSeconds ?? 0)
      };
    }
  }
      return {
        text,
        style,
        durationSec,
        direction,
        background: {
          source,
          assetPaths,
          frameTimesMs,
          imageIntervalSec,
          blur,
          crossfadeSec: clampCreditsFadeSec(raw.backgroundCrossfadeSec ?? raw.crossfadeSec ?? 0)
        },
        audio
      };
}

function measureCreditsLayout(text, style, width) {
  const canvas = measureCreditsLayout._canvas || document.createElement('canvas');
  const ctx = measureCreditsLayout._ctx || canvas.getContext('2d');
  measureCreditsLayout._canvas = canvas;
  measureCreditsLayout._ctx = ctx;
  const sanitizedText = String(text || '').replace(/\r\n/g, '\n');
  const lines = sanitizedText.split('\n');
  ctx.font = `${style.size}px ${style.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let maxWidth = 0;
  let maxAscent = 0;
  let maxDescent = 0;
  const lineWidths = [];
  for (const line of lines) {
    const value = line || ' ';
    const metrics = ctx.measureText(value);
    const w = metrics.width || 0;
    if (w > maxWidth) maxWidth = w;
    const ascent = metrics.actualBoundingBoxAscent ?? style.size * 0.78;
    const descent = metrics.actualBoundingBoxDescent ?? style.size * 0.22;
    if (ascent > maxAscent) maxAscent = ascent;
    if (descent > maxDescent) maxDescent = descent;
    lineWidths.push(w);
  }
  const baseLineHeight = Math.max(style.size * 1.1, (maxAscent + maxDescent) || style.size * 1.2);
  const contentHeight = lines.length * baseLineHeight;
  const pad = style.bgOn ? Math.max(0, style.bgPad || 0) : 0;
  const maxLineWidth = Math.max(1, maxWidth);
  return {
    lines,
    lineWidths,
    maxLineWidth,
    lineHeight: baseLineHeight,
    contentHeight,
    pad,
    style
  };
}

async function prepareCreditsRenderState(rawConfig, options = {}) {
  const normalized = normalizeCreditsConfig(rawConfig);
  if (!normalized) return null;
  const width = Math.max(1, Math.round(options.width || STAGE_WIDTH));
  const height = Math.max(1, Math.round(options.height || STAGE_HEIGHT));
  const layout = measureCreditsLayout(normalized.text, normalized.style, width);
  const durationSec = clampCreditsDurationSec(normalized.durationSec);
  const durationMs = Math.max(1000, Math.round(durationSec * 1000));
  const background = await prepareCreditsBackgrounds(normalized.background, {
    width,
    height,
    presetWidth: Math.max(1, Math.round(options.presetWidth || width)),
    presetHeight: Math.max(1, Math.round(options.presetHeight || height)),
    mode: options.mode || 'export'
  });
  return {
    width,
    height,
    durationMs,
    direction: normalized.direction,
    lines: layout.lines,
    lineWidths: layout.lineWidths,
    lineHeight: layout.lineHeight,
    contentHeight: layout.contentHeight,
    maxLineWidth: layout.maxLineWidth,
    padding: layout.pad,
    style: layout.style,
    background,
    backgroundIntervalMs: Math.max(1000, background.intervalMs),
    scrollDistance: layout.contentHeight + height
  };
}

async function prepareCreditsBackgrounds(background = {}, options = {}) {
  const intervalSec = clampCreditsIntervalSec(background.imageIntervalSec ?? 4);
  const intervalMs = Math.max(1000, Math.round(intervalSec * 1000));
  const blur = !!background.blur;
  const images = [];
  const mode = options.mode || 'export';
  const maxEntries = mode === 'preview' ? 8 : Infinity;
  if (background.source === 'frames') {
    const times = Array.isArray(background.frameTimesMs) ? background.frameTimesMs.slice() : [];
    const captureWidth = Math.max(1, Math.round(options.presetWidth || options.width || STAGE_WIDTH));
    const captureHeight = Math.max(1, Math.round(options.presetHeight || options.height || STAGE_HEIGHT));
    const preset = { width: captureWidth, height: captureHeight };
    const canvas = document.createElement('canvas');
    canvas.width = captureWidth;
    canvas.height = captureHeight;
    const ctx = canvas.getContext('2d');
    const unique = new Set();
    for (const value of times) {
      const timeMs = Math.max(0, Math.round(Number(value) || 0));
      if (unique.has(timeMs)) continue;
      unique.add(timeMs);
      try {
        ctx.clearRect(0, 0, captureWidth, captureHeight);
        await renderFrameToCanvas(ctx, preset, timeMs, null);
        let image = null;
        if (typeof createImageBitmap === 'function') {
          try {
            image = await createImageBitmap(canvas);
          } catch {
            image = null;
          }
        }
        if (!image) {
          const clone = document.createElement('canvas');
          clone.width = captureWidth;
          clone.height = captureHeight;
          const cloneCtx = clone.getContext('2d');
          cloneCtx.drawImage(canvas, 0, 0);
          image = clone;
        }
        images.push({ image, width: captureWidth, height: captureHeight });
        if (images.length >= maxEntries) break;
      } catch (err) {
        console.warn('credits frame capture failed', err);
      }
    }
  } else {
    const paths = Array.isArray(background.assetPaths) ? background.assetPaths : [];
    const seen = new Set();
    for (const rawPath of paths) {
      const path = String(rawPath || '');
      if (!path || seen.has(path)) continue;
      seen.add(path);
      try {
        const image = await loadImageElement(path);
        if (!image) continue;
        const iw = image.naturalWidth || image.width || 0;
        const ih = image.naturalHeight || image.height || 0;
        if (!iw || !ih) continue;
        images.push({ image, width: iw, height: ih });
        if (images.length >= maxEntries) break;
      } catch (err) {
        console.warn('credits asset load failed', path, err);
      }
    }
  }
  const crossfadeSec = Math.max(0, Math.min(Number(background.crossfadeSec) || 0, intervalSec * 0.9));
  return { images, intervalMs, blur, crossfadeSec };
}

function drawCreditsFrame(ctx, state, timeMs) {
  if (!ctx || !state) return;
  const width = state.width || ctx.canvas?.width || STAGE_WIDTH;
  const height = state.height || ctx.canvas?.height || STAGE_HEIGHT;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  drawCreditsBackground(ctx, state, timeMs);
  const duration = Math.max(1, state.durationMs || 1);
  const clampedTime = clamp(timeMs, 0, duration);
  const progress = duration ? clampedTime / duration : 1;
  const distance = state.scrollDistance || (state.contentHeight + height);
  let top;
  if (state.direction === 'down') {
    top = -state.contentHeight + progress * distance;
  } else {
    top = height - progress * distance;
  }
  drawCreditsText(ctx, state, top);
  ctx.restore();
}

function drawCreditsBackground(ctx, state, timeMs) {
  const width = state.width || ctx.canvas?.width || STAGE_WIDTH;
  const height = state.height || ctx.canvas?.height || STAGE_HEIGHT;
  const background = state.background || {};
  const images = Array.isArray(background.images) ? background.images : [];
  if (images.length) {
    const intervalMs = Math.max(1000, state.backgroundIntervalMs || 4000);
    const cycleIndex = images.length === 1 ? 0 : Math.floor(Math.max(0, timeMs) / intervalMs);
    const index = cycleIndex % images.length;
    const entry = images[index] || images[0];
    const crossfadeSec = Math.max(0, Number(background.crossfadeSec) || 0);
    const crossfadeMs = crossfadeSec > 0 ? crossfadeSec * 1000 : 0;
    const phase = Math.max(0, timeMs % intervalMs);
    const crossfadeActive = crossfadeMs > 0 && crossfadeMs < intervalMs && phase >= intervalMs - crossfadeMs && images.length > 1;

    const drawBgImage = (image, alpha = 1) => {
      if (!image) return;
      ctx.save();
      ctx.globalAlpha *= clamp01(alpha);
      if (background.blur) {
        const blurPx = Math.max(2, Math.round(Math.min(width, height) * 0.025));
        ctx.filter = `blur(${blurPx}px)`;
      }
      drawImageCover(ctx, image, width, height);
      ctx.filter = 'none';
      ctx.restore();
    };

    if (entry && entry.image) {
      if (crossfadeActive) {
        const nextIndex = (index + 1) % images.length;
        const nextEntry = images[nextIndex];
        const fadeProgress = (phase - (intervalMs - crossfadeMs)) / crossfadeMs;
        const prevAlpha = clamp01(1 - fadeProgress);
        const nextAlpha = clamp01(fadeProgress);
        drawBgImage(entry.image, prevAlpha);
        drawBgImage(nextEntry?.image, nextAlpha);
      } else {
        drawBgImage(entry.image, 1);
      }
    } else {
      drawCreditsFallbackBackground(ctx, width, height);
    }
  } else {
    drawCreditsFallbackBackground(ctx, width, height);
  }
  ctx.fillStyle = 'rgba(8,12,18,0.35)';
  ctx.fillRect(0, 0, width, height);
}

function drawCreditsFallbackBackground(ctx, width, height) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#101722');
  gradient.addColorStop(1, '#05080d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawCreditsText(ctx, state, top) {
  const width = state.width || ctx.canvas?.width || STAGE_WIDTH;
  const style = state.style || TEXT_DEFAULT_STYLE;
  const padding = Math.max(0, state.padding || 0);
  ctx.save();
  const globalOpacity = Number.isFinite(style.opacity) ? clamp01(style.opacity) : 1;
  ctx.globalAlpha *= globalOpacity;
  if (style.bgOn) {
    const bgWidth = state.maxLineWidth + padding * 2;
    const bgHeight = state.contentHeight + padding * 2;
    const bgX = width / 2 - bgWidth / 2;
    const bgY = top - padding;
    const radius = style.bgRadius ?? 8;
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = formatRgba(style.bgColor || '#000000', style.bgAlpha ?? 0.45);
    drawRoundedRectPath(ctx, bgX, bgY, bgWidth, bgHeight, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.font = `${style.size}px ${style.font}`;
  ctx.textBaseline = 'top';
  const align = style.align === 'left' || style.align === 'right' ? style.align : 'center';
  ctx.textAlign = align;
  ctx.shadowColor = style.shadowColor || 'transparent';
  ctx.shadowBlur = Math.max(0, style.shadowBlur || 0);
  ctx.shadowOffsetX = style.shadowX || 0;
  ctx.shadowOffsetY = style.shadowY || 0;
  const strokeWidth = Math.max(0, style.strokeW || 0);
  if (strokeWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, strokeWidth * 2);
    ctx.strokeStyle = style.strokeColor || '#000000';
  }
  ctx.fillStyle = style.color || '#ffffff';
  let textX;
  if (align === 'left') {
    textX = width / 2 - state.maxLineWidth / 2;
  } else if (align === 'right') {
    textX = width / 2 + state.maxLineWidth / 2;
  } else {
    textX = width / 2;
  }
  let drawY = top;
  for (let i = 0; i < state.lines.length; i++) {
    const text = state.lines[i] || ' ';
    if (strokeWidth > 0) ctx.strokeText(text, textX, drawY);
    ctx.fillText(text, textX, drawY);
    drawY += state.lineHeight;
  }
  ctx.restore();
}

function drawImageCover(ctx, image, targetWidth, targetHeight) {
  if (!image) return;
  const dims = getDrawableDimensions(image);
  const iw = Math.max(1, dims.width);
  const ih = Math.max(1, dims.height);
  const scale = Math.max(targetWidth / iw, targetHeight / ih);
  const drawWidth = iw * scale;
  const drawHeight = ih * scale;
  const drawX = (targetWidth - drawWidth) / 2;
  const drawY = (targetHeight - drawHeight) / 2;
  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function getDrawableDimensions(image) {
  if (!image) return { width: 0, height: 0 };
  const width = image.naturalWidth ?? image.videoWidth ?? image.displayWidth ?? image.width ?? image.canvas?.width ?? 0;
  const height = image.naturalHeight ?? image.videoHeight ?? image.displayHeight ?? image.height ?? image.canvas?.height ?? 0;
  return { width, height };
}

async function showFxDialog(target, { kind = 'visual' } = {}) {
  if (!target) return { ok: false };
  hydrateFx(target);
  const original = cloneFx(target.fx);
  const working = cloneFx(original);
  const title = kind === 'bg' ? 'Background Effects' : 'Visual Effects';
  const name = target?.name ? ` Ã¢â‚¬â€ ${target.name}` : '';

  const fieldDefs = [
    { name: 'brightness',  label: 'Brightness',                min: -100, max: 200, step: 1,   decimals: 0, format: v => `${v > 0 ? '+' : ''}${Math.round(v)}%` },
    { name: 'contrast',    label: 'Contrast',                  min: -100, max: 200, step: 1,   decimals: 0, format: v => `${v > 0 ? '+' : ''}${Math.round(v)}%` },
    { name: 'saturation',  label: 'Saturation',                min: -100, max: 300, step: 1,   decimals: 0, format: v => `${v > 0 ? '+' : ''}${Math.round(v)}%` },
    { name: 'hue',         label: 'Hue Shift',                 min: -180, max: 180, step: 1,   decimals: 0, format: v => `${v > 0 ? '+' : ''}${Math.round(v)}Ã‚Â°` },
    { name: 'blur',        label: 'Blur',                      min: 0,    max: 40,  step: 0.5, decimals: 1, format: v => `${v.toFixed(1)} px` },
    { name: 'sharpen',     label: 'Sharpen',                   min: 0,    max: 100, step: 1,   decimals: 0, format: v => `${v > 0 ? '+' : ''}${Math.round(v)}%` },
    { name: 'temperature', label: 'Temperature (Cool ? Warm)', min: -100, max: 100, step: 1,   decimals: 0, format: v => {
        const n = Math.round(v);
        if (n === 0) return 'Neutral';
        const label = n > 0 ? 'Warm' : 'Cool';
        return `${label} ${n > 0 ? '+' : ''}${Math.abs(n)}`;
      } },
    { name: 'tint',        label: 'Tint (Green ? Magenta)',    min: -100, max: 100, step: 1,   decimals: 0, format: v => {
        const n = Math.round(v);
        if (n === 0) return 'Neutral';
        const label = n > 0 ? 'Magenta' : 'Green';
        return `${label} ${n > 0 ? '+' : ''}${Math.abs(n)}`;
      } }
  ];

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:grid;place-items:center;';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(520px,95vw);max-height:92vh;overflow:auto;background:#0f141a;border:1px solid #2a2f36;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.6);padding:18px;display:grid;gap:16px;font:14px/1.4 system-ui;';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div style="font-weight:600;font-size:16px;">${title}${name}</div>
        <button data-act="cancel" style="background:none;border:none;color:#8fa2b7;font-size:18px;padding:2px 6px;cursor:pointer;">X</button>
      </div>
      <div style="color:#8fa2b7;font-size:13px;">Adjust visual filters. Changes preview instantly and apply to exports.</div>
      <div data-role="fx-fields" style="display:grid;gap:14px;"></div>
      <div data-role="preview-section" style="display:grid;gap:10px;">
        <span style="font-weight:600;">Preview</span>
        <div data-role="preview-wrap" style="background:#12161b;border:1px solid #1f2630;border-radius:12px;padding:16px;display:flex;justify-content:center;align-items:center;min-height:160px;">
          <div data-role="preview" style="max-width:100%;max-height:100%;display:flex;justify-content:center;align-items:center;padding:8px;border-radius:10px;overflow:hidden;color:#8fa2b7;font-size:13px;"></div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <button data-act="reset" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:8px;padding:8px 14px;">Reset</button>
        <div style="display:flex;gap:10px;">
          <button data-act="cancel" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:8px;padding:8px 14px;">Cancel</button>
          <button data-act="apply" style="background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:8px;padding:8px 16px;font-weight:600;">Apply</button>
        </div>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const fieldsWrap = box.querySelector('[data-role="fx-fields"]');
    const previewWrap = box.querySelector('[data-role="preview-wrap"]');
    const previewBox = box.querySelector('[data-role="preview"]');
    const cancelBtns = box.querySelectorAll('[data-act="cancel"]');
    const applyBtn = box.querySelector('[data-act="apply"]');
    const resetBtn = box.querySelector('[data-act="reset"]');

    let previewTargetEl = previewBox;

    previewBox.innerHTML = '';
    if (kind === 'visual' && target.path) {
      const img = document.createElement('img');
      img.src = fileUrl(target.path);
      img.alt = target.name || 'Visual preview';
      img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.45);';
      previewBox.appendChild(img);
      previewTargetEl = img;
    } else if (kind === 'bg' && target.path) {
      const img = document.createElement('img');
      img.src = fileUrl(target.path);
      img.alt = target.name || 'Background preview';
      img.style.cssText = 'width:100%;max-width:100%;max-height:100%;object-fit:cover;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.45);';
      previewBox.appendChild(img);
      previewTargetEl = img;
    } else {
      previewBox.textContent = kind === 'bg' ? 'No background image selected.' : 'No preview available.';
    }

    const refreshPreview = () => updateFxPreview(target, working, kind, previewTargetEl);

    const controls = [];
    const createControl = (def) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;gap:6px;';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:13px;';
      const label = document.createElement('span');
      label.textContent = def.label;
      const valueLabel = document.createElement('span');
      valueLabel.style.cssText = 'color:#8fa2b7;font-variant-numeric:tabular-nums;';
      header.append(label, valueLabel);

      const ctrlRow = document.createElement('div');
      ctrlRow.style.cssText = 'display:flex;align-items:center;gap:12px;';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(def.min);
      slider.max = String(def.max);
      slider.step = String(def.step);
      slider.style.cssText = 'flex:1;accent-color:#2a6df6;';

      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      input.style.cssText = 'width:80px;background:#12161b;border:1px solid #2a2f36;color:#e6e6e6;border-radius:8px;padding:6px;';

      ctrlRow.append(slider, input);
      row.append(header, ctrlRow);
      fieldsWrap.appendChild(row);

      const setValue = (value, { skipPreview = false } = {}) => {
        const current = Number.isFinite(value) ? value : working[def.name];
        const clamped = clamp(current, def.min, def.max);
        working[def.name] = clamped;
        slider.value = String(clamped);
        if (def.decimals != null) input.value = Number(clamped).toFixed(def.decimals);
        else input.value = String(clamped);
        valueLabel.textContent = def.format(clamped);
        if (!skipPreview) refreshPreview();
      };

      slider.addEventListener('input', () => setValue(parseFloat(slider.value)));
      input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        if (Number.isFinite(val)) setValue(val);
      });
      input.addEventListener('blur', () => {
        const val = parseFloat(input.value);
        if (!Number.isFinite(val)) setValue(working[def.name], { skipPreview: true });
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const val = parseFloat(input.value);
          if (Number.isFinite(val)) setValue(val);
          else setValue(working[def.name], { skipPreview: true });
          e.preventDefault();
        }
      });

      return { name: def.name, setValue, focus: () => slider.focus() };
    };

    for (const def of fieldDefs) {
      const ctrl = createControl(def);
      controls.push(ctrl);
      ctrl.setValue(working[def.name], { skipPreview: true });
    }
    refreshPreview();

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
    };

    const cancel = () => {
      updateFxPreview(target, original, kind);
      cleanup();
      resolve({ ok: false });
    };

    const confirm = () => {
      refreshPreview();
      cleanup();
      resolve({ ok: true, value: cloneFx(working) });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);

    cancelBtns.forEach(btn => btn.addEventListener('click', cancel));
    applyBtn.addEventListener('click', confirm);
    resetBtn.addEventListener('click', () => {
      const base = defaultFxSettings();
      controls.forEach(ctrl => ctrl.setValue(base[ctrl.name], { skipPreview: true }));
      Object.keys(DEFAULT_FX).forEach(k => { working[k] = base[k]; });
      refreshPreview();
    });
    setTimeout(() => controls[0]?.focus?.(), 40);
  });
}

async function showChromaKeyDialog(target, { kind = 'visual' } = {}) {
  if (!target) return { ok: false };
  hydrateChromaKey(target);
  const original = cloneChromaKey(target.chromaKey);
  const working = cloneChromaKey(original);
  const title = kind === 'bg' ? 'Background Chroma Key' : 'Chroma Key';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:grid;place-items:center;';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(540px,95vw);max-height:92vh;overflow:auto;background:#0f141a;border:1px solid #2a2f36;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.65);padding:20px;display:grid;gap:18px;font:14px/1.4 system-ui;color:#dbe4f0;';
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div style="font-weight:600;font-size:16px;">${title}${target?.name ? ` - ${target.name}` : ''}</div>
        <button data-act="cancel" style="background:none;border:none;color:#8fa2b7;font-size:18px;padding:2px 6px;cursor:pointer;">X</button>
      </div>
      <div data-role="layout" style="position:relative;width:100%;min-height:240px;overflow:visible;">
        <div data-role="preview-col" style="flex:1 1 auto;display:flex;flex-direction:column;gap:10px;min-width:280px;">
          <div data-role="preview-wrap" style="position:relative;background:#121820;border:1px solid #1f2630;border-radius:12px;padding:14px;display:flex;justify-content:center;align-items:center;min-height:240px;min-width:280px;">
            <canvas data-role="preview-canvas" width="360" height="200" style="width:100%;height:auto;max-width:100%;border-radius:10px;display:none;cursor:crosshair;"></canvas>
            <div data-role="preview-status" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#8fa2b7;font-size:13px;text-align:center;padding:20px;"></div>
          </div>
          <div data-role="video-controls" style="display:none;align-items:center;gap:10px;background:#121820;border:1px solid #1f2630;border-radius:10px;padding:10px 12px;">
            <button type="button" data-role="video-play" style="background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;min-width:64px;cursor:pointer;">Play</button>
            <input type="range" data-role="video-progress" min="0" max="1000" step="1" value="0" style="flex:1 1 auto;accent-color:#2a6df6;">
            <span data-role="video-time" style="font-size:12px;color:#8fa2b7;font-variant-numeric:tabular-nums;white-space:nowrap;">0:00 / 0:00</span>
          </div>
          <div data-role="preview-caption" style="font-size:12px;color:#8fa2b7;display:none;">Click the preview to sample a color.</div>
        </div>
        <div data-role="controls" style="position:fixed;top:24px;left:auto;width:260px;display:grid;gap:14px;background:#101620;border:1px solid #1f2630;border-radius:12px;padding:14px;box-shadow:0 12px 32px rgba(0,0,0,0.45);cursor:grab;z-index:10001;">
          <div data-role="controls-header" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:-6px -6px 6px;">
            <span style="font-weight:600;font-size:13px;color:#d5deeb;">Key Controls</span>
            <button type="button" data-role="controls-reset-pos" style="background:none;border:none;color:#8fa2b7;font-size:12px;cursor:pointer;">Reset</button>
          </div>
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;">
            <input type="checkbox" data-role="toggle-enabled" style="accent-color:#2a6df6;">
            Enable chroma key
          </label>
          <div data-role="color-row" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:13px;">Key color</span>
              <input type="color" data-role="color-input" style="width:34px;height:34px;border:none;border-radius:6px;background:#121820;padding:0;">
              <span data-role="color-value" style="font-size:12px;color:#8fa2b7;">#00ff00</span>
            </div>
          </div>
          <div data-role="intensity-row" style="display:grid;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">
              <span>Intensity</span>
              <span data-role="intensity-value" style="color:#8fa2b7;font-variant-numeric:tabular-nums;">0%</span>
            </div>
            <input type="range" data-role="intensity-slider" min="0" max="100" step="1" style="width:100%;accent-color:#2a6df6;">
          </div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button data-act="reset" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:8px;padding:8px 14px;">Reset</button>
        </div>
        <div style="display:flex;gap:10px;">
          <button data-act="cancel" style="background:#1b222b;border:1px solid #2a2f36;color:#c8d1da;border-radius:8px;padding:8px 14px;">Cancel</button>
          <button data-act="apply" style="background:#2a6df6;border:1px solid #2a6df6;color:#fff;border-radius:8px;padding:8px 18px;font-weight:600;">Apply</button>
        </div>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const previewCanvas = box.querySelector('canvas[data-role="preview-canvas"]');
    const previewCtx = previewCanvas.getContext('2d');
    const previewStatus = box.querySelector('[data-role="preview-status"]');
    const previewCaption = box.querySelector('[data-role="preview-caption"]');
    const toggleEnabled = box.querySelector('[data-role="toggle-enabled"]');
    const colorInput = box.querySelector('[data-role="color-input"]');
    const colorValue = box.querySelector('[data-role="color-value"]');
    const intensitySlider = box.querySelector('[data-role="intensity-slider"]');
    const intensityValue = box.querySelector('[data-role="intensity-value"]');
    const resetBtn = box.querySelector('[data-act="reset"]');
    const applyBtn = box.querySelector('[data-act="apply"]');
    const cancelBtns = box.querySelectorAll('[data-act="cancel"]');
    const controlsWrap = box.querySelector('[data-role="controls"]');
    const controlsHeader = box.querySelector('[data-role="controls-header"]');
    const controlsResetBtn = box.querySelector('[data-role="controls-reset-pos"]');
    const layoutWrap = box.querySelector('[data-role="layout"]');
    const previewWrapEl = box.querySelector('[data-role="preview-wrap"]');
    const colorRow = box.querySelector('[data-role="color-row"]');
    const intensityRow = box.querySelector('[data-role="intensity-row"]');
    const videoControls = box.querySelector('[data-role="video-controls"]');
    const videoPlayBtn = box.querySelector('[data-role="video-play"]');
    const videoProgress = box.querySelector('[data-role="video-progress"]');
    const videoTimeLabel = box.querySelector('[data-role="video-time"]');

    let sourceCanvas = null;
    let sourceCtx = null;
    let keyedCanvas = null;
    let keyedCtx = null;
    let hasImage = false;
    let disposed = false;
    let previewVideo = null;
    let videoFrameHandle = null;
    let videoEventCleanup = null;
    let videoDurationMs = 0;
    let videoFxForPreview = null;
    let progressScrubbing = false;
    if (videoControls) {
      if (!videoControls.dataset.originalDisplay) videoControls.dataset.originalDisplay = 'flex';
      videoControls.dataset.active = '0';
    }

    const formatVideoTime = (ms) => {
      const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    };

    const resetVideoUi = () => {
      if (videoPlayBtn) {
        videoPlayBtn.textContent = 'Play';
        videoPlayBtn.disabled = true;
      }
      if (videoProgress) {
        videoProgress.value = '0';
        videoProgress.disabled = true;
      }
      if (videoTimeLabel) {
        videoTimeLabel.textContent = '0:00 / 0:00';
      }
      if (videoControls) {
        videoControls.dataset.active = '0';
        videoControls.style.display = 'none';
        videoControls.style.pointerEvents = 'none';
        videoControls.style.visibility = 'hidden';
        videoControls.style.opacity = '0';
      }
    };

    const setPlayButtonState = () => {
      if (!videoPlayBtn) return;
      const playing = previewVideo && !previewVideo.paused && !previewVideo.ended;
      videoPlayBtn.textContent = playing ? 'Pause' : 'Play';
      videoPlayBtn.disabled = !previewVideo;
    };

    const updateVideoUi = (forceSlider = false) => {
      if (!videoControls) return;
      const durationMs = videoDurationMs > 0 ? videoDurationMs : 0;
      const currentMs = previewVideo ? Math.max(0, Math.round(previewVideo.currentTime * 1000)) : 0;
      if (videoTimeLabel) {
        const total = durationMs > 0 ? durationMs : Math.max(currentMs, 0);
        videoTimeLabel.textContent = `${formatVideoTime(currentMs)} / ${formatVideoTime(total)}`;
      }
      if (videoProgress) {
        if (forceSlider || !progressScrubbing) {
          const total = durationMs > 0 ? durationMs : Math.max(currentMs, 1);
          const ratio = total > 0 ? clamp(currentMs / total, 0, 1) : 0;
          videoProgress.value = String(Math.round(ratio * 1000));
        }
        videoProgress.disabled = !(durationMs > 0);
      }
    };

    const stopVideoLoop = () => {
      if (videoFrameHandle != null) {
        cancelAnimationFrame(videoFrameHandle);
        videoFrameHandle = null;
      }
    };

    const renderVideoFrame = () => {
      if (!previewVideo || !sourceCanvas || !sourceCtx) return;
      if (previewVideo.readyState < 2) return;
      const width = sourceCanvas.width || 0;
      const height = sourceCanvas.height || 0;
      if (!width || !height) return;
      sourceCtx.clearRect(0, 0, width, height);
      const fx = videoFxForPreview || cloneFx(hydrateFx(target));
      videoFxForPreview = fx;
      drawImageWithFx(sourceCtx, previewVideo, fx, width, height);
      updatePreview();
    };

    const startVideoLoop = () => {
      if (!previewVideo || videoFrameHandle != null) return;
      const step = () => {
        if (disposed || !previewVideo) {
          videoFrameHandle = null;
          return;
        }
        if (!previewVideo.paused && !previewVideo.ended) {
          renderVideoFrame();
          updateVideoUi();
          videoFrameHandle = requestAnimationFrame(step);
        } else {
          videoFrameHandle = null;
        }
      };
      videoFrameHandle = requestAnimationFrame(step);
    };

    const cleanupVideo = () => {
      stopVideoLoop();
      if (videoEventCleanup) {
        videoEventCleanup();
        videoEventCleanup = null;
      }
      if (previewVideo) {
        try { previewVideo.pause(); } catch {}
        try { previewVideo.removeAttribute('src'); previewVideo.load(); } catch {}
      }
      previewVideo = null;
      videoDurationMs = 0;
      videoFxForPreview = null;
      progressScrubbing = false;
      resetVideoUi();
    };

    resetVideoUi();

    const normalizeWorking = () => {
      const normalized = {
        enabled: !!working.enabled,
        color: normalizeHexColor(working.color) || DEFAULT_CHROMA_KEY.color,
        intensity: clamp01(Number(working.intensity) || 0)
      };
      return normalized;
    };

    const updateIntensityLabel = () => {
      const percent = Math.round(clamp01(Number(working.intensity) || 0) * 100);
      intensityValue.textContent = working.enabled ? `${percent}%` : `${percent}% (off)`;
    };

    const updateControlStates = () => {
      const normalizedColor = normalizeHexColor(working.color) || DEFAULT_CHROMA_KEY.color;
      if (colorInput) colorInput.value = normalizedColor;
      if (colorValue) colorValue.textContent = normalizedColor.toUpperCase();
      const percent = Math.round(clamp01(Number(working.intensity) || 0) * 100);
      if (intensitySlider) intensitySlider.value = String(percent);
      if (toggleEnabled) toggleEnabled.checked = !!working.enabled;
      const disabled = !working.enabled;
      if (colorInput) colorInput.disabled = disabled;
      if (intensitySlider) intensitySlider.disabled = disabled;
      updateIntensityLabel();
    };

    const togglePickerUi = (visible) => {
      [colorRow, intensityRow].forEach((row) => {
        if (!row) return;
        if (!row.dataset.originalDisplay) {
          row.dataset.originalDisplay = row.style.display || '';
        }
        if (visible) {
          row.style.display = row.dataset.originalDisplay || '';
          row.style.pointerEvents = '';
          row.style.visibility = '';
          row.style.opacity = '';
        } else {
          row.style.display = 'none';
          row.style.pointerEvents = 'none';
          row.style.visibility = 'hidden';
          row.style.opacity = '0';
        }
      });
      if (videoControls) {
        if (!videoControls.dataset.originalDisplay) videoControls.dataset.originalDisplay = 'flex';
        const active = videoControls.dataset.active === '1';
        const shouldShow = visible && active;
        videoControls.style.display = shouldShow ? (videoControls.dataset.originalDisplay || 'flex') : 'none';
        videoControls.style.pointerEvents = shouldShow ? '' : 'none';
        videoControls.style.visibility = shouldShow ? '' : 'hidden';
        videoControls.style.opacity = shouldShow ? '' : '0';
      }
      if (controlsWrap) {
        if (!controlsWrap.dataset.originalDisplay) controlsWrap.dataset.originalDisplay = controlsWrap.style.display || '';
        controlsWrap.style.display = visible ? (controlsWrap.dataset.originalDisplay || '') : 'none';
        controlsWrap.style.pointerEvents = visible ? '' : 'none';
        controlsWrap.style.visibility = visible ? '' : 'hidden';
        controlsWrap.style.opacity = visible ? '' : '0';
        if (visible) {
          if (controlsWrap.dataset.left) controlsWrap.style.left = controlsWrap.dataset.left;
          if (controlsWrap.dataset.top) controlsWrap.style.top = controlsWrap.dataset.top;
          controlsWrap.style.cursor = 'grab';
        } else {
          endDrag();
          controlsWrap.style.cursor = 'grab';
        }
      }
    };

    const updatePreview = () => {
      if (!previewCtx || !hasImage || !sourceCanvas || !keyedCanvas) {
        if (previewCtx) {
          previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
          drawCheckerboard(previewCtx, previewCanvas.width, previewCanvas.height);
        }
        return;
      }
      const normalized = normalizeWorking();
      keyedCtx.clearRect(0, 0, keyedCanvas.width, keyedCanvas.height);
      keyedCtx.drawImage(sourceCanvas, 0, 0);
      if (chromaKeyIsActive({ ...normalized, enabled: true })) {
        const data = keyedCtx.getImageData(0, 0, keyedCanvas.width, keyedCanvas.height);
        applyChromaKeyToImageData(data, normalized);
        keyedCtx.putImageData(data, 0, 0);
      }
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      drawCheckerboard(previewCtx, previewCanvas.width, previewCanvas.height);
      const source = normalized.enabled && chromaKeyIsActive(normalized) ? keyedCanvas : sourceCanvas;
      previewCtx.drawImage(source, 0, 0, previewCanvas.width, previewCanvas.height);
    };

    const setEnabled = (value) => {
      working.enabled = !!value;
      updateControlStates();
      updatePreview();
    };

    const onPreviewClick = (ev) => {
      if (!hasImage || !sourceCtx) return;
      togglePickerUi(false);
      if (previewVideo && !previewVideo.paused) {
        try { previewVideo.pause(); } catch {}
      }
      const rect = previewCanvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) { togglePickerUi(true); return; }
      const scaleX = sourceCanvas.width / Math.max(1, previewCanvas.width);
      const scaleY = sourceCanvas.height / Math.max(1, previewCanvas.height);
      const sampleX = Math.max(0, Math.min(sourceCanvas.width - 1, Math.floor(x * scaleX)));
      const sampleY = Math.max(0, Math.min(sourceCanvas.height - 1, Math.floor(y * scaleY)));
      const pixel = sourceCtx.getImageData(sampleX, sampleY, 1, 1).data;
      if (!pixel || pixel.length < 4) { togglePickerUi(true); return; }
      if (pixel[3] === 0) { togglePickerUi(true); return; }
      working.color = rgbToHex(pixel[0], pixel[1], pixel[2]);
      setEnabled(true);
      togglePickerUi(true);
    };

    const cleanup = (result) => {
      if (disposed) return;
      disposed = true;
      endDrag();
      window.removeEventListener('keydown', onKeyDown);
      previewCanvas.removeEventListener('click', onPreviewClick);
       cleanupVideo();
      overlay.remove();
      resolve(result);
    };

    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cleanup({ ok: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);

    if (previewCanvas) {
      previewCanvas.addEventListener('click', onPreviewClick);
    }

    cancelBtns.forEach(btn => btn.addEventListener('click', () => cleanup({ ok: false })));

    if (videoPlayBtn) {
      videoPlayBtn.addEventListener('click', async () => {
        if (!previewVideo) return;
        if (previewVideo.paused || previewVideo.ended) {
          try {
            await previewVideo.play();
          } catch (err) {
            console.warn('chroma preview video play failed', err);
          }
        } else {
          try { previewVideo.pause(); } catch {}
        }
      });
    }

    if (videoProgress) {
      const handlePointerDown = () => {
        progressScrubbing = true;
        if (previewVideo && !previewVideo.paused) {
          try { previewVideo.pause(); } catch {}
        }
      };
      const handlePointerUp = () => {
        progressScrubbing = false;
        updateVideoUi(true);
      };
      videoProgress.addEventListener('pointerdown', handlePointerDown);
      videoProgress.addEventListener('pointerup', handlePointerUp);
      videoProgress.addEventListener('pointercancel', handlePointerUp);
      videoProgress.addEventListener('input', (ev) => {
        if (!previewVideo || !(videoDurationMs > 0)) return;
        const raw = Number(ev.target.value);
        const fraction = clamp(isFinite(raw) ? raw / 1000 : 0, 0, 1);
        const nextTime = (videoDurationMs / 1000) * fraction;
        try { previewVideo.currentTime = nextTime; } catch {}
        updateVideoUi(true);
      });
      videoProgress.addEventListener('change', () => {
        progressScrubbing = false;
        updateVideoUi(true);
      });
    }

    const positionControlsDefault = () => {
      if (!controlsWrap) return;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const previewRect = previewWrapEl ? previewWrapEl.getBoundingClientRect() : null;
      const width = controlsWrap.offsetWidth || 260;
      const height = controlsWrap.offsetHeight || 220;
      const margin = 16;
      let left = viewportWidth - width - margin;
      let top = margin;
      if (previewRect) {
        const rightSpace = viewportWidth - previewRect.right - margin;
        const leftSpace = previewRect.left - margin;
        if (rightSpace >= width) {
          left = previewRect.right + margin;
        } else if (leftSpace >= width) {
          left = previewRect.left - width - margin;
        } else {
          left = Math.max(margin, Math.min(viewportWidth - width - margin, previewRect.right - width / 2));
        }
        top = Math.max(margin, Math.min(viewportHeight - height - margin, previewRect.top));
      }
      const minLeft = -width + margin;
      const maxLeft = viewportWidth - margin;
      const minTop = -height + margin;
      const maxTop = viewportHeight - margin;
      left = clamp(left, minLeft, maxLeft);
      top = clamp(top, minTop, maxTop);
      controlsWrap.style.left = `${left}px`;
      controlsWrap.style.top = `${top}px`;
      controlsWrap.style.right = '';
      controlsWrap.dataset.left = controlsWrap.style.left;
      controlsWrap.dataset.top = controlsWrap.style.top;
      controlsWrap.dataset.userMoved = '0';
      controlsWrap.style.cursor = 'grab';
    };

    let dragging = false;
    let dragId = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      if (controlsWrap) {
        controlsWrap.style.cursor = 'grab';
        controlsWrap.dataset.left = controlsWrap.style.left;
        controlsWrap.dataset.top = controlsWrap.style.top;
      }
      if (controlsHeader && dragId != null) {
        controlsHeader.releasePointerCapture(dragId);
      }
      dragId = null;
    };

    if (controlsHeader && controlsWrap) {
      controlsHeader.addEventListener('pointerdown', (ev) => {
        if (ev.target.closest('[data-role="controls-reset-pos"]')) return;
        if (!controlsWrap.isConnected) return;
        const rect = controlsWrap.getBoundingClientRect();
        dragging = true;
      dragId = ev.pointerId;
      dragOffsetX = ev.clientX - rect.left;
      dragOffsetY = ev.clientY - rect.top;
      controlsWrap.style.cursor = 'grabbing';
      controlsHeader.setPointerCapture(ev.pointerId);
      controlsWrap.dataset.userMoved = '1';
      ev.preventDefault();
    });

      controlsHeader.addEventListener('pointermove', (ev) => {
        if (!dragging || !controlsWrap) return;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const width = controlsWrap.offsetWidth || 260;
        const height = controlsWrap.offsetHeight || 220;
        const margin = 24;
        const rawLeft = ev.clientX - dragOffsetX;
        const rawTop = ev.clientY - dragOffsetY;
        const minLeft = -width + margin;
        const maxLeft = viewportWidth - margin;
        const minTop = -height + margin;
        const maxTop = viewportHeight - margin;
        const left = clamp(rawLeft, minLeft, maxLeft);
        const top = clamp(rawTop, minTop, maxTop);
        controlsWrap.style.left = `${left}px`;
        controlsWrap.style.top = `${top}px`;
        controlsWrap.style.right = '';
        ev.preventDefault();
      });

      controlsHeader.addEventListener('pointerup', endDrag);
      controlsHeader.addEventListener('pointercancel', endDrag);
      controlsHeader.addEventListener('pointerleave', (ev) => {
        if (!dragging) return;
        // keep dragging if pointer captured; pointerleave happens during drag, ignore
      });
    }

    if (controlsResetBtn) {
      controlsResetBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        positionControlsDefault();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const fresh = cloneChromaKey(DEFAULT_CHROMA_KEY);
        working.enabled = fresh.enabled;
        working.color = fresh.color;
        working.intensity = fresh.intensity;
        updateControlStates();
        updatePreview();
      });
    }

    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const normalized = normalizeWorking();
        cleanup({ ok: true, value: normalized });
      });
    }

    if (toggleEnabled) {
      toggleEnabled.addEventListener('change', () => {
        setEnabled(toggleEnabled.checked);
      });
    }

    if (colorInput) {
      colorInput.addEventListener('input', () => {
        const normalized = normalizeHexColor(colorInput.value) || DEFAULT_CHROMA_KEY.color;
        working.color = normalized;
        if (!working.enabled) setEnabled(true);
        else {
          updateControlStates();
          updatePreview();
        }
      });
    }

    if (intensitySlider) {
      intensitySlider.addEventListener('input', () => {
        const value = clamp(Number(intensitySlider.value) || 0, 0, 100);
        working.intensity = value / 100;
        if (!working.enabled && value > 0) {
          setEnabled(true);
        } else {
          updateControlStates();
          updatePreview();
        }
      });
    }

    togglePickerUi(true);
    const loadPreview = async () => {
      if (!previewCanvas || !previewCtx) return;
      cleanupVideo();
      sourceCanvas = null;
      sourceCtx = null;
      keyedCanvas = null;
      keyedCtx = null;
      hasImage = false;
      drawCheckerboard(previewCtx, previewCanvas.width, previewCanvas.height);

      if (!target?.path) {
        previewStatus.textContent = 'No preview available for this clip.';
        previewStatus.style.display = 'flex';
        previewCaption.style.display = 'none';
        previewCanvas.style.display = 'none';
        previewCanvas.style.cursor = 'default';
        return;
      }

      const isVideoAsset = isVideo(target.path);
      previewStatus.textContent = isVideoAsset ? 'Loading video preview...' : 'Loading preview...';
      previewStatus.style.display = 'flex';
      previewCaption.style.display = 'none';
      previewCanvas.style.display = 'none';
      previewCanvas.style.cursor = 'default';

      if (isVideoAsset) {
        try {
          const video = document.createElement('video');
          previewVideo = video;
          video.playsInline = true;
          video.muted = true;
          video.controls = false;
          video.preload = 'auto';
          video.crossOrigin = 'anonymous';
          const src = fileUrl(target.path);
          if (video.src !== src) {
            try {
              video.src = src;
            } catch {
              video.setAttribute('src', src);
            }
          }
          try { video.load(); } catch {}

          await new Promise((resolve, reject) => {
            if (disposed) { resolve(); return; }
            const clean = () => {
              video.removeEventListener('loadeddata', handleLoaded);
              video.removeEventListener('error', handleError);
            };
            const handleLoaded = () => {
              clean();
              resolve();
            };
            const handleError = (err) => {
              clean();
              reject(err || new Error('Video preview failed to load.'));
            };
            if (video.readyState >= 2) {
              clean();
              resolve();
              return;
            }
            video.addEventListener('loadeddata', handleLoaded, { once: true });
            video.addEventListener('error', handleError, { once: true });
          });
          if (disposed) return;

          const vw = Math.max(1, Math.round(video.videoWidth || 0));
          const vh = Math.max(1, Math.round(video.videoHeight || 0));
          if (!vw || !vh) throw new Error('Video preview missing dimensions.');

          sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = vw;
          sourceCanvas.height = vh;
          sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });

          keyedCanvas = document.createElement('canvas');
          keyedCanvas.width = vw;
          keyedCanvas.height = vh;
          keyedCtx = keyedCanvas.getContext('2d', { willReadFrequently: true });

          const maxWidth = 420;
          const maxHeight = 280;
          const previewScale = Math.min(1, Math.min(maxWidth / vw, maxHeight / vh));
          const renderWidth = Math.max(1, Math.round(vw * previewScale));
          const renderHeight = Math.max(1, Math.round(vh * previewScale));
          previewCanvas.width = renderWidth;
          previewCanvas.height = renderHeight;

          hasImage = true;
          previewCanvas.style.display = 'block';
          previewCanvas.style.cursor = 'crosshair';
          previewStatus.style.display = 'none';
          previewCaption.style.display = 'block';

          videoDurationMs = (video.duration && isFinite(video.duration)) ? Math.max(0, Math.round(video.duration * 1000)) : 0;
          videoFxForPreview = cloneFx(hydrateFx(target));

          if (videoControls) {
            videoControls.dataset.active = '1';
            videoControls.style.display = videoControls.dataset.originalDisplay || 'flex';
            videoControls.style.pointerEvents = '';
            videoControls.style.visibility = '';
            videoControls.style.opacity = '';
          }
          setPlayButtonState();
          updateVideoUi(true);

          const onPlay = () => {
            setPlayButtonState();
            startVideoLoop();
          };
          const onPause = () => {
            setPlayButtonState();
            stopVideoLoop();
            renderVideoFrame();
            updateVideoUi(true);
          };
          const onTimeUpdate = () => {
            if (!progressScrubbing) updateVideoUi();
          };
          const onSeeked = () => {
            renderVideoFrame();
            updateVideoUi(true);
          };
          const onLoadedData = () => {
            renderVideoFrame();
            updateVideoUi(true);
          };
          const onDurationChange = () => {
            if (!previewVideo) return;
            const next = previewVideo.duration && isFinite(previewVideo.duration)
              ? Math.max(0, Math.round(previewVideo.duration * 1000))
              : 0;
            if (next && next !== videoDurationMs) {
              videoDurationMs = next;
              updateVideoUi(true);
            }
          };
          const onEnded = () => {
            setPlayButtonState();
            stopVideoLoop();
            updateVideoUi(true);
          };

          video.addEventListener('play', onPlay);
          video.addEventListener('pause', onPause);
          video.addEventListener('timeupdate', onTimeUpdate);
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('loadeddata', onLoadedData);
          video.addEventListener('durationchange', onDurationChange);
          video.addEventListener('ended', onEnded);

          videoEventCleanup = () => {
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('loadeddata', onLoadedData);
            video.removeEventListener('durationchange', onDurationChange);
            video.removeEventListener('ended', onEnded);
          };

          renderVideoFrame();
          updateVideoUi(true);
          if (controlsWrap && controlsWrap.dataset.userMoved !== '1') {
            positionControlsDefault();
          }
          return;
        } catch (err) {
          console.warn('chroma preview video load failed', err);
          cleanupVideo();
          previewStatus.textContent = 'Unable to load preview for this clip.';
          previewCaption.style.display = 'none';
          previewCanvas.style.display = 'none';
          previewCanvas.style.cursor = 'default';
          return;
        }
      }

      let sourceImage = null;
      try {
        if (isGifPath(target.path) && target._gif?.frames?.length) {
          sourceImage = target._gif.frames[0]?.bitmap || null;
        }
        if (!sourceImage && isGifPath(target.path) && supportsImageDecoder) {
          if (!target._gif || !target._gif.frames?.length) {
            try { await prepareGif(target); } catch (err) { console.warn('chroma preview gif prepare failed', err); }
          }
          sourceImage = target._gif?.frames?.[0]?.bitmap || null;
        }
        if (!sourceImage) {
          sourceImage = await loadImageElement(target.path);
        }
      } catch (err) {
        console.warn('chroma preview load failed', err);
        sourceImage = null;
      }

      if (!sourceImage) {
        previewStatus.textContent = 'Unable to load preview for this clip.';
        previewCaption.style.display = 'none';
        previewCanvas.style.display = 'none';
        previewCanvas.style.cursor = 'default';
        hasImage = false;
        return;
      }

      const dims = getDrawableDimensions(sourceImage);
      const iw = Math.max(1, dims.width);
      const ih = Math.max(1, dims.height);

      sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = iw;
      sourceCanvas.height = ih;
      sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      sourceCtx.clearRect(0, 0, iw, ih);
      const fxForPreview = cloneFx(hydrateFx(target));
      drawImageWithFx(sourceCtx, sourceImage, fxForPreview, iw, ih);

      keyedCanvas = document.createElement('canvas');
      keyedCanvas.width = iw;
      keyedCanvas.height = ih;
      keyedCtx = keyedCanvas.getContext('2d', { willReadFrequently: true });

      const maxWidth = 420;
      const maxHeight = 280;
      const previewScale = Math.min(1, Math.min(maxWidth / iw, maxHeight / ih));
      const renderWidth = Math.max(1, Math.round(iw * previewScale));
      const renderHeight = Math.max(1, Math.round(ih * previewScale));
      previewCanvas.width = renderWidth;
      previewCanvas.height = renderHeight;
      previewCanvas.style.display = 'block';
      previewCanvas.style.cursor = 'crosshair';
      previewStatus.style.display = 'none';
      previewCaption.style.display = 'block';
      hasImage = true;
      if (controlsWrap && controlsWrap.dataset.userMoved !== '1') {
        positionControlsDefault();
      }
      updatePreview();
    };

    if (controlsWrap && controlsWrap.dataset.userMoved !== '1') {
      positionControlsDefault();
    }
    updateControlStates();
    updatePreview();
    loadPreview();
  });
}

async function editFxForClip(target, kind) {
  if (!target) return;
  const historySnapshot = snapshotProject();
  const original = cloneFx(hydrateFx(target));
  const res = await showFxDialog(target, { kind });
  if (!res?.ok) {
    updateFxPreview(target, original, kind);
    return;
  }
  const next = cloneFx(res.value || target.fx);
  if (fxEqual(next, original)) {
    updateFxPreview(target, original, kind);
    return;
  }

  const label = kind === 'bg' ? 'set-bg-fx' : 'set-visual-fx';
  pushHistoryWithSnapshot(historySnapshot, label);
  target.fx = next;
  hydrateFx(target);
  updateFxPreview(target, next, kind);
  scheduleAutosave(kind === 'bg' ? 'bg-fx-change' : 'visual-fx-change');
}

async function editChromaKeyForClip(target, kind) {
  if (!target) return;
  const historySnapshot = snapshotProject();
  const original = cloneChromaKey(hydrateChromaKey(target));
  const res = await showChromaKeyDialog(target, { kind });
  if (!res?.ok) return;
  const next = cloneChromaKey(res.value || target.chromaKey);
  if (chromaKeyEqual(next, original)) return;

  const label = kind === 'bg' ? 'set-bg-chroma' : 'set-visual-chroma';
  pushHistoryWithSnapshot(historySnapshot, label);
  target.chromaKey = next;
  hydrateChromaKey(target);
  invalidateChromaCache(target);

  if (kind === 'visual') {
    if (isVideoClip(target)) {
      syncStageVideoChroma(target, { forceFrame: true });
    } else if (isGifPath(target.path)) {
      renderActiveGifs();
    } else {
      refreshStageStaticCanvas(target);
    }
    refreshStageVisibility();
  } else if (kind === 'bg') {
    applyBackgroundForTime(currentTime);
  }

  renderTimeline();
  scheduleAutosave(kind === 'bg' ? 'bg-chroma-change' : 'visual-chroma-change');
}

// ---------- Create Text ------------------
function createTextAtCurrentTime(config = {}) {
  const historySnapshot = snapshotProject();
  const id = uid();
  const baseStart = Math.round(currentTime);
  const style = hydrateTextStyle(config.style);
  const t = {
    id,
    content: config.content && config.content.trim() ? config.content.trim() : 'New Text',
    start: Number.isFinite(config.start) ? Math.max(0, Math.round(config.start)) : baseStart,
    end: Number.isFinite(config.end) ? Math.max(0, Math.round(config.end)) : baseStart + (Number.isFinite(config.duration) ? Math.max(500, Math.round(config.duration)) : 4000),
    x: Number.isFinite(config.x) ? config.x : 480,
    y: Number.isFinite(config.y) ? config.y : 270,
    scale: Number.isFinite(config.scale) ? clamp(config.scale, 0.1, 10) : 1,
    rotation: Number.isFinite(config.rotation) ? clampStageRotationNumber(config.rotation) : 0,
    trackIndex: Number.isInteger(config.trackIndex) ? config.trackIndex : (getNextTrackIndex('text') || 0),
    style
  };
  PROJECT.text.push(t);
  spawnTextItem(t);
  renderTimeline();
  refreshStageVisibility();
  scheduleAutosave('add-text');
  pushHistoryWithSnapshot(historySnapshot, 'add-text');
  return t;
}

async function editTextObject(text) {
  if (!text) return;
  try {
    const res = await showTextDialog(text);
    if (!res) return;
    pushHistory('edit-text');
    text.content = res.content;
    text.style = hydrateTextStyle(res.style);
    applyTextStyle(text);
    positionTextItem(text);
    renderTimeline();
    refreshStageVisibility();
    scheduleAutosave('edit-text');
  } catch (err) {
    console.error('editTextObject error', err);
  }
}

let selectedTextId = null;
function selectText(id){ selectedTextId = id; updateClipSelectionStyles(); }
function getSelectedText(){ return PROJECT.text.find(t=>t.id===selectedTextId) || null; }

// ---------- History (Undo/Redo) ----------
const UNDO = [];
const REDO = [];
const HISTORY_LIMIT = 50;
let _pendingHistorySnapshot = null;
let historySequence = 0;
let historyListEl = null;
let historyEmptyEl = null;
let historyUndoBtnEl = null;
let historyRedoBtnEl = null;
let historyPanelNeedsSync = false;

const HISTORY_LABEL_LOOKUP = {
  'add-text': 'Added text',
  'add-visual': 'Added visual',
  'add-audio': 'Added audio',
  'edit-text': 'Edited text',
  'delete': 'Deleted clip',
  'delete-one': 'Deleted clip',
  'delete-multi': 'Deleted clips',
  'delete-keyframe': 'Deleted keyframe',
  'add-keyframe': 'Added keyframe',
  'cut': 'Cut selection',
  'paste': 'Pasted selection',
  'lock-track': 'Locked track',
  'unlock-track': 'Unlocked track',
  'lock-clip': 'Locked clip',
  'unlock-clip': 'Unlocked clip',
  'stage-move': 'Moved on stage',
  'text-move': 'Moved text',
  'stage-scale': 'Scaled on stage',
  'text-scale': 'Scaled text',
  'stage-rotate': 'Rotated on stage',
  'text-rotate': 'Rotated text',
  'set-transition': 'Set transition',
  'remove-transition': 'Removed transition',
  'set-bg-transition': 'Set background transition',
  'remove-bg-transition': 'Removed background transition',
  'set-bg-fx': 'Background effect',
  'set-visual-fx': 'Visual effect',
  'add-timeline-label': 'Added marker',
  'edit-timeline-label': 'Edited marker',
  'delete-timeline-label': 'Deleted marker',
  'clip-move': 'Moved clip',
  'clip-resize': 'Trimmed clip',
  'clip-transform': 'Adjusted clip'
};

const historyTimeFormatter = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return null;
  }
})();

function createHistoryEntry(state, label = '', meta = {}) {
  if (!state) return null;
  return {
    id: ++historySequence,
    label: typeof label === 'string' ? label : '',
    at: Date.now(),
    state,
    direction: meta.direction || 'undo'
  };
}

function describeHistoryLabel(raw) {
  if (!raw) return 'Edit';
  const preset = HISTORY_LABEL_LOOKUP[raw];
  if (preset) return preset;
  const cleaned = String(raw).replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return 'Edit';
  return cleaned.replace(/\b\w/g, ch => ch.toUpperCase());
}

function formatHistoryTime(ts) {
  if (!Number.isFinite(ts)) return '';
  if (!historyTimeFormatter) return '';
  try {
    return historyTimeFormatter.format(ts);
  } catch {
    return '';
  }
}

function pushHistoryWithSnapshot(snapshot, label = '') {
  if (!snapshot) return;
  const entry = createHistoryEntry(snapshot, label, { direction: 'undo' });
  if (!entry) return;
  UNDO.push(entry);
  if (UNDO.length > HISTORY_LIMIT) UNDO.shift();
  if (REDO.length) REDO.length = 0;
  renderHistoryPanel();
}

function clearHistory() {
  UNDO.length = 0;
  REDO.length = 0;
  _pendingHistorySnapshot = null;
  historySequence = 0;
  renderHistoryPanel();
}

function renderHistoryPanel() {
  if (!historyListEl) { historyPanelNeedsSync = true; return; }
  if (!historyEmptyEl) return;
  historyPanelNeedsSync = false;

  if (historyUndoBtnEl) historyUndoBtnEl.disabled = UNDO.length === 0;
  if (historyRedoBtnEl) historyRedoBtnEl.disabled = REDO.length === 0;

  const hasEntries = UNDO.length > 0 || REDO.length > 0;
  historyEmptyEl.hidden = hasEntries;
  historyListEl.toggleAttribute('hidden', !hasEntries);
  historyListEl.textContent = '';
  if (!hasEntries) return;

  const frag = document.createDocumentFragment();

  const makeSection = (title, entries, direction) => {
    if (!entries.length) return;
    const section = document.createElement('div');
    section.className = 'history-section';
    const heading = document.createElement('div');
    heading.className = 'history-section-title';
    heading.textContent = title;
    section.appendChild(heading);

    const iterate = direction === 'undo'
      ? (callback) => {
          for (let idx = 0; idx < entries.length; idx++) {
            const distance = entries.length - idx;
            callback(entries[idx], distance);
          }
        }
      : (callback) => {
          for (let idx = entries.length - 1, distance = 1; idx >= 0; idx--, distance++) {
            callback(entries[idx], distance);
          }
        };

    iterate((entry, distance) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `history-entry ${direction}`;
      btn.dataset.entryId = String(entry.id);
      btn.dataset.direction = direction;
      btn.dataset.distance = String(distance);

      const labelEl = document.createElement('span');
      labelEl.className = 'history-entry-label';
      labelEl.textContent = describeHistoryLabel(entry.label);
      btn.appendChild(labelEl);

      const detail = document.createElement('span');
      detail.className = 'history-entry-detail';
      const distanceText = distance === 1 ? '1 step' : `${distance} steps`;
      detail.textContent = direction === 'undo'
        ? `${distanceText} back`
        : `${distanceText} forward`;
      btn.appendChild(detail);

      const timeTxt = formatHistoryTime(entry.at);
      if (timeTxt) {
        const timeEl = document.createElement('span');
        timeEl.className = 'history-entry-time';
        timeEl.textContent = timeTxt;
        btn.appendChild(timeEl);
      }

      btn.title = direction === 'undo'
        ? `Undo ${distance === 1 ? '1 step' : `${distance} steps`} to ${timeTxt || 'this edit'}`
        : `Redo ${distance === 1 ? '1 step' : `${distance} steps`} to ${timeTxt || 'this edit'}`;

      section.appendChild(btn);
    });

    frag.appendChild(section);
  };

  makeSection('Past edits (Undo)', UNDO, 'undo');

  const current = document.createElement('div');
  current.className = 'history-entry current';
  current.dataset.direction = 'current';
  const curLabel = document.createElement('span');
  curLabel.className = 'history-entry-label';
  curLabel.textContent = 'Current project';
  current.appendChild(curLabel);
  frag.appendChild(current);

  makeSection('Upcoming edits (Redo)', REDO, 'redo');

  historyListEl.appendChild(frag);
}

function jumpToHistoryEntry(entryId) {
  if (!entryId) return;
  const undoIndex = UNDO.findIndex(entry => entry.id === entryId);
  if (undoIndex !== -1) {
    const steps = UNDO.length - undoIndex;
    for (let i = 0; i < steps; i++) {
      if (!undo()) break;
    }
    return;
  }
  const redoIndex = REDO.findIndex(entry => entry.id === entryId);
  if (redoIndex !== -1) {
    const steps = REDO.length - redoIndex;
    for (let i = 0; i < steps; i++) {
      if (!redo()) break;
    }
  }
}

function snapshotProject() {
  // Serialize only the model data we can safely restore
  return {
        items: PROJECT.items.map(({_el,_gif,element,_imageEl,_imageReady,_imagePromise,_imageWidth,_imageHeight,_stageCanvas,_chromaCanvas,_chromaBitmap,_chromaHash,_chromaSourceWidth,_chromaSourceHeight,_videoEl,_videoReady,_videoPromise,_videoWidth,_videoHeight,_videoDurationMs,_videoPlaying,_videoNeedsSeek,_autoDuration, ...r})=>JSON.parse(JSON.stringify(r))),
    text:  PROJECT.text.map(({_el, ...r})=>JSON.parse(JSON.stringify(r))),
    audio: PROJECT.audio.map(({_el, _src, _gain, _nodes, _effectHash, _revUrl, _currentSrcKey, ...r})=>JSON.parse(JSON.stringify(r))),
    bgClips: (PROJECT.bgClips||[]).map(({_chromaCanvas,_chromaBitmap,_chromaHash,_chromaSourceWidth,_chromaSourceHeight,_imageEl,_imageReady,_imagePromise,_imageWidth,_imageHeight, ...c})=>JSON.parse(JSON.stringify(c))),
    timelineLabels: (PROJECT.timelineLabels || []).map(l => JSON.parse(JSON.stringify(l))),
    timelineCustomEndMs: Number.isFinite(PROJECT.timelineCustomEndMs) ? PROJECT.timelineCustomEndMs : null,
    trackNames: PROJECT.trackNames ? JSON.parse(JSON.stringify(PROJECT.trackNames)) : {visual:{},audio:{},text:{}},
    trackLocks: JSON.parse(JSON.stringify(ensureTrackLocks())),
    trackHeights: JSON.parse(JSON.stringify(ensureTrackHeights())),
    bgTrackName: PROJECT.bgTrackName || 'Background',
    currentTime
  };
}
function restoreProject(s) {
  PROJECT.items       = s.items       || [];
  PROJECT.text        = s.text        || [];
  PROJECT.audio       = s.audio       || [];
  PROJECT.bgClips     = s.bgClips     || [];
  PROJECT.trackNames  = s.trackNames  || { visual:{}, audio:{}, text:{} };
  if (!PROJECT.trackNames.visual) PROJECT.trackNames.visual = {};
  if (!PROJECT.trackNames.audio)  PROJECT.trackNames.audio  = {};
  if (!PROJECT.trackNames.text)   PROJECT.trackNames.text   = {};
  PROJECT.timelineLabels = Array.isArray(s.timelineLabels) ? s.timelineLabels.map(l => {
    const obj = { ...l };
    if (!obj.id) obj.id = uid();
    obj.time = Number.isFinite(obj.time) ? Math.max(0, Math.round(obj.time)) : 0;
    obj.title = typeof obj.title === 'string' ? obj.title : '';
    obj.color = typeof obj.color === 'string' && obj.color ? obj.color : '#ffd166';
    return obj;
  }) : [];
  PROJECT.timelineLabels.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  const tail = Number(s.timelineCustomEndMs);
  PROJECT.timelineCustomEndMs = Number.isFinite(tail) ? Math.max(0, Math.round(tail)) : null;
  PROJECT.trackLocks  = s.trackLocks  || { visual:{}, audio:{}, bg:{} };
  ensureTrackLocks();
  PROJECT.trackHeights = s.trackHeights || { visual:{}, audio:{}, bg:null };
  ensureTrackHeights();
  PROJECT.bgTrackName = s.bgTrackName || 'Background';
  currentTime = s.currentTime || 0;

  PROJECT.items.forEach(item => {
    if (!item.mediaType) {
      if (isVideo(item.path)) item.mediaType = 'video';
      else if (isGifPath(item.path)) item.mediaType = 'gif';
      else item.mediaType = 'image';
    }
    item._autoDuration = false;
    resetVisualRuntimeState(item);
    hydrateFx(item);
    hydrateChromaKey(item);
  });
  PROJECT.items.forEach(item => {
    if (!item) return;
    const info = getWeldInfo(item);
    if (!info) {
      if (item.weld) delete item.weld;
      return;
    }
    if (info.parentId === item.id) {
      delete item.weld;
      return;
    }
    const parentExists = PROJECT.items.some(i => i && i.id === info.parentId);
    if (!parentExists) {
      delete item.weld;
    }
  });
  (PROJECT.bgClips || []).forEach(clip => {
    resetVisualRuntimeState(clip);
    hydrateFx(clip);
    hydrateChromaKey(clip);
  });

  // Rebuild stage DOM for visuals
  const st = $('#stage');
  st.querySelectorAll('.stage-item').forEach(n => n.remove());

  for (const it of PROJECT.items) {
    if (!Number.isFinite(it.rotation)) it.rotation = 0;
    else it.rotation = clampStageRotationNumber(it.rotation);
    spawnStageItem(it);
    if (isGifPath(it.path)) {
      if (supportsImageDecoder) {
        prepareGif(it).catch(() => fallbackToImg(it));
      } else {
        fallbackToImg(it);
      }
    }
  }

  // Spawn text layers
  for (const t of PROJECT.text) {
    if (!Number.isInteger(t.trackIndex)) t.trackIndex = 0;
    if (t.id == null) t.id = uid();
    t.style = hydrateTextStyle(t.style);
    if (!Number.isFinite(t.rotation)) t.rotation = 0;
    else t.rotation = clampStageRotationNumber(t.rotation);
    spawnTextItem(t);
  }


  // reset selections and rebuild views
  selectedClipIds = new Set();
  selectedClipId = null;
  selectedItemId = null;
  clipboardClips = null;
  clearSelectedKeyframe();

  rehydrateAudioClips();
  renderTimeline();
  refreshStageVisibility();
  renderActiveGifs();
  drawPlayhead();
  applyBackgroundForTime(currentTime);
  scheduleAutosave('restoreProject');


  // Do not autosave while restoring; re-enable after first render completes
  scheduleSubtitlePreviewRebuild({ immediate: true });
  scheduleAutosave('post-restore');
}

function projectExportData() {
  return {
    format: 'su-movie-project',
    version: 1,
    savedAt: new Date().toISOString(),
    state: snapshotProject()
  };
}

function deriveLoadedState(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.state && typeof data.state === 'object') return data.state;
  if (data.project && typeof data.project === 'object') return data.project;
  return data;
}

function setProjectTitle(path) {
  const base = 'SU Movie Maker (Prototype)';
  if (!path) { document.title = base; return; }
  const name = String(path).split(/[/\\]/).pop();
  document.title = `${base} - ${name}`;
}

function projectTtsAudioClips() {
  return PROJECT.audio
    .filter(clip => {
      if (!clip) return false;
      if (clip.kind !== 'audio') return false;
      if (!clip.dialogText || typeof clip.dialogText !== 'string') return false;
      const start = Number(clip.start);
      const end = Number(clip.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return end > start;
    })
      .map(clip => ({
        clip,
        start: Math.max(0, Math.round(Number(clip.start) || 0)),
        end: Math.max(0, Math.round(Number(clip.end) || 0)),
        characterName: sanitizeTtsCharacterName(clip.characterName || ''),
        dialog: String(clip.dialogText || '').replace(/\r\n/g, '\n').trim(),
        assDialog: typeof clip.subtitleAssText === 'string' ? String(clip.subtitleAssText).replace(/\r\n/g, '\n') : '',
        assMeta: (clip.subtitleAssMeta && typeof clip.subtitleAssMeta === 'object' && !Array.isArray(clip.subtitleAssMeta))
          ? { ...clip.subtitleAssMeta }
          : null,
        muted: !!clip.muted
      }))
      .filter(entry => entry.end > entry.start && entry.dialog);
}

const SUBTITLE_TEXT_FORMATS = {
  CHARACTER_DIALOGUE: 'character-dialogue',
  DIALOGUE_ONLY: 'dialogue'
};

function formatSubtitleContent(entry, format) {
  const mode = format || SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE;
  if (mode === SUBTITLE_TEXT_FORMATS.DIALOGUE_ONLY || !entry.characterName) {
    return entry.dialog;
  }
  return `${entry.characterName}: ${entry.dialog}`;
}

function formatAssSubtitleContent(entry, format) {
  const mode = format || SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE;
  const content = (entry.assDialog && entry.assDialog.trim().length)
    ? entry.assDialog
    : entry.dialog;
  if (mode === SUBTITLE_TEXT_FORMATS.DIALOGUE_ONLY || !entry.characterName) {
    return content;
  }
  const prefix = `${entry.characterName}: `;
  return `${prefix}${content}`;
}

function buildSubtitleEntries({ format = SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE } = {}) {
  const clips = projectTtsAudioClips()
    .filter(entry => !entry.muted)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const entries = [];
  for (const entry of clips) {
    const text = formatSubtitleContent(entry, format);
    if (!text) continue;
    const start = entry.start;
    const end = Math.max(start + 200, entry.end);
    const assText = formatAssSubtitleContent(entry, format);
    const hasOverrides = /{\s*\\/.test(entry.assDialog || '') || /\\[NnhkKo]/.test(entry.assDialog || '') || /{\\p\d/.test(entry.assDialog || '');
    entries.push({
      start,
      end,
      text,
      assText,
      characterName: entry.characterName,
      characterKey: subtitleCharacterKey(entry.characterName),
      rawDialog: entry.dialog,
      rawAssDialog: entry.assDialog,
      assMeta: entry.assMeta || null,
      hasAssOverrides: hasOverrides
    });
  }
  return entries;
}

function formatSubtitleTimestamp(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const pad = (n, size) => String(n).padStart(size, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

function buildSrtContent(entries) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const blocks = entries.map((entry, idx) => {
    const start = formatSubtitleTimestamp(entry.start);
    const end = formatSubtitleTimestamp(entry.end);
    const lines = String(entry.text || '').replace(/\r\n/g, '\n').split('\n');
    const normalizedLines = lines.map(line => line.trimEnd());
    return [
      String(idx + 1),
      `${start} --> ${end}`,
      ...normalizedLines
    ].join('\r\n');
  });
  return blocks.join('\r\n\r\n') + '\r\n';
}

function formatAssTimestamp(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(totalMs / 1000);
  const centis = Math.floor((totalMs % 1000) / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function buildAssContent(entries, { width = 1280, height = 720 } = {}) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const playResX = Number.isFinite(width) && width > 0 ? Math.round(width) : 1280;
  const playResY = Number.isFinite(height) && height > 0 ? Math.round(height) : 720;
  const scriptInfo = [
    '[Script Info]',
    'Title: SU Movie Maker Export',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  const clampMargin = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(parsed, 9999);
  };

  const escapeName = (value) => String(value || '').replace(/\r?\n/g, ' ').replace(/,/g, ' ');

  const normalizeAssText = (value) => {
    const raw = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return raw.replace(/\n/g, '\\N');
  };

  const lines = entries.map((entry) => {
    const start = formatAssTimestamp(entry.start);
    const end = formatAssTimestamp(entry.end);
    const meta = entry.assMeta || {};
    const styleName = escapeName(meta.styleName || 'Default');
    const nameField = escapeName(entry.characterName || '');
    const marginL = clampMargin(meta.marginL);
    const marginR = clampMargin(meta.marginR);
    const marginV = clampMargin(meta.marginV);
    const text = normalizeAssText(entry.assText != null ? entry.assText : entry.text);
    return `Dialogue: 0,${start},${end},${styleName},${nameField},${marginL},${marginR},${marginV},,${text}`;
  });

  return [...scriptInfo, ...lines].join('\r\n') + '\r\n';
}

function buildAssPreviewStage(options = {}) {
  const {
    text = '',
    fallbackText = '',
    meta = null,
    stageWidth = 640,
    stageHeight = 360
  } = options || {};

  const primaryText = (typeof text === 'string' && text.trim().length) ? text : null;
  const rawSource = primaryText != null
    ? primaryText
    : (typeof fallbackText === 'string' ? fallbackText : '');
  const rawText = String(rawSource || '').replace(/\r\n/g, '\n');
  const assMeta = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : null;

  const baseStyle = {
    fontFamily: 'Arial, sans-serif',
    fontSize: 28,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: '#f7f9ff',
    alpha: 1,
    secondaryColor: null,
    secondaryAlpha: 0.45,
    letterSpacing: 0,
    outlineColor: '#000000',
    outlineAlpha: 1,
    outlineWidth: 0,
    shadowColor: '#000000',
    shadowAlpha: 1,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    karaoke: null
  };

  let currentStyle = { ...baseStyle };
  const tagSummary = new Set();
  const metaSummary = [];
  const effectNotes = [];
  let positionInfo = null;
  let wrapModeValue = null;
  let fadeInfo = null;

  if (assMeta?.styleName) metaSummary.push(`Style=${assMeta.styleName}`);
  if (assMeta?.marginL) metaSummary.push(`MarginL=${assMeta.marginL}`);
  if (assMeta?.marginR) metaSummary.push(`MarginR=${assMeta.marginR}`);
  if (assMeta?.marginV) metaSummary.push(`MarginV=${assMeta.marginV}`);

  const parseAssColor = (value) => {
    if (!value) return null;
    const match = value.match(/&H([0-9a-fA-F]{6,8})/);
    if (!match) return null;
    let hexRaw = match[1];
    if (hexRaw.length > 8) hexRaw = hexRaw.slice(-8);
    if (hexRaw.length < 6) hexRaw = hexRaw.padStart(6, '0');
    if (hexRaw.length === 7) hexRaw = `0${hexRaw}`;
    if (hexRaw.length === 6) {
      const bb = hexRaw.slice(0, 2);
      const gg = hexRaw.slice(2, 4);
      const rr = hexRaw.slice(4, 6);
      return { color: `#${rr}${gg}${bb}`.toLowerCase(), alpha: null };
    }
    if (hexRaw.length === 8) {
      const aa = hexRaw.slice(0, 2);
      const bb = hexRaw.slice(2, 4);
      const gg = hexRaw.slice(4, 6);
      const rr = hexRaw.slice(6, 8);
      const alpha = 1 - Math.min(255, Math.max(0, parseInt(aa, 16))) / 255;
      return { color: `#${rr}${gg}${bb}`.toLowerCase(), alpha };
    }
    return null;
  };

  const hexToRgba = (value, alpha = 1) => {
    if (!value || typeof value !== 'string') return value;
    if (/^rgba\(/i.test(value)) return value;
    const hex = value.startsWith('#') ? value.slice(1) : value;
    if (hex.length !== 6 && hex.length !== 8) return value;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    let a = alpha;
    if (hex.length === 8) {
      a = Math.min(1, Math.max(0, parseInt(hex.slice(6, 8), 16) / 255));
    } else {
      a = Math.min(1, Math.max(0, alpha));
    }
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  const resolveColor = (color, alphaOverride = null) => {
    if (!color) return color;
    if (alphaOverride == null || alphaOverride >= 0.999) return color;
    return hexToRgba(color, alphaOverride);
  };

  const stage = document.createElement('div');
  stage.dataset.role = 'ass-preview-stage';
  stage.style.cssText = [
    'position:relative',
    'width:100%',
    `aspect-ratio:${Math.max(1, Math.floor(stageWidth))}/${Math.max(1, Math.floor(stageHeight))}`,
    'background:linear-gradient(180deg,#131a24 0%,#0c1119 100%)',
    'border-radius:6px',
    'border:1px solid rgba(255,255,255,0.07)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:18px',
    'box-sizing:border-box',
    'overflow:hidden'
  ].join(';');

  const content = document.createElement('div');
  content.dataset.role = 'ass-preview-line';
  content.style.cssText = [
    'display:inline-block',
    'max-width:100%',
    'text-align:center',
    'white-space:pre-wrap',
    'word-break:normal',
    'color:#f7f9ff',
    'font-size:28px',
    'font-weight:600',
    'line-height:1.45',
    'text-shadow:0 2px 6px rgba(0,0,0,0.55)',
    'pointer-events:none',
    'padding:0'
  ].join(';');

  stage.appendChild(content);

  const applyTag = (tag) => {
    const parts = tag.split(/\\+/).filter(Boolean);
    for (const partRaw of parts) {
      const part = partRaw.trim();
      if (!part) continue;
      const lower = part.toLowerCase();
      if (lower === 'r' || lower === 'r0') {
        currentStyle = { ...baseStyle };
        continue;
      }
      if (lower.startsWith('r')) {
        currentStyle = { ...baseStyle };
        continue;
      }
      if (lower.startsWith('b')) {
        const val = part.slice(1);
        currentStyle.bold = val !== '0';
        tagSummary.add('Bold');
        continue;
      }
      if (lower.startsWith('i')) {
        const val = part.slice(1);
        currentStyle.italic = val !== '0';
        tagSummary.add('Italic');
        continue;
      }
      if (lower.startsWith('u')) {
        const val = part.slice(1);
        currentStyle.underline = val !== '0';
        tagSummary.add('Underline');
        continue;
      }
      if (lower.startsWith('s')) {
        const val = part.slice(1);
        currentStyle.strike = val !== '0';
        tagSummary.add('Strikeout');
        continue;
      }
      if (lower.startsWith('fn')) {
        currentStyle.fontFamily = part.slice(2) || baseStyle.fontFamily;
        tagSummary.add('Font');
        continue;
      }
      if (lower.startsWith('fs')) {
        const val = parseInt(part.slice(2), 10);
        if (Number.isFinite(val) && val > 0) {
          currentStyle.fontSize = Math.max(8, Math.min(96, Math.round(val / 2)));
          tagSummary.add('Size');
        }
        continue;
      }
      if (/^[1234]?c/i.test(part)) {
        const parsed = parseAssColor(part.replace(/^[1234]?c/i, ''));
        if (parsed) {
          if (lower.startsWith('3c')) {
            currentStyle.outlineColor = parsed.color;
            if (parsed.alpha != null) currentStyle.outlineAlpha = parsed.alpha;
            tagSummary.add('Outline Color');
          } else if (lower.startsWith('4c')) {
            currentStyle.shadowColor = parsed.color;
            if (parsed.alpha != null) currentStyle.shadowAlpha = parsed.alpha;
            tagSummary.add('Shadow Color');
          } else if (lower.startsWith('2c')) {
            currentStyle.secondaryColor = parsed.color;
            if (parsed.alpha != null) currentStyle.secondaryAlpha = parsed.alpha;
            tagSummary.add('Secondary Color');
          } else {
            currentStyle.color = parsed.color;
            if (parsed.alpha != null) currentStyle.alpha = parsed.alpha;
            tagSummary.add('Primary Color');
          }
        }
        continue;
      }
      if (/^[1234]a/i.test(part) || lower.startsWith('alpha')) {
        const match = part.match(/&H([0-9a-fA-F]{2})/);
        if (match) {
          const aa = parseInt(match[1], 16);
          const alpha = 1 - Math.min(255, Math.max(0, aa)) / 255;
          if (lower.startsWith('3a')) {
            currentStyle.outlineAlpha = alpha;
            tagSummary.add('Outline Alpha');
          } else if (lower.startsWith('4a')) {
            currentStyle.shadowAlpha = alpha;
            tagSummary.add('Shadow Alpha');
          } else {
            currentStyle.alpha = alpha;
            tagSummary.add('Alpha');
          }
        }
        continue;
      }
      if (lower.startsWith('fsp')) {
        const val = parseInt(part.slice(3), 10);
        if (Number.isFinite(val)) {
          currentStyle.letterSpacing = val;
          tagSummary.add('Letter Spacing');
        }
        continue;
      }
      if (lower.startsWith('bord')) {
        const val = parseFloat(part.slice(4));
        if (Number.isFinite(val)) {
          currentStyle.outlineWidth = Math.max(0, val);
          tagSummary.add('Outline Width');
        }
        continue;
      }
      if (lower.startsWith('shad')) {
        const val = parseFloat(part.slice(4));
        if (Number.isFinite(val)) {
          currentStyle.shadowOffsetX = val;
          currentStyle.shadowOffsetY = val;
          tagSummary.add('Shadow Offset');
        }
        continue;
      }
      if (lower.startsWith('xshad')) {
        const val = parseFloat(part.slice(5));
        if (Number.isFinite(val)) {
          currentStyle.shadowOffsetX = val;
          tagSummary.add('Shadow Offset');
        }
        continue;
      }
      if (lower.startsWith('yshad')) {
        const val = parseFloat(part.slice(5));
        if (Number.isFinite(val)) {
          currentStyle.shadowOffsetY = val;
          tagSummary.add('Shadow Offset');
        }
        continue;
      }
      if (lower.startsWith('blur')) {
        const val = parseFloat(part.slice(4));
        if (Number.isFinite(val)) {
          currentStyle.shadowBlur = Math.max(0, val);
          tagSummary.add('Blur');
        }
        continue;
      }
      if (lower.startsWith('fr') || lower.startsWith('fax') || lower.startsWith('fay')) {
        tagSummary.add('Transform');
        continue;
      }
      if (/^k[fFoO]?/i.test(part) || /^K/.test(part)) {
        const firstChar = part[0] || '';
        const type = lower.startsWith('kf')
          ? 'KF'
          : lower.startsWith('ko')
          ? 'KO'
          : firstChar === 'K'
          ? 'K'
          : 'k';
        const valMatch = part.match(/\d+/);
        const duration = valMatch ? parseInt(valMatch[0], 10) : 0;
        currentStyle.karaoke = duration > 0 ? { type, duration } : null;
        if (valMatch) effectNotes.push(`Karaoke ${type.toUpperCase()}: ${valMatch[0]}`);
        tagSummary.add('Karaoke');
        continue;
      }
      if (lower.startsWith('fad')) {
        const args = part.match(/\\fad\(([^)]+)\)/i);
        if (args) {
          effectNotes.push(`Fade in/out: ${args[1]}`);
          fadeInfo = args[1];
          tagSummary.add('Fade');
        }
        continue;
      }
      if (lower.startsWith('move')) {
        const args = part.match(/\\move\(([^)]+)\)/i);
        if (args) {
          effectNotes.push(`Move: ${args[1]}`);
          tagSummary.add('Move');
          const coords = args[1].split(',').map((n) => parseFloat(n.trim()));
          if (coords.length >= 4 && coords.slice(0, 4).every((n) => Number.isFinite(n))) {
            positionInfo = { x: coords[2], y: coords[3] };
          }
        }
        continue;
      }
      if (lower.startsWith('pos')) {
        const args = part.match(/\\pos\(([^)]+)\)/i);
        if (args) {
          effectNotes.push(`Position: ${args[1]}`);
          tagSummary.add('Position');
          const coords = args[1].split(',').map((n) => parseFloat(n.trim()));
          if (coords.length >= 2 && coords.every((n) => Number.isFinite(n))) {
            positionInfo = { x: coords[0], y: coords[1] };
          }
        }
        continue;
      }
      if (lower.startsWith('org')) {
        const args = part.match(/\\org\(([^)]+)\)/i);
        if (args) effectNotes.push(`Origin: ${args[1]}`);
        continue;
      }
      if (lower.startsWith('q')) {
        const mode = part.slice(1) || '0';
        effectNotes.push(`Wrap mode: ${mode}`);
        tagSummary.add('Wrap Mode');
        wrapModeValue = mode;
        continue;
      }
    }
  };

  const pushText = (textValue) => {
    if (!textValue) return;
    const segments = textValue.split(/(\\N|\\n|\\h)/);
    segments.forEach((segment) => {
      if (!segment) return;
      if (segment === '\\N' || segment === '\\n') {
        content.appendChild(document.createElement('br'));
        return;
      }
      if (segment === '\\h') {
        const span = document.createElement('span');
        span.innerHTML = '&nbsp;';
        content.appendChild(span);
        return;
      }
      const span = document.createElement('span');
      span.textContent = segment;
      span.style.display = 'inline';
      span.style.fontFamily = currentStyle.fontFamily;
      span.style.fontSize = `${currentStyle.fontSize}px`;
      span.style.fontWeight = currentStyle.bold ? '700' : '400';
      span.style.fontStyle = currentStyle.italic ? 'italic' : 'normal';
      span.style.color = resolveColor(currentStyle.color, currentStyle.alpha);
      if (currentStyle.alpha < 1) span.style.opacity = currentStyle.alpha.toFixed(2);
      else span.style.removeProperty('opacity');
      if (currentStyle.letterSpacing) span.style.letterSpacing = `${currentStyle.letterSpacing}px`;
      const decorations = [];
      if (currentStyle.underline) decorations.push('underline');
      if (currentStyle.strike) decorations.push('line-through');
      span.style.textDecoration = decorations.length ? decorations.join(' ') : 'none';

      const karaokeActive = currentStyle.karaoke && currentStyle.karaoke.duration > 0;
      if (karaokeActive) {
        const fill = hexToRgba(
          currentStyle.secondaryColor || currentStyle.color || '#ffd166',
          currentStyle.secondaryColor ? (currentStyle.secondaryAlpha ?? 0.6) : 0.45
        );
        span.style.backgroundImage = `linear-gradient(90deg, ${fill} 0%, ${fill} 70%, transparent 100%)`;
        span.style.padding = '0 3px';
        span.style.borderRadius = '3px';
      } else if (currentStyle.secondaryColor) {
        const sc = hexToRgba(currentStyle.secondaryColor, currentStyle.secondaryAlpha ?? 0.5);
        span.style.backgroundColor = sc;
        span.style.padding = '0 3px';
        span.style.borderRadius = '3px';
      }

      const shadows = [];
      if (currentStyle.outlineWidth > 0) {
        const w = currentStyle.outlineWidth;
        const oc = hexToRgba(currentStyle.outlineColor || '#000000', currentStyle.outlineAlpha ?? 1);
        shadows.push(
          `${w}px 0 ${oc}`,
          `-${w}px 0 ${oc}`,
          `0 ${w}px ${oc}`,
          `0 -${w}px ${oc}`,
          `${w}px ${w}px ${oc}`,
          `${-w}px ${w}px ${oc}`,
          `${w}px ${-w}px ${oc}`,
          `${-w}px ${-w}px ${oc}`
        );
      }
      if (currentStyle.shadowColor && (currentStyle.shadowOffsetX || currentStyle.shadowOffsetY || currentStyle.shadowBlur)) {
        const sc = hexToRgba(currentStyle.shadowColor, currentStyle.shadowAlpha ?? 1);
        shadows.push(`${currentStyle.shadowOffsetX}px ${currentStyle.shadowOffsetY}px ${currentStyle.shadowBlur}px ${sc}`);
      }
      if (shadows.length) span.style.textShadow = shadows.join(', ');
      else span.style.removeProperty('text-shadow');

      content.appendChild(span);
    });
  };

  const tagRegex = /\{([^}]*)\}/g;
  let lastIndex = 0;
  let match;
  while ((match = tagRegex.exec(rawText))) {
    const preceding = rawText.slice(lastIndex, match.index);
    pushText(preceding);
    applyTag(match[1]);
    lastIndex = match.index + match[0].length;
  }
  pushText(rawText.slice(lastIndex));

  switch (wrapModeValue) {
    case '2':
      content.style.whiteSpace = 'nowrap';
      content.style.wordBreak = 'normal';
      break;
    case '3':
      content.style.whiteSpace = 'pre-wrap';
      content.style.wordBreak = 'break-all';
      break;
    default:
      content.style.whiteSpace = 'pre-wrap';
      content.style.wordBreak = 'normal';
      break;
  }

  if (positionInfo) {
    const xRatio = Math.max(0, Math.min(1, positionInfo.x / stageWidth));
    const yRatio = Math.max(0, Math.min(1, positionInfo.y / stageHeight));
    content.style.position = 'absolute';
    content.style.left = `${(xRatio * 100).toFixed(2)}%`;
    content.style.top = `${(yRatio * 100).toFixed(2)}%`;
    content.style.transform = 'translate(-50%, -50%)';
    content.style.textAlign = xRatio < 0.33 ? 'left' : xRatio > 0.66 ? 'right' : 'center';
    stage.style.alignItems = 'stretch';
    stage.style.justifyContent = 'flex-start';
  } else {
    content.style.position = 'relative';
    content.style.transform = 'none';
    content.style.left = 'auto';
    content.style.top = 'auto';
    content.style.textAlign = 'center';
  }

  if (!content.hasChildNodes()) {
    const placeholder = document.createElement('div');
    placeholder.textContent = '(ASS preview empty)';
    placeholder.style.cssText = 'color:#8a94a3;font-size:14px;text-align:center;';
    content.appendChild(placeholder);
  }

  if (fadeInfo) {
    const fadeOverlay = document.createElement('div');
    fadeOverlay.style.cssText = [
      'position:absolute',
      'inset:0',
      'pointer-events:none',
      'background:linear-gradient(180deg,rgba(9,12,18,0.65) 0%,rgba(9,12,18,0) 35%,rgba(9,12,18,0) 65%,rgba(9,12,18,0.65) 100%)'
    ].join(';');
    stage.appendChild(fadeOverlay);
    content.style.opacity = '0.82';
  } else {
    content.style.removeProperty('opacity');
  }

  return {
    stage,
    tagSummary: Array.from(tagSummary),
    metaSummary,
    effectNotes
  };
}

function ensureSubtitlePreviewLayer() {
  if (subtitlePreviewLayer && subtitlePreviewLayer.isConnected) return subtitlePreviewLayer;
  const stageEl = document.getElementById('stage');
  if (!stageEl) return null;
  subtitlePreviewLayer = document.createElement('div');
  subtitlePreviewLayer.id = 'subtitle-preview-layer';
  subtitlePreviewLayer.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'display:none',
    'align-items:flex-end',
    'justify-content:center',
    'padding:0 8%',
    'box-sizing:border-box',
    'z-index:120',
    'gap:12px'
  ].join(';');
  if (!stageEl.style.position) stageEl.style.position = 'relative';
  stageEl.appendChild(subtitlePreviewLayer);
  return subtitlePreviewLayer;
}

function getSubtitlePreviewMode() {
  return subtitlePreviewState.mode || null;
}

function setSubtitlePreviewMode(mode, { persist = true } = {}) {
  let normalized = mode === 'ass' ? 'ass' : (mode === 'srt' ? 'srt' : null);
  if (persist) {
    const stored = saveTtsPreviewPrefs({ mode: normalized });
    normalized = stored.mode || (stored.srt ? 'srt' : stored.ass ? 'ass' : null);
  }
  subtitlePreviewState.mode = normalized;
  subtitlePreviewState.lastSignature = null;
  subtitlePreviewState.lastMode = null;
  renderSubtitlePreviewOverlay();
}

function scheduleSubtitlePreviewRebuild({ immediate = false } = {}) {
  if (subtitlePreviewRebuildTimer) {
    clearTimeout(subtitlePreviewRebuildTimer);
    subtitlePreviewRebuildTimer = null;
  }
  const trigger = () => {
    const promise = rebuildSubtitlePreviewData().catch((err) => {
      console.warn('rebuildSubtitlePreviewData error', err);
    });
    subtitlePreviewRebuildPromise = Promise.resolve(promise).finally(() => {
      if (subtitlePreviewRebuildPromise === promise) {
        subtitlePreviewRebuildPromise = null;
      }
    });
  };
  if (immediate) trigger();
  else subtitlePreviewRebuildTimer = setTimeout(trigger, 120);
}

async function rebuildSubtitlePreviewData() {
  const entries = buildSubtitleEntries({ format: SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE });
  const colors = loadSubtitleColorPrefs();
  subtitlePreviewState.entries = entries;
  subtitlePreviewState.colors = colors;
  subtitlePreviewState.srtContent = entries.length ? buildSrtContent(entries) : '';
  subtitlePreviewState.assContent = entries.length ? buildAssContent(entries, { width: STAGE_WIDTH, height: STAGE_HEIGHT }) : '';
  subtitlePreviewState.lastSignature = null;
  subtitlePreviewState.lastMode = null;
  if (window.suAPI?.writeTempSubtitles) {
    try {
      const res = await window.suAPI.writeTempSubtitles({
        srtContent: subtitlePreviewState.srtContent,
        assContent: subtitlePreviewState.assContent
      });
      if (res?.ok) {
        subtitlePreviewState.tempPaths = {
          srt: res.srtPath || null,
          ass: res.assPath || null
        };
      }
    } catch (err) {
      console.warn('writeTempSubtitles failed', err);
    }
  }
  renderSubtitlePreviewOverlay();
}

async function ensureSubtitlePreviewSync() {
  if (subtitlePreviewRebuildTimer) {
    clearTimeout(subtitlePreviewRebuildTimer);
    subtitlePreviewRebuildTimer = null;
    const promise = rebuildSubtitlePreviewData().catch((err) => {
      console.warn('rebuildSubtitlePreviewData error', err);
    });
    subtitlePreviewRebuildPromise = Promise.resolve(promise).finally(() => {
      if (subtitlePreviewRebuildPromise === promise) {
        subtitlePreviewRebuildPromise = null;
      }
    });
    await subtitlePreviewRebuildPromise;
    return;
  }
  if (subtitlePreviewRebuildPromise) {
    await subtitlePreviewRebuildPromise;
  }
}

function renderSubtitlePreviewOverlay() {
  const layer = ensureSubtitlePreviewLayer();
  if (!layer) return;
  const mode = getSubtitlePreviewMode();
  const entries = subtitlePreviewState.entries || [];
  const now = Math.max(0, Number(currentTime) || 0);
  const active = entries.filter(entry => now >= entry.start && now < entry.end);
  const signatureBase = active.map(entry => `${entry.start}-${entry.end}-${mode === 'ass' ? entry.assText : entry.text || ''}`).join('|');
  const signature = `${mode || 'none'}|${signatureBase}`;
  if (!mode || !active.length) {
    layer.style.display = 'none';
    layer.innerHTML = '';
    subtitlePreviewState.lastSignature = signature;
    subtitlePreviewState.lastMode = mode;
    return;
  }
  if (subtitlePreviewState.lastSignature === signature && subtitlePreviewState.lastMode === mode) {
    return;
  }
  subtitlePreviewState.lastSignature = signature;
  subtitlePreviewState.lastMode = mode;
  layer.innerHTML = '';
  layer.style.display = 'flex';
  if (mode === 'ass') {
    renderAssOverlay(layer, active);
  } else {
    renderSrtOverlay(layer, active, subtitlePreviewState.colors);
  }
}

function renderSrtOverlay(layer, entries, colors) {
  if (!layer || !Array.isArray(entries) || !entries.length) return;
  const sorted = entries.slice().sort((a, b) => a.start - b.start);
  const fontSize = Math.max(22, Math.round(STAGE_HEIGHT * 0.045));
  const padX = Math.round(fontSize * 0.6);
  const padY = Math.round(fontSize * 0.45);
  const group = document.createElement('div');
  group.style.cssText = [
    'width:100%',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:flex-end',
    `gap:${Math.round(fontSize * 0.35)}px`
  ].join(';');
  for (const entry of sorted) {
    const block = document.createElement('div');
    block.textContent = entry.text || '';
    const color = subtitleColorForCharacter(entry.characterName, colors);
    block.style.cssText = [
      'max-width:82%',
      `padding:${padY}px ${padX}px`,
      'background:rgba(10,12,16,0.35)',
      'border-radius:18px',
      `color:${color || '#f0f4ff'}`,
      `font-size:${fontSize}px`,
      'font-weight:600',
      'line-height:1.35',
      'text-align:center',
      'white-space:pre-wrap',
      'word-break:break-word',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
      'text-shadow:0 3px 8px rgba(0,0,0,0.75)'
    ].join(';');
    group.appendChild(block);
  }
  layer.appendChild(group);
}

function renderAssOverlay(layer, entries) {
  if (!layer || !Array.isArray(entries) || !entries.length) return;
  const sorted = entries.slice().sort((a, b) => a.start - b.start);
  for (const entry of sorted) {
    const preview = buildAssPreviewStage({
      text: entry.rawAssDialog || entry.assText,
      fallbackText: entry.text,
      meta: entry.assMeta,
      stageWidth: STAGE_WIDTH,
      stageHeight: STAGE_HEIGHT
    });
    if (!preview || !preview.stage) continue;
    const stageEl = preview.stage;
    stageEl.style.width = '100%';
    stageEl.style.height = '100%';
    stageEl.style.aspectRatio = '';
    stageEl.style.background = 'transparent';
    stageEl.style.border = 'none';
    stageEl.style.boxShadow = 'none';
    stageEl.style.borderRadius = '0';
    stageEl.style.padding = '0';
    stageEl.style.pointerEvents = 'none';
    stageEl.style.position = 'absolute';
    stageEl.style.left = '0';
    stageEl.style.top = '0';
    stageEl.style.right = '0';
    stageEl.style.bottom = '0';
    const content = stageEl.querySelector('[data-role="ass-preview-line"]');
    if (content) {
      content.style.padding = '0';
      content.style.maxWidth = '100%';
    }
    if ((stageEl.style.alignItems || '').trim() === 'center'
        && (stageEl.style.justifyContent || '').trim() === 'center') {
      stageEl.style.alignItems = 'flex-end';
      stageEl.style.justifyContent = 'center';
      stageEl.style.padding = '0 8% 6%';
    }
    layer.appendChild(stageEl);
  }
}

const EXPORT_PRESETS = [
  { id: 'mp4-720', label: 'MP4 720p (1280x720)', description: 'H.264 video at 30 fps.', kind: 'video', width: 1280, height: 720, ext: 'mp4', frameRate: 30 },
  { id: 'mp4-1080', label: 'MP4 1080p (1920x1080)', description: 'Full HD H.264 video at 30 fps.', kind: 'video', width: 1920, height: 1080, ext: 'mp4', frameRate: 30 },
  { id: 'gif-540', label: 'Animated GIF (540p)', description: 'Looping GIF at timeline resolution.', kind: 'video', width: 960, height: 540, ext: 'gif', frameRate: 15 },
  { id: 'image-seq', label: 'Image Sequence (ZIP)', description: 'PNG frames packaged as a ZIP.', kind: 'video', width: 960, height: 540, ext: 'zip', frameRate: 30 }
];

async function handleSaveProject() {
  if (!window.suAPI?.saveProject) { alert('Saving is not available in this build.'); return; }
  try {
    const data = projectExportData();
    // Always prompt the user (Save As), even if we have a current path
    const res = await window.suAPI.saveProject({ data }); // <-- removed "path: currentProjectPath"
    if (res?.canceled) return;
    if (res?.ok && res.path) {
      currentProjectPath = res.path;
      setProjectTitle(currentProjectPath);
      // User explicitly saved; backup no longer needed
      clearAutosave();
    } else if (res?.error) {
      alert(`Save failed: ${res.error}`);
    }
  } catch (error) {
    console.error('handleSaveProject error', error);
    alert(`Save failed: ${error?.message || error}`);
  }
}

async function handleOpenProject() {
  if (!window.suAPI?.openProject) { alert('Opening is not available in this build.'); return; }
  try {
    const res = await window.suAPI.openProject({ path: currentProjectPath });
    if (!res || res.canceled) return;
    if (!res.ok) { alert(`Open failed: ${res.error || 'Unknown error'}`); return; }
    const state = deriveLoadedState(res.data);
    if (!state) { alert('The selected file does not contain a project.'); return; }
    clearHistory();
    restoreProject(state);
    currentProjectPath = res.path || null;
    setProjectTitle(currentProjectPath);
    // New project loaded; discard any stale backup
    clearAutosave();
    playing = false;
    stopAllAudios({ pauseOnly: true });
    stopAllVideos({ pauseOnly: true });
    currentTime = 0;
    drawPlayhead();
    refreshStageVisibility();
    renderActiveGifs();
    applyBackgroundForTime(currentTime);
    const tracks = $('#tracks');
    if (tracks) {
      _suppressTimelineAutoExtend = true;
      try {
        tracks.scrollLeft = 0;
        tracks.scrollTop = 0;
      } finally {
        _suppressTimelineAutoExtend = false;
      }
    }
  } catch (error) {
    console.error('handleOpenProject error', error);
    alert(`Open failed: ${error?.message || error}`);
  }
}

function showExportProgress(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,14,20,0.55);display:flex;align-items:center;justify-content:center;z-index:2000;';
  const box = document.createElement('div');
  box.style.cssText = 'min-width:260px;max-width:320px;background:#0f141a;border:1px solid #2a2f36;border-radius:12px;padding:16px;display:grid;gap:10px;color:#e6edf7;font:14px/1.4 system-ui;box-shadow:0 16px 48px rgba(0,0,0,0.45);';
  const label = document.createElement('div');
  label.textContent = message;
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:12px;color:#8fa2bd;';
  meta.textContent = '';
  meta.hidden = true;
  const bar = document.createElement('div');
  bar.style.cssText = 'height:6px;background:#1e2632;border-radius:999px;overflow:hidden;';
  const fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:0%;background:#2f80ff;transition:width 0.15s ease;';
  bar.appendChild(fill);
  box.append(label, meta, bar);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return {
    update(current, total) {
      if (typeof total === 'number' && total > 0) {
        const percent = Math.min(100, Math.round((current / total) * 100));
        fill.style.width = `${percent}%`;
        label.textContent = `Exporting... ${current}/${total} frames`;
      } else {
        label.textContent = current;
        fill.style.width = '100%';
      }
    },
    setMeta(text) {
      if (typeof text === 'string' && text.trim().length) {
        meta.textContent = text;
        meta.hidden = false;
      } else {
        meta.textContent = '';
        meta.hidden = true;
      }
    },
    close() { overlay.remove(); }
  };
}

async function showExportDialog() {
  const config = await openExportDialog();
  if (!config) return;
  await exportVideoPreset(config);
}

function openExportDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    const dialog = document.createElement('div');
    dialog.className = 'export-dialog';

    const ttsEntries = projectTtsAudioClips().filter(entry => !entry.muted);
    const uniqueCharacters = Array.from(new Set(ttsEntries.map(entry => entry.characterName).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    const storedColorPrefs = loadSubtitleColorPrefs();
    const hasAssEffects = ttsEntries.some(entry => {
      const assText = entry.assDialog || '';
      const meta = entry.assMeta && typeof entry.assMeta === 'object' ? entry.assMeta : null;
      const hasOverrides = /{\s*\\/.test(assText) || /\\[NnhkKo]/.test(assText) || /{\\p\d/.test(assText);
      const hasMeta = meta && Object.keys(meta).length > 0;
      return hasOverrides || hasMeta;
    });
    const state = {
      step: 'preset',
      selectedPresetId: EXPORT_PRESETS[0]?.id || null,
      subtitleOption: 'none',
      subtitleFormat: SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE,
      subtitleColors: { ...storedColorPrefs },
      subtitleOutline: 'black',
      watermarkOption: 'none',
      watermarkText: {
        content: 'Sample Watermark',
        style: hydrateTextStyle({
          size: 48,
          bgOn: false,
          strokeW: 2,
          strokeColor: '#000000',
          shadowBlur: 6,
          shadowColor: '#000000',
          opacity: 1
        })
      },
      watermarkImagePath: null,
      watermarkImageName: '',
      watermarkSize: 0.22,
      watermarkOpacity: 0.65,
      watermarkPosition: 'bottom-right',
      credits: {
        enabled: false,
        text: 'Directed by\nYour Name\n\nStarring\nActor',
        direction: 'up',
        durationSec: 12,
        style: hydrateTextStyle({
          size: 48,
          align: 'center',
          color: '#ffffff',
          strokeW: 0,
          bgOn: false,
          shadowBlur: 12,
          shadowColor: '#000000',
          opacity: 1
        }),
        backgroundSource: 'assets',
        assetPaths: [],
        frameTimesMs: [],
        imageIntervalSec: 4,
        blurBackground: true,
        backgroundCrossfade: false,
        backgroundCrossfadeSec: 1,
        audioOption: 'none',
        audioPath: null,
        audioName: '',
        audioVolume: 1,
        audioFadeInSec: 0,
        audioFadeOutSec: 2
      },
      hasAssEffects
    };

    let colorPickerActive = false;
    let restoreOverlayFocusHandler = null;
    let colorRestoreBtn = null;
    let colorPickerAnchor = null;
    let activePickerInput = null;
    const positionRestoreButton = () => {
      if (!colorRestoreBtn) return;
      const pad = 16;
      const btnRect = colorRestoreBtn.getBoundingClientRect();
      let left = (window.innerWidth - btnRect.width) / 2;
      let top = pad;
      const stageEl = document.getElementById('stage');
      if (stageEl) {
        const stageRect = stageEl.getBoundingClientRect();
        if (stageRect.width && stageRect.height) {
          left = stageRect.right + pad;
          top = stageRect.top + (stageRect.height - btnRect.height) / 2;
        }
      } else if (activePickerInput) {
        const inputRect = activePickerInput.getBoundingClientRect();
        left = inputRect.right + pad;
        top = inputRect.top + (inputRect.height - btnRect.height) / 2;
      } else if (colorPickerAnchor) {
        left = colorPickerAnchor.x + pad;
        top = colorPickerAnchor.y - btnRect.height / 2;
      }
      left = Math.max(pad, Math.min(left, window.innerWidth - btnRect.width - pad));
      top = Math.max(pad, Math.min(top, window.innerHeight - btnRect.height - pad));
      colorRestoreBtn.style.left = `${Math.round(left)}px`;
      colorRestoreBtn.style.top = `${Math.round(top)}px`;
    };

    const ensureRestoreButton = () => {
      if (colorRestoreBtn) return;
      colorRestoreBtn = document.createElement('button');
      colorRestoreBtn.className = 'subtitle-color-restore';
      colorRestoreBtn.type = 'button';
      colorRestoreBtn.textContent = 'Return to Subtitle Options';
      colorRestoreBtn.addEventListener('click', () => {
        showOverlayAfterColorPicker();
      });
      document.body.appendChild(colorRestoreBtn);
      positionRestoreButton();
      window.addEventListener('resize', positionRestoreButton);
      window.addEventListener('scroll', positionRestoreButton, true);
    };

    const removeRestoreButton = () => {
      if (colorRestoreBtn) {
        colorRestoreBtn.remove();
        colorRestoreBtn = null;
        window.removeEventListener('resize', positionRestoreButton);
        window.removeEventListener('scroll', positionRestoreButton, true);
      }
    };

    const hideOverlayForColorPicker = () => {
      if (colorPickerActive) return;
      colorPickerActive = true;
      overlay.classList.add('colorpicker-hidden');
      ensureRestoreButton();
      restoreOverlayFocusHandler = () => {
        showOverlayAfterColorPicker();
      };
      window.addEventListener('focus', restoreOverlayFocusHandler, { once: true });
    };

    const showOverlayAfterColorPicker = () => {
      if (!colorPickerActive) return;
      colorPickerActive = false;
      overlay.classList.remove('colorpicker-hidden');
      removeRestoreButton();
      colorPickerAnchor = null;
      activePickerInput = null;
      if (restoreOverlayFocusHandler) {
        window.removeEventListener('focus', restoreOverlayFocusHandler);
        restoreOverlayFocusHandler = null;
      }
    };

    dialog.innerHTML = `
      <div class="export-step export-step-preset">
        <div class="export-dialog-title">Export Project</div>
        <p class="export-dialog-sub">Choose an export format.</p>
        <div class="export-preset-list"></div>
      </div>
      <div class="export-step export-step-subtitles" style="display:none;">
        <div class="export-dialog-title">Subtitles</div>
        <p class="export-dialog-sub">Would you like to include subtitles with this export?</p>
        <div class="subtitle-option-list">
          <label class="subtitle-option">
            <input type="radio" name="subtitle-option" value="none" checked>
            <div>
              <div class="subtitle-option-title">No Subtitles</div>
              <div class="subtitle-option-desc">Export the video without generating subtitle files.</div>
            </div>
          </label>
          <label class="subtitle-option">
            <input type="radio" name="subtitle-option" value="srt">
            <div>
              <div class="subtitle-option-title">Generate .srt File</div>
              <div class="subtitle-option-desc">Create a separate SRT subtitle file synced with the video.</div>
            </div>
          </label>
          <label class="subtitle-option">
            <input type="radio" name="subtitle-option" value="ass">
            <div>
              <div class="subtitle-option-title">Generate .ass File</div>
              <div class="subtitle-option-desc">Export an ASS subtitle file to preserve advanced effects.</div>
            </div>
          </label>
          <label class="subtitle-option">
            <input type="radio" name="subtitle-option" value="burn">
            <div>
              <div class="subtitle-option-title">Burn In Subtitles</div>
              <div class="subtitle-option-desc">Render subtitles directly on the exported video.</div>
            </div>
          </label>
        </div>
        <div data-role="ass-format-warning" style="display:none;margin:12px 0 0 0;padding:10px;border-radius:8px;border:1px solid #684015;background:#2b1a00;color:#ffaf56;font-size:12px;">
          ASS formatting detected. Choose the .ass option to include override effects. SRT and burn-in exports will use plain text.
        </div>
        <div class="subtitle-format-section" data-role="subtitle-format">
          <div class="subtitle-format-title">Text Format</div>
          <label class="subtitle-format-choice">
            <input type="radio" name="subtitle-format" value="${SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE}" checked>
            <span>Character Name: Dialogue</span>
          </label>
          <label class="subtitle-format-choice">
            <input type="radio" name="subtitle-format" value="${SUBTITLE_TEXT_FORMATS.DIALOGUE_ONLY}">
            <span>Dialogue</span>
          </label>
        </div>
        <div class="subtitle-outline-section" data-role="subtitle-outline" style="display:none;">
          <div class="subtitle-format-title">Outline Color</div>
          <label class="subtitle-format-choice">
            <input type="radio" name="subtitle-outline" value="black" checked>
            <span>Black Outline</span>
          </label>
          <label class="subtitle-format-choice">
            <input type="radio" name="subtitle-outline" value="white">
            <span>White Outline</span>
          </label>
          <label class="subtitle-format-choice">
            <input type="radio" name="subtitle-outline" value="none">
            <span>No Outline</span>
          </label>
        </div>
      </div>
      <div class="export-step export-step-colors" style="display:none;">
        <div class="export-dialog-title">Subtitle Colors</div>
        <p class="export-dialog-sub">Choose a subtitle color for each character. These choices are saved for future exports.</p>
        <div class="subtitle-color-list" data-role="subtitle-color-list"></div>
      </div>
      <div class="export-step export-step-watermark" style="display:none;">
        <div class="export-dialog-title">Watermark</div>
        <p class="export-dialog-sub">Add an optional watermark to your export.</p>
        <div class="watermark-option-list">
          <label class="watermark-option">
            <input type="radio" name="watermark-option" value="none" checked>
            <div>
              <div class="watermark-option-title">No Watermark</div>
              <div class="watermark-option-desc">Export without adding a watermark.</div>
            </div>
          </label>
          <label class="watermark-option">
            <input type="radio" name="watermark-option" value="text">
            <div>
              <div class="watermark-option-title">Text Watermark</div>
              <div class="watermark-option-desc">Use the text tools to create a custom watermark.</div>
            </div>
          </label>
          <label class="watermark-option">
            <input type="radio" name="watermark-option" value="image">
            <div>
              <div class="watermark-option-title">Image Watermark</div>
              <div class="watermark-option-desc">Pick an image from your assets to overlay on the export.</div>
            </div>
          </label>
        </div>
        <div class="watermark-config" data-role="watermark-config" style="display:none;">
          <div class="watermark-text-config" data-role="watermark-text-config" style="display:none;">
            <div class="watermark-field">
              <div class="watermark-field-label">Watermark Text</div>
              <div class="watermark-field-value">
                <span class="watermark-summary" data-role="watermark-text-summary"></span>
                <button type="button" data-act="watermark-edit-text">Edit...</button>
              </div>
            </div>
          </div>
          <div class="watermark-image-config" data-role="watermark-image-config" style="display:none;">
            <div class="watermark-field">
              <div class="watermark-field-label">Watermark Image</div>
              <div class="watermark-field-value">
                <select data-role="watermark-image-select"></select>
                <button type="button" data-act="watermark-refresh-assets" title="Refresh asset list">Refresh</button>
              </div>
            </div>
          </div>
          <div class="watermark-field">
            <label class="watermark-field-label" for="watermark-position">Position</label>
            <select id="watermark-position" data-role="watermark-position"></select>
          </div>
          <div class="watermark-field">
            <label class="watermark-field-label" for="watermark-size">Size</label>
            <div class="watermark-slider-wrap">
              <input type="range" id="watermark-size" data-role="watermark-size" min="10" max="60" value="${Math.round(state.watermarkSize * 100)}">
              <span class="watermark-slider-value" data-role="watermark-size-value"></span>
            </div>
          </div>
          <div class="watermark-field">
            <label class="watermark-field-label" for="watermark-opacity">Opacity</label>
            <div class="watermark-slider-wrap">
              <input type="range" id="watermark-opacity" data-role="watermark-opacity" min="5" max="100" value="${Math.round(state.watermarkOpacity * 100)}">
              <span class="watermark-slider-value" data-role="watermark-opacity-value"></span>
            </div>
      </div>
      <div class="watermark-preview-wrap">
        <canvas data-role="watermark-preview" width="320" height="180"></canvas>
      </div>
    </div>
  </div>
      <div class="export-step export-step-credits" style="display:none;">
        <div class="export-dialog-title">Credits</div>
        <p class="export-dialog-sub">Append an optional scrolling credit roll after the video export.</p>
        <div class="credits-option-list">
          <label class="credits-option">
            <input type="radio" name="credits-option" value="none" checked>
            <div>
              <div class="credits-option-title">No Credits</div>
              <div class="credits-option-desc">Finish the export without adding end credits.</div>
            </div>
          </label>
          <label class="credits-option">
            <input type="radio" name="credits-option" value="scroll">
            <div>
              <div class="credits-option-title">Add Scrolling Credits</div>
              <div class="credits-option-desc">Create a customizable credit roll that plays after the main video.</div>
            </div>
          </label>
        </div>
        <div class="credits-config" data-role="credits-config" style="display:none;">
          <label class="credits-field">
            <span class="credits-field-label">Credits Text</span>
            <textarea data-role="credits-text" rows="6" placeholder="Enter the names and roles you want to feature..."></textarea>
          </label>
          <div class="credits-field-group">
            <button type="button" data-act="credits-edit-style">Edit Text Style</button>
            <label>
              <span>Scroll Direction</span>
              <select data-role="credits-direction">
                <option value="up">Bottom to top</option>
                <option value="down">Top to bottom</option>
              </select>
            </label>
            <label>
              <span>Scroll Duration (seconds)</span>
              <input type="number" data-role="credits-duration" min="4" max="180" step="1">
            </label>
          </div>
          <div class="credits-background">
            <div class="credits-field">
              <span class="credits-field-label">Background Source</span>
              <div class="credits-background-options">
                <label><input type="radio" name="credits-bg-source" value="assets" checked> Images from assets</label>
                <label><input type="radio" name="credits-bg-source" value="frames"> Frames from video</label>
              </div>
            </div>
            <div class="credits-field" data-role="credits-assets-wrap">
              <span class="credits-field-label">Choose Images</span>
              <div class="credits-asset-select">
                <select data-role="credits-asset-select" multiple size="6"></select>
                <button type="button" data-act="credits-refresh-assets">Refresh</button>
              </div>
              <div class="credits-asset-hint">Hold Ctrl or Shift to select multiple images.</div>
            </div>
            <div class="credits-field" data-role="credits-frames-wrap" style="display:none;">
              <span class="credits-field-label">Use Frames</span>
              <div class="credits-frame-controls">
                <div class="credits-frame-add">
                  <input type="number" data-role="credits-frame-input" min="0" step="0.5" placeholder="Time (seconds)">
                  <button type="button" data-act="credits-add-frame-input">Add Time</button>
                  <button type="button" data-act="credits-add-frame-current">Use Playhead</button>
                </div>
                <div class="credits-frame-list" data-role="credits-frame-list"></div>
                <div class="credits-frame-hint">Add at least one timestamp to capture a background from the project.</div>
              </div>
            </div>
            <div class="credits-field">
              <label>
                <span>Time Between Backgrounds (seconds)</span>
                <input type="number" data-role="credits-interval" min="1" max="30" step="0.5">
              </label>
            </div>
            <label class="credits-inline">
              <input type="checkbox" data-role="credits-blur">
              <span>Blur backgrounds</span>
            </label>
            <label class="credits-inline">
              <input type="checkbox" data-role="credits-crossfade">
              <span>Crossfade between backgrounds</span>
            </label>
            <div class="credits-field" data-role="credits-crossfade-settings" style="display:none;">
              <span class="credits-field-label">Crossfade Duration (seconds)</span>
              <input type="number" data-role="credits-crossfade-seconds" min="0.1" max="10" step="0.1">
            </div>
          </div>
          <div class="credits-audio">
            <div class="credits-field">
              <span class="credits-field-label">Credits Audio</span>
              <div class="credits-audio-options">
                <label><input type="radio" name="credits-audio-option" value="none" checked> No audio</label>
                <label><input type="radio" name="credits-audio-option" value="asset"> Choose audio file</label>
              </div>
            </div>
            <div class="credits-audio-config" data-role="credits-audio-config" style="display:none;">
              <div class="credits-field">
                <span class="credits-field-label">Audio File</span>
                <div class="credits-audio-select">
                  <select data-role="credits-audio-select"></select>
                  <button type="button" data-act="credits-refresh-audio">Refresh</button>
                </div>
                <div class="credits-audio-hint">Audio starts when credits begin and is trimmed to their duration.</div>
              </div>
              <div class="credits-field-group">
                <label>
                  <span>Volume</span>
                  <div class="credits-slider-wrap">
                    <input type="range" data-role="credits-audio-volume" min="0" max="100" value="100">
                    <span data-role="credits-audio-volume-value">100%</span>
                  </div>
                </label>
                <label>
                  <span>Fade In (s)</span>
                  <input type="number" data-role="credits-audio-fade-in" min="0" max="20" step="0.5">
                </label>
                <label>
                  <span>Fade Out (s)</span>
                  <input type="number" data-role="credits-audio-fade-out" min="0" max="20" step="0.5">
                </label>
              </div>
            </div>
          </div>
          <div class="credits-preview">
            <div class="credits-preview-canvas">
              <canvas data-role="credits-preview" width="320" height="180"></canvas>
            </div>
            <div class="credits-preview-actions">
              <button type="button" data-act="credits-preview">Preview Credits</button>
              <span data-role="credits-preview-status"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="export-actions">
        <button type="button" data-act="back" style="display:none;">Back</button>
        <div style="flex:1;"></div>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="button" class="primary" data-act="primary" disabled>Export</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const stepPreset = dialog.querySelector('.export-step-preset');
    const stepSubtitles = dialog.querySelector('.export-step-subtitles');
    const stepColors = dialog.querySelector('.export-step-colors');
    const stepWatermark = dialog.querySelector('.export-step-watermark');
    const stepCredits = dialog.querySelector('.export-step-credits');
    const presetList = dialog.querySelector('.export-preset-list');
    const backBtn = dialog.querySelector('[data-act="back"]');
    const cancelBtn = dialog.querySelector('[data-act="cancel"]');
    const primaryBtn = dialog.querySelector('[data-act="primary"]');
    const subtitleOptionRadios = dialog.querySelectorAll('input[name="subtitle-option"]');
    const subtitleFormatRadios = dialog.querySelectorAll('input[name="subtitle-format"]');
    const subtitleFormatSection = dialog.querySelector('[data-role="subtitle-format"]');
    const subtitleOutlineSection = dialog.querySelector('[data-role="subtitle-outline"]');
    const subtitleOutlineRadios = dialog.querySelectorAll('input[name="subtitle-outline"]');
    const assFormatWarning = dialog.querySelector('[data-role="ass-format-warning"]');
    const colorList = dialog.querySelector('[data-role="subtitle-color-list"]');
    const watermarkOptionRadios = dialog.querySelectorAll('input[name="watermark-option"]');
    const watermarkConfigWrap = dialog.querySelector('[data-role="watermark-config"]');
    const watermarkTextConfig = dialog.querySelector('[data-role="watermark-text-config"]');
    const watermarkImageConfig = dialog.querySelector('[data-role="watermark-image-config"]');
    const watermarkTextSummary = dialog.querySelector('[data-role="watermark-text-summary"]');
    const watermarkEditBtn = dialog.querySelector('[data-act="watermark-edit-text"]');
    const watermarkImageSelect = dialog.querySelector('[data-role="watermark-image-select"]');
    const watermarkRefreshBtn = dialog.querySelector('[data-act="watermark-refresh-assets"]');
    const watermarkPositionSelect = dialog.querySelector('[data-role="watermark-position"]');
    const watermarkSizeSlider = dialog.querySelector('[data-role="watermark-size"]');
    const watermarkSizeValue = dialog.querySelector('[data-role="watermark-size-value"]');
    const watermarkOpacitySlider = dialog.querySelector('[data-role="watermark-opacity"]');
    const watermarkOpacityValue = dialog.querySelector('[data-role="watermark-opacity-value"]');
    const watermarkPreviewCanvas = dialog.querySelector('[data-role="watermark-preview"]');
    const watermarkPreviewCtx = watermarkPreviewCanvas ? watermarkPreviewCanvas.getContext('2d') : null;
    const creditsOptionRadios = dialog.querySelectorAll('input[name="credits-option"]');
    const creditsConfigWrap = dialog.querySelector('[data-role="credits-config"]');
    const creditsTextArea = dialog.querySelector('[data-role="credits-text"]');
    const creditsEditBtn = dialog.querySelector('[data-act="credits-edit-style"]');
    const creditsDirectionSelect = dialog.querySelector('[data-role="credits-direction"]');
    const creditsDurationInput = dialog.querySelector('[data-role="credits-duration"]');
    const creditsBgSourceRadios = dialog.querySelectorAll('input[name="credits-bg-source"]');
    const creditsAssetsWrap = dialog.querySelector('[data-role="credits-assets-wrap"]');
    const creditsFramesWrap = dialog.querySelector('[data-role="credits-frames-wrap"]');
    const creditsAssetSelect = dialog.querySelector('[data-role="credits-asset-select"]');
    const creditsRefreshAssetsBtn = dialog.querySelector('[data-act="credits-refresh-assets"]');
    const creditsIntervalInput = dialog.querySelector('[data-role="credits-interval"]');
    const creditsBlurCheckbox = dialog.querySelector('[data-role="credits-blur"]');
    const creditsCrossfadeCheckbox = dialog.querySelector('[data-role="credits-crossfade"]');
    const creditsCrossfadeSettings = dialog.querySelector('[data-role="credits-crossfade-settings"]');
    const creditsCrossfadeInput = dialog.querySelector('[data-role="credits-crossfade-seconds"]');
    const creditsFrameInput = dialog.querySelector('[data-role="credits-frame-input"]');
    const creditsAddFrameInputBtn = dialog.querySelector('[data-act="credits-add-frame-input"]');
    const creditsAddFrameCurrentBtn = dialog.querySelector('[data-act="credits-add-frame-current"]');
    const creditsFrameList = dialog.querySelector('[data-role="credits-frame-list"]');
    const creditsPreviewCanvas = dialog.querySelector('[data-role="credits-preview"]');
    const creditsPreviewCtx = creditsPreviewCanvas ? creditsPreviewCanvas.getContext('2d') : null;
    const creditsPreviewBtn = dialog.querySelector('[data-act="credits-preview"]');
    const creditsPreviewStatus = dialog.querySelector('[data-role="credits-preview-status"]');
    const creditsAudioOptionRadios = dialog.querySelectorAll('input[name="credits-audio-option"]');
    const creditsAudioConfigWrap = dialog.querySelector('[data-role="credits-audio-config"]');
    const creditsAudioSelect = dialog.querySelector('[data-role="credits-audio-select"]');
    const creditsRefreshAudioBtn = dialog.querySelector('[data-act="credits-refresh-audio"]');
    const creditsAudioVolumeSlider = dialog.querySelector('[data-role="credits-audio-volume"]');
    const creditsAudioVolumeLabel = dialog.querySelector('[data-role="credits-audio-volume-value"]');
    const creditsAudioFadeInInput = dialog.querySelector('[data-role="credits-audio-fade-in"]');
    const creditsAudioFadeOutInput = dialog.querySelector('[data-role="credits-audio-fade-out"]');

    const hasTts = ttsEntries.length > 0;
    const getSelectedPreset = () => EXPORT_PRESETS.find(p => p.id === state.selectedPresetId) || null;
    const subtitleEligible = () => {
      const preset = getSelectedPreset();
      if (!preset) return false;
      return hasTts && String(preset.ext || '').toLowerCase() === 'mp4';
    };

    let watermarkAssetOptions = [];
    let loadingWatermarkAssets = false;
    let watermarkPreviewToken = 0;
    let creditsAssetOptions = [];
    let loadingCreditsAssets = false;
    let creditsPreviewToken = 0;
    let creditsPreviewPlaying = false;
    let creditsPreviewStartTs = 0;
    let creditsPreviewDurationMs = 0;
    let creditsPreviewState = null;
    let creditsPreviewFrame = null;
    let creditsPreviewBufferCanvas = null;
    let creditsPreviewBufferCtx = null;
    let creditsAudioOptions = [];
    let loadingCreditsAudio = false;
    let creditsPreviewAudio = null;
    let creditsPreviewAudioBaseVolume = 1;
    let creditsPreviewAudioFadeInMs = 0;
    let creditsPreviewAudioFadeOutMs = 0;
    let framePickerActive = false;
    let framePickerPanel = null;
    let framePickerTimeLabel = null;
    let framePickerFeedback = null;
    let framePickerTicker = null;
    let framePickerKeyHandler = null;

    const watermarkConfigValid = () => {
      if (state.watermarkOption === 'none') return true;
      if (state.watermarkOption === 'text') {
        return !!(state.watermarkText?.content || '').trim();
      }
      if (state.watermarkOption === 'image') {
        return !!state.watermarkImagePath;
      }
      return false;
    };

    const getWatermarkExportConfig = () => {
      if (state.watermarkOption === 'none') return null;
      if (!watermarkConfigValid()) return null;
      if (state.watermarkOption === 'text') {
        return {
          mode: 'text',
          text: {
            content: state.watermarkText?.content || '',
            style: JSON.parse(JSON.stringify(state.watermarkText?.style || {}))
          },
          size: state.watermarkSize,
          opacity: state.watermarkOpacity,
          position: state.watermarkPosition
        };
      }
      return {
        mode: 'image',
        imagePath: state.watermarkImagePath,
        imageName: state.watermarkImageName || basename(state.watermarkImagePath || ''),
        size: state.watermarkSize,
        opacity: state.watermarkOpacity,
        position: state.watermarkPosition
      };
    };

    const updateWatermarkSummary = () => {
      if (!watermarkTextSummary) return;
      const text = (state.watermarkText?.content || '').trim();
      if (!text) {
        watermarkTextSummary.textContent = 'No text set';
        watermarkTextSummary.classList.add('watermark-summary-empty');
      } else {
        const shortened = text.length > 48 ? `${text.slice(0, 48)}...` : text;
        watermarkTextSummary.textContent = shortened;
        watermarkTextSummary.classList.remove('watermark-summary-empty');
      }
    };

    const populateWatermarkPositions = () => {
      if (!watermarkPositionSelect) return;
      watermarkPositionSelect.innerHTML = '';
      WATERMARK_POSITION_OPTIONS.forEach((pos) => {
        const opt = document.createElement('option');
        opt.value = pos;
        opt.textContent = watermarkPositionLabel(pos);
        if (pos === state.watermarkPosition) opt.selected = true;
        watermarkPositionSelect.appendChild(opt);
      });
    };

    const populateWatermarkAssetSelect = () => {
      if (!watermarkImageSelect) return;
      watermarkImageSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = watermarkAssetOptions.length ? 'Select image...' : 'No image assets found';
      placeholder.selected = !state.watermarkImagePath;
      placeholder.disabled = !watermarkAssetOptions.length;
      watermarkImageSelect.appendChild(placeholder);

      let hasMatch = false;
      for (const asset of watermarkAssetOptions) {
        const opt = document.createElement('option');
        opt.value = asset.path;
        opt.textContent = asset.label;
        if (asset.path === state.watermarkImagePath) {
          opt.selected = true;
          hasMatch = true;
        }
        watermarkImageSelect.appendChild(opt);
      }

      if (state.watermarkImagePath && !hasMatch) {
        const opt = document.createElement('option');
        opt.value = state.watermarkImagePath;
        opt.textContent = state.watermarkImageName || basename(state.watermarkImagePath);
        opt.selected = true;
        opt.dataset.missing = 'true';
        watermarkImageSelect.appendChild(opt);
      }

      watermarkImageSelect.disabled = !watermarkAssetOptions.length;
    };

    const loadWatermarkAssets = async (force = false) => {
      if (loadingWatermarkAssets) return;
      if (!force && watermarkAssetOptions.length) return;
      if (!PATHS) return;
      loadingWatermarkAssets = true;
      try {
        const collected = [];
        const sources = [
          { root: PATHS.characters, label: 'Characters' },
          { root: PATHS.objects, label: 'Objects' },
          { root: PATHS.backgrounds, label: 'Backgrounds' }
        ];
        const collect = (nodes, prefix) => {
          if (!Array.isArray(nodes)) return;
          for (const node of nodes) {
            if (node.type === 'dir') {
              collect(node.children, `${prefix}${node.name}/`);
            } else if (node.type === 'file' && isImage(node.path)) {
              collected.push({ path: node.path, label: `${prefix}${node.name}` });
            }
          }
        };
        for (const source of sources) {
          if (!source.root) continue;
          try {
            const tree = await window.suAPI.readAssetTree(source.root);
            collect(tree, source.label ? `${source.label}/` : '');
          } catch (err) {
            console.warn('watermark asset load failed', source.root, err);
          }
        }
        collected.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
        watermarkAssetOptions = collected;
        populateWatermarkAssetSelect();
        if (state.watermarkOption === 'image') {
          renderWatermarkPreview();
        }
      } finally {
        loadingWatermarkAssets = false;
      }
    };

    const updateWatermarkVisibility = () => {
      if (!watermarkConfigWrap) return;
      const enabled = state.watermarkOption !== 'none';
      watermarkConfigWrap.style.display = enabled ? '' : 'none';
      if (watermarkTextConfig) watermarkTextConfig.style.display = state.watermarkOption === 'text' ? '' : 'none';
      if (watermarkImageConfig) watermarkImageConfig.style.display = state.watermarkOption === 'image' ? '' : 'none';
      if (watermarkPreviewCanvas) {
        const wrap = watermarkPreviewCanvas.parentElement;
        if (wrap) wrap.style.display = enabled ? '' : 'none';
      }
    };

    const updateWatermarkSizeLabel = () => {
      if (!watermarkSizeValue) return;
      watermarkSizeValue.textContent = `${Math.round(state.watermarkSize * 100)}%`;
    };

    const updateWatermarkOpacityLabel = () => {
      if (!watermarkOpacityValue) return;
      watermarkOpacityValue.textContent = `${Math.round(clamp01(state.watermarkOpacity) * 100)}%`;
    };

    const clearWatermarkPreview = (message) => {
      if (!watermarkPreviewCtx || !watermarkPreviewCanvas) return;
      const { width, height } = watermarkPreviewCanvas;
      const ctx = watermarkPreviewCtx;
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1b2433');
      gradient.addColorStop(1, '#0d1117');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      if (message) {
        ctx.fillStyle = 'rgba(227,237,255,0.75)';
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(message, width / 2, height / 2);
      }
      ctx.restore();
    };

    const renderWatermarkPreview = async () => {
      if (!watermarkPreviewCtx || !watermarkPreviewCanvas) return;
      const ctx = watermarkPreviewCtx;
      const { width, height } = watermarkPreviewCanvas;
      const token = ++watermarkPreviewToken;
      clearWatermarkPreview('');

      if (state.watermarkOption === 'none') {
        clearWatermarkPreview('Watermark disabled.');
        return;
      }

      const exportConfig = getWatermarkExportConfig();
      if (!exportConfig) {
        const msg = state.watermarkOption === 'image'
          ? 'Select an image asset to preview.'
          : 'Edit the watermark text to preview.';
        clearWatermarkPreview(msg);
        return;
      }

      try {
        const prepared = await buildWatermarkRenderState(exportConfig);
        if (token !== watermarkPreviewToken) return;
        if (!prepared) {
          clearWatermarkPreview('Unable to preview watermark.');
          return;
        }
        drawWatermarkOnCanvas(ctx, width, height, prepared);
      } catch (err) {
        console.error('watermark preview error', err);
        clearWatermarkPreview('Watermark preview failed.');
      }
    };

    const syncWatermarkControls = () => {
      populateWatermarkPositions();
      updateWatermarkSummary();
      updateWatermarkVisibility();
      if (watermarkSizeSlider) {
        watermarkSizeSlider.value = String(Math.round(clamp(state.watermarkSize, 0.05, 0.6) * 100));
      }
      updateWatermarkSizeLabel();
      if (watermarkOpacitySlider) {
        watermarkOpacitySlider.value = String(Math.round(clamp01(state.watermarkOpacity) * 100));
      }
      updateWatermarkOpacityLabel();
      if (watermarkPositionSelect) {
        const desired = WATERMARK_POSITION_OPTIONS.includes(state.watermarkPosition) ? state.watermarkPosition : 'bottom-right';
        state.watermarkPosition = desired;
        watermarkPositionSelect.value = desired;
      }
      populateWatermarkAssetSelect();
      watermarkOptionRadios.forEach(radio => {
        radio.checked = radio.value === state.watermarkOption;
      });
    };

    const clampCreditsDuration = (value) => {
      const base = clampCreditsDurationSec(value);
      return Math.round(base * 10) / 10;
    };

    const clampCreditsInterval = (value) => {
      const base = clampCreditsIntervalSec(value);
      return Math.round(base * 10) / 10;
    };

    const populateCreditsAssetSelect = () => {
      if (!creditsAssetSelect) return;
      creditsAssetSelect.innerHTML = '';
      const selections = Array.isArray(state.credits.assetPaths) ? state.credits.assetPaths.slice() : [];
      const selectedSet = new Set(selections);
      if (!creditsAssetOptions.length) {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = 'No image assets found';
        creditsAssetSelect.appendChild(opt);
        creditsAssetSelect.disabled = true;
        return;
      }
      for (const item of creditsAssetOptions) {
        const opt = document.createElement('option');
        opt.value = item.path;
        opt.textContent = item.label;
        if (selectedSet.has(item.path)) opt.selected = true;
        creditsAssetSelect.appendChild(opt);
      }
      for (const path of selections) {
        if (creditsAssetOptions.some(opt => opt.path === path)) continue;
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = `${basename(path)} (missing)`;
        opt.selected = true;
        opt.dataset.missing = 'true';
        creditsAssetSelect.appendChild(opt);
      }
      creditsAssetSelect.disabled = false;
    };

    const loadCreditsAssets = async (force = false) => {
      if (loadingCreditsAssets) return;
      if (!force && creditsAssetOptions.length) return;
      if (!PATHS) return;
      loadingCreditsAssets = true;
      try {
        const collected = [];
        const sources = [
          { root: PATHS.characters, label: 'Characters' },
          { root: PATHS.objects, label: 'Objects' },
          { root: PATHS.backgrounds, label: 'Backgrounds' }
        ];
        const collect = (nodes, prefix) => {
          if (!Array.isArray(nodes)) return;
          for (const node of nodes) {
            if (node.type === 'dir') {
              collect(node.children, `${prefix}${node.name}/`);
            } else if (node.type === 'file' && isImage(node.path)) {
              collected.push({ path: node.path, label: `${prefix}${node.name}` });
            }
          }
        };
        for (const src of sources) {
          if (!src.root) continue;
          try {
            const tree = await window.suAPI.readAssetTree(src.root);
            collect(tree, src.label ? `${src.label}/` : '');
          } catch (err) {
            console.warn('credits asset load failed', src.root, err);
          }
        }
        collected.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
        creditsAssetOptions = collected;
        populateCreditsAssetSelect();
      } finally {
        loadingCreditsAssets = false;
      }
    };

    const populateCreditsAudioSelect = () => {
      if (!creditsAudioSelect) return;
      creditsAudioSelect.innerHTML = '';
      const currentPath = state.credits.audioPath;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = creditsAudioOptions.length ? 'Select audio...' : 'No audio assets found';
      placeholder.disabled = !creditsAudioOptions.length;
      placeholder.selected = !currentPath;
      creditsAudioSelect.appendChild(placeholder);
      let hasMatch = false;
      for (const asset of creditsAudioOptions) {
        const opt = document.createElement('option');
        opt.value = asset.path;
        opt.textContent = asset.label;
        if (asset.path === currentPath) {
          opt.selected = true;
          hasMatch = true;
        }
        creditsAudioSelect.appendChild(opt);
      }
      if (currentPath && !hasMatch) {
        const opt = document.createElement('option');
        opt.value = currentPath;
        opt.textContent = `${basename(currentPath)} (missing)`;
        opt.selected = true;
        opt.dataset.missing = 'true';
        creditsAudioSelect.appendChild(opt);
      }
      creditsAudioSelect.disabled = !creditsAudioOptions.length;
    };

    const loadCreditsAudioAssets = async (force = false) => {
      if (loadingCreditsAudio) return;
      if (!force && creditsAudioOptions.length) return;
      loadingCreditsAudio = true;
      try {
        const collected = [];
        const collect = (nodes, prefix) => {
          if (!Array.isArray(nodes)) return;
          for (const node of nodes) {
            if (node.type === 'dir') {
              collect(node.children, `${prefix}${node.name}/`);
            } else if (node.type === 'file' && isAudio(node.path)) {
              collected.push({ path: node.path, label: `${prefix}${node.name}` });
            }
          }
        };
        if (PATHS?.audio) {
          try {
            const tree = await window.suAPI.readAssetTree(PATHS.audio);
            collect(tree, '');
          } catch (err) {
            console.warn('credits audio load failed', PATHS.audio, err);
          }
        }
        collected.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
        creditsAudioOptions = collected;
        populateCreditsAudioSelect();
      } finally {
        loadingCreditsAudio = false;
      }
    };

    const updateCreditsAudioVolumeLabel = () => {
      if (!creditsAudioVolumeLabel) return;
      creditsAudioVolumeLabel.textContent = `${Math.round(clamp01(state.credits.audioVolume) * 100)}%`;
    };

    const updateFramePickerTime = () => {
      if (framePickerTimeLabel) {
        framePickerTimeLabel.textContent = fmtTime(currentTime);
      }
    };

    const framePickerTick = () => {
      if (!framePickerActive) return;
      updateFramePickerTime();
      framePickerTicker = requestAnimationFrame(framePickerTick);
    };

    const stopFramePicker = () => {
      if (!framePickerActive) return;
      framePickerActive = false;
      overlay.classList.remove('framepicker-hidden');
      if (framePickerPanel) framePickerPanel.remove();
      framePickerPanel = null;
      framePickerTimeLabel = null;
      framePickerFeedback = null;
      if (framePickerTicker) {
        cancelAnimationFrame(framePickerTicker);
        framePickerTicker = null;
      }
      if (framePickerKeyHandler) {
        document.removeEventListener('keydown', framePickerKeyHandler, true);
        framePickerKeyHandler = null;
      }
    };

    const startFramePicker = () => {
      if (framePickerActive) return;
      framePickerActive = true;
      overlay.classList.add('framepicker-hidden');
      framePickerPanel = document.createElement('div');
      framePickerPanel.className = 'credits-frame-picker';
      framePickerPanel.innerHTML = `
        <div class="credits-frame-picker-title">Pick Frame from Timeline</div>
        <div class="credits-frame-picker-desc">Move the playhead to the frame you want to capture, then confirm.</div>
        <div class="credits-frame-picker-time" data-role="picker-time">${fmtTime(currentTime)}</div>
        <div class="credits-frame-picker-feedback" data-role="picker-feedback"></div>
        <div class="credits-frame-picker-actions">
          <button type="button" data-role="picker-cancel">Cancel</button>
          <button type="button" class="primary" data-role="picker-confirm">Use This Frame</button>
        </div>
      `;
      document.body.appendChild(framePickerPanel);
      framePickerTimeLabel = framePickerPanel.querySelector('[data-role="picker-time"]');
      framePickerFeedback = framePickerPanel.querySelector('[data-role="picker-feedback"]');
      const confirmBtn = framePickerPanel.querySelector('[data-role="picker-confirm"]');
      const cancelBtn = framePickerPanel.querySelector('[data-role="picker-cancel"]');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          const added = addCreditsFrameTime(currentTime);
          if (!added) {
            if (framePickerFeedback) framePickerFeedback.textContent = 'That frame is already in the list.';
            return;
          }
          renderCreditsFrameList();
          updateControls();
          stopFramePicker();
        });
      }
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => stopFramePicker());
      }
      framePickerKeyHandler = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          stopFramePicker();
        }
      };
      document.addEventListener('keydown', framePickerKeyHandler, true);
      updateFramePickerTime();
      framePickerTicker = requestAnimationFrame(framePickerTick);
    };

    const addCreditsFrameTime = (timeMs) => {
      if (!Number.isFinite(timeMs)) return false;
      const timelineEnd = Math.max(timelineViewportEnd(), 0);
      const clamped = clamp(Math.round(timeMs), 0, timelineEnd);
      if (!state.credits.frameTimesMs) state.credits.frameTimesMs = [];
      const exists = state.credits.frameTimesMs.some((value) => Math.abs(value - clamped) < 1);
      if (exists) return false;
      state.credits.frameTimesMs.push(clamped);
      state.credits.frameTimesMs.sort((a, b) => a - b);
      return true;
    };

    const renderCreditsFrameList = () => {
      if (!creditsFrameList) return;
      creditsFrameList.innerHTML = '';
      const frames = Array.isArray(state.credits.frameTimesMs) ? state.credits.frameTimesMs : [];
      if (!frames.length) {
        const empty = document.createElement('div');
        empty.className = 'credits-frame-empty';
        empty.textContent = 'No frames selected.';
        creditsFrameList.appendChild(empty);
        return;
      }
      const ordered = frames.map((timeMs, idx) => ({ timeMs, idx })).sort((a, b) => a.timeMs - b.timeMs);
      for (const entry of ordered) {
        const token = document.createElement('div');
        token.className = 'credits-frame-token';
        token.dataset.index = String(entry.idx);
        const label = document.createElement('span');
        label.textContent = fmtTime(entry.timeMs);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.index = String(entry.idx);
        remove.className = 'credits-frame-remove';
        remove.textContent = '×';
        token.append(label, remove);
        creditsFrameList.appendChild(token);
      }
    };

    const creditsConfigValid = () => {
      if (!state.credits.enabled) return true;
      const text = (state.credits.text || '').trim();
      if (!text) return false;
      const duration = clampCreditsDuration(state.credits.durationSec);
      if (!Number.isFinite(duration) || duration < CREDITS_MIN_DURATION_SEC) return false;
      const interval = clampCreditsInterval(state.credits.imageIntervalSec);
      if (!Number.isFinite(interval) || interval < CREDITS_MIN_INTERVAL_SEC) return false;
      const source = state.credits.backgroundSource === 'frames' ? 'frames' : 'assets';
      let backgroundOk = false;
      if (source === 'assets') {
        backgroundOk = Array.isArray(state.credits.assetPaths) && state.credits.assetPaths.length > 0;
      } else {
        backgroundOk = Array.isArray(state.credits.frameTimesMs) && state.credits.frameTimesMs.length > 0;
      }
      if (!backgroundOk) return false;
      if (state.credits.audioOption === 'asset' && !state.credits.audioPath) return false;
      return true;
    };

    const getCreditsExportConfig = () => {
      if (!state.credits.enabled) return null;
      if (!creditsConfigValid()) return null;
      return {
        text: (state.credits.text || '').replace(/\r\n/g, '\n'),
        direction: state.credits.direction === 'down' ? 'down' : 'up',
        durationSec: clampCreditsDuration(state.credits.durationSec),
        style: JSON.parse(JSON.stringify(state.credits.style || {})),
        background: {
          source: state.credits.backgroundSource === 'frames' ? 'frames' : 'assets',
          assetPaths: Array.isArray(state.credits.assetPaths) ? state.credits.assetPaths.slice() : [],
          frameTimesMs: Array.isArray(state.credits.frameTimesMs) ? state.credits.frameTimesMs.slice() : [],
          imageIntervalSec: clampCreditsInterval(state.credits.imageIntervalSec),
          blur: !!state.credits.blurBackground
        },
        audio: state.credits.audioOption === 'asset' && state.credits.audioPath ? {
          path: state.credits.audioPath,
          name: state.credits.audioName || basename(state.credits.audioPath),
          volume: clamp01(state.credits.audioVolume ?? 1),
          fadeInSec: clampCreditsFadeSec(state.credits.audioFadeInSec ?? 0),
          fadeOutSec: clampCreditsFadeSec(state.credits.audioFadeOutSec ?? 0)
        } : null,
        backgroundCrossfadeSec: state.credits.backgroundCrossfade ? clampCreditsFadeSec(state.credits.backgroundCrossfadeSec ?? 1) : 0
      };
    };

    const resetCreditsPreviewCanvas = (message = 'Preview credits') => {
      if (!creditsPreviewCtx || !creditsPreviewCanvas) return;
      const { width, height } = creditsPreviewCanvas;
      creditsPreviewCtx.save();
      creditsPreviewCtx.clearRect(0, 0, width, height);
      const grad = creditsPreviewCtx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#1b2433');
      grad.addColorStop(1, '#0d1117');
      creditsPreviewCtx.fillStyle = grad;
      creditsPreviewCtx.fillRect(0, 0, width, height);
      if (message) {
        creditsPreviewCtx.fillStyle = '#c2cee2';
        creditsPreviewCtx.font = '14px system-ui';
        creditsPreviewCtx.textAlign = 'center';
        creditsPreviewCtx.textBaseline = 'middle';
        creditsPreviewCtx.fillText(message, width / 2, height / 2, width - 24);
      }
      creditsPreviewCtx.restore();
    };

    const stopCreditsPreview = (message = '') => {
      creditsPreviewPlaying = false;
      creditsPreviewToken++;
      creditsPreviewState = null;
      creditsPreviewBufferCanvas = null;
      creditsPreviewBufferCtx = null;
      if (creditsPreviewAudio) {
        try {
          creditsPreviewAudio.pause();
        } catch {}
        creditsPreviewAudio = null;
      }
      if (creditsPreviewFrame != null) {
        cancelAnimationFrame(creditsPreviewFrame);
        creditsPreviewFrame = null;
      }
      if (creditsPreviewStatus) creditsPreviewStatus.textContent = message;
      resetCreditsPreviewCanvas('Preview credits');
    };

    const playCreditsPreview = async () => {
      if (!creditsPreviewCanvas || !creditsPreviewCtx) return;
      if (!state.credits.enabled) {
        stopCreditsPreview('Enable credits to preview.');
        return;
      }
      if (!creditsConfigValid()) {
        stopCreditsPreview('Complete the credits setup to preview.');
        return;
      }
      const config = getCreditsExportConfig();
      if (!config) {
        stopCreditsPreview('Unable to build credits preview.');
        return;
      }
      const preset = getSelectedPreset();
      const previewWidth = creditsPreviewCanvas.width;
      const previewHeight = creditsPreviewCanvas.height;
      const token = ++creditsPreviewToken;
      if (creditsPreviewStatus) creditsPreviewStatus.textContent = 'Preparing preview...';
      try {
        const renderWidth = preset?.width || STAGE_WIDTH;
        const renderHeight = preset?.height || STAGE_HEIGHT;
        creditsPreviewState = await prepareCreditsRenderState(config, {
          width: renderWidth,
          height: renderHeight,
          presetWidth: renderWidth,
          presetHeight: renderHeight,
          mode: 'preview'
        });
        if (!creditsPreviewState || token !== creditsPreviewToken) return;
        creditsPreviewDurationMs = Math.max(1000, creditsPreviewState.durationMs || state.credits.durationSec * 1000);
        creditsPreviewBufferCanvas = document.createElement('canvas');
        creditsPreviewBufferCanvas.width = creditsPreviewState.width;
        creditsPreviewBufferCanvas.height = creditsPreviewState.height;
        creditsPreviewBufferCtx = creditsPreviewBufferCanvas.getContext('2d');
        if (creditsPreviewAudio) {
          try { creditsPreviewAudio.pause(); } catch {}
        }
        creditsPreviewAudio = null;
        creditsPreviewAudioBaseVolume = 1;
        creditsPreviewAudioFadeInMs = 0;
        creditsPreviewAudioFadeOutMs = 0;
        if (config.audio?.path) {
          try {
            creditsPreviewAudio = new Audio(fileUrl(config.audio.path));
            creditsPreviewAudio.preload = 'auto';
            creditsPreviewAudio.loop = false;
            creditsPreviewAudioBaseVolume = clamp01(config.audio.volume ?? 1);
            creditsPreviewAudioFadeInMs = Math.max(0, Math.round((config.audio.fadeInSec || 0) * 1000));
            creditsPreviewAudioFadeOutMs = Math.max(0, Math.round((config.audio.fadeOutSec || 0) * 1000));
            creditsPreviewAudio.currentTime = 0;
            creditsPreviewAudio.volume = 0;
            creditsPreviewAudio.play().catch((err) => {
              console.warn('credits preview audio play failed', err);
              creditsPreviewAudio = null;
            });
          } catch (err) {
            console.warn('credits preview audio error', err);
            creditsPreviewAudio = null;
          }
        }
        creditsPreviewPlaying = true;
        creditsPreviewStartTs = performance.now();
        const loop = (ts) => {
          if (!creditsPreviewPlaying || token !== creditsPreviewToken) return;
          const elapsed = ts - creditsPreviewStartTs;
          const clamped = Math.min(elapsed, creditsPreviewDurationMs);
          if (creditsPreviewBufferCtx) {
            drawCreditsFrame(creditsPreviewBufferCtx, creditsPreviewState, clamped);
          }
          if (creditsPreviewAudio) {
            let audioVolume = creditsPreviewAudioBaseVolume;
            if (creditsPreviewAudioFadeInMs > 0 && clamped < creditsPreviewAudioFadeInMs) {
              audioVolume *= clamp01(clamped / creditsPreviewAudioFadeInMs);
            }
            if (creditsPreviewAudioFadeOutMs > 0 && creditsPreviewDurationMs > 0) {
              const remaining = Math.max(0, creditsPreviewDurationMs - clamped);
              if (remaining < creditsPreviewAudioFadeOutMs) {
                audioVolume *= clamp01(remaining / creditsPreviewAudioFadeOutMs);
              }
            }
            try {
              creditsPreviewAudio.volume = clamp01(audioVolume);
            } catch {}
          }
          creditsPreviewCtx.save();
          creditsPreviewCtx.clearRect(0, 0, previewWidth, previewHeight);
          const grad = creditsPreviewCtx.createLinearGradient(0, 0, previewWidth, previewHeight);
          grad.addColorStop(0, '#1b2433');
          grad.addColorStop(1, '#0d1117');
          creditsPreviewCtx.fillStyle = grad;
          creditsPreviewCtx.fillRect(0, 0, previewWidth, previewHeight);
          if (creditsPreviewBufferCanvas) {
            const scale = Math.min(previewWidth / creditsPreviewState.width, previewHeight / creditsPreviewState.height);
            const drawW = creditsPreviewState.width * scale;
            const drawH = creditsPreviewState.height * scale;
            const offsetX = (previewWidth - drawW) / 2;
            const offsetY = (previewHeight - drawH) / 2;
            creditsPreviewCtx.drawImage(creditsPreviewBufferCanvas, offsetX, offsetY, drawW, drawH);
          }
          creditsPreviewCtx.restore();
          if (creditsPreviewStatus) {
            creditsPreviewStatus.textContent = `Previewing ${Math.min(clamped / 1000, creditsPreviewDurationMs / 1000).toFixed(1)}s / ${(creditsPreviewDurationMs / 1000).toFixed(1)}s`;
          }
          if (elapsed >= creditsPreviewDurationMs) {
            creditsPreviewPlaying = false;
            creditsPreviewState = null;
            creditsPreviewFrame = null;
             if (creditsPreviewAudio) {
               try { creditsPreviewAudio.pause(); } catch {}
               creditsPreviewAudio = null;
             }
            if (creditsPreviewStatus) creditsPreviewStatus.textContent = 'Preview complete';
            return;
          }
          creditsPreviewFrame = requestAnimationFrame(loop);
        };
        resetCreditsPreviewCanvas('');
        creditsPreviewFrame = requestAnimationFrame(loop);
      } catch (err) {
        console.error('credits preview failed', err);
        stopCreditsPreview('Preview failed.');
      }
    };

    const syncCreditsControls = () => {
      const enabled = !!state.credits.enabled;
      creditsOptionRadios.forEach((radio) => {
        radio.checked = enabled ? radio.value === 'scroll' : radio.value === 'none';
      });
      if (creditsConfigWrap) creditsConfigWrap.style.display = enabled ? '' : 'none';
      if (creditsTextArea && creditsTextArea.value !== (state.credits.text || '')) {
        creditsTextArea.value = state.credits.text || '';
      }
      if (creditsDirectionSelect) {
        const dir = state.credits.direction === 'down' ? 'down' : 'up';
        creditsDirectionSelect.value = dir;
        state.credits.direction = dir;
      }
      if (creditsDurationInput) {
        creditsDurationInput.value = String(clampCreditsDuration(state.credits.durationSec));
      }
      if (creditsIntervalInput) {
        creditsIntervalInput.value = String(clampCreditsInterval(state.credits.imageIntervalSec));
      }
      if (creditsBlurCheckbox) {
        creditsBlurCheckbox.checked = !!state.credits.blurBackground;
      }
      if (creditsCrossfadeCheckbox) {
        creditsCrossfadeCheckbox.checked = !!state.credits.backgroundCrossfade;
      }
      if (creditsCrossfadeInput) {
        creditsCrossfadeInput.value = String(clampCreditsFadeSec(state.credits.backgroundCrossfadeSec ?? 1));
      }
      if (creditsCrossfadeSettings) {
        creditsCrossfadeSettings.style.display = state.credits.backgroundCrossfade ? '' : 'none';
      }
      const source = state.credits.backgroundSource === 'frames' ? 'frames' : 'assets';
      state.credits.backgroundSource = source;
      creditsBgSourceRadios.forEach((radio) => {
        radio.checked = radio.value === source;
      });
      if (creditsAssetsWrap) creditsAssetsWrap.style.display = source === 'assets' ? '' : 'none';
      if (creditsFramesWrap) creditsFramesWrap.style.display = source === 'frames' ? '' : 'none';
      populateCreditsAssetSelect();
      renderCreditsFrameList();
      const audioEnabled = state.credits.audioOption === 'asset';
      creditsAudioOptionRadios.forEach((radio) => {
        radio.checked = audioEnabled ? radio.value === 'asset' : radio.value === 'none';
      });
      if (creditsAudioConfigWrap) creditsAudioConfigWrap.style.display = audioEnabled ? '' : 'none';
      if (audioEnabled) {
        if (!creditsAudioOptions.length) loadCreditsAudioAssets();
        populateCreditsAudioSelect();
      }
      if (creditsAudioVolumeSlider) {
        creditsAudioVolumeSlider.value = String(Math.round(clamp01(state.credits.audioVolume ?? 1) * 100));
      }
      updateCreditsAudioVolumeLabel();
      if (creditsAudioFadeInInput) {
        creditsAudioFadeInInput.value = String(clampCreditsFadeSec(state.credits.audioFadeInSec ?? 0));
      }
      if (creditsAudioFadeOutInput) {
        creditsAudioFadeOutInput.value = String(clampCreditsFadeSec(state.credits.audioFadeOutSec ?? 0));
      }
      if (!enabled) {
        resetCreditsPreviewCanvas('Credits disabled');
        if (creditsPreviewStatus) creditsPreviewStatus.textContent = '';
      } else if (!creditsPreviewPlaying) {
        resetCreditsPreviewCanvas('Preview credits');
      }
    };

    watermarkOptionRadios.forEach((radio) => {
      if (radio.value === state.watermarkOption) radio.checked = true;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.watermarkOption = radio.value;
        if (state.watermarkOption === 'image') loadWatermarkAssets();
        syncWatermarkControls();
        renderWatermarkPreview();
        updateControls();
      });
    });

    if (watermarkEditBtn) {
      watermarkEditBtn.addEventListener('click', async () => {
        try {
          const initial = {
            content: state.watermarkText?.content || '',
            style: JSON.parse(JSON.stringify(state.watermarkText?.style || {}))
          };
          const res = await showTextDialog(initial);
          if (!res) return;
          state.watermarkText = {
            content: res.content,
            style: hydrateTextStyle(res.style)
          };
          syncWatermarkControls();
          renderWatermarkPreview();
          updateControls();
        } catch (err) {
          console.error('watermark text dialog failed', err);
        }
      });
    }

    if (watermarkImageSelect) {
      watermarkImageSelect.addEventListener('change', () => {
        const value = watermarkImageSelect.value || '';
        state.watermarkImagePath = value || null;
        const selected = watermarkImageSelect.selectedOptions && watermarkImageSelect.selectedOptions[0];
        state.watermarkImageName = selected ? selected.textContent : '';
        renderWatermarkPreview();
        updateControls();
      });
    }

    if (watermarkRefreshBtn) {
      watermarkRefreshBtn.addEventListener('click', () => {
        loadWatermarkAssets(true);
      });
    }

    if (watermarkPositionSelect) {
      watermarkPositionSelect.addEventListener('change', () => {
        const value = watermarkPositionSelect.value;
        if (WATERMARK_POSITION_OPTIONS.includes(value)) {
          state.watermarkPosition = value;
          renderWatermarkPreview();
        }
      });
    }

    if (watermarkSizeSlider) {
      watermarkSizeSlider.addEventListener('input', () => {
        const value = Number(watermarkSizeSlider.value) / 100;
        state.watermarkSize = clamp(value, 0.05, 0.6);
        updateWatermarkSizeLabel();
        renderWatermarkPreview();
      });
    }

    if (watermarkOpacitySlider) {
      watermarkOpacitySlider.addEventListener('input', () => {
        const value = Number(watermarkOpacitySlider.value) / 100;
        state.watermarkOpacity = clamp01(value);
        updateWatermarkOpacityLabel();
        renderWatermarkPreview();
      });
    }

    creditsOptionRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const enabled = radio.value === 'scroll';
        if (state.credits.enabled !== enabled) {
          state.credits.enabled = enabled;
          if (enabled && state.credits.backgroundSource === 'assets') {
            loadCreditsAssets();
          }
          if (enabled && state.credits.audioOption === 'asset') {
            loadCreditsAudioAssets();
          }
        }
        syncCreditsControls();
        updateControls();
      });
    });

    creditsAudioOptionRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const option = radio.value === 'asset' ? 'asset' : 'none';
        if (state.credits.audioOption !== option) {
          state.credits.audioOption = option;
          if (option === 'none') {
            state.credits.audioPath = null;
            state.credits.audioName = '';
          } else if (!creditsAudioOptions.length) {
            loadCreditsAudioAssets();
          }
        }
        syncCreditsControls();
        updateControls();
      });
    });

    if (creditsAudioSelect) {
      creditsAudioSelect.addEventListener('change', () => {
        const value = creditsAudioSelect.value || '';
        state.credits.audioPath = value || null;
        const selected = creditsAudioSelect.selectedOptions && creditsAudioSelect.selectedOptions[0];
        state.credits.audioName = selected ? selected.textContent : '';
        updateControls();
      });
    }

    if (creditsRefreshAudioBtn) {
      creditsRefreshAudioBtn.addEventListener('click', () => {
        loadCreditsAudioAssets(true);
      });
    }

    if (creditsAudioVolumeSlider) {
      creditsAudioVolumeSlider.addEventListener('input', () => {
        const value = Number(creditsAudioVolumeSlider.value);
        state.credits.audioVolume = clamp01(Number.isFinite(value) ? value / 100 : 1);
        updateCreditsAudioVolumeLabel();
      });
    }

    if (creditsAudioFadeInInput) {
      creditsAudioFadeInInput.addEventListener('input', () => {
        state.credits.audioFadeInSec = clampCreditsFadeSec(creditsAudioFadeInInput.value);
        creditsAudioFadeInInput.value = String(state.credits.audioFadeInSec);
      });
    }

    if (creditsAudioFadeOutInput) {
      creditsAudioFadeOutInput.addEventListener('input', () => {
        state.credits.audioFadeOutSec = clampCreditsFadeSec(creditsAudioFadeOutInput.value);
        creditsAudioFadeOutInput.value = String(state.credits.audioFadeOutSec);
      });
    }

    if (creditsTextArea) {
      creditsTextArea.value = state.credits.text || '';
      creditsTextArea.addEventListener('input', () => {
        state.credits.text = creditsTextArea.value;
        updateControls();
      });
    }

    if (creditsEditBtn) {
      creditsEditBtn.addEventListener('click', async () => {
        try {
          const res = await showTextDialog({
            content: state.credits.text || '',
            style: JSON.parse(JSON.stringify(state.credits.style || {}))
          });
          if (!res) return;
          state.credits.text = res.content;
          state.credits.style = hydrateTextStyle(res.style);
          if (creditsTextArea) creditsTextArea.value = state.credits.text;
          updateControls();
        } catch (err) {
          console.error('credits text dialog failed', err);
        }
      });
    }

    if (creditsDirectionSelect) {
      creditsDirectionSelect.addEventListener('change', () => {
        state.credits.direction = creditsDirectionSelect.value === 'down' ? 'down' : 'up';
      });
    }

    if (creditsDurationInput) {
      creditsDurationInput.value = String(clampCreditsDuration(state.credits.durationSec));
      creditsDurationInput.addEventListener('input', () => {
        const clamped = clampCreditsDuration(creditsDurationInput.value);
        state.credits.durationSec = clamped;
        creditsDurationInput.value = String(clamped);
        updateControls();
      });
    }

    if (creditsIntervalInput) {
      creditsIntervalInput.value = String(clampCreditsInterval(state.credits.imageIntervalSec));
      creditsIntervalInput.addEventListener('input', () => {
        const clamped = clampCreditsInterval(creditsIntervalInput.value);
        state.credits.imageIntervalSec = clamped;
        creditsIntervalInput.value = String(clamped);
      });
    }

    if (creditsBlurCheckbox) {
      creditsBlurCheckbox.checked = !!state.credits.blurBackground;
      creditsBlurCheckbox.addEventListener('change', () => {
        state.credits.blurBackground = !!creditsBlurCheckbox.checked;
      });
    }

    if (creditsCrossfadeCheckbox) {
      creditsCrossfadeCheckbox.addEventListener('change', () => {
        state.credits.backgroundCrossfade = !!creditsCrossfadeCheckbox.checked;
        syncCreditsControls();
      });
    }

    if (creditsCrossfadeInput) {
      creditsCrossfadeInput.addEventListener('input', () => {
        const clamped = clampCreditsFadeSec(creditsCrossfadeInput.value);
        state.credits.backgroundCrossfadeSec = clamped;
        creditsCrossfadeInput.value = String(clamped);
      });
    }

    creditsBgSourceRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        const source = radio.value === 'frames' ? 'frames' : 'assets';
        if (state.credits.backgroundSource !== source) {
          state.credits.backgroundSource = source;
          if (source === 'assets') {
            loadCreditsAssets();
          }
        }
        syncCreditsControls();
        updateControls();
      });
    });

    if (creditsAssetSelect) {
      creditsAssetSelect.addEventListener('change', () => {
        const selected = Array.from(creditsAssetSelect.selectedOptions || []).map(opt => opt.value).filter(Boolean);
        state.credits.assetPaths = selected;
        updateControls();
      });
    }

    if (creditsRefreshAssetsBtn) {
      creditsRefreshAssetsBtn.addEventListener('click', () => {
        loadCreditsAssets(true);
      });
    }

    if (creditsAddFrameInputBtn && creditsFrameInput) {
      creditsAddFrameInputBtn.addEventListener('click', () => {
        const seconds = Number(creditsFrameInput.value);
        if (!Number.isFinite(seconds)) return;
        if (addCreditsFrameTime(seconds * 1000)) {
          creditsFrameInput.value = '';
          renderCreditsFrameList();
          updateControls();
        }
      });
    }

    if (creditsAddFrameCurrentBtn) {
      creditsAddFrameCurrentBtn.addEventListener('click', () => {
        startFramePicker();
      });
    }

    if (creditsFrameList) {
      creditsFrameList.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const idxRaw = target.dataset.index;
        if (idxRaw == null) return;
        const idx = Number(idxRaw);
        if (!Number.isInteger(idx)) return;
        if (!Array.isArray(state.credits.frameTimesMs)) return;
        if (idx < 0 || idx >= state.credits.frameTimesMs.length) return;
        state.credits.frameTimesMs.splice(idx, 1);
        renderCreditsFrameList();
        updateControls();
      });
    }

    if (creditsPreviewBtn) {
      creditsPreviewBtn.addEventListener('click', () => {
        playCreditsPreview();
      });
    }

    if (state.watermarkOption === 'image') loadWatermarkAssets();
    syncWatermarkControls();
    renderWatermarkPreview();

    const renderPresetList = () => {
      presetList.innerHTML = '';
      EXPORT_PRESETS.forEach((preset, idx) => {
        const row = document.createElement('label');
        row.className = 'export-preset';
        row.innerHTML = `
          <input type="radio" name="export-preset" value="${preset.id}" ${state.selectedPresetId === preset.id || (!state.selectedPresetId && idx === 0) ? 'checked' : ''}>
          <div class="export-preset-info">
            <div class="export-preset-name">${preset.label}</div>
            <div class="export-preset-desc">${preset.description}</div>
          </div>
        `;
        const input = row.querySelector('input');
        input.addEventListener('change', () => {
          if (input.checked) {
            state.selectedPresetId = input.value;
            updateControls();
          }
        });
        presetList.appendChild(row);
      });
      if (!state.selectedPresetId && EXPORT_PRESETS.length) {
        state.selectedPresetId = EXPORT_PRESETS[0].id;
      }
    };

    const renderColorInputs = () => {
      if (!colorList) return;
      colorList.innerHTML = '';
      if (!uniqueCharacters.length) {
        const empty = document.createElement('div');
        empty.className = 'subtitle-color-empty';
        empty.textContent = 'No character names were found for TTS clips in this export.';
        colorList.appendChild(empty);
        return;
      }
      uniqueCharacters.forEach((name) => {
        const key = subtitleCharacterKey(name);
        if (!key) return;
        if (!state.subtitleColors[key]) {
          state.subtitleColors[key] = subtitleColorForCharacter(name, state.subtitleColors);
        }
        const row = document.createElement('div');
        row.className = 'subtitle-color-row';
        const label = document.createElement('div');
        label.className = 'subtitle-color-name';
        label.textContent = name;
        const pickerWrap = document.createElement('div');
        pickerWrap.className = 'subtitle-color-picker';
        const input = document.createElement('input');
        input.type = 'color';
        input.value = state.subtitleColors[key];
        const applyColorValue = () => {
          const normalized = normalizeSubtitleColor(input.value);
          if (normalized) {
            state.subtitleColors[key] = normalized;
          }
        };
        const handlePickerClose = () => {
          showOverlayAfterColorPicker();
        };
        input.addEventListener('pointerdown', (ev) => {
          colorPickerAnchor = { x: ev.clientX, y: ev.clientY };
          activePickerInput = input;
        }, { capture: true });
        input.addEventListener('pointerup', (ev) => {
          if (!colorPickerAnchor) {
            colorPickerAnchor = { x: ev.clientX, y: ev.clientY };
          }
          setTimeout(() => hideOverlayForColorPicker(), 0);
        });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === ' ' || ev.key === 'Enter') {
            colorPickerAnchor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
            setTimeout(() => hideOverlayForColorPicker(), 0);
          }
        });
        input.addEventListener('input', applyColorValue);
        input.addEventListener('change', () => {
          applyColorValue();
          handlePickerClose();
        });
        input.addEventListener('blur', handlePickerClose);
        input.addEventListener('cancel', handlePickerClose);
        pickerWrap.appendChild(input);
        row.append(label, pickerWrap);
        colorList.appendChild(row);
      });
    };

    const showStep = (step) => {
      const previous = state.step;
      if (previous === 'credits' && step !== 'credits') {
        stopCreditsPreview();
      }
      state.step = step;
      stepPreset.style.display = step === 'preset' ? '' : 'none';
      stepSubtitles.style.display = step === 'subtitles' ? '' : 'none';
      stepColors.style.display = step === 'colors' ? '' : 'none';
      stepWatermark.style.display = step === 'watermark' ? '' : 'none';
      stepCredits.style.display = step === 'credits' ? '' : 'none';
      backBtn.style.display = step === 'preset' ? 'none' : '';
      updateControls();
      if (step === 'colors') {
        renderColorInputs();
      } else if (step === 'watermark') {
        syncWatermarkControls();
        if (state.watermarkOption === 'image') loadWatermarkAssets();
        renderWatermarkPreview();
      } else if (step === 'credits') {
        if (state.credits.backgroundSource === 'assets') loadCreditsAssets();
        syncCreditsControls();
      }
    };

    const formatNeedsSelection = () => state.subtitleOption === 'srt' || state.subtitleOption === 'burn' || state.subtitleOption === 'ass';

    const updateControls = () => {
      const preset = getSelectedPreset();
      const eligible = subtitleEligible();
      let disabled = !preset;

      if (state.step === 'credits') {
        primaryBtn.textContent = 'Export';
        if (!creditsConfigValid()) disabled = true;
      } else if (state.step === 'watermark') {
        primaryBtn.textContent = 'Next';
        if (!watermarkConfigValid()) disabled = true;
      } else {
        primaryBtn.textContent = 'Next';
      }

      primaryBtn.disabled = disabled;

    if (subtitleFormatSection) {
      subtitleFormatSection.style.display = formatNeedsSelection() ? '' : 'none';
    }

    if (subtitleOutlineSection) {
      const showOutline = state.subtitleOption === 'burn';
      subtitleOutlineSection.style.display = showOutline ? '' : 'none';
      if (showOutline) {
        subtitleOutlineRadios.forEach((radio) => {
          radio.checked = radio.value === state.subtitleOutline;
        });
      }
    }

    if (assFormatWarning) {
      const warn = state.hasAssEffects && state.subtitleOption !== 'ass' && state.subtitleOption !== 'none';
      assFormatWarning.style.display = warn ? '' : 'none';
    }

    // Hide subtitle step entirely if preset changes to non-eligible while on subtitles/colors.
    if (!eligible && state.step === 'subtitles') {
      showStep('watermark');
    }
    };

    const finish = (result) => {
      showOverlayAfterColorPicker();
      stopFramePicker();
      stopCreditsPreview();
      overlay.remove();
      resolve(result);
    };

    const finalizeConfig = () => {
      const preset = getSelectedPreset();
      if (!preset) return;
      const subtitleOption = state.subtitleOption;
      const subtitleFormat = state.subtitleFormat;
      const colors = subtitleOption === 'burn' ? saveSubtitleColorPrefs(state.subtitleColors) : {};
      const watermark = getWatermarkExportConfig();
      const credits = getCreditsExportConfig();
      finish({
        preset,
        subtitleOption,
        subtitleFormat,
        subtitleColors: colors,
        subtitleOutline: state.subtitleOutline,
        watermark,
        credits
      });
    };

    backBtn.addEventListener('click', () => {
      if (state.step === 'credits') {
        showStep('watermark');
      } else if (state.step === 'watermark') {
        if (state.subtitleOption === 'burn' && uniqueCharacters.length) {
          showStep('colors');
        } else if (subtitleEligible()) {
          showStep('subtitles');
        } else {
          showStep('preset');
        }
      } else if (state.step === 'colors') {
        showStep('subtitles');
      } else if (state.step === 'subtitles') {
        showStep('preset');
      }
    });

    cancelBtn.addEventListener('click', () => finish(null));

    primaryBtn.addEventListener('click', () => {
      const preset = getSelectedPreset();
      if (!preset) return;
      if (state.step === 'preset') {
        if (subtitleEligible()) {
          showStep('subtitles');
        } else {
          showStep('watermark');
        }
        return;
      }
      if (state.step === 'subtitles') {
        if (state.subtitleOption === 'burn' && uniqueCharacters.length) {
          showStep('colors');
          return;
        }
        showStep('watermark');
        return;
      }
      if (state.step === 'colors') {
        showStep('watermark');
        return;
      }
      if (state.step === 'watermark') {
        showStep('credits');
        return;
      }
      if (state.step === 'credits') {
        finalizeConfig();
      }
    });

    subtitleOptionRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.subtitleOption = radio.value;
        updateControls();
      });
    });

    subtitleFormatRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.subtitleFormat = radio.value;
      });
    });

    subtitleOutlineRadios.forEach((radio) => {
      radio.checked = radio.value === state.subtitleOutline;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        if (radio.value === 'white') state.subtitleOutline = 'white';
        else if (radio.value === 'none') state.subtitleOutline = 'none';
        else state.subtitleOutline = 'black';
      });
    });

    const closeOnEsc = (ev) => {
      if (ev.key === 'Escape') {
        document.removeEventListener('keydown', closeOnEsc);
        finish(null);
      }
    };
    document.addEventListener('keydown', closeOnEsc, { once: true });

    renderPresetList();
    showStep('preset');
    updateControls();
  });
}


function yieldForExportTick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return Promise.resolve();
  }
  if (typeof requestAnimationFrame === 'function') {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }
  return Promise.resolve();
}

async function exportVideoPreset(config) {
  if (!window.suAPI?.exportProject) { alert('Video export is not available in this build.'); return; }

  const preset = (config && config.preset) || config;
  if (!preset) { alert('No export preset selected.'); return; }

  const subtitleOptionRaw = (config && config.subtitleOption) || 'none';
  const subtitleFormat = (config && config.subtitleFormat) || SUBTITLE_TEXT_FORMATS.CHARACTER_DIALOGUE;
  const subtitleColorsRaw = (config && config.subtitleColors) || {};
  const subtitleOutlineRaw = (config && config.subtitleOutline) || 'black';
  const watermarkConfigRaw = (config && config.watermark) || null;
  const creditsConfigRaw = (config && config.credits) || null;

  let subtitleEntries = [];
  let effectiveSubtitleOption = subtitleOptionRaw;
  if (subtitleOptionRaw !== 'none') {
    subtitleEntries = buildSubtitleEntries({ format: subtitleFormat });
    if (!subtitleEntries.length) {
      console.warn('No subtitle entries found; continuing without subtitles.');
      effectiveSubtitleOption = 'none';
    }
  }
  await ensureSubtitlePreviewSync();

  const normalizedSubtitleColors = {};
  const subtitleOutline = subtitleOutlineRaw === 'white' ? 'white' : (subtitleOutlineRaw === 'none' ? 'none' : 'black');
  if (effectiveSubtitleOption === 'burn') {
    Object.entries(subtitleColorsRaw || {}).forEach(([key, value]) => {
      const normalized = normalizeSubtitleColor(value);
      if (normalized) normalizedSubtitleColors[key] = normalized;
    });
  }

  const burnSubtitleState = effectiveSubtitleOption === 'burn' && subtitleEntries.length ? {
    mode: 'burn',
    entries: subtitleEntries,
    colors: normalizedSubtitleColors,
    outline: subtitleOutline
  } : null;

  let subtitlesPayload = null;
  if (effectiveSubtitleOption === 'srt' && subtitleEntries.length) {
    const srtContent = buildSrtContent(subtitleEntries);
    if (srtContent) {
      subtitlesPayload = { mode: 'srt', format: subtitleFormat, content: srtContent };
    } else {
      effectiveSubtitleOption = 'none';
    }
  } else if (effectiveSubtitleOption === 'ass' && subtitleEntries.length) {
    const assContent = buildAssContent(subtitleEntries, { width: preset.width, height: preset.height });
    if (assContent) {
      subtitlesPayload = { mode: 'ass', format: subtitleFormat, content: assContent };
    } else {
      effectiveSubtitleOption = 'none';
    }
  } else if (effectiveSubtitleOption === 'burn' && subtitleEntries.length) {
    subtitlesPayload = { mode: 'burn', format: subtitleFormat, colors: normalizedSubtitleColors, outline: subtitleOutline };
  }

  const frameRate = preset.frameRate || FRAME_RATE;
  const frameDuration = 1000 / frameRate;

  // Round project end UP to the next frame and render frames 0..end-?.
  const hardEndMs  = Math.ceil(projectEndMs() / frameDuration) * frameDuration;
  const frameCount = Math.max(1, Math.floor(hardEndMs / frameDuration));

  const wasPlaying = playing;
  const prevTime = currentTime;
  if (wasPlaying) pause();

  let progress = null;
  let exportId = null;
  try {
    const prepare = await window.suAPI.exportProject({
      action: 'prepare',
      preset,
      frameRate,
      width: preset.width,
      height: preset.height,
      projectPath: currentProjectPath
    });
    if (!prepare || prepare.canceled) return;
    if (!prepare.ok) throw new Error(prepare.error || 'Unknown error');

    exportId = prepare.exportId;
    progress = showExportProgress('Preparing export...');
    const encoderId = prepare.hwEncoder || null;
    const encoderLabel = prepare.hwEncoderLabel || (encoderId ? encoderId.toUpperCase() : null);
    if (progress && typeof progress.setMeta === 'function') {
      progress.setMeta(encoderLabel ? `Encoder: ${encoderLabel}` : 'Encoder: Software (libx264)');
    }
    console.info('[Export] Encoder:', encoderLabel ? `${encoderLabel} (hardware)` : 'libx264 (software)'); 

    const watermarkState = await buildWatermarkRenderState(watermarkConfigRaw);
    const creditsState = creditsConfigRaw ? await prepareCreditsRenderState(creditsConfigRaw, {
      width: preset.width,
      height: preset.height,
      presetWidth: preset.width,
      presetHeight: preset.height,
      mode: 'export'
    }) : null;

    const canvas = document.createElement('canvas');
    canvas.width = preset.width;
    canvas.height = preset.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;

    const baseFrameCount = frameCount;
    let creditsDurationMs = creditsState ? Math.max(1000, Math.round(creditsState.durationMs || 0)) : 0;
    let creditsFrameCount = creditsState && creditsDurationMs > 0 ? Math.max(1, Math.ceil(creditsDurationMs / frameDuration)) : 0;
    if (!creditsState || creditsFrameCount <= 0) {
      creditsDurationMs = 0;
      creditsFrameCount = 0;
    }
    const totalFrameCount = baseFrameCount + creditsFrameCount;

    for (let frameIndex = 0; frameIndex < totalFrameCount; frameIndex++) {
      if (frameIndex < baseFrameCount) {
        const timeMs = frameIndex * frameDuration; // exact frame times: 0, ?, 2?, ...
        await renderFrameToCanvas(ctx, preset, timeMs, { subtitles: burnSubtitleState, watermark: watermarkState });
        const dataUrl = canvas.toDataURL('image/png');
        const res = await window.suAPI.exportProject({ action: 'frame', exportId, index: frameIndex, dataUrl });
        if (!res?.ok) throw new Error(res?.error || 'Failed to write frame');
      } else {
        const creditsFrameIndex = frameIndex - baseFrameCount;
        const creditTimeMs = Math.min(creditsDurationMs, creditsFrameIndex * frameDuration);
        drawCreditsFrame(ctx, creditsState, creditTimeMs);
        if (watermarkState) {
          drawWatermarkOnCanvas(ctx, preset.width, preset.height, watermarkState);
        }
        const dataUrl = canvas.toDataURL('image/png');
        const res = await window.suAPI.exportProject({ action: 'frame', exportId, index: frameIndex, dataUrl });
        if (!res?.ok) throw new Error(res?.error || 'Failed to write frame');
      }
      progress.update(frameIndex + 1, totalFrameCount);
      if (frameIndex % 10 === 0) await yieldForExportTick();
    }

    const audioClips = PROJECT.audio.map(a => {
      const start = Math.round(a.start || 0);
      const end = Math.round(a.end || 0);
      const durationMs = Math.max(0, end - start);
      return {
        path: a.path,
        start,
        end,
        durationMs,
        volume: a.volume ?? 1,
        muted: !!a.muted,
        fadeInSec: a.fadeInSec ?? 0,
        fadeOutSec: a.fadeOutSec ?? 0,
        crossfadePrevMs: Math.round(a.crossfadePrevMs || 0),
        crossfadeNextMs: Math.round(a.crossfadeNextMs || 0),
        playbackRate: a.playbackRate ?? 1,
        mediaOffsetMs: Math.round(a.mediaOffset || 0),
        reversed: !!a.reversed,
        effects: JSON.parse(JSON.stringify(a.effects || null))
      };
    });

    if (creditsState && creditsDurationMs > 0 && creditsConfigRaw?.audio?.path) {
      const baseDurationMs = Math.round(baseFrameCount * frameDuration);
      const clipDurationMs = Math.max(1, Math.round(creditsDurationMs));
      const audioConfig = creditsConfigRaw.audio;
      const fadeInSec = Math.min(clampCreditsFadeSec(audioConfig.fadeInSec ?? 0), clipDurationMs / 1000);
      const fadeOutSec = Math.min(clampCreditsFadeSec(audioConfig.fadeOutSec ?? 0), clipDurationMs / 1000);
      audioClips.push({
        path: audioConfig.path,
        start: baseDurationMs,
        end: baseDurationMs + clipDurationMs,
        durationMs: clipDurationMs,
        volume: clamp01(audioConfig.volume ?? 1),
        muted: false,
        fadeInSec,
        fadeOutSec,
        crossfadePrevMs: 0,
        crossfadeNextMs: 0,
        playbackRate: 1,
        mediaOffsetMs: 0,
        reversed: false,
        effects: null
      });
    }

    progress.update('Finalizing export...');
    const finalize = await window.suAPI.exportProject({ action: 'finalize', exportId, frameRate, preset, audioClips, subtitles: subtitlesPayload });
    if (!finalize?.ok) throw new Error(finalize?.error || 'Finalization failed');
    const outputPath = (finalize && finalize.path) || prepare.path || '';
    let message = outputPath ? `Exported to: ${outputPath}` : 'Export completed.';
    if (finalize?.subtitles?.path) {
      const modeLabel = finalize.subtitles.mode === 'ass' ? 'ASS' : 'SRT';
      message += `\n${modeLabel} subtitles saved to: ${finalize.subtitles.path}`;
    }
    alert(message);
    // Consider export as completion; backup not needed
    clearAutosave();
  } catch (error) {
    console.error('exportVideoPreset error', error);
    if (exportId) {
      try { await window.suAPI.exportProject({ action: 'abort', exportId }); } catch {}
    }
    alert(`Export failed: ${error?.message || error}`);
  } finally {
    progress?.close();
    clearExportVideoCache();
    currentTime = prevTime;
    if (wasPlaying) {
      play();
    } else {
      drawPlayhead();
      refreshStageVisibility();
      renderActiveGifs();
      applyBackgroundForTime(currentTime);
    }
  }
}


function pickGifFrameAt(item, tMs) {
  const g = item._gif;
  if (!g || !Array.isArray(g.frames) || !g.frames.length) return null;
  const T = g.totalDur || 1000;

  let local = 0;
  if (item.loopMode === 'once') {
    local = Math.min(tMs - item.start, T - 1);
    if (local < 0) local = 0;
  } else if (item.loopMode === 'count' && Number.isInteger(item.loopCount) && item.loopCount > 0) {
    const maxMs = T * item.loopCount;
    const into = Math.max(0, tMs - item.start);
    local = Math.min(into, maxMs - 1);
    // after last loop, hold last frame
    if (local >= maxMs - 1) local = T - 1;
    else local = local % T;
  } else {
    // infinite
    const into = Math.max(0, tMs - item.start);
    local = into % T;
  }

  // frames[].at is cumulative start time
  const frames = g.frames;
  // binary search is overkill; linear is fine for small GIFs
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (local >= f.at) return f;
  }
  return frames[0];
}


async function renderFrameToCanvas(ctx, preset, timeMs, options = null) {
  let subtitleState = null;
  let watermarkState = null;
  if (options && typeof options === 'object' && !Array.isArray(options) && (options.subtitles !== undefined || options.watermark !== undefined || options.subtitleState !== undefined)) {
    subtitleState = options.subtitles ?? options.subtitleState ?? null;
    watermarkState = options.watermark ?? null;
  } else {
    subtitleState = options;
  }

  const { width, height } = preset;
  ctx.save();
  const bgSelection = resolveBackgroundSelectionForTime(timeMs, { width, height });
  ctx.fillStyle = bgSelection.stageColor || '#000';
  ctx.fillRect(0, 0, width, height);

  await drawBackgroundClipToCanvas(ctx, bgSelection.prevClip, bgSelection.prevState, width, height);
  await drawBackgroundClipToCanvas(ctx, bgSelection.clip, bgSelection.clipState, width, height);

  const scaleX = width / STAGE_WIDTH;
  const scaleY = height / STAGE_HEIGHT;
  const items = PROJECT.items
    .filter(it => isActiveAt(timeMs, it.start ?? 0, it.end ?? 0, FRAME_RATE))
    .sort((a, b) => (b.trackIndex ?? 0) - (a.trackIndex ?? 0) || (a.start ?? 0) - (b.start ?? 0));

  for (const item of items) {
    hydrateChromaKey(item);
    const pose = getPoseAt(item, timeMs);

    let iw = 1;
    let ih = 1;
    let drawSource = null;
    let gifFrame = null;
    let frameMaskOptions = null;

    if (isVideo(item.path)) {
      const frame = await captureVideoFrameForExport(item, timeMs);
      if (!frame) continue;
      drawSource = frame.canvas;
      iw = frame.width || frame.canvas?.width || 1;
      ih = frame.height || frame.canvas?.height || 1;
      const localMs = resolveVideoLocalMs(item, timeMs);
      frameMaskOptions = { frameKey: maskFrameKeyForVideo(localMs) };
    } else if (isGifPath(item.path) && item._gif && item._gif.frames) {
      gifFrame = pickGifFrameAt(item, timeMs);
      if (gifFrame?.bitmap) {
        const bmp = gifFrame.bitmap;
        iw = bmp.displayWidth || bmp.codedWidth || bmp.width || 1;
        ih = bmp.displayHeight || bmp.codedHeight || bmp.height || 1;
        drawSource = bmp;
        frameMaskOptions = { frameKey: maskFrameKeyForGif(gifFrame.index ?? item._gif.frames.indexOf(gifFrame)) };
      }
    }

    if (!drawSource) {
      const img = await loadImageElement(item.path);
      if (!img) continue;
      iw = img.naturalWidth || img.width || 1;
      ih = img.naturalHeight || img.height || 1;
      drawSource = img;
      item._imageEl = img;
      item._imageReady = true;
      item._imageWidth = iw;
      item._imageHeight = ih;
    }

    if (!drawSource) continue;

    let finalSource = drawSource;
    if (gifFrame && drawSource) {
      const chromaFrame = ensureGifFrameChromaCanvas(item, gifFrame);
      if (chromaFrame) finalSource = chromaFrame;
    } else if (drawSource instanceof HTMLImageElement) {
      item._imageEl = drawSource;
      item._imageReady = true;
      item._imageWidth = iw;
      item._imageHeight = ih;
      const chromaStatic = getStaticChromaCanvas(item, drawSource);
      if (chromaStatic) finalSource = chromaStatic;
    }

    const poseScaleX = Number.isFinite(pose?.scaleX) ? pose.scaleX : Number.isFinite(pose?.scale) ? pose.scale : 1;
    const poseScaleY = Number.isFinite(pose?.scaleY) ? pose.scaleY : Number.isFinite(pose?.scale) ? pose.scale : 1;
    const transitionState = resolveClipTransitionState(item, timeMs, 1, item.end);
    const rotation = Number.isFinite(pose?.rotation) ? pose.rotation : getStageRotation(item);
    const rotationRad = rotation * (Math.PI / 180);

    const effectiveOpacity = clamp01(transitionState.opacity ?? 1);
    if (effectiveOpacity <= 0) continue;
    const clipState = transitionState.clip;
    const clipWidth = clipState && clipState.type === 'wipe-left' ? clamp(clipState.width ?? 0, 0, 1) : 1;
    if (clipWidth <= 0) continue;

    ctx.save();
    ctx.scale(scaleX, scaleY);
    ctx.translate(
      pose.x + (transitionState.translateX || 0),
      pose.y + (transitionState.translateY || 0)
    );
    ctx.rotate(rotationRad);
    ctx.scale(poseScaleX, poseScaleY);
    ctx.translate(-iw / 2, -ih / 2);
    ctx.globalAlpha *= effectiveOpacity;
    if (clipWidth < 0.999) {
      ctx.beginPath();
      ctx.rect(0, 0, iw * clipWidth, ih);
      ctx.clip();
    }
    const maskedSource = ensureMaskedSourceCanvas(item, finalSource, iw, ih, frameMaskOptions);
    if (maskedSource) finalSource = maskedSource;
    ctx.drawImage(finalSource, 0, 0, iw, ih);
    ctx.restore();
  }

  if (watermarkState) {
    drawWatermarkOnCanvas(ctx, width, height, watermarkState);
  }

  if (subtitleState?.mode === 'burn') {
    drawBurnInSubtitles(ctx, preset, timeMs, subtitleState);
  }

  ctx.restore();
}

function loadImageElement(path) {
  if (!path) return Promise.resolve(null);
  if (imageCache.has(path)) return imageCache.get(path);
  const prom = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = fileUrl(path);
  });
  imageCache.set(path, prom);
  return prom;
}

function resolveVideoLocalMs(item, timeMs) {
  if (!item) return 0;
  const start = item.start ?? 0;
  const end = item.end ?? start;
  const baseDuration = Math.max(0, Math.round(item._videoDurationMs || (end - start)));
  const rel = timeMs - start;
  if (baseDuration <= 0) return Math.max(0, rel);
  const loopMode = item.loopMode || (item.loop === false ? 'once' : 'infinite');
  let local = 0;
  if (loopMode === 'infinite') {
    local = ((rel % baseDuration) + baseDuration) % baseDuration;
  } else if (loopMode === 'count') {
    const n = Math.max(1, Math.floor(item.loopCount ?? 1));
    const limit = baseDuration * n;
    const clamped = clamp(rel, 0, limit);
    local = ((clamped % baseDuration) + baseDuration) % baseDuration;
  } else {
    local = clamp(rel, 0, baseDuration);
  }
  return Math.max(0, local);
}

function getExportVideoState(item) {
  if (!item || !item.id) return null;
  let state = exportVideoStateCache.get(item.id);
  if (!state) {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    video.autoplay = false;
    video.loop = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    state = {
      video,
      canvas,
      ctx,
      src: null,
      ready: false,
      durationMs: 0,
      width: 0,
      height: 0,
      readyPromise: null,
      lastSeekSec: null,
      failed: false
    };
    exportVideoStateCache.set(item.id, state);
  }
  return state;
}

function waitForVideoReady(video) {
  if (!video) return Promise.resolve();
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const onLoaded = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onLoaded);
      resolve();
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onLoaded, { once: true });
  });
}

async function ensureExportVideoReady(item) {
  const state = getExportVideoState(item);
  if (!state || !item?.path) return null;
  if (state.failed) return null;
  const desiredSrc = fileUrl(item.path);
  if (state.src !== desiredSrc) {
    state.src = desiredSrc;
    state.ready = false;
    state.failed = false;
    state.readyPromise = null;
    state.lastSeekSec = null;
    try {
      state.video.pause();
    } catch {}
    try {
      state.video.removeAttribute('src');
      state.video.load();
    } catch {}
    state.video.src = desiredSrc;
  }
  if (state.ready && !state.failed) {
    return state;
  }
  if (!state.readyPromise) {
    state.readyPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        state.video.removeEventListener('loadeddata', onLoaded);
        state.video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        state.ready = true;
        state.failed = false;
        state.durationMs = Math.max(0, Math.round((state.video.duration && isFinite(state.video.duration)) ? state.video.duration * 1000 : 0));
        state.width = Math.max(1, Math.round(state.video.videoWidth || state.video.width || 0));
        state.height = Math.max(1, Math.round(state.video.videoHeight || state.video.height || 0));
        if (state.width && state.height) {
          if (state.canvas.width !== state.width) state.canvas.width = state.width;
          if (state.canvas.height !== state.height) state.canvas.height = state.height;
          state.canvas.style.width = state.width + 'px';
          state.canvas.style.height = state.height + 'px';
        }
        resolve(state);
      };
      const onError = (err) => {
        cleanup();
        state.ready = false;
        state.failed = true;
        reject(err || new Error('Video failed to load.'));
      };
      if (state.video.readyState >= 2) {
        onLoaded();
        return;
      }
      state.video.addEventListener('loadeddata', onLoaded, { once: true });
      state.video.addEventListener('error', onError, { once: true });
      try { state.video.load(); } catch {}
    });
  }
  try {
    await state.readyPromise;
  } catch (err) {
    console.warn('export video ready failed', err);
    return null;
  }
  return state.ready ? state : null;
}

function seekVideoToTime(video, targetSec) {
  if (!video) return Promise.resolve();
  if (!Number.isFinite(targetSec)) return Promise.resolve();
  if (Math.abs((video.currentTime || 0) - targetSec) < 0.0005 && !video.seeking) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err || new Error('Video seek failed.'));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    try {
      video.currentTime = targetSec;
    } catch (err) {
      onError(err);
      return;
    }
    if (video.readyState >= 2 && !video.seeking) {
      onSeeked();
      return;
    }
    setTimeout(() => onSeeked(), 500);
  });
}

function waitForVideoSeek(video) {
  if (!video || !video.seeking) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done, { once: true });
  });
}

async function captureVideoFrameForExport(item, timeMs) {
  if (!isVideo(item?.path)) return null;
  const state = await ensureExportVideoReady(item);
  if (!state || state.failed || !state.ctx) return null;
  const video = state.video;
  await waitForVideoReady(video);
  const durationMs = state.durationMs || Math.max(0, Math.round((video.duration && isFinite(video.duration)) ? video.duration * 1000 : 0));
  if (!item._videoDurationMs && durationMs) {
    item._videoDurationMs = durationMs;
  }
  const localMs = resolveVideoLocalMs(item, timeMs);
  const maxDurationMs = durationMs || item._videoDurationMs || 0;
  const clampedMs = maxDurationMs > 0 ? clamp(localMs, 0, maxDurationMs) : Math.max(0, localMs);
  const targetSec = clampedMs / 1000;
  try { video.pause(); } catch {}
  if (video.seeking) {
    await waitForVideoSeek(video);
  }
  if (!Number.isFinite(state.lastSeekSec) || Math.abs(state.lastSeekSec - targetSec) > 0.0005) {
    try {
      await seekVideoToTime(video, targetSec);
    } catch (err) {
      console.warn('export video seek failed', err);
      return null;
    }
    state.lastSeekSec = targetSec;
  }
  await waitForVideoReady(video);
  const width = state.width || Math.max(1, Math.round(video.videoWidth || video.width || 0));
  const height = state.height || Math.max(1, Math.round(video.videoHeight || video.height || 0));
  if (!width || !height) return null;
  if (state.canvas.width !== width) state.canvas.width = width;
  if (state.canvas.height !== height) state.canvas.height = height;
  const ctx = state.ctx;
  ctx.clearRect(0, 0, width, height);
  const fx = hydrateFx(item);
  drawImageWithFx(ctx, video, fx, width, height);
  if (chromaKeyIsActive(item.chromaKey)) {
    let frame;
    try {
      frame = ctx.getImageData(0, 0, width, height);
    } catch (err) {
      console.warn('export video getImageData failed', err);
      frame = null;
    }
    if (frame) {
      applyChromaKeyToImageData(frame, item.chromaKey);
      try { ctx.putImageData(frame, 0, 0); } catch {}
    }
  }
  return { canvas: state.canvas, width, height };
}

function clearExportVideoCache() {
  for (const [id, state] of exportVideoStateCache) {
    if (state?.video) {
      try { state.video.pause(); } catch {}
      try {
        state.video.removeAttribute('src');
        state.video.load();
      } catch {}
    }
    if (state?.canvas && state.canvas.parentElement) {
      state.canvas.parentElement.removeChild(state.canvas);
    }
  }
  exportVideoStateCache.clear();
}

function pushHistory(label='') {
  try {
    const snapshot = snapshotProject();
    pushHistoryWithSnapshot(snapshot, label);
    scheduleAutosave('pushHistory:'+label);
  } catch(e){ console.warn('pushHistory failed', e); }
}
function undo() {
  if (!UNDO.length) return false;
  try {
    const target = UNDO.pop();
    const redoEntry = createHistoryEntry(snapshotProject(), target.label, { direction: 'redo' });
    if (redoEntry) {
      REDO.push(redoEntry);
      if (REDO.length > HISTORY_LIMIT) REDO.shift();
    }
    restoreProject(target.state);
    renderHistoryPanel();
    scheduleAutosave('undo');
    return true;
  } catch (err) {
    console.warn('undo failed', err);
    return false;
  }
}
function redo() {
  if (!REDO.length) return false;
  try {
    const next = REDO.pop();
    const undoEntry = createHistoryEntry(snapshotProject(), next.label, { direction: 'undo' });
    if (undoEntry) {
      UNDO.push(undoEntry);
      if (UNDO.length > HISTORY_LIMIT) UNDO.shift();
    }
    restoreProject(next.state);
    renderHistoryPanel();
    scheduleAutosave('redo');
    return true;
  } catch (err) {
    console.warn('redo failed', err);
    return false;
  }
}


// ---------- UI wiring ----------
function hookUI() {
  historyListEl = $('#history-list');
  historyEmptyEl = $('#history-empty');
  historyUndoBtnEl = $('#history-undo-btn');
  historyRedoBtnEl = $('#history-redo-btn');
  if (historyUndoBtnEl) historyUndoBtnEl.addEventListener('click', () => undo());
  if (historyRedoBtnEl) historyRedoBtnEl.addEventListener('click', () => redo());
  if (historyListEl) {
    historyListEl.addEventListener('click', (event) => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const target = origin.closest('.history-entry');
      if (!target || target.classList.contains('current')) return;
      const entryId = Number.parseInt(target.dataset.entryId, 10);
      if (!Number.isFinite(entryId) || entryId <= 0) return;
      jumpToHistoryEntry(entryId);
    });
  }
  renderHistoryPanel();

  const stage = $('#stage');
  setupMasterAudioMeterDom();
  setupPaletteSearch();
  stageSizePanelEl = document.getElementById('stage-size-panel');
  stageSizeXEl = stageSizePanelEl?.querySelector('[data-axis="x"]') || null;
  stageSizeYEl = stageSizePanelEl?.querySelector('[data-axis="y"]') || null;
  updateStageSizePanel();

  if (stage) {
    stage.addEventListener('dragover', e => e.preventDefault());
    stage.addEventListener('drop', onStageDrop);
    stage.addEventListener('mousedown', stageMouseDown);
    stage.addEventListener('wheel', onStageWheel, { passive: false });
    stage.addEventListener('contextmenu', onStageContextMenu);
  }

  const fsBtn = $('#btn-stage-fullscreen');
  if (fsBtn) fsBtn.addEventListener('click', toggleStageFullscreen);
  const fsPlayToggle = $('#stage-fs-play-toggle');
  if (fsPlayToggle) fsPlayToggle.addEventListener('click', () => {
    if (playing) pause();
    else play();
  });
  const fsStopBtn = $('#stage-fs-stop');
  if (fsStopBtn) fsStopBtn.addEventListener('click', stop);
  const fsVolume = $('#stage-fs-volume');
  if (fsVolume) {
    fsVolume.addEventListener('input', (e)=>{
      const raw = clamp(Number(e.target.value) || 0, 0, 100);
      setPreviewVolume(raw / 100);
    });
  }
  if (!stageFullscreenEventsBound) {
    document.addEventListener('fullscreenchange', handleStageFullscreenChange);
    window.addEventListener('resize', handleStageWindowResize);
    stageFullscreenEventsBound = true;
  }
  handleStageFullscreenChange();
  updateFullscreenPlaybackUI();

  $('#btn-play').addEventListener('click', play);
  $('#btn-pause').addEventListener('click', pause);
  $('#btn-stop').addEventListener('click', stop);
  $('#btn-save-project').addEventListener('click', handleSaveProject);
  $('#btn-open-project').addEventListener('click', handleOpenProject);
  $('#btn-export-project').addEventListener('click', showExportDialog);
  const exportPackBtn = $('#btn-export-pack');
  if (exportPackBtn) exportPackBtn.addEventListener('click', showSummpackExportDialog);
  const importPackBtn = $('#btn-import-pack');
  if (importPackBtn) importPackBtn.addEventListener('click', handleSummpackImport);

  // Right-click on empty timeline space does nothing (keep for clip/label menus)
  $('#tracks').addEventListener('contextmenu', (e)=>{
    const onClip = e.target.closest('.clip');
    const onTrackLabel = e.target.closest('.track-label');
    const onLabelMarker = e.target.closest('.timeline-label-marker');
    if (onClip || onTrackLabel || onLabelMarker) return;
    e.preventDefault();
    e.stopPropagation();
    showTimelineEmptyMenu(e.clientX, e.clientY);
  });
  ensureTimelineAutoExtendBindings();

  // Remove manual duration UI (timeline auto-expands)
  const durInput = $('#project-duration');
  if (durInput) durInput.closest('label')?.remove();

  // Background selector -> create/extend bg clips
  $('#background-select').addEventListener('change', (e)=>{
    const path = e.target.value || null; // null = "No Background"
    setBackgroundAtTime(path, currentTime);
    renderTimeline();
    applyBackgroundForTime(currentTime);
  });

  // Keyboard (undo/redo, copy/cut/paste, delete, etc.)
  document.addEventListener('keydown', onKeyDown);
  bindTextControls();

  // Ctrl/Cmd + wheel zoom on timeline
  const tracksEl = $('#tracks');
  tracksEl.addEventListener('wheel', (e)=>{
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const old = pxPerSecond;
    const rect = tracksEl.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left + tracksEl.scrollLeft) - lanesOffsetLeft();
    const mouseT = (mouseX / Math.max(old, 0.0001)) * 1000;
    pxPerSecond = clamp(pxPerSecond * factor, 10, 400);
    const newX = (mouseT / 1000) * pxPerSecond;
    const newScrollLeft = tracksEl.scrollLeft + (newX - mouseX);
    renderTimeline._forceScrollLeft = newScrollLeft;
    renderTimeline();
    drawPlayhead();
  }, { passive:false });
  tracksEl.addEventListener('scroll', scheduleTimelineLabelGuideUpdate);
  if (!window.__timelineLabelResizeBound) {
    window.addEventListener('resize', scheduleTimelineLabelGuideUpdate);
    window.__timelineLabelResizeBound = true;
  }

  const btnAddText = $('#btn-add-text');
  if (btnAddText) btnAddText.addEventListener('click', async ()=>{
    try {
      const res = await showTextDialog();
      if (!res) return;
      const t = createTextAtCurrentTime(res);
      selectClip(t.id);
    } catch (err) {
      console.error('Add text dialog failed', err);
    }
  });

function bindTextControls() {
  const ids = ['tc-content','tc-size','tc-color','tc-stroke','tc-stroke-color','tc-shadow-color','tc-shadow-x','tc-shadow-y','tc-shadow-blur','tc-bg','tc-bg-color','tc-bg-alpha','tc-bg-pad','tc-bg-radius'];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', ()=>{
      const t = getSelectedText(); if (!t) return;
      const st = t.style || (t.style = {});
      t.content = document.getElementById('tc-content')?.value ?? t.content;
      st.size = +document.getElementById('tc-size')?.value || st.size;
      st.color = document.getElementById('tc-color')?.value || st.color;
      st.strokeW = +document.getElementById('tc-stroke')?.value || st.strokeW;
      st.strokeColor = document.getElementById('tc-stroke-color')?.value || st.strokeColor;
      st.shadowColor = document.getElementById('tc-shadow-color')?.value || st.shadowColor;
      st.shadowX = +document.getElementById('tc-shadow-x')?.value || st.shadowX;
      st.shadowY = +document.getElementById('tc-shadow-y')?.value || st.shadowY;
      st.shadowBlur = +document.getElementById('tc-shadow-blur')?.value || st.shadowBlur;
      st.bgOn = !!document.getElementById('tc-bg')?.checked;
      st.bgColor = document.getElementById('tc-bg-color')?.value || st.bgColor;
      st.bgAlpha = +document.getElementById('tc-bg-alpha')?.value || st.bgAlpha;
      st.bgPad = +document.getElementById('tc-bg-pad')?.value || st.bgPad;
      st.bgRadius = +document.getElementById('tc-bg-radius')?.value || st.bgRadius;
      applyTextStyle(t);
      refreshStageVisibility();
      renderTimeline();
      scheduleAutosave('edit-text');
    });
  });
}

    // -------- Marquee selection on empty timeline area --------
  let marquee = null;

  tracksEl.addEventListener('mousedown', (e)=>{
    if (e.target.closest('.playhead, .playhead-handle')) return; // playhead drag path
    // if grabbing the playhead, do nothing here
    if (e.target.closest('.playhead, .playhead-handle')) return;
    if (e.button !== 0) return;
    const onClipOrLabel = e.target.closest('.clip') || e.target.classList.contains('track-label');
    if (onClipOrLabel) return; // let clip/label handlers run
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
      clearSelection();                // deselect group on empty click
      updateClipSelectionStyles();
    }

    const rect = tracksEl.getBoundingClientRect();
    const start = {
      x: e.clientX + tracksEl.scrollLeft - rect.left,
      y: e.clientY - rect.top
    };

    // default = scrub; switch to marquee after small move or if Shift/Alt held
    let mode = (e.shiftKey || e.altKey) ? 'marquee' : 'scrub';
    let moved = false;

    const ensureMarquee = ()=>{
      if (marquee) return;
      marquee = document.createElement('div');
      marquee.className = 'marquee-select';
      marquee.style.cssText = `
        position:absolute; pointer-events:none; z-index:50;
        border:1px dashed #58a6ff; background:rgba(88,166,255,.15);
        left:${start.x}px; top:${start.y}px; width:0px; height:0px;
      `;
      tracksEl.appendChild(marquee);
    };

    if (mode === 'scrub') scrubTimelineAtClientX(e.clientX);
    document.body.classList.add('no-select');

    const onMove = (ev)=>{
      const x2 = ev.clientX + tracksEl.scrollLeft - rect.left;
      const y2 = ev.clientY - rect.top;
      const dx = x2 - start.x, dy = y2 - start.y;
      if (!moved && Math.hypot(dx, dy) > 6) moved = true;

      if (mode === 'scrub' && moved) {
         mode = 'marquee';
         ensureMarquee();
       }

      if (mode === 'scrub') {
        scrubTimelineAtClientX(ev.clientX);
      } else {
        ensureMarquee();
        const left = Math.min(start.x, x2);
        const top  = Math.min(start.y, y2);
        marquee.style.left = `${left}px`;
        marquee.style.top  = `${top}px`;
        marquee.style.width  = `${Math.abs(dx)}px`;
        marquee.style.height = `${Math.abs(dy)}px`;
      }
    };

    const onUp = (ev)=>{
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('no-select');

      if (mode === 'scrub') {
        scrubTimelineAtClientX(ev.clientX);
      } else if (marquee) {
        const mrect = marquee.getBoundingClientRect();
        marquee.remove(); marquee = null;

        const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        if (!additive) selectedClipIds.clear();

        for (const el of $$('.clip')) {
          const r = el.getBoundingClientRect();
          const overlap = !(r.right < mrect.left || r.left > mrect.right || r.bottom < mrect.top || r.top > mrect.bottom);
          if (overlap) selectedClipIds.add(el.dataset.id);
        }
        selectedClipId = [...selectedClipIds][0] || null;
        const vis = PROJECT.items.find(i=>i.id===selectedClipId);
        selectedItemId = vis ? vis.id : null;
        updateClipSelectionStyles();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

}

// ---------- Keys ----------
function onKeyDown(e) {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  const mod = e.ctrlKey || e.metaKey;

  // Undo / Redo
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if ((mod && e.shiftKey && e.key.toLowerCase()==='z') || (mod && e.key.toLowerCase()==='y')) { e.preventDefault(); redo(); return; }

  // Copy / Cut / Paste
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelectedClips(); return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelectedClips(); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboardAt(currentTime); return; }

  if (!mod && !e.altKey) {
    if (e.key === ',' || e.key === '<') { e.preventDefault(); stepTimelineByFrames(-1); return; }
    if (e.key === '.' || e.key === '>') { e.preventDefault(); stepTimelineByFrames(1); return; }
  }

  // Frame-by-frame with < and >
  if (!mod && !e.altKey) {
    if (e.key === ',' || e.key === '<') {
      e.preventDefault();
      if (playing) pause();
      stepTimelineByFrames(-1);
      return;
    }
    if (e.key === '.' || e.key === '>') {
      e.preventDefault();
      if (playing) pause();
      stepTimelineByFrames(1);
      return;
    }
  }

  // Delete
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedKeyframe) {
      if (!isClipLocked(selectedKeyframe.itemId)) {
        const item = PROJECT.items.find(i=>i.id===selectedKeyframe.itemId);
        if (item) {
          pushHistory('delete-keyframe');
          deleteKeyframe(item, selectedKeyframe.t);
          clearSelectedKeyframe();
          renderTimeline();
          refreshStageVisibility();
          drawPlayhead();
        }
      }
      e.preventDefault();
      return;
    }
    if (selectedClipIds.size) {
      const deletable = [...selectedClipIds].filter(id => !isClipLocked(id));
      if (deletable.length) {
        pushHistory('delete-multi');
        for (const id of deletable) {
          deleteItemById(id);
          selectedClipIds.delete(id);
        }
        if (selectedClipIds.size) {
          updateClipSelectionStyles();
        } else {
          clearSelection();
        }
      }
      e.preventDefault();
      return;
    }
    if (selectedClipId && !isClipLocked(selectedClipId)) {
      pushHistory('delete-one');
      deleteItemById(selectedClipId);
      selectedClipId = null;
      selectedItemId = null;
      updateClipSelectionStyles();
      e.preventDefault();
      return;
    }
    if (selectedItemId && !isClipLocked(selectedItemId)) {
      pushHistory('delete-one');
      deleteItemById(selectedItemId);
      selectedItemId = null;
      updateClipSelectionStyles();
      e.preventDefault();
      return;
    }
    if (selectedClipId || selectedItemId) {
      e.preventDefault();
      return;
    }
  }
}

function stepTimelineByFrames(count) {
  if (!Number.isFinite(count) || count === 0) return;
  const base = Math.round(currentTime / FRAME_MS) * FRAME_MS;
  currentTime = clamp(base + count * FRAME_MS, 0, timelineViewportEnd());
  if (playing) t0 = performance.now() - currentTime;
  drawPlayhead();
  refreshStageVisibility();
  renderActiveGifs();
  applyBackgroundForTime(currentTime);
}

function serializeClipForClipboard(id) {
  const m = getClipModel(id);
  if (!m) return null;
  if (m.kind === 'bg') {
    // Optional: include background in clipboard; comment to exclude
    // return { kind:'bg', data: PROJECT.bgClips.find(b=>b.id===id) };
  }
  if (m.kind === 'visual') {
    const it = PROJECT.items.find(i=>i.id===id);
    if (!it) return null;
    const { _gif, _el, element, _imageEl, _imageReady, _imagePromise, _imageWidth, _imageHeight, _stageCanvas, _chromaCanvas, _chromaBitmap, _chromaHash, _chromaSourceWidth, _chromaSourceHeight, ...data } = it;
    return { kind:'visual', data: JSON.parse(JSON.stringify(data)) };
  }
  if (m.kind === 'audio') {
    const au = PROJECT.audio.find(a=>a.id===id);
    const { _el, ...data } = au;
    return { kind:'audio', data: JSON.parse(JSON.stringify(data)) };
  }
  return null;
}

function copySelectedClips(ids = null) {
  const list = ids ? [...ids] : [...selectedClipIds];
  if (!list.length) return;
  const clips = list.map(serializeClipForClipboard).filter(Boolean);
  if (!clips.length) return;
  // Normalize relative to earliest start
  const minStart = Math.min(...clips.map(c => c.data.start));
  clipboardClips = { minStart, clips };
}

function cutSelectedClips() {
  if (!selectedClipIds.size) return;
  const ids = [...selectedClipIds].filter(id => !isClipLocked(id));
  if (!ids.length) return;
  pushHistory('cut');
  copySelectedClips(ids);
  for (const id of ids) {
    deleteItemById(id);
    selectedClipIds.delete(id);
  }
  if (selectedClipIds.size) {
    updateClipSelectionStyles();
  } else {
    clearSelection();
  }
}

function pasteClipboardAt(t) {
  if (!clipboardClips) return;
  pushHistory('paste');
  const base = Math.max(0, Math.round(t));
  const newIds = [];
  const clones = [];
  const idMap = new Map();

  for (const { kind, data } of clipboardClips.clips) {
    const d = JSON.parse(JSON.stringify(data));
    const originalId = d.id;
    d.id = uid();
    idMap.set(originalId, d.id);
    const shift = d.start - clipboardClips.minStart;
    d.start = base + shift;
    d.end = d.start + (data.end - data.start);
    clones.push({ kind, data: d, originalId });
  }

  for (const entry of clones) {
    const { kind, data: d } = entry;
    const targetTrack = kind === 'bg' ? 0 : (d.trackIndex ?? 0);
    if (isTrackLocked(kind, targetTrack)) {
      console.warn('Track locked, skipping paste for clip', d.id);
      continue;
    }

    if (kind === 'visual') {
      const weldInfo = getWeldInfo(d);
      if (weldInfo) {
        const mapped = idMap.get(weldInfo.parentId);
        if (mapped) {
          d.weld.parentId = mapped;
        } else {
          delete d.weld;
        }
      }
      hydrateFx(d);
      hydrateChromaKey(d);
      PROJECT.items.push(d);
      spawnStageItem(d);
    } else if (kind === 'audio') {
      d._el = null;
      hydrateAudioEffectsObject(d);
      d.crossfadePrevMs = 0;
      d.crossfadeNextMs = 0;
      PROJECT.audio.push(d);
    } else if (kind === 'bg') {
      if (!PROJECT.bgClips) PROJECT.bgClips = [];
      const clip = { id: d.id, path: d.path || null, start: d.start, end: d.end, fx: cloneFx(d.fx) };
      hydrateFx(clip);
      hydrateChromaKey(clip);
      PROJECT.bgClips.push(clip);
    }
    newIds.push(d.id);
  }

  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();

  selectedClipIds = new Set(newIds);
  updateClipSelectionStyles();
}


// ---------- Background select list ----------
async function renderBackgroundOptions() {
  const bgTree = await window.suAPI.readAssetTree(PATHS.backgrounds);
  const sel = $('#background-select');
  sel.innerHTML = '<option value="">No Background</option>';
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.type==='dir') walk(n.children);
      if (n.type==='file' && isImage(n.path)) {
        const opt = document.createElement('option');
        opt.value = n.path;
        opt.textContent = n.name;
        sel.appendChild(opt);
      }
    }
  })(bgTree);
}

// ---------- Background track logic ----------
function setBackgroundAtTime(pathOrNull, t) {
  if (isTrackLocked('bg', 0)) return;
  if (!Array.isArray(PROJECT.bgClips)) PROJECT.bgClips = [];
  const clips = PROJECT.bgClips;
  const now = Math.max(0, Math.round(t));

  if (clips.length === 0) {
    const entry = { id: uid(), path: pathOrNull, start: 0, end: null, fx: defaultFxSettings(), chromaKey: defaultChromaKeySettings() };
    hydrateFx(entry);
    hydrateChromaKey(entry);
    clips.push(entry);
    return;
  }

  const last = clips[clips.length - 1];
  const safeT = PROJECT.bgNonDecreasingOnly ? Math.max(now, last.start + 1) : now;

  if (safeT >= last.start && last.end == null && last.path === pathOrNull) return;

  if (last.end == null) last.end = safeT;
  const entry = { id: uid(), path: pathOrNull, start: safeT, end: null, fx: defaultFxSettings(), chromaKey: defaultChromaKeySettings() };
  hydrateFx(entry);
  hydrateChromaKey(entry);
  clips.push(entry);
  scheduleAutosave('bg-change');
}

function getActiveBgAt(t) {
  const clips = PROJECT.bgClips || [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const end = (c.end == null) ? Infinity : c.end;
    if (t >= (c.start ?? 0) && t < end) return c;
  }
  return null;
}

function getPreviousBgBefore(t) {
  const clips = PROJECT.bgClips || [];
  let candidate = null;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.end == null) continue;
    if (c.end <= t && (!candidate || (candidate.end ?? -Infinity) < c.end)) {
      candidate = c;
    }
  }
  return candidate;
}


function applyBackgroundForTime(t) {
  const { layer, prevLayer } = ensureBgLayers();
  const stage = document.getElementById('stage');
  if (!stage || !layer || !prevLayer) return;
  const rect = stage?.getBoundingClientRect?.();
  const dims = {
    width: Math.max(1, Math.round(rect?.width || stage?.clientWidth || window.innerWidth || 1920)),
    height: Math.max(1, Math.round(rect?.height || stage?.clientHeight || window.innerHeight || 1080)),
  };

  const selection = resolveBackgroundSelectionForTime(t, dims);
  const { clip, prevClip, clipState, prevState, stageColor } = selection;

  if (clip) applyFxStyles(clip, layer);
  else layer.style.removeProperty('filter');

  const activePath = clip?.path || null;
  if (activePath) {
    const want = `url(${fileUrl(activePath)}) center / cover no-repeat #000`;
    if (layer.style.background !== want) layer.style.background = want;
  } else {
    layer.style.background = 'none';
  }
  applyBackgroundStateToLayer(layer, clipState, !!activePath);

  if (prevClip) {
    applyFxStyles(prevClip, prevLayer);
    const prevPath = prevClip.path || null;
    if (prevPath) {
      const wantPrev = `url(${fileUrl(prevPath)}) center / cover no-repeat #000`;
      if (prevLayer.style.background !== wantPrev) prevLayer.style.background = wantPrev;
    } else {
      prevLayer.style.background = 'none';
    }
    applyBackgroundStateToLayer(prevLayer, prevState, !!prevPath);
  } else {
    prevLayer.style.opacity = '0';
    prevLayer.style.background = 'none';
    prevLayer.style.removeProperty('transform');
    prevLayer.style.removeProperty('filter');
  }

  stage.style.background = stageColor;
}

function computeBackgroundTransitionState(clip, timeMs, dims) {
  if (!clip) {
    return { opacity: 0, translateX: 0, translateY: 0 };
  }
  const width = Math.max(1, dims?.width || 0);
  const height = Math.max(1, dims?.height || 0);
  const start = clip.start ?? 0;
  const end = Number.isFinite(clip.end) ? clip.end : null;

  let opacity = 1;
  let translateX = 0;
  let translateY = 0;

  const applySlideOffset = (dir, offset, phase) => {
    if (offset === 0) return;
    if (dir === 'left') translateX -= offset;
    else if (dir === 'right') translateX += offset;
    else if (dir === 'up') translateY -= offset;
    else if (dir === 'down') translateY += offset;
  };

  const resolveSlideDistance = (dir) => {
    return (dir === 'left' || dir === 'right') ? width : height;
  };

  const applyInTransition = (transition) => {
    if (!transition || transition.dur <= 0) return;
    const type = transition.type;
    const progress = clamp01((timeMs - start) / Math.max(1, transition.dur));
    if (type === 'fade' || type === 'fade-white') {
      opacity *= progress;
    } else if (typeof type === 'string' && type.startsWith('slide-')) {
      const dir = type.split('-')[1];
      const dist = resolveSlideDistance(dir);
      const offset = (1 - progress) * dist;
      applySlideOffset(dir, offset, 'in');
    }
  };

  const applyOutTransition = (transition) => {
    if (!transition || transition.dur <= 0 || end == null) return;
    const type = transition.type;
    if (typeof type === 'string' && type.startsWith('slide-')) {
      const dir = type.split('-')[1];
      const dist = resolveSlideDistance(dir);
      const progress = clamp01((timeMs - end) / Math.max(1, transition.dur));
      const offset = progress * dist;
      applySlideOffset(dir, offset, 'out-slide');
    } else if (type === 'fade' || type === 'fade-white') {
      const progress = clamp((end - timeMs) / Math.max(1, transition.dur), 0, 1);
      opacity *= progress;
    }
  };

  applyInTransition(clip.transIn || null);
  applyOutTransition(clip.transOut || null);

  return {
    opacity: clamp01(opacity),
    translateX,
    translateY,
  };
}

const BG_TRANSITION_EPS = 0.5;

function resolveBackgroundSelectionForTime(timeMs, dims) {
  const clip = getActiveBgAt(timeMs);
  const prevCandidate = getPreviousBgBefore(timeMs);
  let prevClip = null;

  if (prevCandidate && (!clip || prevCandidate.id !== clip.id)) {
    const end = prevCandidate.end;
    const out = prevCandidate.transOut;
    const hasSlideOut = typeof out?.type === 'string' && out.type.startsWith('slide-') && out.dur > 0;
    if (Number.isFinite(end)) {
      if (timeMs <= end + BG_TRANSITION_EPS) {
        prevClip = prevCandidate;
      } else if (hasSlideOut && timeMs <= end + out.dur + BG_TRANSITION_EPS) {
        prevClip = prevCandidate;
      }
    }
  }

  if (clip && !prevClip) {
    const prevBeforeStart = getPreviousBgBefore((clip.start ?? 0) + 0.0001);
    const inT = clip.transIn;
    const inType = typeof inT?.type === 'string' ? inT.type : '';
    if (prevBeforeStart && prevBeforeStart !== clip && inType.startsWith('slide-') && inT?.dur > 0) {
      const end = prevBeforeStart.end;
      if (Number.isFinite(end) && Math.abs(end - (clip.start ?? 0)) <= (inT.dur * 2 + BG_TRANSITION_EPS)) {
        prevClip = prevBeforeStart;
      }
    }
  }

  const activeState = computeBackgroundTransitionState(clip, timeMs, dims);
  const prevState = computeBackgroundTransitionState(prevClip, timeMs, dims);
  const stagePrevRef = prevClip || prevCandidate;
  const stageColor = backgroundStageColorForTime(timeMs, clip, stagePrevRef);

  return {
    clip,
    prevClip,
    clipState: activeState,
    prevState,
    stageColor,
  };
}

async function drawBackgroundClipToCanvas(ctx, clip, state, width, height) {
  if (!ctx || !clip || !clip.path) return;
  const opacity = clamp01(state?.opacity ?? 1);
  if (opacity <= 0) return;

  hydrateChromaKey(clip);
  const img = await loadImageElement(clip.path);
  if (!img) return;

  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const scale = Math.max(width / iw, height / ih);
  const drawW = iw * scale;
  const drawH = ih * scale;
  const drawX = (width - drawW) / 2;
  const drawY = (height - drawH) / 2;

  let source = img;
  if (chromaKeyIsActive(clip.chromaKey)) {
    clip._imageEl = img;
    clip._imageReady = true;
    clip._imageWidth = iw;
    clip._imageHeight = ih;
    const chroma = getStaticChromaCanvas(clip, img);
    if (chroma) source = chroma;
  }

  const offsetX = state?.translateX ?? 0;
  const offsetY = state?.translateY ?? 0;

  ctx.save();
  ctx.globalAlpha *= opacity;
  if (Math.abs(offsetX) > 0.01 || Math.abs(offsetY) > 0.01) {
    ctx.translate(offsetX, offsetY);
  }
  ctx.drawImage(source, drawX, drawY, drawW, drawH);
  ctx.restore();
}

function applyBackgroundStateToLayer(layer, state, hasMedia) {
  if (!layer) return;
  if (!hasMedia || !state) {
    layer.style.opacity = '0';
    layer.style.removeProperty('transform');
    return;
  }
  const opacity = clamp01(state.opacity ?? 0);
  const x = state.translateX ?? 0;
  const y = state.translateY ?? 0;
  layer.style.opacity = String(opacity);
  if (Math.abs(x) > 0.01 || Math.abs(y) > 0.01) {
    layer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  } else {
    layer.style.removeProperty('transform');
  }
}

function backgroundStageColorForTime(timeMs, clip, prevCandidate) {
  const WHITE = '#fff';
  const BLACK = '#000';
  if (clip) {
    const start = clip.start ?? 0;
    const inT = clip.transIn;
    if (inT?.type === 'fade-white' && inT.dur > 0) {
      const progress = clamp01((timeMs - start) / Math.max(1, inT.dur));
      if (progress < 1) return WHITE;
    }
    const end = clip.end;
    const outT = clip.transOut;
    if (Number.isFinite(end) && outT?.type === 'fade-white' && outT.dur > 0) {
      if (timeMs >= end - outT.dur && timeMs <= end) return WHITE;
    }
  }
  if (prevCandidate?.transOut?.type === 'fade-white' && prevCandidate.transOut.dur > 0 && Number.isFinite(prevCandidate.end)) {
    if (timeMs <= prevCandidate.end + prevCandidate.transOut.dur) return WHITE;
  }
  return BLACK;
}

function wrapSubtitleLines(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = String(text || '').split(/\n+/);
  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p].trim();
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = words.shift() || '';
    while (words.length) {
      const nextWord = words.shift();
      const testLine = current ? `${current} ${nextWord}` : nextWord;
      if (ctx.measureText(testLine).width <= maxWidth) {
        current = testLine;
      } else {
        if (current) lines.push(current);
        if (ctx.measureText(nextWord).width <= maxWidth) {
          current = nextWord;
        } else {
          let chunk = '';
          for (const ch of nextWord) {
            const attempt = chunk ? `${chunk}${ch}` : ch;
            if (ctx.measureText(attempt).width > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk = attempt;
            }
          }
          current = chunk;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

function drawRoundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBurnInSubtitles(ctx, preset, timeMs, state) {
  if (!state?.entries?.length) return;
  const active = state.entries.filter(entry => timeMs >= entry.start && timeMs < entry.end);
  if (!active.length) return;

  ctx.save();
  const width = preset.width;
  const height = preset.height;
  const fontSize = Math.max(24, Math.round(height * 0.045));
  const lineHeight = fontSize * 1.25;
  const blockGap = fontSize * 0.4;
  const bottomMargin = fontSize * 1.2;
  const topMargin = fontSize * 0.8;
  const maxTextWidth = Math.max(100, width * 0.82);
  const fontFamily = 'Segoe UI, Helvetica Neue, Arial, sans-serif';
  const outlineChoice = state?.outline === 'white' ? 'white' : (state?.outline === 'none' ? 'none' : 'black');
  const strokeStyle = outlineChoice === 'white' ? 'rgba(255,255,255,0.9)' : (outlineChoice === 'black' ? 'rgba(0,0,0,0.85)' : null);
  const shadowColor = 'rgba(0,0,0,0.65)';
  const shadowBlur = fontSize * 0.45;
  const useStroke = !!strokeStyle;
  const textStrokeWidth = useStroke ? Math.max(2, Math.round(fontSize * 0.08)) : 0;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.font = `600 ${fontSize}px ${fontFamily}`;

  const layouts = active.map(entry => {
    const lines = wrapSubtitleLines(ctx, entry.text, maxTextWidth);
    const lineWidths = lines.map(line => ctx.measureText(line).width);
    const widest = lineWidths.length ? Math.max(...lineWidths, 0) : 0;
    const padTop = fontSize * 0.3;
    const padBottom = fontSize * 0.45;
    const textHeight = lines.length ? fontSize + (lines.length - 1) * lineHeight : fontSize;
    const blockHeight = padTop + padBottom + textHeight;
    return {
      entry,
      lines,
      blockHeight,
      textColor: subtitleColorForCharacter(entry.characterName, state.colors),
      padTop,
      padBottom
    };
  });

  const positions = new Array(layouts.length);
  let cursor = height - bottomMargin;
  for (let i = layouts.length - 1; i >= 0; i--) {
    const layout = layouts[i];
    const bottom = cursor;
    const top = bottom - layout.blockHeight;
    positions[i] = { top, bottom };
    cursor = top - blockGap;
  }
  const minTop = Math.min(...positions.map(pos => pos.top));
  if (minTop < topMargin) {
    const shift = topMargin - minTop;
    for (const pos of positions) {
      pos.top += shift;
      pos.bottom += shift;
    }
  }

  for (let i = 0; i < layouts.length; i++) {
    const layout = layouts[i];
    const pos = positions[i];
    const top = Math.round(pos.top);
    const textStartY = top + layout.padTop + fontSize;

    ctx.save();
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlur;
    ctx.fillStyle = layout.textColor || '#ffffff';
    if (useStroke) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = textStrokeWidth;
    } else {
      ctx.lineWidth = 0;
    }

    let lineY = textStartY;
    for (const line of layout.lines) {
      if (line) {
        if (useStroke) ctx.strokeText(line, width / 2, lineY);
        ctx.fillText(line, width / 2, lineY);
      }
      lineY += lineHeight;
    }
    ctx.restore();
  }

  ctx.restore();
}

function ensureBgLayers() {
  const stage = document.getElementById('stage');
  if (!stage) return { layer: null, prevLayer: null };
  stage.style.position ||= 'relative';

  let prevLayer = document.getElementById('bg-layer-prev');
  let layer = document.getElementById('bg-layer');

  if (!prevLayer) {
    prevLayer = document.createElement('div');
    prevLayer.id = 'bg-layer-prev';
    prevLayer.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:0;';
    stage.insertBefore(prevLayer, stage.firstChild);
  }

  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'bg-layer';
    layer.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:1;';
    const referenceNode = prevLayer.nextSibling;
    if (referenceNode) stage.insertBefore(layer, referenceNode);
    else stage.appendChild(layer);
  }

  return { layer, prevLayer };
}

// ---------- Track names ----------
 function getDefaultTrackLabel(kind, idx) {
   if (kind === 'visual') return `VIS Track ${idx+1}`;
   if (kind === 'audio')  return `AUD Track ${idx+1}`;
   if (kind === 'text')   return `TXT Track ${idx+1}`;
   if (kind === 'bg')     return PROJECT.bgTrackName || 'Background';
   return `Track ${idx+1}`;
 }
function getTrackName(kind, idx) {
  const map = PROJECT.trackNames?.[kind] || {};
  return map[idx] || getDefaultTrackLabel(kind, idx);
}
function setTrackName(kind, idx, name) {
  if (!PROJECT.trackNames) PROJECT.trackNames = { visual:{}, audio:{}, text:{} };
  if (!PROJECT.trackNames.text) PROJECT.trackNames.text = {};
  const map = PROJECT.trackNames[kind];
  if (name && name.trim()) map[idx] = name.trim();
  else delete map[idx];
}
function remapTrackNames(kind, indexMap) {
  const src = PROJECT.trackNames?.[kind] || {};
  const next = {};
  Object.keys(src).forEach(k=>{
    const oldIdx = Number(k);
    const ni = indexMap.get(oldIdx);
    if (ni !== undefined && next[ni] == null) next[ni] = src[k];
  });
    PROJECT.trackNames[kind] = next;
}

function remapTrackLocks(kind, indexMap) {
  const locks = ensureTrackLocks();
  const src = locks[kind] || {};
  const next = {};
  Object.keys(src).forEach(k => {
    const oldIdx = Number(k);
    const ni = indexMap.get(oldIdx);
    if (ni !== undefined) next[ni] = true;
  });
  locks[kind] = next;
}

// ---------- Audio waveform + decoding helpers ----------
const AUDIO_EFFECT_DEFAULTS = Object.freeze({
  eq: Object.freeze({
    enabled: false,
    lowGain: 0,
    midGain: 0,
    highGain: 0
  }),
  reverb: Object.freeze({
    enabled: false,
    amount: 0.3,
    time: 2.2,
    decay: 2.5
  }),
  compression: Object.freeze({
    enabled: false,
    threshold: -24,
    ratio: 2.5,
    attack: 0.003,
    release: 0.25,
    knee: 30
  }),
  denoise: Object.freeze({
    enabled: false,
    amount: 0.25
  })
});
const REVERB_CACHE = new Map();

function cloneAudioEffectDefaults() {
  return {
    eq: { ...AUDIO_EFFECT_DEFAULTS.eq },
    reverb: { ...AUDIO_EFFECT_DEFAULTS.reverb },
    compression: { ...AUDIO_EFFECT_DEFAULTS.compression },
    denoise: { ...AUDIO_EFFECT_DEFAULTS.denoise }
  };
}

function hydrateAudioEffectsObject(au) {
  if (!au || typeof au !== 'object') return cloneAudioEffectDefaults();
  let target = au.effects;
  if (!target || typeof target !== 'object') {
    target = cloneAudioEffectDefaults();
    au.effects = target;
    return target;
  }
  target.eq = { ...AUDIO_EFFECT_DEFAULTS.eq, ...(target.eq || {}) };
  target.reverb = { ...AUDIO_EFFECT_DEFAULTS.reverb, ...(target.reverb || {}) };
  target.compression = { ...AUDIO_EFFECT_DEFAULTS.compression, ...(target.compression || {}) };
  target.denoise = { ...AUDIO_EFFECT_DEFAULTS.denoise, ...(target.denoise || {}) };
  return target;
}

function getReverbImpulse(ac, seconds, decay) {
  const s = clamp(Math.max(0.1, Number(seconds) || 1.5), 0.1, 10);
  const d = clamp(Math.max(0.1, Number(decay) || 2), 0.1, 10);
  const key = `${ac.sampleRate}|${s.toFixed(2)}|${d.toFixed(2)}`;
  if (REVERB_CACHE.has(key)) return REVERB_CACHE.get(key);

  const length = Math.max(1, Math.floor(ac.sampleRate * s));
  const impulse = ac.createBuffer(2, length, ac.sampleRate);
  for (let ch = 0; ch < impulse.numberOfChannels; ch++) {
    const channelData = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const decayFactor = Math.pow(1 - i / length, d);
      channelData[i] = (Math.random() * 2 - 1) * decayFactor;
    }
  }
  REVERB_CACHE.set(key, impulse);
  return impulse;
}

let __audioCtx = null;
function getAudioCtx() {
  if (!__audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    __audioCtx = AC ? new AC() : null;
  }
  return __audioCtx;
}

const AUDIO_PREROLL_MS = 120;
const VIDEO_PREROLL_MS = 120;

let __previewMasterBus = null;
const TRACK_AUDIO_BUSES = new Map();
const AUDIO_METER_STATES = new Map();
let audioMeterLoopHandle = null;

function getPreviewMasterBus() {
  const ac = getAudioCtx();
  if (!ac) return null;
  if (!__previewMasterBus) {
    const gain = ac.createGain();
    gain.gain.value = 1;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    analyser.minDecibels = -90;
    analyser.maxDecibels = 0;
    analyser.smoothingTimeConstant = 0.85;
    gain.connect(analyser);
    analyser.connect(ac.destination);
    __previewMasterBus = { gain, analyser };
  }
  return __previewMasterBus;
}

function getTrackBus(trackIndex) {
  const ac = getAudioCtx();
  if (!ac) return null;
  const key = Number.isFinite(trackIndex) ? trackIndex : 0;
  let bus = TRACK_AUDIO_BUSES.get(key);
  if (!bus) {
    const gain = ac.createGain();
    gain.gain.value = 1;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    analyser.minDecibels = -90;
    analyser.maxDecibels = 0;
    analyser.smoothingTimeConstant = 0.75;
    bus = { key, gain, analyser, connectedToMaster: false };
    TRACK_AUDIO_BUSES.set(key, bus);
  }
  const master = getPreviewMasterBus();
  if (master?.gain && !bus.connectedToMaster) {
    try {
      bus.gain.connect(bus.analyser);
      bus.analyser.connect(master.gain);
      bus.connectedToMaster = true;
    } catch (err) {
      console.error('track bus connect error', err);
    }
  }
  return bus;
}

function registerAudioMeter(key, {
  kind,
  trackIndex = null,
  el,
  fill,
  peak,
  valueEl,
  minDb = -60,
  activeTarget
} = {}) {
  if (!key) return null;
  let state = AUDIO_METER_STATES.get(key);
  if (!state) {
    state = {
      key,
      kind,
      trackIndex,
      minDb,
      el: null,
      fill: null,
      peak: null,
      valueEl: null,
      activeTarget: null,
      data: null,
      level: 0,
      peakLevel: 0,
      missingFrames: 0
    };
    AUDIO_METER_STATES.set(key, state);
  }
  state.kind = kind || state.kind;
  state.trackIndex = trackIndex != null ? trackIndex : state.trackIndex;
  state.minDb = minDb;
  if (el) state.el = el;
  if (fill) state.fill = fill;
  if (peak) state.peak = peak;
  if (valueEl) state.valueEl = valueEl;
  state.activeTarget = activeTarget ?? state.activeTarget ?? state.el;
  if (state.el) {
    state.el.setAttribute('aria-valuenow', String(state.minDb));
  }
  ensureAudioMeterLoop();
  return state;
}

function ensureAudioMeterLoop() {
  if (audioMeterLoopHandle != null) return;
  const step = () => {
    const keepRunning = tickAudioMeters();
    if (keepRunning) audioMeterLoopHandle = requestAnimationFrame(step);
    else audioMeterLoopHandle = null;
  };
  audioMeterLoopHandle = requestAnimationFrame(step);
}

function tickAudioMeters() {
  let anyActive = false;
  for (const state of AUDIO_METER_STATES.values()) {
    const el = state.el;
    if (!el || !document.body.contains(el)) {
      state.missingFrames = (state.missingFrames || 0) + 1;
      if (state.missingFrames > 180) {
        AUDIO_METER_STATES.delete(state.key);
      }
      continue;
    }
    state.missingFrames = 0;

    let analyser = null;
    if (state.kind === 'master') analyser = getPreviewMasterBus()?.analyser || null;
    else if (state.kind === 'track') analyser = getTrackBus(state.trackIndex)?.analyser || null;

    updateAudioMeterState(state, analyser);
    anyActive = true;
  }
  return anyActive && AUDIO_METER_STATES.size > 0;
}

function updateAudioMeterState(state, analyser) {
  const minDb = state.minDb;
  let level = state.level || 0;
  let peakLevel = state.peakLevel || 0;
  let db = minDb;

  if (analyser) {
    if (!state.data || state.data.length !== analyser.fftSize) {
      state.data = new Float32Array(analyser.fftSize);
    }
    const data = state.data;
    analyser.getFloatTimeDomainData(data);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const sample = data[i];
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / data.length);
    const peakDb = 20 * Math.log10(Math.max(peak, 1e-5));
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-5));
    const peakNorm = clamp((peakDb - minDb) / (0 - minDb), 0, 1);
    const rmsNorm = clamp((rmsDb - minDb) / (0 - minDb), 0, 1);
    level = rmsNorm;
    peakLevel = Math.max(peakNorm, peakLevel * 0.92);
    db = clamp(rmsDb, minDb, 0);
  } else {
    level = Math.max(0, level * 0.85);
    peakLevel = Math.max(0, peakLevel * 0.9);
  }

  state.level = level;
  state.peakLevel = peakLevel;
  applyAudioMeterVisual(state, level, peakLevel, db);
}

function applyAudioMeterVisual(state, level, peakLevel, db) {
  if (state.fill) {
    state.fill.style.width = `${Math.round(level * 100)}%`;
  }
  if (state.peak) {
    if (peakLevel > 0.002) {
      state.peak.style.opacity = '1';
      state.peak.style.left = `${Math.round(peakLevel * 100)}%`;
    } else {
      state.peak.style.opacity = '0';
    }
  }

  const isActive = level > 0.05 || peakLevel > 0.05;
  const valueText = level > 0.02 ? `${db.toFixed(1)} dB` : '-inf dB';
  if (state.valueEl) state.valueEl.textContent = valueText;

  if (state.el) {
    state.el.setAttribute('aria-valuenow', isActive ? db.toFixed(1) : String(state.minDb));
    state.el.classList.toggle('active', isActive);
  }
  if (state.activeTarget && state.activeTarget !== state.el) {
    state.activeTarget.classList.toggle('active-meter', isActive);
  }
}

function setupMasterAudioMeterDom() {
  const el = $('#audio-meter-master');
  if (!el) return;
  const fill = el.querySelector('[data-role="meter-fill"]');
  const peak = el.querySelector('[data-role="meter-peak"]');
  const valueEl = el.querySelector('[data-role="meter-value"]');
  registerAudioMeter('master', {
    kind: 'master',
    el,
    fill,
    peak,
    valueEl,
    minDb: -60,
    activeTarget: el
  });
}

function ensureMediaGraph(au) {
  const ac = getAudioCtx();
  if (!ac || !au?._el) return;
  if (!au._src) {
    try { au._el.crossOrigin = 'anonymous'; } catch {}
    try { au._src = ac.createMediaElementSource(au._el); }
    catch { /* element already used by a node */ }
  }
  if (au._src && !au._nodes) {
    try { au._src.disconnect(); } catch {}
    const nodes = {
      denoiseHP: ac.createBiquadFilter(),
      denoiseLP: ac.createBiquadFilter(),
      eqLow: ac.createBiquadFilter(),
      eqMid: ac.createBiquadFilter(),
      eqHigh: ac.createBiquadFilter(),
      compressor: ac.createDynamicsCompressor(),
      dryGain: ac.createGain(),
      wetSend: ac.createGain(),
      reverb: ac.createConvolver(),
      reverbGain: ac.createGain(),
      masterGain: ac.createGain()
    };
    nodes.denoiseHP.type = 'highpass';
    nodes.denoiseLP.type = 'lowpass';
    nodes.eqLow.type = 'lowshelf';
    nodes.eqLow.frequency.value = 180;
    nodes.eqMid.type = 'peaking';
    nodes.eqMid.frequency.value = 1000;
    nodes.eqMid.Q.value = 0.9;
    nodes.eqHigh.type = 'highshelf';
    nodes.eqHigh.frequency.value = 3800;
    nodes.reverb.normalize = true;
    nodes.dryGain.gain.value = 1;
    nodes.wetSend.gain.value = 0;
    nodes.reverbGain.gain.value = 0;
    nodes.masterGain.gain.value = 0;

    try {
      au._src.connect(nodes.denoiseHP);
      nodes.denoiseHP.connect(nodes.denoiseLP);
      nodes.denoiseLP.connect(nodes.eqLow);
      nodes.eqLow.connect(nodes.eqMid);
      nodes.eqMid.connect(nodes.eqHigh);
      nodes.eqHigh.connect(nodes.compressor);
      nodes.compressor.connect(nodes.dryGain);
      nodes.dryGain.connect(nodes.masterGain);
      nodes.compressor.connect(nodes.wetSend);
      nodes.wetSend.connect(nodes.reverb);
      nodes.reverb.connect(nodes.reverbGain);
      nodes.reverbGain.connect(nodes.masterGain);
      au._nodes = nodes;
      au._gain = nodes.masterGain;
      au._connected = true;
    } catch (err) {
      console.error('ensureMediaGraph wiring error', err);
    }
  }
  hydrateAudioEffectsObject(au);
  updateAudioGraphEffects(au);
  if (au._nodes) {
    const bus = getTrackBus(au.trackIndex ?? 0);
    const targetGain = bus?.gain ?? null;
    if (targetGain && au._trackBusGain !== targetGain) {
      try { au._nodes.masterGain.disconnect(); } catch {}
      try {
        au._nodes.masterGain.connect(targetGain);
        au._trackBusGain = targetGain;
      } catch (err) {
        console.error('audio track bus connect error', err);
      }
    } else if (!targetGain && au._trackBusGain) {
      try { au._nodes.masterGain.disconnect(); } catch {}
      au._trackBusGain = null;
    }
  }
  if (typeof ac.resume === 'function' && ac.state === 'suspended') {
    ac.resume().catch(()=>{});
  }
}

function updateAudioGraphEffects(au) {
  const ac = getAudioCtx();
  const nodes = au?._nodes;
  if (!ac || !nodes) return;
  const fx = hydrateAudioEffectsObject(au);
  const hash = JSON.stringify(fx);
  if (hash === au._effectHash) return;
  au._effectHash = hash;

  // Noise reduction (simple band-pass approach)
  const denoise = fx.denoise || {};
  const dnAmt = denoise.enabled ? clamp01(Number(denoise.amount) || 0) : 0;
  const hpFreq = dnAmt > 0 ? lerp(40, 400, dnAmt) : 20;
  const lpFreq = dnAmt > 0 ? lerp(18000, 6500, dnAmt) : 20000;
  nodes.denoiseHP.frequency.value = hpFreq;
  nodes.denoiseHP.Q.value = 0.707;
  nodes.denoiseLP.frequency.value = lpFreq;
  nodes.denoiseLP.Q.value = 0.707;

  // EQ gains
  const eq = fx.eq || {};
  const eqEnabled = !!eq.enabled;
  const lowGain = eqEnabled ? clamp(Number(eq.lowGain) || 0, -18, 18) : 0;
  const midGain = eqEnabled ? clamp(Number(eq.midGain) || 0, -18, 18) : 0;
  const highGain = eqEnabled ? clamp(Number(eq.highGain) || 0, -18, 18) : 0;
  nodes.eqLow.gain.value = lowGain;
  nodes.eqMid.gain.value = midGain;
  nodes.eqHigh.gain.value = highGain;

  // Compression
  const comp = fx.compression || {};
  const compOn = !!comp.enabled;
  const compNode = nodes.compressor;
  compNode.threshold.value = compOn ? clamp(Number(comp.threshold) || -24, -60, 0) : 0;
  compNode.knee.value = compOn ? clamp(Number(comp.knee) || 30, 0, 40) : 40;
  compNode.ratio.value = compOn ? clamp(Number(comp.ratio) || 2.5, 1, 20) : 1;
  compNode.attack.value = clamp(Math.max(0.001, compOn ? Number(comp.attack) || 0.003 : 0.003), 0.001, 1);
  compNode.release.value = clamp(Math.max(0.01, compOn ? Number(comp.release) || 0.25 : 0.25), 0.01, 1);

  // Reverb
  const rv = fx.reverb || {};
  const rvAmt = rv.enabled ? clamp01(Number(rv.amount) || 0) : 0;
  nodes.reverbGain.gain.value = rvAmt;
  nodes.wetSend.gain.value = rvAmt;
  nodes.dryGain.gain.value = clamp01(1 - rvAmt * 0.85);
  if (rvAmt > 0.0001) {
    const time = clamp(Number(rv.time) || 2.2, 0.1, 10);
    const decay = clamp(Number(rv.decay) || 2.5, 0.1, 10);
    const buffer = getReverbImpulse(ac, time, decay);
    if (buffer && nodes.reverb.buffer !== buffer) nodes.reverb.buffer = buffer;
  } else if (nodes.reverb.buffer) {
    nodes.reverb.buffer = null;
  }
}

async function ensureWaveform(au) {
  if (au._wave && au._audioBuffer) return au._wave;
  if (au._wavePromise) return au._wavePromise;
  au._wavePromise = (async () => {
    try {
      if (!window.suAPI?.readFileBytes) return null;
      const raw = await window.suAPI.readFileBytes(au.path);
      if (!raw) return null;

      let u8;
      if (raw instanceof Uint8Array) u8 = raw;
      else if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
      else if (raw?.buffer instanceof ArrayBuffer) u8 = new Uint8Array(raw.buffer);
      else if (Array.isArray(raw?.data)) u8 = new Uint8Array(raw.data);
      else return null;

      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      const ac = getAudioCtx();
      if (!ac || !ac.decodeAudioData) return null;

      const buf = await ac.decodeAudioData(ab);
      au._audioBuffer = buf;
      au.srcDurationMs = buf.duration * 1000;

      const wave = computePeaks(buf);
      au._wave = wave;
      return wave;
    } catch (e) {
      console.error('ensureWaveform error:', e);
      return null;
    } finally {
      au._wavePromise = null;
    }
  })();
  return au._wavePromise;
}

function computePeaks(buffer) {
  const channels = buffer.numberOfChannels;
  const chData = [];
  for (let c = 0; c < channels; c++) chData.push(buffer.getChannelData(c));
  const length = buffer.length;

  const buckets = Math.min(8000, Math.max(600, Math.ceil(buffer.duration * 160)));
  const samplesPerBucket = Math.max(1, Math.floor(length / buckets));
  const step = Math.max(1, Math.floor(samplesPerBucket / 64));

  const mins = new Float32Array(buckets);
  const maxs = new Float32Array(buckets);

  for (let i = 0; i < buckets; i++) {
    const start = i * samplesPerBucket;
    const end = (i === buckets - 1) ? length : start + samplesPerBucket;
    let mn = 1.0, mx = -1.0;
    for (let c = 0; c < channels; c++) {
      const data = chData[c];
      for (let s = start; s < end; s += step) {
        const v = data[s];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    mins[i] = mn;
    maxs[i] = mx;
  }

  return { mins, maxs, durationMs: buffer.duration * 1000 };
}

// encode 16-bit PCM WAV from an AudioBuffer (optionally reversed)
function encodeWav16(buffer, { reverse=false } = {}) {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const interleaved = new Int16Array(length * numCh);

  for (let ch = 0; ch < numCh; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const idx = reverse ? (length - 1 - i) : i;
      const v = Math.max(-1, Math.min(1, data[idx]));
      interleaved[i * numCh + ch] = (v < 0 ? v * 0x8000 : v * 0x7FFF);
    }
  }

  const byteRate = sampleRate * numCh * 2;
  const blockAlign = numCh * 2;
  const dataSize = interleaved.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  let off = 0;
  function writeString(s){ for (let i=0;i<s.length;i++) view.setUint8(off++, s.charCodeAt(i)); }
  function writeU32(v){ view.setUint32(off, v, true); off+=4; }
  function writeU16(v){ view.setUint16(off, v, true); off+=2; }

  writeString('RIFF'); writeU32(36 + dataSize); writeString('WAVE');
  writeString('fmt '); writeU32(16); writeU16(1); writeU16(numCh);
  writeU32(sampleRate); writeU32(byteRate); writeU16(blockAlign); writeU16(16);
  writeString('data'); writeU32(dataSize);

  const pcm = new Int16Array(buf, 44);
  pcm.set(interleaved);

  return new Blob([buf], { type: 'audio/wav' });
}

async function ensureReversedUrl(au) {
  if (au._revUrl) return au._revUrl;
  await ensureWaveform(au);
  if (!au._audioBuffer) return null;
  try {
    const blob = encodeWav16(au._audioBuffer, { reverse:true });
    au._revUrl = URL.createObjectURL(blob);
    return au._revUrl;
  } catch (e) {
    console.error('ensureReversedUrl', e);
    return null;
  }
}

// Envelope curve: make fade start quieter (ease-in/out quadratic)
function fadeInCurve(posMs, fiMs) {
  if (fiMs <= 0) return 1;
  const t = clamp(posMs / fiMs, 0, 1);
  return t * t;
}
function fadeOutCurve(remainMs, foMs) {
  if (foMs <= 0) return 1;
  const t = clamp(remainMs / foMs, 0, 1);
  return t * t;
}

// ---- Transition helpers (visual clips) ----
const TRANSITION_LABELS = {
  'fade':        'Fade',
  'slide-left':  'Slide Left',
  'slide-right': 'Slide Right',
  'slide-up':    'Slide Up',
  'slide-down':  'Slide Down',
  'wipe-left':   'Wipe Left',
};

function neighborsForItem(item) {
  const arr = PROJECT.items.filter(i=>i.trackIndex===item.trackIndex).sort((a,b)=>a.start-b.start);
  const ix = arr.findIndex(i=>i.id===item.id);
  return { prev: arr[ix-1]||null, next: arr[ix+1]||null };
}

function applyVisualTransitionStyles(el, item, baseScaleStr) {
  applyClipTransitionStyles(el, item, { baseTransform: baseScaleStr, baseOpacity: 1, effectiveEnd: item.end });
}

function resolveClipTransitionState(clip, timeMs, baseOpacity = 1, effectiveEnd = null) {
  if (!clip) {
    return {
      opacity: clamp01(baseOpacity ?? 1),
      translateX: 0,
      translateY: 0,
      clip: null
    };
  }
  const start = clip.start ?? 0;
  const end = Number.isFinite(effectiveEnd)
    ? effectiveEnd
    : (effectiveEnd === Infinity)
      ? Infinity
      : Number.isFinite(clip.end)
        ? clip.end
        : Number.isFinite(clip.duration)
          ? start + clip.duration
          : start;

  const now = timeMs;
  let opacityFactor = clamp01(baseOpacity ?? 1);
  let translateX = 0;
  let translateY = 0;
  let clipState = null;

  const updateWipeWidth = (value) => {
    const w = clamp(Number.isFinite(value) ? value : 0, 0, 1);
    if (!clipState || clipState.type !== 'wipe-left') {
      clipState = { type: 'wipe-left', width: w };
    } else {
      clipState.width = w;
    }
  };

  const applySlide = (dir, progress) => {
    const delta = (1 - progress);
    const distance = 60 * delta;
    if (dir === 'left') translateX += -distance;
    else if (dir === 'right') translateX += distance;
    else if (dir === 'up') translateY += -distance;
    else if (dir === 'down') translateY += distance;
  };

  const applyWipe = (dir, progress) => {
    if (dir === 'left') {
      updateWipeWidth(progress);
    }
    // Future directions could be handled here if added.
  };

  const applyIn = (type, pRaw) => {
    const p = clamp01(pRaw);
    if (type === 'fade' || type === 'fade-white') {
      opacityFactor *= p;
    } else if (type === 'slide-left' || type === 'slide-right' || type === 'slide-up' || type === 'slide-down') {
      const dir = type.split('-')[1];
      applySlide(dir, p);
    } else if (type === 'wipe-left' || type === 'wipe-right' || type === 'wipe-up' || type === 'wipe-down') {
      const dir = type.split('-')[1];
      applyWipe(dir, p);
    }
  };

  const applyOut = (type, pRaw) => {
    const p = clamp01(pRaw);
    if (type === 'fade' || type === 'fade-white') {
      opacityFactor *= p;
    } else if (type === 'slide-left' || type === 'slide-right' || type === 'slide-up' || type === 'slide-down') {
      const dir = type.split('-')[1];
      applySlide(dir, p);
    } else if (type === 'wipe-left' || type === 'wipe-right' || type === 'wipe-up' || type === 'wipe-down') {
      const dir = type.split('-')[1];
      applyWipe(dir, p);
    }
  };

  const inT = clip.transIn;
  if (inT && inT.dur > 0 && now >= start && now < start + inT.dur) {
    const p = (now - start) / Math.max(1, inT.dur);
    applyIn(inT.type, p);
  }

  const outT = clip.transOut;
  if (outT && outT.dur > 0 && now >= end - outT.dur && now < end) {
    const p = (end - now) / Math.max(1, outT.dur);
    applyOut(outT.type, p);
  }

  if (clipState && !Number.isFinite(clipState.width)) {
    clipState = null;
  } else if (clipState && clipState.width <= 0) {
    clipState.width = 0;
  }

  return {
    opacity: clamp01(opacityFactor),
    translateX,
    translateY,
    clip: clipState
  };
}

function applyClipTransitionStyles(el, clip, { baseTransform = '', baseOpacity = 1, effectiveEnd = null } = {}) {
  if (!el || !clip) return;
  const base = baseTransform || '';
  const state = resolveClipTransitionState(clip, currentTime, baseOpacity, effectiveEnd);
  const transforms = [];
  if (Math.abs(state.translateX) > 0.0001) transforms.push(`translateX(${state.translateX}px)`);
  if (Math.abs(state.translateY) > 0.0001) transforms.push(`translateY(${state.translateY}px)`);
  if (base.trim()) transforms.push(base.trim());
  el.style.transform = transforms.join(' ').trim() || base.trim();
  el.style.opacity = String(state.opacity);
  let clipPath = 'none';
  if (state.clip && state.clip.type === 'wipe-left') {
    const pct = clamp(state.clip.width, 0, 1);
    const w = Math.round(pct * 100);
    clipPath = `polygon(0% 0%, ${w}% 0%, ${w}% 100%, 0% 100%)`;
  }
  el.style.clipPath = clipPath;
  if (clipPath === 'none') el.style.removeProperty('clip-path');
}

function handleCrossfades() {
  const trackIdxs = uniqueSorted(PROJECT.items.map(i=>i.trackIndex));
  for (const ti of trackIdxs) {
    const onTrack = PROJECT.items.filter(i=>i.trackIndex===ti).sort((a,b)=>a.start-b.start);
    const C = onTrack.find(i=> currentTime >= i.start && currentTime < i.end);
    if (!C) continue;
    const inT = C.transIn;
    if (!inT || inT.type !== 'crossfade') continue;

    const tInto = currentTime - C.start;
    if (tInto < 0 || tInto >= inT.dur) continue;

    const prev = neighborsForItem(C).prev;
    if (!prev) continue;

    const elPrev = document.querySelector(`.stage-item[data-id="${prev.id}"]`);
    if (!elPrev) continue;

    elPrev.style.display = 'block';
    elPrev.style.clipPath = 'none';
    const posePrev = resolveDisplayPose(prev);
    elPrev.style.transform = `scale(${posePrev.scale})`;
    elPrev.style.opacity = String(1 - clamp(tInto / Math.max(1,inT.dur), 0, 1));
  }
}

// Paint waveform reflecting fade/volume/speed/mute
function paintAudioWaveOnCanvas(canvas, au, tempOffsetMs=null, tempDurTimelineMs=null, tempRate=null) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== w*dpr || canvas.height !== h*dpr) {
    canvas.width = w*dpr;
    canvas.height = h*dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  // center line
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h/2 + 0.5);
  ctx.lineTo(w, h/2 + 0.5);
  ctx.stroke();

  const wave = au._wave;
  if (!wave || !wave.mins || w < 2) { ctx.restore(); return; }

  const rate = tempRate != null ? tempRate : (au.playbackRate || 1);
  const startSourceMs = tempOffsetMs != null ? tempOffsetMs : (au.mediaOffset || 0);
  const durTimelineMs = tempDurTimelineMs != null ? tempDurTimelineMs : Math.max(1, (au.end - au.start));
  const spanSourceMs = durTimelineMs * rate;

  const N = wave.mins.length;
  const fromIdx = Math.floor((startSourceMs / wave.durationMs) * N);
  const toIdx = Math.ceil(Math.min(N, (startSourceMs + spanSourceMs) / wave.durationMs * N));
  const span = Math.max(1, toIdx - fromIdx);
  const bucketsPerPx = span / w;

  const crossIn = Math.max(0, au.crossfadePrevMs || 0);
  const crossOut = Math.max(0, au.crossfadeNextMs || 0);
  const fiMs = Math.max(Math.max(0, (au.fadeInSec || 0) * 1000), crossIn);
  const foMs = Math.max(Math.max(0, (au.fadeOutSec || 0) * 1000), crossOut);
  const volBase = clamp(au.muted ? 0 : (au.volume ?? 1), 0, 1);

  const lineColor = au.muted ? 'rgba(180,180,180,0.85)' : 'rgba(160,190,255,0.95)';
  ctx.strokeStyle = lineColor;
  ctx.beginPath();

  for (let x = 0; x < w; x++) {
    const i0 = Math.floor(fromIdx + x * bucketsPerPx);
    const i1 = Math.min(toIdx, Math.floor(fromIdx + (x+1) * bucketsPerPx));
    let mn = 1, mx = -1;
    const ie = Math.max(i0 + 1, i1);
    for (let i = i0; i < ie; i++) {
      const a = wave.mins[i] ?? 0;
      const b = wave.maxs[i] ?? 0;
      if (a < mn) mn = a;
      if (b > mx) mx = b;
    }

    // envelope at this x in timeline space
    const posMs = (x / Math.max(1, w)) * durTimelineMs;
    const inF = fadeInCurve(posMs, fiMs);
    const outF = fadeOutCurve(durTimelineMs - posMs, foMs);
    const env = clamp(volBase * inF * outF, 0, 1);

    const top = (0.5 - (mx * 0.5 * env)) * h;
    const bot = (0.5 - (mn * 0.5 * env)) * h;
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, bot);
  }
  ctx.stroke();

  ctx.restore();
}

function addAudioWaveCanvas(clip, au) {
  let canvas = clip.querySelector('canvas.waveform');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'waveform';
    canvas.style.cssText = 'position:absolute; inset:0; opacity:.75; pointer-events:none;';
    clip.insertBefore(canvas, clip.firstChild);
  }
  paintAudioWaveOnCanvas(canvas, au, null, null, null);
  ensureWaveform(au).then(()=> {
    if (!au.srcDurationMs) return;
    if (!Number.isFinite(au.end - au.start) || (au.end <= au.start)) {
      au.end = au.start + Math.ceil(au.srcDurationMs / (au.playbackRate || 1));
    }
    paintAudioWaveOnCanvas(canvas, au, null, null, null);
  });
}

function updateAudioClipOverlay(clip, au, selected = false) {
  if (!clip || !au) return;
  const isSelected = !!selected;

  let wrap = clip.querySelector('.vol-wrap');
  if (!isSelected) {
    if (wrap) wrap.remove();
  } else {
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'vol-wrap';
      wrap.style.cssText = `
        position:absolute; top:2px; right:6px; z-index:3;
        display:flex; align-items:center; gap:6px;
        background:rgba(8,12,16,0.85); border:1px solid #2a2f36; border-radius:6px;
        padding:2px 6px; pointer-events:auto;
      `;
      const icon = document.createElement('span');
      icon.textContent = 'VOL';
      icon.style.fontSize = '12px';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '1'; slider.step = '0.01';
      slider.style.cssText = 'width:110px; height:16px;';
      const val = document.createElement('span');
      val.dataset.role = 'vol-value';
      val.style.cssText = 'font-size:11px; min-width:28px; text-align:right;';
      wrap.append(icon, slider, val);
      clip.appendChild(wrap);

      slider.addEventListener('mousedown', e=>e.stopPropagation());
      slider.addEventListener('click', e=>e.stopPropagation());
      slider.addEventListener('input', ()=>{
        au.volume = clamp(parseFloat(slider.value)||0, 0, 1);
        const valEl = wrap.querySelector('[data-role="vol-value"]');
        if (valEl) valEl.textContent = Math.round((au.volume)*100)+'%';
        const canvas = clip.querySelector('canvas.waveform');
        if (canvas) paintAudioWaveOnCanvas(canvas, au, null, null, null);
      });
    }
    const slider = wrap.querySelector('input[type="range"]');
    const val = wrap.querySelector('[data-role="vol-value"]');
    const v = clamp(au.volume ?? 1, 0, 1);
    if (slider) slider.value = String(v);
    if (val) val.textContent = Math.round(v*100)+'%';
  }

  let badge = clip.querySelector('.speed-badge');
  if (!isSelected) {
    if (badge) badge.remove();
  } else {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'speed-badge';
      badge.style.cssText = `
        position:absolute; top:2px; left:6px; z-index:3;
        font-size:11px; padding:1px 6px; border-radius:6px;
        background:rgba(8,12,16,0.85); border:1px solid #2a2f36;
        pointer-events:none; opacity:.95;
      `;
      clip.appendChild(badge);
    }
    const r = (au.playbackRate || 1);
    const label = `${(Math.round(r*100)/100)}x speed${au.reversed ? ' (rev)' : ''}`;
    badge.textContent = label;
  }
}

function refreshAudioClipOverlays() {
  for (const au of PROJECT.audio) {
    const clip = document.querySelector(`.clip[data-id="${au.id}"]`);
    if (!clip) continue;
    const isSelected = selectedClipIds.has(au.id);
    updateAudioClipOverlay(clip, au, isSelected);
  }
}

// ---------- Stage drop / spawn ----------
function onStageDrop(e) {
  e.preventDefault();

  let data = {};
  const txt = e.dataTransfer.getData('text/plain') || '';
  try { data = JSON.parse(txt); } catch { return; }
  if (!data || !data.kind) return;

  const stage = $('#stage');
  const rect = stage.getBoundingClientRect();
  const scale = stagePreviewScale || 1;
  const x = (e.clientX - rect.left) / scale;
  const y = (e.clientY - rect.top) / scale;

  if (data.kind === 'audio' && isAudio(data.path)) {
    const historySnapshot = snapshotProject();
    const trackIdx = getNextTrackIndex('audio');
    const startAt = Math.max(0, Math.round(currentTime));
    const track = {
      id: uid(),
      kind: 'audio',
      name: data.name,
      path: data.path,
      start: startAt,
      end: startAt + 3000,  // provisional; will expand to full file (divided by speed)
      element: null,
      type: 'audio',
      mediaOffset: 0, // ms into source file (forward-space)
      fadeInSec: 0,
      fadeOutSec: 0,
      muted: false,
      volume: 1,
      playbackRate: 1,
      reversed: false,
      srcDurationMs: null,   // filled after decode/metadata
      _revUrl: null,
      _currentSrcKey: null,  // to avoid resetting src every tick
      _needsSeek: true,
      trackIndex: trackIdx,
      crossfadePrevMs: 0,
      crossfadeNextMs: 0,
      effects: cloneAudioEffectDefaults()
    };
    PROJECT.audio.push(track);
    hydrateAudioEffectsObject(track);
    initializeAudioRuntimeState(track, { waveSource: null });
    ensureFullAudioLength(track);
    ensureWaveform(track); // start decoding waveform ASAP
    renderTimeline();
    scheduleAutosave('drop-audio');
    pushHistoryWithSnapshot(historySnapshot, 'add-audio');
    scheduleAutosave('pushHistory:add-audio');
    return;
  }

  const isVideoAsset = isVideo(data.path);
  const isGifAsset = isGifPath(data.path);
  const isImageAsset = isImage(data.path);
  if (!isImageAsset && !isVideoAsset) return;

  const historySnapshot = snapshotProject();
  const trackIdx = getNextTrackIndex('visual');
  const mediaType = isVideoAsset ? 'video' : (isGifAsset ? 'gif' : 'image');
  const item = {
    id: uid(),
    kind: 'visual',
    name: data.name,
    path: data.path,
    x: x, y: y,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    start: Math.min(currentTime, timelineViewportEnd()-500),
    end: Math.min(currentTime + 3000, timelineViewportEnd()),
    loop: mediaType === 'video' ? false : true,
    loopMode: mediaType === 'video' ? 'once' : 'infinite',
    loopCount: 1,
    keyframes: [],
    _editing: false,
    mediaType,
    _gif: null,
    fx: defaultFxSettings(),
    chromaKey: defaultChromaKeySettings(),
    trackIndex: trackIdx,
    transIn:  null,
    transOut: null,
  };
  if (mediaType === 'video') item._autoDuration = true;
  PROJECT.items.push(item);
  spawnStageItem(item);

  if (mediaType === 'gif') {
    if (supportsImageDecoder) {
      prepareGif(item).catch(err => { console.error('prepareGif:', err); fallbackToImg(item); });
    } else {
      fallbackToImg(item);
    }
  }
  if (mediaType === 'video') {
    ensureVideoDuration(item).catch(()=>{});
  }

  refreshStageVisibility();
  renderActiveGifs();
  renderTimeline();
  pushHistoryWithSnapshot(historySnapshot, 'add-visual');
  scheduleAutosave('pushHistory:add-visual');
  selectItem(item.id);
}

// expand dropped audio to its true duration (divided by speed)
async function ensureFullAudioLength(au) {
  const ms = await getAudioDurationMs(au.path);
  if (ms && isFinite(ms) && ms > 0) {
    au.srcDurationMs = ms;
    const maxDur = Math.ceil(ms / (au.playbackRate || 1));
    au.end = au.start + maxDur;
    renderTimeline();
    drawPlayhead();
  }
}

function getAudioDurationMs(path) {
  return new Promise((resolve) => {
    try {
      const el = new Audio(fileUrl(path));
      el.preload = 'metadata';
      const cleanup = ()=>{ el.removeAttribute('src'); try{ el.load(); }catch{} };
      const done = (ms)=>{ cleanup(); resolve(ms||0); };
      el.addEventListener('loadedmetadata', ()=> done((el.duration && isFinite(el.duration)) ? el.duration*1000 : 0), { once:true });
      el.addEventListener('error', ()=> done(0), { once:true });
      setTimeout(()=> done(4000), 4000);
      el.load();
    } catch {
      resolve(0);
    }
  });
}

async function ensureVideoDuration(item, { force = false } = {}) {
  if (!isVideoClip(item) || !item?.path) return;
  if (!force && item._videoDurationMs && !item._autoDuration) return;
  const ms = await getVideoDurationMs(item.path);
  if (!ms) return;
  item._videoDurationMs = ms;
  if (force || item._autoDuration || !Number.isFinite(item.end)) {
    const newEnd = item.start + Math.round(ms);
    const prevEnd = Number.isFinite(item.end) ? item.end : item.start;
    if (!Number.isFinite(item.end) || Math.abs(prevEnd - newEnd) > 10) {
      item.end = newEnd;
      renderTimeline();
    }
    item._autoDuration = false;
  }
}

function getVideoDurationMs(path) {
  return new Promise((resolve) => {
    try {
      const el = document.createElement('video');
      el.preload = 'metadata';
      el.muted = true;
      el.playsInline = true;
      const cleanup = () => {
        el.removeAttribute('src');
        try { el.load(); } catch {}
      };
      const done = (ms) => {
        cleanup();
        resolve(ms || 0);
      };
      el.addEventListener('loadedmetadata', () => {
        const dur = el.duration;
        done((dur && isFinite(dur)) ? dur * 1000 : 0);
      }, { once: true });
      el.addEventListener('error', () => done(0), { once: true });
      el.src = fileUrl(path);
      el.load();
      setTimeout(() => done(0), 4000);
    } catch {
      resolve(0);
    }
  });
}

// ---------- Stage items ----------
const STAGE_LAYER_BASE = { bg: 0, visual: 200000, text: 300000 };
const STAGE_LAYER_RANGE = 100000;

function stageLayerZ(kind, trackIndex) {
  const base = STAGE_LAYER_BASE[kind] ?? STAGE_LAYER_BASE.visual;
  const idx = Number.isInteger(trackIndex) ? trackIndex : 0;
  return base + (STAGE_LAYER_RANGE - idx);
}

function ensureStageItemHandles(el) {
  if (!el || el.querySelector('[data-role="rotate-handles"]')) return;
  const handles = document.createElement('div');
  handles.className = 'stage-item-handles';
  handles.dataset.role = 'rotate-handles';
  handles.style.position = 'absolute';
  handles.style.inset = '0';
  handles.style.transformOrigin = '50% 50%';
  STAGE_ROTATE_HANDLE_POSITIONS.forEach((pos) => {
    const handle = document.createElement('div');
    handle.className = `stage-rotate-handle pos-${pos}`;
    handle.dataset.role = 'rotate-handle';
    handle.dataset.position = pos;
    handle.addEventListener('mousedown', onStageRotateHandleMouseDown);
    handles.appendChild(handle);
  });
  el.appendChild(handles);
  el._rotateHandles = handles;
}

function resetVisualRuntimeState(item) {
  if (!item) return;
  invalidateChromaCache(item);
  stopStageVideoLoop(item);
  if (typeof item._videoChromaCleanup === 'function') {
    try { item._videoChromaCleanup(); } catch {}
  }
  item._videoChromaCleanup = null;
  if (item._videoEl instanceof HTMLVideoElement) {
    try { item._videoEl.pause(); } catch {}
    try { item._videoEl.removeAttribute('src'); item._videoEl.load(); } catch {}
    if (item._videoEl.parentElement) item._videoEl.parentElement.removeChild(item._videoEl);
  }
  delete item._videoEl;
  delete item._videoReady;
  delete item._videoPromise;
  delete item._videoWidth;
  delete item._videoHeight;
  delete item._videoDurationMs;
  delete item._videoPlaying;
  delete item._videoNeedsSeek;
  if (item._videoCanvas instanceof HTMLCanvasElement && item._videoCanvas.parentElement) {
    item._videoCanvas.parentElement.removeChild(item._videoCanvas);
  }
  delete item._videoCanvas;
  delete item._videoCanvasCtx;
  delete item._videoFrameRaf;
  delete item._videoChromaCleanup;
  delete item._imageEl;
  delete item._imageReady;
  delete item._imagePromise;
  delete item._imageWidth;
  delete item._imageHeight;
  delete item._stageCanvas;
  delete item._chromaCanvas;
  delete item._chromaBitmap;
  delete item._chromaHash;
  delete item._chromaSourceWidth;
  delete item._chromaSourceHeight;
  invalidateItemMaskCache(item);
}

async function ensureStaticImageSource(item) {
  if (!item || !item.path) return null;
  if (item._imageEl && item._imageReady) return item._imageEl;
  if (item._imagePromise) return item._imagePromise;
  const prom = loadImageElement(item.path).then((img) => {
    if (img) {
      item._imageEl = img;
      item._imageReady = true;
      item._imageWidth = img.naturalWidth || img.width || 1;
      item._imageHeight = img.naturalHeight || img.height || 1;
      return img;
    }
    item._imageEl = null;
    item._imageReady = false;
    item._imageWidth = 0;
    item._imageHeight = 0;
    return null;
  }).catch((err) => {
    console.warn('ensureStaticImageSource failed', err);
    item._imageEl = null;
    item._imageReady = false;
    item._imageWidth = 0;
    item._imageHeight = 0;
    return null;
  }).finally(() => {
    item._imagePromise = null;
  });
  item._imagePromise = prom;
  return prom;
}

function getStaticChromaCanvas(item, img) {
  if (!item || !img) return null;
  hydrateChromaKey(item);
  if (!chromaKeyIsActive(item.chromaKey)) {
    invalidateChromaCache(item, { deep: false });
    return null;
  }
  const drawable = isDrawableSource(img) ? img : null;
  if (!drawable) return null;
  const dims = getDrawableDimensions(drawable);
  const width = item._imageWidth || dims.width || img.naturalWidth || img.width || 1;
  const height = item._imageHeight || dims.height || img.naturalHeight || img.height || 1;
  const hash = chromaKeyHash(item.chromaKey);
  if (
    item._chromaCanvas instanceof HTMLCanvasElement &&
    item._chromaHash === hash &&
    item._chromaSourceWidth === width &&
    item._chromaSourceHeight === height
  ) {
    return item._chromaCanvas;
  }
  const canvas = item._chromaCanvas instanceof HTMLCanvasElement ? item._chromaCanvas : document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  try {
    ctx.drawImage(drawable, 0, 0, width, height);
  } catch (err) {
    console.warn('getStaticChromaCanvas draw failed', err);
    return null;
  }
  const data = ctx.getImageData(0, 0, width, height);
  applyChromaKeyToImageData(data, item.chromaKey);
  ctx.putImageData(data, 0, 0);
  item._chromaCanvas = canvas;
  item._chromaHash = hash;
  item._chromaSourceWidth = width;
  item._chromaSourceHeight = height;
  return canvas;
}

function drawStaticImageToCanvas(canvas, img, item) {
  if (!canvas || !img) return;
  const dims = getDrawableDimensions(img);
  const width = item?._imageWidth || dims.width || img.naturalWidth || img.width || 1;
  const height = item?._imageHeight || dims.height || img.naturalHeight || img.height || 1;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  let source = (item && getStaticChromaCanvas(item, img)) || img;
  if (!isDrawableSource(source)) source = img;
  if (!isDrawableSource(source)) return;
  try {
    ctx.drawImage(source, 0, 0, width, height);
  } catch (err) {
    console.warn('drawStaticImageToCanvas failed; falling back to base image', err);
    if (source !== img && isDrawableSource(img)) {
      ctx.drawImage(img, 0, 0, width, height);
    }
  }
  applyMaskCompositeToContext(ctx, item, width, height);
}

// ---------- Mask helpers ----------
const MASK_TEXTURE_MAX_DIMENSION = 2048;
const MASK_PRESET_SEGMENTS = 48;
const MASK_VIDEO_PREVIEW_FPS = 30;
const MASK_VIDEO_FRAME_STEP_MS = Math.max(1, Math.round(1000 / MASK_VIDEO_PREVIEW_FPS));

function defaultMaskPreset() {
  return {
    shape: 'square',
    square: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    circle: { cx: 0.5, cy: 0.5, radius: 0.4 },
    ellipse: { cx: 0.5, cy: 0.5, rx: 0.45, ry: 0.35 },
    star: { cx: 0.5, cy: 0.5, outerRadius: 0.45, innerRadius: 0.2, points: 5 },
    freehand: { points: [] }
  };
}

function maskFrameKeyForGif(index) {
  const idx = Math.max(0, Number.isFinite(index) ? Math.round(index) : 0);
  return `gif:${idx}`;
}

function maskFrameKeyForVideo(timeMs) {
  const ms = Math.max(0, Number.isFinite(timeMs) ? Math.round(timeMs) : 0);
  return `vid:${ms}`;
}

function ensureMaskFrameStore(item) {
  if (!item || typeof item !== 'object') return null;
  if (!item.maskFrames || typeof item.maskFrames !== 'object') {
    item.maskFrames = {};
  }
  return item.maskFrames;
}

function hasAnyFrameMasks(item) {
  if (!item?.maskFrames || typeof item.maskFrames !== 'object') return false;
  return Object.keys(item.maskFrames).length > 0;
}

function getFrameMaskDefinition(item, frameKey) {
  if (!item?.maskFrames || !frameKey) return null;
  const def = item.maskFrames[frameKey];
  return def ? cloneMask(def) : null;
}

function cloneMaskFrames(frames) {
  if (!frames || typeof frames !== 'object') return null;
  const copy = {};
  for (const [key, value] of Object.entries(frames)) {
    const def = cloneMask(value);
    if (def) copy[key] = def;
  }
  return copy;
}

function cloneMask(mask) {
  if (!mask || typeof mask !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(mask));
  } catch {
    return null;
  }
}

function invalidateItemMaskCache(item) {
  if (!item || typeof item !== 'object') return;
  delete item._maskTextureKey;
  delete item._maskTextureDataUrl;
  delete item._maskTextureCanvas;
  delete item._maskSourceCanvas;
  delete item._maskTextureCache;
  delete item._maskSourceCache;
}

function maskRoundCoord(v) {
  return Math.round(clamp01(Number(v) || 0) * 10_000) / 10_000;
}

function sanitizeMaskPoints(rawPoints) {
  if (!Array.isArray(rawPoints) || rawPoints.length < 3) return null;
  const points = [];
  for (const entry of rawPoints) {
    const x = maskRoundCoord(entry?.x ?? entry?.[0]);
    const y = maskRoundCoord(entry?.y ?? entry?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (points.length) {
      const prev = points[points.length - 1];
      if (Math.abs(prev.x - x) < 0.0001 && Math.abs(prev.y - y) < 0.0001) continue;
    }
    points.push({ x, y });
  }
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.x - last.x) < 0.0001 && Math.abs(first.y - last.y) < 0.0001) {
    points.pop();
  }
  return points.length >= 3 ? points : null;
}

function maskRectToPoints(rect = {}) {
  let x = Number(rect.x);
  let y = Number(rect.y);
  let w = Number(rect.width);
  let h = Number(rect.height);
  if (!Number.isFinite(x)) x = 0.1;
  if (!Number.isFinite(y)) y = 0.1;
  if (!Number.isFinite(w) || w <= 0) w = 0.8;
  if (!Number.isFinite(h) || h <= 0) h = 0.8;
  const x2 = maskRoundCoord(x + w);
  const y2 = maskRoundCoord(y + h);
  const x0 = maskRoundCoord(x);
  const y0 = maskRoundCoord(y);
  return sanitizeMaskPoints([
    { x: x0, y: y0 },
    { x: x2, y: y0 },
    { x: x2, y: y2 },
    { x: x0, y: y2 }
  ]);
}

function maskCircleToPoints(circle = {}) {
  const seg = Math.max(12, Number(circle.segments) || MASK_PRESET_SEGMENTS);
  const cx = maskRoundCoord(circle.cx ?? circle.x ?? 0.5);
  const cy = maskRoundCoord(circle.cy ?? circle.y ?? 0.5);
  const radius = clamp01(Number(circle.radius) || 0.45);
  const rotation = Number(circle.rotation) || 0;
  const pts = [];
  const step = (Math.PI * 2) / seg;
  for (let i = 0; i < seg; i++) {
    const angle = rotation + i * step;
    pts.push({
      x: maskRoundCoord(cx + Math.cos(angle) * radius),
      y: maskRoundCoord(cy + Math.sin(angle) * radius)
    });
  }
  return sanitizeMaskPoints(pts);
}

function maskEllipseToPoints(ellipse = {}) {
  const seg = Math.max(12, Number(ellipse.segments) || MASK_PRESET_SEGMENTS);
  const cx = maskRoundCoord(ellipse.cx ?? ellipse.x ?? 0.5);
  const cy = maskRoundCoord(ellipse.cy ?? ellipse.y ?? 0.5);
  const rx = clamp01(Number(ellipse.rx ?? ellipse.radiusX ?? ellipse.width ?? ellipse.size) || 0.45);
  const ry = clamp01(Number(ellipse.ry ?? ellipse.radiusY ?? ellipse.height ?? ellipse.size) || 0.35);
  const rotation = Number(ellipse.rotation) || 0;
  const pts = [];
  const step = (Math.PI * 2) / seg;
  for (let i = 0; i < seg; i++) {
    const angle = rotation + i * step;
    pts.push({
      x: maskRoundCoord(cx + Math.cos(angle) * rx),
      y: maskRoundCoord(cy + Math.sin(angle) * ry)
    });
  }
  return sanitizeMaskPoints(pts);
}

function maskStarToPoints(star = {}) {
  const spikes = Math.max(3, Math.round(Number(star.points) || 5));
  const cx = maskRoundCoord(star.cx ?? star.x ?? 0.5);
  const cy = maskRoundCoord(star.cy ?? star.y ?? 0.5);
  const inner = clamp01(Number(star.innerRadius ?? star.inner) || 0.2);
  const outer = clamp01(Number(star.outerRadius ?? star.outer) || 0.45);
  const rotation = Number(star.rotation) || -Math.PI / 2;
  const pts = [];
  const step = Math.PI / spikes;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = rotation + i * step;
    pts.push({
      x: maskRoundCoord(cx + Math.cos(angle) * r),
      y: maskRoundCoord(cy + Math.sin(angle) * r)
    });
  }
  return sanitizeMaskPoints(pts);
}

function normalizeMaskShapeName(shape) {
  if (!shape || typeof shape !== 'string') return '';
  const key = shape.trim().toLowerCase();
  if (key === 'rectangle' || key === 'rect') return 'square';
  if (key === 'oval' || key === 'eclipse') return 'ellipse';
  return key;
}

function normalizedMaskPoints(mask) {
  if (!mask || typeof mask !== 'object') return null;
  if (Array.isArray(mask.points)) {
    const pts = sanitizeMaskPoints(mask.points);
    if (pts) return pts;
  }
  const shape = (mask.shape || mask.type || '').toLowerCase();
  if (shape === 'square' || shape === 'rectangle' || shape === 'rect') {
    return maskRectToPoints(mask.rect || mask);
  }
  if (shape === 'circle') {
    return maskCircleToPoints(mask.circle || mask);
  }
  if (shape === 'ellipse' || shape === 'oval' || shape === 'eclipse') {
    return maskEllipseToPoints(mask.ellipse || mask);
  }
  if (shape === 'star') {
    return maskStarToPoints(mask.star || mask);
  }
  if (shape === 'freehand' || shape === 'polygon' || shape === 'custom') {
    const pts = sanitizeMaskPoints(mask.points);
    if (pts) return pts;
  }
  return null;
}

function activeMaskForItem(item, { frameKey = null, fallbackDefault = true } = {}) {
  if (!item || typeof item !== 'object') return null;
  let mask = null;
  if (frameKey && item.maskFrames && item.maskFrames[frameKey]) {
    mask = item.maskFrames[frameKey];
  }
  if (!mask && fallbackDefault) {
    mask = item.mask;
  }
  if (!mask || typeof mask !== 'object') return null;
  if (mask.disabled || mask.enabled === false) return null;
  const points = normalizedMaskPoints(mask);
  if (!points || points.length < 3) return null;
  const mode = mask.mode === 'remove' ? 'remove' : 'keep';
  const version = Number.isFinite(mask.version) ? mask.version : 0;
  const shape = typeof mask.shape === 'string' ? mask.shape : (typeof mask.type === 'string' ? mask.type : 'custom');
  return { points, mode, version, shape, frameKey: mask === item.mask ? null : frameKey };
}

function maskPointsKey(points) {
  return points.map(p => `${maskRoundCoord(p.x)},${maskRoundCoord(p.y)}`).join(';');
}

function getMaskBaseDimensions(item) {
  if (!item || typeof item !== 'object') return { width: 512, height: 512 };
  const width = Math.max(
    32,
    Math.round(
      Number(item._videoWidth) ||
      Number(item._imageWidth) ||
      Number(item._chromaSourceWidth) ||
      Number(item._gif?.width) ||
      Number(item.width) ||
      512
    )
  );
  const height = Math.max(
    32,
    Math.round(
      Number(item._videoHeight) ||
      Number(item._imageHeight) ||
      Number(item._chromaSourceHeight) ||
      Number(item._gif?.height) ||
      Number(item.height) ||
      512
    )
  );
  return {
    width: Math.min(width, MASK_TEXTURE_MAX_DIMENSION),
    height: Math.min(height, MASK_TEXTURE_MAX_DIMENSION)
  };
}

function traceMaskPath(ctx, points, width, height) {
  if (!ctx || !Array.isArray(points) || points.length < 3) return;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const px = clamp01(p.x) * width;
    const py = clamp01(p.y) * height;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function ensureItemMaskTexture(item, baseWidth = null, baseHeight = null, options = null) {
  const opts = options || {};
  const mask = activeMaskForItem(item, opts);
  if (!mask) return null;
  const dims = getMaskBaseDimensions(item);
  const width = Math.max(4, Math.min(MASK_TEXTURE_MAX_DIMENSION, Math.round(baseWidth || dims.width)));
  const height = Math.max(4, Math.min(MASK_TEXTURE_MAX_DIMENSION, Math.round(baseHeight || dims.height)));
  const frameKey = opts.frameKey || 'clip';
  if (!item._maskTextureCache || typeof item._maskTextureCache !== 'object') {
    item._maskTextureCache = {};
  }
  const cacheEntry = item._maskTextureCache[frameKey];
  const key = `${frameKey}|${mask.version}|${mask.mode}|${mask.shape}|${maskPointsKey(mask.points)}|${width}x${height}`;
  if (cacheEntry && cacheEntry.key === key) {
    return cacheEntry.texture;
  }
  const canvas = item._maskTextureCanvas instanceof HTMLCanvasElement ? item._maskTextureCanvas : document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = mask.mode === 'remove' ? '#ffffff' : '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = mask.mode === 'remove' ? '#000000' : '#ffffff';
  ctx.beginPath();
  traceMaskPath(ctx, mask.points, width, height);
  ctx.closePath();
  ctx.fill();
  let dataUrl = null;
  try {
    dataUrl = canvas.toDataURL();
  } catch (err) {
    console.warn('mask toDataURL failed', err);
    dataUrl = null;
  }
  if (!dataUrl) return null;
  const texture = {
    dataUrl,
    width,
    height,
    mode: mask.mode
  };
  item._maskTextureCache[frameKey] = { key, texture };
  if (!opts.frameKey) {
    item._maskTextureCanvas = canvas;
    item._maskTextureDataUrl = dataUrl;
    item._maskTextureKey = key;
  }
  return texture;
}

function applyStageMaskToElement(item, el) {
  if (!el) return;
  const hasFrameMasks = item.maskFrames && Object.keys(item.maskFrames).length > 0;
  const animated = isGifPath(item.path) || item.mediaType === 'gif' || isVideoClip(item);
  if (animated && hasFrameMasks) {
    applyMaskTextureStyles(el, null);
    return;
  }
  const maskTexture = ensureItemMaskTexture(item);
  applyMaskTextureStyles(el, null);
  const targets = el.querySelectorAll(
    'canvas[data-role="visual-canvas"], canvas[data-role="gif-canvas"], canvas[data-role="visual-video-canvas"], video[data-role="visual-video"]'
  );
  targets.forEach(node => applyMaskTextureStyles(node, maskTexture));
}

function ensureMaskedSourceCanvas(item, source, width, height, options = null) {
  const opts = options || {};
  const mask = activeMaskForItem(item, opts);
  if (!mask) return null;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (!item._maskSourceCache || typeof item._maskSourceCache !== 'object') {
    item._maskSourceCache = {};
  }
  const frameKey = opts.frameKey || 'clip';
  const cacheEntry = item._maskSourceCache[frameKey];
  let canvas = cacheEntry?.canvas instanceof HTMLCanvasElement ? cacheEntry.canvas : document.createElement('canvas');
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch (err) {
    console.warn('mask drawImage failed', err);
    return null;
  }
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.globalCompositeOperation = mask.mode === 'remove' ? 'destination-out' : 'destination-in';
  ctx.beginPath();
  traceMaskPath(ctx, mask.points, w, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  const key = `${frameKey}|${mask.version}|${mask.mode}|${mask.shape}|${maskPointsKey(mask.points)}|${w}x${h}`;
  item._maskSourceCache[frameKey] = { key, canvas };
  if (!opts.frameKey) {
    item._maskSourceCanvas = canvas;
  }
  return canvas;
}

function applyMaskCompositeToContext(ctx, item, width, height, options = null) {
  if (!ctx || !item) return;
  const opts = (options && typeof options === 'object') ? options : {};
  const mask = activeMaskForItem(item, opts);
  if (!mask) return;
  const w = Math.max(1, Math.round(width || ctx.canvas?.width || 0));
  const h = Math.max(1, Math.round(height || ctx.canvas?.height || 0));
  if (!w || !h) return;
  ctx.save();
  ctx.globalCompositeOperation = mask.mode === 'remove' ? 'destination-out' : 'destination-in';
  ctx.beginPath();
  traceMaskPath(ctx, mask.points, w, h);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

function applyMaskTextureStyles(target, texture) {
  if (!target) return;
  if (!texture) {
    target.style.removeProperty('mask-image');
    target.style.removeProperty('mask-size');
    target.style.removeProperty('mask-repeat');
    target.style.removeProperty('mask-position');
    target.style.removeProperty('mask-mode');
    target.style.removeProperty('-webkit-mask-image');
    target.style.removeProperty('-webkit-mask-size');
    target.style.removeProperty('-webkit-mask-repeat');
    target.style.removeProperty('-webkit-mask-position');
    target.style.removeProperty('-webkit-mask-composite');
    target.removeAttribute('data-mask-mode');
    return;
  }
  const url = `url("${texture.dataUrl}")`;
  target.style.maskImage = url;
  target.style.maskSize = '100% 100%';
  target.style.maskRepeat = 'no-repeat';
  target.style.maskPosition = '0 0';
  target.style.maskMode = 'alpha';
  target.style.webkitMaskImage = url;
  target.style.webkitMaskSize = '100% 100%';
  target.style.webkitMaskRepeat = 'no-repeat';
  target.style.webkitMaskPosition = '0 0';
  target.style.webkitMaskComposite = 'source-over';
  target.dataset.maskMode = texture.mode;
}

function refreshStageMaskPreview(item) {
  if (!item) return;
  if (item.kind && item.kind !== 'visual') return;
  const type = item.mediaType || (isVideo(item.path) ? 'video' : (isGifPath(item.path) ? 'gif' : 'image'));
  if (type === 'image') {
    refreshStageStaticCanvas(item);
  } else if (type === 'gif') {
    renderActiveGifs();
  } else if (type === 'video') {
    syncStageVideoChroma(item, { forceFrame: true });
  }
}

function bumpMaskVersion(mask) {
  if (!mask || typeof mask !== 'object') return;
  const next = Number.isFinite(mask.version) ? Number(mask.version) + 1 : 1;
  mask.version = next;
}

function applyMaskDefinitionToItem(item, definition, { mode = null, frameKey = null } = {}) {
  if (!item || typeof item !== 'object') return null;
  const maskDef = cloneMask(definition);
  if (!maskDef) {
    if (frameKey && item.maskFrames && item.maskFrames[frameKey]) {
      delete item.maskFrames[frameKey];
      if (!Object.keys(item.maskFrames).length) delete item.maskFrames;
      invalidateItemMaskCache(item);
      positionStageItem(item);
      refreshStageMaskPreview(item);
      return null;
    }
    delete item.mask;
    invalidateItemMaskCache(item);
    positionStageItem(item);
    refreshStageMaskPreview(item);
    return null;
  }
  if (mode) maskDef.mode = mode;
  if (!maskDef.shape && maskDef.type) maskDef.shape = maskDef.type;
  bumpMaskVersion(maskDef);
  if (frameKey) {
    const store = ensureMaskFrameStore(item);
    store[frameKey] = maskDef;
  } else {
    item.mask = maskDef;
  }
  invalidateItemMaskCache(item);
  positionStageItem(item);
  refreshStageMaskPreview(item);
  return maskDef;
}

function clearItemMask(item, { frameKey = null } = {}) {
  if (!item || typeof item !== 'object') return;
  if (frameKey) {
    if (item.maskFrames && item.maskFrames[frameKey]) {
      delete item.maskFrames[frameKey];
      if (!Object.keys(item.maskFrames).length) delete item.maskFrames;
      invalidateItemMaskCache(item);
      positionStageItem(item);
      refreshStageMaskPreview(item);
    }
    return;
  }
  if (!item.mask) return;
  delete item.mask;
  invalidateItemMaskCache(item);
  positionStageItem(item);
  refreshStageMaskPreview(item);
}

function cloneVisualItemStructure(item, overrides = {}) {
  if (!item || typeof item !== 'object') return null;
  const {
    _el,
    _gif,
    element,
    _imageEl,
    _imageReady,
    _imagePromise,
    _imageWidth,
    _imageHeight,
    _stageCanvas,
    _chromaCanvas,
    _chromaBitmap,
    _chromaHash,
    _chromaSourceWidth,
    _chromaSourceHeight,
    _videoEl,
    _videoReady,
    _videoPromise,
    _videoWidth,
    _videoHeight,
    _videoDurationMs,
    _videoPlaying,
    _videoNeedsSeek,
    _autoDuration,
    _videoCanvas,
    _videoCanvasCtx,
    _videoFrameRaf,
    _videoChromaCleanup,
    _maskTextureKey,
    _maskTextureDataUrl,
    _maskTextureCanvas,
    _maskSourceCanvas,
    ...rest
  } = item;
  const clone = { ...rest, ...overrides };
  clone.id = overrides.id || uid();
  clone._editing = false;
  clone._gif = null;
  clone.fx = cloneFx(item.fx);
  clone.chromaKey = cloneChromaKey(item.chromaKey);
  clone.mask = overrides.mask ? cloneMask(overrides.mask) : cloneMask(item.mask);
  const sourceMaskFrames = overrides.maskFrames
    ? overrides.maskFrames
    : (item.maskFrames || null);
  clone.maskFrames = sourceMaskFrames ? cloneMaskFrames(sourceMaskFrames) : null;
  clone.keyframes = Array.isArray(item.keyframes) ? item.keyframes.map(k => ({ ...k })) : [];
  resetVisualRuntimeState(clone);
  hydrateFx(clone);
  hydrateChromaKey(clone);
  invalidateItemMaskCache(clone);
  return clone;
}

function splitVisualItemIntoMaskedLayers(item, maskDefinition, { trackOffset = 0 } = {}) {
  if (!item || item.kind !== 'visual') return null;
  const baseMask = cloneMask(maskDefinition);
  if (!baseMask) return null;
  if (!baseMask.shape && baseMask.type) baseMask.shape = baseMask.type;
  const keepMask = cloneMask(baseMask);
  const removeMask = cloneMask(baseMask);
  if (!keepMask || !removeMask) return null;
  keepMask.mode = 'keep';
  removeMask.mode = 'remove';
  bumpMaskVersion(keepMask);
  bumpMaskVersion(removeMask);
  const overrides = { mask: keepMask };
  if (item.maskFrames && typeof item.maskFrames === 'object') {
    const keepFrames = cloneMaskFrames(item.maskFrames);
    if (keepFrames) {
      Object.values(keepFrames).forEach((def) => {
        if (!def) return;
        def.mode = 'keep';
        bumpMaskVersion(def);
      });
      overrides.maskFrames = keepFrames;
    }
    Object.entries(item.maskFrames).forEach(([key, def]) => {
      if (!def) return;
      def.mode = 'remove';
      bumpMaskVersion(def);
      item.maskFrames[key] = def;
    });
  }
  if (Number.isInteger(trackOffset) && Number.isFinite(item.trackIndex)) {
    overrides.trackIndex = Math.max(0, (item.trackIndex ?? 0) + trackOffset);
  }
  const clone = cloneVisualItemStructure(item, overrides);
  item.mask = removeMask;
  invalidateItemMaskCache(item);
  positionStageItem(item);
  refreshStageMaskPreview(item);
  refreshStageMaskPreview(clone);
  return clone;
}

async function populateStageStaticCanvas(item, canvas) {
  if (!item || !canvas) return;
  const img = await ensureStaticImageSource(item);
  if (!img) return;
  drawStaticImageToCanvas(canvas, img, item);
  positionStageItem(item);
}

function refreshStageStaticCanvas(item) {
  if (!item) return;
  const holder = document.querySelector(`.stage-item[data-id="${item.id}"]`);
  if (!holder) return;
  const canvas = holder.querySelector('canvas[data-role="visual-canvas"]');
  if (!canvas) return;
  if (item._imageEl && item._imageReady) {
    drawStaticImageToCanvas(canvas, item._imageEl, item);
    positionStageItem(item);
  } else {
    ensureStaticImageSource(item).then((img) => {
      if (!img) return;
      if (!canvas.isConnected) return;
      drawStaticImageToCanvas(canvas, img, item);
      positionStageItem(item);
    });
  }
}

function ensureGifFrameChromaCanvas(item, frame) {
  if (!item || !frame || !frame.bitmap) return null;
  hydrateChromaKey(item);
  if (!chromaKeyIsActive(item.chromaKey)) {
    if (frame._chromaCanvas) {
      frame._chromaCanvas.width = frame._chromaCanvas.width;
    }
    releaseImageBitmap(frame._chromaBitmap);
    delete frame._chromaCanvas;
    delete frame._chromaBitmap;
    delete frame._chromaHash;
    return null;
  }
  const bmp = frame.bitmap;
  const width = bmp.displayWidth || bmp.codedWidth || bmp.width || 1;
  const height = bmp.displayHeight || bmp.codedHeight || bmp.height || 1;
  const hash = chromaKeyHash(item.chromaKey);
  if (
    frame._chromaCanvas instanceof HTMLCanvasElement &&
    frame._chromaHash === hash &&
    frame._chromaCanvas.width === width &&
    frame._chromaCanvas.height === height
  ) {
    return frame._chromaCanvas;
  }
  const canvas = frame._chromaCanvas instanceof HTMLCanvasElement ? frame._chromaCanvas : document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  applyChromaKeyToImageData(data, item.chromaKey);
  ctx.putImageData(data, 0, 0);
  frame._chromaCanvas = canvas;
  frame._chromaHash = hash;
  return canvas;
}

function ensureGifFrameBitmapCanvas(frame) {
  if (!frame || !frame.bitmap) return null;
  const bmp = frame.bitmap;
  const width = bmp.displayWidth || bmp.codedWidth || bmp.width || 1;
  const height = bmp.displayHeight || bmp.codedHeight || bmp.height || 1;
  const canvas = frame._bitmapCanvas instanceof HTMLCanvasElement ? frame._bitmapCanvas : document.createElement('canvas');
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  try {
    if (typeof ctx.transferFromImageBitmap === 'function') {
      ctx.transferFromImageBitmap(bmp);
    } else {
      ctx.drawImage(bmp, 0, 0, width, height);
    }
  } catch (err) {
    console.warn('ensureGifFrameBitmapCanvas draw failed', err);
    return null;
  }
  frame._bitmapCanvas = canvas;
  return canvas;
}

function spawnStageItem(item) {
  hydrateFx(item);
  hydrateChromaKey(item);
  const el = document.createElement('div');
  el.className = 'stage-item';
  el.dataset.id = item.id;
  el.style.position = 'absolute';
  el.style.willChange = 'transform, opacity';
  const mediaTypeRaw = typeof item.mediaType === 'string' ? item.mediaType.toLowerCase() : '';
  const resolvedMediaType = mediaTypeRaw || (isGifPath(item.path) ? 'gif' : (isVideo(item.path) ? 'video' : 'image'));
  item.mediaType = resolvedMediaType;
  el.dataset.mediaType = resolvedMediaType;

  if (resolvedMediaType === 'gif') {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    canvas.dataset.role = 'gif-canvas';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    el.appendChild(canvas);
    item._stageCanvas = canvas;
  } else if (resolvedMediaType === 'video') {
    setupStageVideoElement(item, el);
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    canvas.dataset.role = 'visual-canvas';
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'none';
    el.appendChild(canvas);
    item._stageCanvas = canvas;
    populateStageStaticCanvas(item, canvas);
  }

  ensureStageItemHandles(el);
  $('#stage').appendChild(el);
  positionStageItem(item);
  if (resolvedMediaType === 'video') {
    ensureVideoDuration(item).catch(()=>{});
  }
}

function setupStageVideoElement(item, holder) {
  if (!item || !holder) return;
  let video = item._videoEl;
  if (!(video instanceof HTMLVideoElement)) {
    video = document.createElement('video');
    item._videoEl = video;
  } else if (video.parentElement && video.parentElement !== holder) {
    video.parentElement.removeChild(video);
  }
  if (!video.dataset) video.dataset = {};
  video.dataset.role = 'visual-video';
  video.playsInline = true;
  video.muted = true;
  video.controls = false;
  video.autoplay = false;
  video.loop = false;
  video.preload = 'metadata';
  video.style.display = 'block';
  video.style.pointerEvents = 'none';
  video.style.maxWidth = 'none';
  video.style.maxHeight = 'none';
  video.style.objectFit = 'contain';
  if (!video.isConnected) {
    holder.appendChild(video);
  } else if (video.parentElement !== holder) {
    holder.appendChild(video);
  }
  ensureStageVideoCanvas(item, holder);
  stopStageVideoLoop(item);
  if (typeof item._videoChromaCleanup === 'function') {
    try { item._videoChromaCleanup(); } catch {}
  }
  const onVideoPlay = () => {
    syncStageVideoChroma(item);
    startStageVideoLoop(item);
  };
  const onVideoPause = () => {
    stopStageVideoLoop(item);
    syncStageVideoChroma(item, { forceFrame: true });
  };
  const onVideoSeeked = () => {
    syncStageVideoChroma(item, { forceFrame: true });
  };
  const onVideoLoadedData = () => {
    syncStageVideoChroma(item, { forceFrame: true });
  };
  const onVideoEmptied = () => {
    stopStageVideoLoop(item);
    if (item._videoCanvasCtx && item._videoCanvas instanceof HTMLCanvasElement) {
      item._videoCanvasCtx.clearRect(0, 0, item._videoCanvas.width, item._videoCanvas.height);
    }
  };
  video.addEventListener('play', onVideoPlay);
  video.addEventListener('pause', onVideoPause);
  video.addEventListener('seeked', onVideoSeeked);
  video.addEventListener('loadeddata', onVideoLoadedData);
  video.addEventListener('emptied', onVideoEmptied);
  item._videoChromaCleanup = () => {
    video.removeEventListener('play', onVideoPlay);
    video.removeEventListener('pause', onVideoPause);
    video.removeEventListener('seeked', onVideoSeeked);
    video.removeEventListener('loadeddata', onVideoLoadedData);
    video.removeEventListener('emptied', onVideoEmptied);
  };
  item._videoReady = false;
  item._videoNeedsSeek = true;
  item._videoPlaying = false;
  const src = fileUrl(item.path);
  if (video.src !== src) {
    try {
      video.src = src;
    } catch {
      video.setAttribute('src', src);
    }
    try { video.load(); } catch {}
  }
  const onMeta = () => {
    video.removeEventListener('loadedmetadata', onMeta);
    handleStageVideoMetadata(item, video);
  };
  const onError = () => {
    video.removeEventListener('error', onError);
    item._videoReady = false;
    item._videoWidth = 0;
    item._videoHeight = 0;
  };
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('error', onError);
  if (video.readyState >= 1) {
    video.removeEventListener('loadedmetadata', onMeta);
    video.removeEventListener('error', onError);
    handleStageVideoMetadata(item, video);
  }
  syncStageVideoChroma(item);
}

function handleStageVideoMetadata(item, video) {
  if (!item || !(video instanceof HTMLVideoElement)) return;
  item._videoReady = true;
  const vw = video.videoWidth || video.width || 0;
  const vh = video.videoHeight || video.height || 0;
  if (vw > 0 && vh > 0) {
    video.style.width = `${vw}px`;
    video.style.height = `${vh}px`;
    item._videoWidth = vw;
    item._videoHeight = vh;
    item._imageWidth = vw;
    item._imageHeight = vh;
  } else {
    video.style.removeProperty('width');
    video.style.removeProperty('height');
  }
  try { video.currentTime = 0; } catch {}
  try { video.pause(); } catch {}
  const dur = (video.duration && isFinite(video.duration)) ? video.duration * 1000 : 0;
  if (dur > 0) {
    const rounded = Math.round(dur);
    item._videoDurationMs = rounded;
    if (item._autoDuration) {
      const newEnd = item.start + rounded;
      const prevEnd = Number.isFinite(item.end) ? item.end : item.start;
      if (!Number.isFinite(item.end) || Math.abs(prevEnd - newEnd) > 10) {
        item.end = newEnd;
        renderTimeline();
      }
      item._autoDuration = false;
    }
  }
  syncStageVideoChroma(item, { forceFrame: true });
  positionStageItem(item);
}

function ensureStageVideoCanvas(item, holder = null) {
  if (!item) return null;
  const container = holder || document.querySelector(`.stage-item[data-id="${item.id}"]`);
  if (!container) return null;
  let canvas = item._videoCanvas;
  if (!(canvas instanceof HTMLCanvasElement) || canvas.dataset.role !== 'visual-video-canvas') {
    if (canvas instanceof HTMLCanvasElement && canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    canvas = document.createElement('canvas');
    canvas.dataset.role = 'visual-video-canvas';
    canvas.style.display = 'none';
    canvas.style.pointerEvents = 'none';
    canvas.style.userSelect = 'none';
    const handles = container.querySelector('.stage-item-handles');
    if (handles) container.insertBefore(canvas, handles);
    else container.appendChild(canvas);
    item._videoCanvas = canvas;
    item._videoCanvasCtx = canvas.getContext('2d', { willReadFrequently: true });
  } else if (canvas.parentElement !== container) {
    const handles = container.querySelector('.stage-item-handles');
    if (handles) container.insertBefore(canvas, handles);
    else container.appendChild(canvas);
  }
  if (!item._videoCanvasCtx || item._videoCanvasCtx.canvas !== canvas) {
    item._videoCanvasCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return canvas;
}

function updateStageVideoCanvasSize(item) {
  const canvas = item?._videoCanvas;
  const video = item?._videoEl;
  if (!(canvas instanceof HTMLCanvasElement)) return false;
  const rawWidth = item._videoWidth || video?.videoWidth || video?.width || 0;
  const rawHeight = item._videoHeight || video?.videoHeight || video?.height || 0;
  if (!rawWidth || !rawHeight) return false;
  const width = Math.max(1, Math.round(rawWidth));
  const height = Math.max(1, Math.round(rawHeight));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  return true;
}

function drawStageVideoFrame(item) {
  if (!item) return false;
  const video = item._videoEl;
  const canvas = item._videoCanvas;
  const ctx = item._videoCanvasCtx;
  if (!(video instanceof HTMLVideoElement) || !(canvas instanceof HTMLCanvasElement) || !ctx) return false;
  if (video.readyState < 2) return false;
  const chroma = hydrateChromaKey(item);
  const chromaActive = chromaKeyIsActive(chroma);
  if (!updateStageVideoCanvasSize(item)) return false;
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return false;
  try {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(video, 0, 0, width, height);
  } catch (err) {
    console.warn('stage video draw failed', err);
    return false;
  }
  if (chromaActive) {
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (err) {
      console.warn('stage video getImageData failed', err);
      imageData = null;
    }
    if (imageData) {
      applyChromaKeyToImageData(imageData, chroma);
      try {
        ctx.putImageData(imageData, 0, 0);
      } catch (err) {
        console.warn('stage video putImageData failed', err);
      }
    }
  }
  const frameKey = maskFrameKeyForVideo((video.currentTime || 0) * 1000);
  applyMaskCompositeToContext(ctx, item, width, height, { frameKey });
  return true;
}

function stopStageVideoLoop(item) {
  if (!item) return;
  if (item._videoFrameRaf != null) {
    cancelAnimationFrame(item._videoFrameRaf);
    item._videoFrameRaf = null;
  }
}

function startStageVideoLoop(item) {
  if (!item || item._videoFrameRaf != null) return;
  const loop = () => {
    item._videoFrameRaf = null;
    const video = item._videoEl;
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.paused || video.ended) {
      drawStageVideoFrame(item);
      return;
    }
    drawStageVideoFrame(item);
    item._videoFrameRaf = requestAnimationFrame(loop);
  };
  item._videoFrameRaf = requestAnimationFrame(loop);
}

function syncStageVideoChroma(item, { forceFrame = false } = {}) {
  if (!item) return;
  const video = item._videoEl;
  if (!(video instanceof HTMLVideoElement)) return;
  const holder = document.querySelector(`.stage-item[data-id="${item.id}"]`);
  if (!holder) return;
  const canvas = ensureStageVideoCanvas(item, holder);
  if (!canvas) return;

  const chroma = hydrateChromaKey(item);
  const chromaActive = chromaKeyIsActive(chroma);
  const frameMaskActive = hasAnyFrameMasks(item);
  const needsCanvas = chromaActive || frameMaskActive;
  if (!needsCanvas) {
    stopStageVideoLoop(item);
    canvas.style.display = 'none';
    if (canvas.width && canvas.height) {
      const ctx = item._videoCanvasCtx;
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    video.style.opacity = '';
    video.style.visibility = '';
    return;
  }

  if (!updateStageVideoCanvasSize(item)) {
    return;
  }
  canvas.style.display = 'block';
  video.style.opacity = '0';
  video.style.visibility = 'hidden';
  if (forceFrame || video.paused || video.ended) {
    drawStageVideoFrame(item);
  }
  if (!video.paused && !video.ended) {
    startStageVideoLoop(item);
  }
}

// ---------- GIF decoding / rendering ----------
async function prepareGif(item) {
  try {
    if (!supportsImageDecoder) return fallbackToImg(item);
    if (!window.suAPI?.readFileBytes) return fallbackToImg(item);

    const raw = await window.suAPI.readFileBytes(item.path);
    if (!raw) return fallbackToImg(item);

    let u8;
    if (raw instanceof Uint8Array) u8 = raw;
    else if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
    else if (raw?.buffer instanceof ArrayBuffer) u8 = new Uint8Array(raw.buffer);
    else if (Array.isArray(raw?.data)) u8 = new Uint8Array(raw.data);
    else return fallbackToImg(item);

    let decoder = new ImageDecoder({ data: u8, type: 'image/gif' });
    const frames = [];
    let totalDur = 0;

    let frameCount = decoder.tracks?.selectedTrack?.frameCount ?? null;

    if (typeof frameCount === 'number' && frameCount > 0) {
      for (let i = 0; i < frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        const durUs = decoder.tracks?.selectedTrack?.frameDuration ?? image?.duration ?? 0;
        const ms = durUs ? (typeof durUs === 'number' ? durUs/1000 : 0) : 0;
        const durationMs = ms > 0 ? ms : 100;
        frames.push({ bitmap: image, duration: durationMs, at: totalDur, index: frames.length });
        totalDur += durationMs;
      }
    } else {
      for (let i = 0; i < 1000; i++) {
        try {
          const { image } = await decoder.decode({ frameIndex: i });
          const durUs = decoder.tracks?.selectedTrack?.frameDuration ?? image?.duration ?? 0;
          const ms = durUs ? (typeof durUs === 'number' ? durUs/1000 : 0) : 0;
          const durationMs = ms > 0 ? ms : 100;
        frames.push({ bitmap: image, duration: durationMs, at: totalDur, index: frames.length });
        totalDur += durationMs;
        } catch { break; }
      }
    }

    if (!frames.length) return fallbackToImg(item);

    item._gif = { mode: 'decoder', decoder, frames, totalDur: totalDur || 1000 };

    const canvas = document.querySelector(`.stage-item[data-id="${item.id}"] canvas[data-role="gif-canvas"]`);
    if (canvas) {
      const f0 = frames[0].bitmap;
      canvas.width  = f0.displayWidth  || f0.codedWidth  || f0.width  || 2;
      canvas.height = f0.displayHeight || f0.codedHeight || f0.height || 2;
      canvas.style.width = canvas.width + 'px';
      canvas.style.height = canvas.height + 'px';
      if (!canvas.style.display) canvas.style.display = 'block';
      if (!canvas.style.pointerEvents) canvas.style.pointerEvents = 'none';
      const ctx = canvas.getContext('2d');
      const firstFrame = frames[0];
      const frameOptions = { frameKey: maskFrameKeyForGif(firstFrame.index ?? 0) };
      drawBitmapToCanvas(ctx, firstFrame, item, frameOptions);
      const w = canvas.width || f0.displayWidth || f0.codedWidth || f0.width || 2;
      const h = canvas.height || f0.displayHeight || f0.codedHeight || f0.height || 2;
      item._imageWidth = w;
      item._imageHeight = h;
      item._imageReady = true;
    }
    positionStageItem(item);
  } catch (e) {
    console.error('prepareGif error:', e);
    fallbackToImg(item);
  }
}

function fallbackToImg(item) {
  const holder = document.querySelector(`.stage-item[data-id="${item.id}"]`);
  if (!holder) return;

  holder.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 2;
  canvas.dataset.role = 'gif-canvas';
  canvas.style.display = 'block';
  canvas.style.pointerEvents = 'none';
  holder.appendChild(canvas);
  item._stageCanvas = canvas;

  const img = document.createElement('img');
  img.src = fileUrl(item.path);
  img.draggable = false;
  img.style.display = 'none';
  img.dataset.role = 'gif-hidden-img';
  holder.appendChild(img);
  ensureStageItemHandles(holder);

  item._gif = { mode: 'mirror', img, totalDur: null, frames: null };
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    try {
      const w = img.naturalWidth || 2;
      const h = img.naturalHeight || 2;
      item._imageEl = img;
      item._imageReady = true;
      item._imageWidth = w;
      item._imageHeight = h;
      drawStaticImageToCanvas(canvas, img, item);
    } catch (err) {
      console.warn('fallbackToImg draw failed', err);
    }
    positionStageItem(item);
  };

  if (typeof img.decode === 'function') {
    img.decode().catch(()=>{}).finally(finalize);
  } else if (img.complete && img.naturalWidth > 0) {
    finalize();
  } else {
    img.addEventListener('load', finalize, { once: true });
    img.addEventListener('error', finalize, { once: true });
  }
}

function drawBitmapToCanvas(ctx, frame, item = null, options = null) {
  if (!ctx || !frame || !frame.bitmap) return;
  const bmp = frame.bitmap;
  const w = bmp.displayWidth || bmp.codedWidth || bmp.width || ctx.canvas.width || 1;
  const h = bmp.displayHeight || bmp.codedHeight || bmp.height || ctx.canvas.height || 1;
  if (ctx.canvas.width !== w) ctx.canvas.width = w;
  if (ctx.canvas.height !== h) ctx.canvas.height = h;
  ctx.canvas.style.width = w + 'px';
  ctx.canvas.style.height = h + 'px';
  ctx.clearRect(0, 0, w, h);
  let source = null;
  if (item) {
    source = ensureGifFrameChromaCanvas(item, frame);
  }
  if (!source) {
    source = ensureGifFrameBitmapCanvas(frame);
  }
  if (!isDrawableSource(source)) source = bmp;
  if (!isDrawableSource(source)) return;
  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch (err) {
    console.warn('drawBitmapToCanvas failed; using raw bitmap', err);
    if (source !== bmp && isDrawableSource(bmp)) {
      ctx.drawImage(bmp, 0, 0, w, h);
    }
  }
  if (item) applyMaskCompositeToContext(ctx, item, w, h, options);
}

// ---------- KEYFRAMES ----------
function addKeyframeForClipId(id) {
  if (!id) return;
  if (isClipLocked(id)) return;
  const item = PROJECT.items.find(i=>i.id===id);
  if (!item) return;

  if (currentTime < item.start) item.start = Math.max(0, Math.floor(currentTime));
  if (currentTime > item.end)   item.end   = Math.min(timelineViewportEnd(), Math.ceil(currentTime));

  const t = clamp(Math.round(currentTime), item.start ?? 0, item.end ?? timelineViewportEnd());
  const axes = getScaleAxes(item);
  const pose = { x: item.x, y: item.y, scaleX: axes.x, scaleY: axes.y, rotation: getStageRotation(item) };
  pushHistory('add-keyframe');
  upsertKeyframe(item, t, pose);
  selectClip(id);
  selectItem(id);
  setSelectedKeyframe(item.id, t);

  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
}

function addKeyframeForSelected() {
  if (!selectedItemId) return;
  addKeyframeForClipId(selectedItemId);
}

function upsertKeyframe(item, t, pose) {
  if (!item.keyframes) item.keyframes = [];
  const kf = item.keyframes;
  const axes = {
    x: Number.isFinite(pose?.scaleX) ? clampStageScaleNumber(pose.scaleX) : clampStageScaleNumber(pose?.scale ?? 1),
    y: Number.isFinite(pose?.scaleY) ? clampStageScaleNumber(pose.scaleY) : clampStageScaleNumber(pose?.scale ?? 1)
  };
  const rotation = Number.isFinite(pose?.rotation) ? clampStageRotationNumber(pose.rotation) : getStageRotation(item);
  const payload = { t, x: pose.x, y: pose.y, scaleX: axes.x, scaleY: axes.y, scale: (axes.x + axes.y) / 2, rotation };
  const exist = kf.find(k => approxEqual(k.t, t));
  if (exist) Object.assign(exist, payload);
  else kf.push(payload);
  kf.sort((a,b)=>a.t-b.t);
}


function deleteKeyframe(item, t) {
  if (!item?.keyframes?.length) return;
  item.keyframes = item.keyframes.filter(k=>!approxEqual(k.t, t));
  if (selectedKeyframe && item && selectedKeyframe.itemId === item.id && approxEqual(selectedKeyframe.t, t)) {
    selectedKeyframe = null;
    updateKeyframeSelectionStyles();
  } else {
    updateKeyframeSelectionStyles();
  }
}

function setSelectedKeyframe(itemId, t) {
  selectedKeyframe = { itemId, t: Number(t) };
  updateKeyframeSelectionStyles();
}

function clearSelectedKeyframe() {
  if (!selectedKeyframe) return;
  selectedKeyframe = null;
  updateKeyframeSelectionStyles();
}

function updateKeyframeSelectionStyles() {
  const sel = selectedKeyframe;
  $$('.kf-tick').forEach(el => {
    const id = el.dataset.itemId;
    const t = Number(el.dataset.kfTime || 0);
    const match = sel && id === sel.itemId && approxEqual(t, sel.t);
    el.classList.toggle('selected', !!match);
  });
}

function clampStageScaleNumber(value) {
  if (!Number.isFinite(value)) return 1;
  return clamp(value, STAGE_SCALE_MIN, STAGE_SCALE_MAX);
}

function clampStageRotationNumber(value) {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, STAGE_ROTATION_MIN, STAGE_ROTATION_MAX);
}

function clampStageRotationValue(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return clampStageRotationNumber(num);
}

function getStageRotation(source) {
  if (!source) return 0;
  const raw = Number(source.rotation);
  return Number.isFinite(raw) ? clampStageRotationNumber(raw) : 0;
}

function setStageRotation(target, value) {
  if (!target) return 0;
  const clamped = clampStageRotationNumber(value);
  target.rotation = clamped;
  return clamped;
}

function haveStageRotationsChanged(a, b, eps = STAGE_ROTATION_EPS) {
  return Math.abs(a - b) > eps;
}

function formatStageRotationValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0.0';
  return num.toFixed(1);
}

function getScaleAxes(source) {
  const base = Number(source?.scale);
  const fallback = Number.isFinite(base) ? clampStageScaleNumber(base) : 1;
  const sx = Number(source?.scaleX);
  const sy = Number(source?.scaleY);
  return {
    x: Number.isFinite(sx) ? clampStageScaleNumber(sx) : fallback,
    y: Number.isFinite(sy) ? clampStageScaleNumber(sy) : fallback
  };
}

function setScaleAxes(target, nextX, nextY) {
  const clampedX = clampStageScaleNumber(nextX);
  const clampedY = clampStageScaleNumber(nextY);
  target.scaleX = clampedX;
  target.scaleY = clampedY;
  target.scale = Math.abs(clampedX - clampedY) < STAGE_SCALE_EPS ? clampedX : (clampedX + clampedY) / 2;
}

function setUniformScale(target, value) {
  setScaleAxes(target, value, value);
}

function getVisualNaturalSize(item) {
  if (!item) return { width: STAGE_WIDTH, height: STAGE_HEIGHT };
  const widthSources = [
    item._videoWidth,
    item._imageWidth,
    item._stageCanvas?.width,
    item._videoEl?.videoWidth,
    item._imageEl?.naturalWidth,
    item._imageEl?.width
  ];
  const heightSources = [
    item._videoHeight,
    item._imageHeight,
    item._stageCanvas?.height,
    item._videoEl?.videoHeight,
    item._imageEl?.naturalHeight,
    item._imageEl?.height
  ];
  let width = widthSources.find((val) => Number.isFinite(val) && val > 0) || STAGE_WIDTH;
  let height = heightSources.find((val) => Number.isFinite(val) && val > 0) || STAGE_HEIGHT;
  if (!(width > 0)) width = STAGE_WIDTH;
  if (!(height > 0)) height = STAGE_HEIGHT;
  return { width, height };
}

function fitVisualItemToStage(item, { includeKeyframes = true } = {}) {
  if (!item) return;
  const { width, height } = getVisualNaturalSize(item);
  if (!(width > 0) || !(height > 0)) return;
  const rawScale = Math.min(STAGE_WIDTH / width, STAGE_HEIGHT / height);
  const targetScale = clampStageScaleNumber(rawScale);
  const weld = getWeldInfo(item);
  const weldParent = weld ? getWeldParent(item) : null;
  if (weld && weldParent) {
    const parentPose = resolvePoseRecursive(weldParent, {
      time: currentTime,
      includeEditing: true,
      visited: new Set([item.id])
    });
    const localCenter = worldToLocalPose({ x: STAGE_WIDTH / 2, y: STAGE_HEIGHT / 2 }, parentPose, weld);
    item.x = localCenter.x;
    item.y = localCenter.y;
  } else {
    item.x = STAGE_WIDTH / 2;
    item.y = STAGE_HEIGHT / 2;
  }
  setUniformScale(item, targetScale);
  if (includeKeyframes && Array.isArray(item.keyframes)) {
    for (const kf of item.keyframes) {
      if (!kf || typeof kf !== 'object') continue;
      kf.x = item.x;
      kf.y = item.y;
      kf.scaleX = targetScale;
      kf.scaleY = targetScale;
      kf.scale = targetScale;
    }
  }
  item._editing = false;
}

function haveScaleAxesChanged(ax, ay, bx, by, eps = 0.005) {
  return Math.abs(ax - bx) > eps || Math.abs(ay - by) > eps;
}

function getSelectedStageTarget() {
  if (selectedItemId) {
    const item = PROJECT.items.find(i => i.id === selectedItemId);
    if (item) return { kind: 'visual', subject: item };
  }
  if (selectedTextId) {
    const text = PROJECT.text.find(t => t.id === selectedTextId);
    if (text) return { kind: 'text', subject: text };
  }
  return null;
}

function getStageTargetScales(target) {
  if (!target || !target.subject) return { x: 1, y: 1 };
  if (target.kind === 'visual') {
    const pose = resolveDisplayPose(target.subject);
    const sx = Number(pose?.scaleX ?? pose?.scale);
    const sy = Number(pose?.scaleY ?? pose?.scale);
    return {
      x: Number.isFinite(sx) ? sx : 1,
      y: Number.isFinite(sy) ? sy : 1
    };
  }
  const s = Number(target.subject.scale);
  const fallback = Number.isFinite(s) ? s : 1;
  return { x: fallback, y: fallback };
}

function formatStageScaleValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '1.000';
  return num.toFixed(3);
}

function updateStageSizePanel() {
  if (!stageSizePanelEl) {
    stageSizePanelEl = document.getElementById('stage-size-panel');
    stageSizeXEl = stageSizePanelEl?.querySelector('[data-axis="x"]') || null;
    stageSizeYEl = stageSizePanelEl?.querySelector('[data-axis="y"]') || null;
  }
  if (!stageSizePanelEl) return;
  const target = getSelectedStageTarget();
  if (!target) {
    stageSizePanelEl.classList.remove('has-selection');
    stageSizePanelEl.setAttribute('aria-hidden', 'true');
    return;
  }
  const scales = getStageTargetScales(target);
  if (stageSizeXEl) stageSizeXEl.textContent = formatStageScaleValue(scales.x);
  if (stageSizeYEl) stageSizeYEl.textContent = formatStageScaleValue(scales.y);
  stageSizePanelEl.removeAttribute('aria-hidden');
  stageSizePanelEl.classList.add('has-selection');
}

function clampStageScaleValue(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return clamp(num, STAGE_SCALE_MIN, STAGE_SCALE_MAX);
}

function openMaskEditor(item) {
  if (!item || item.kind !== 'visual') return;
  if (isClipLocked(item.id)) {
    alert('Unlock this clip to edit its mask.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible mask-editor-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'mask-editor';

  const header = document.createElement('div');
  header.className = 'mask-editor-header';
  const title = document.createElement('h2');
  title.className = 'mask-editor-title';
  title.textContent = 'Mask Editor';
  header.appendChild(title);
  const subtitle = document.createElement('p');
  subtitle.className = 'mask-editor-subtitle';
  const displayName = item.name || basename(item.path) || 'Visual Clip';
  subtitle.textContent = `Adjust the mask for ${displayName}.`;
  header.appendChild(subtitle);
  const existingMode = item.mask?.mode === 'remove' ? 'Remove' : (item.mask?.mode === 'keep' ? 'Keep' : null);
  if (existingMode) {
    const modeLabel = document.createElement('span');
    modeLabel.className = 'mask-editor-current-mode';
    modeLabel.textContent = `Current mode: ${existingMode}`;
    header.appendChild(modeLabel);
  }
  dialog.appendChild(header);

  const mediaIsGif = isGifPath(item.path) || item.mediaType === 'gif';
  const mediaIsVideoClip = isVideoClip(item);
  const frameSupport = mediaIsGif || mediaIsVideoClip;
  const frameState = {
    enabled: frameSupport,
    kind: mediaIsGif ? 'gif' : (mediaIsVideoClip ? 'video' : null),
    entries: [],
    index: 0,
    durationMs: 0,
    timeMs: 0,
    loading: false
  };
  let frameLabelEl = null;
  let frameStatusEl = null;
  let frameAppliedBadge = null;
  let frameSlider = null;
  let frameScopeInput = null;
  let clipScopeInput = null;
  let framePrevBtn = null;
  let frameNextBtn = null;
  if (frameState.kind === 'gif') {
    const frames = Array.isArray(item._gif?.frames) ? item._gif.frames : [];
    frameState.entries = frames.map((frame, idx) => ({
      index: Number.isFinite(frame.index) ? frame.index : idx,
      key: maskFrameKeyForGif(Number.isFinite(frame.index) ? frame.index : idx),
      at: Number.isFinite(frame.at) ? frame.at : (idx === 0 ? 0 : frames[idx - 1].at + (frames[idx - 1].duration || 0)),
      duration: frame.duration || 0,
      bitmap: frame.bitmap
    }));
    if (!frameState.entries.length) {
      frameState.enabled = false;
    } else {
      const totalDur = item._gif?.totalDur || frameState.entries[frameState.entries.length - 1].at + (frameState.entries[frameState.entries.length - 1].duration || 0) || 0;
      const startTime = item.start ?? 0;
      const tInto = Math.max(0, currentTime - startTime);
      const wrapped = totalDur > 0 ? ((tInto % totalDur) + totalDur) % totalDur : tInto;
      let selectedIndex = 0;
      for (let i = 0; i < frameState.entries.length; i++) {
        const entry = frameState.entries[i];
        const nextStart = (i + 1 < frameState.entries.length) ? frameState.entries[i + 1].at : totalDur;
        if (wrapped >= entry.at && wrapped < nextStart) {
          selectedIndex = i;
          break;
        }
      }
      frameState.index = selectedIndex;
      frameState.timeMs = frameState.entries[selectedIndex].at || 0;
    }
  } else if (frameState.kind === 'video') {
    const effectiveStart = item.start ?? 0;
    const effectiveEnd = Number.isFinite(item.end) ? item.end : (effectiveStart + (item._videoDurationMs || 0));
    const durationMs = Math.max(1, Math.round(item._videoDurationMs || Math.max(0, effectiveEnd - effectiveStart) || 1000));
    frameState.durationMs = durationMs;
    frameState.timeMs = clamp(Math.round(currentTime - effectiveStart), 0, durationMs);
  }

  const basePreset = defaultMaskPreset();
  const naturalWidth = Math.max(1, Math.round(item._imageWidth || item._videoWidth || item.width || 512));
  const naturalHeight = Math.max(1, Math.round(item._imageHeight || item._videoHeight || item.height || 512));
  function sanitizeMaskTemplate(mask) {
    if (!mask || typeof mask !== 'object') return null;
    const tpl = cloneMask(mask);
    if (!tpl) return null;
    if (!tpl.shape && tpl.type) tpl.shape = tpl.type;
    if ((tpl.shape || tpl.type) === 'freehand') {
      tpl.points = [];
    }
    return tpl;
  }

  function resolveMaskShape(mask) {
    if (!mask || typeof mask !== 'object') return null;
    const raw = (mask.shape || mask.type || (Array.isArray(mask.points) ? 'freehand' : '')).toString().toLowerCase();
    return raw || null;
  }

  let lastMaskTemplate = sanitizeMaskTemplate(item.mask);
  let lastShapeKey = resolveMaskShape(lastMaskTemplate) || resolveMaskShape(item.mask) || basePreset.shape;
  const state = {
    shape: basePreset.shape,
    square: { ...basePreset.square },
    circle: { ...basePreset.circle },
    ellipse: { ...basePreset.ellipse },
    star: { ...basePreset.star },
    freehand: { points: basePreset.freehand.points.map(p => ({ ...p })) },
    assetWidth: naturalWidth,
    assetHeight: naturalHeight,
    scale: 1,
    baseScale: 1,
    offsetX: 0,
    offsetY: 0,
    panX: 0,
    panY: 0,
    previewSource: null,
    loading: true,
    mode: item.mask?.mode === 'remove' ? 'remove' : 'keep',
    zoom: 1,
    frame: frameState,
    scope: frameState.enabled ? 'frame' : 'clip',
    selectedAction: null,
    pendingSplit: false
  };
  state.selectedAction = frameState.enabled ? (state.mode === 'remove' ? 'remove' : 'keep') : null;

  function rememberLastMaskTemplate(maskDef) {
    const tpl = sanitizeMaskTemplate(maskDef);
    if (tpl) {
      lastMaskTemplate = tpl;
      const tplShape = resolveMaskShape(tpl);
      if (tplShape) lastShapeKey = tplShape;
    }
  }

  function cacheWorkingMaskTemplate() {
    if (!state || !state.shape) return;
    const template = { shape: state.shape, mode: state.mode };
    if (state.shape === 'square') {
      template.rect = { ...state.square };
    } else if (state.shape === 'circle') {
      template.circle = { ...state.circle };
    } else if (state.shape === 'ellipse') {
      template.ellipse = { ...state.ellipse };
    } else if (state.shape === 'star') {
      template.star = { ...state.star };
    } else if (state.shape === 'freehand') {
      template.points = state.freehand.points.map(p => ({ x: p.x, y: p.y }));
    }
    rememberLastMaskTemplate(template);
  }

  const previewWrap = document.createElement('div');
  previewWrap.className = 'mask-editor-preview-wrap';
  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'mask-editor-preview';
  const PREVIEW_SIZE = 440;
  previewCanvas.width = PREVIEW_SIZE;
  previewCanvas.height = PREVIEW_SIZE;
  previewCanvas.style.width = PREVIEW_SIZE + 'px';
  previewCanvas.style.height = PREVIEW_SIZE + 'px';
  previewWrap.appendChild(previewCanvas);
  const zoomRow = document.createElement('div');
  zoomRow.className = 'mask-editor-zoom';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'mask-editor-zoom-label';
  zoomLabel.textContent = 'Zoom';
  const zoomSlider = document.createElement('input');
  zoomSlider.type = 'range';
  zoomSlider.min = '50';
  zoomSlider.max = '800';
  zoomSlider.step = '10';
  zoomSlider.className = 'mask-editor-zoom-slider';
  const zoomValue = document.createElement('span');
  zoomValue.className = 'mask-editor-zoom-value';
  zoomRow.append(zoomLabel, zoomSlider, zoomValue);
  previewWrap.appendChild(zoomRow);
  if (frameState.enabled) {
    const frameNav = document.createElement('div');
    frameNav.className = 'mask-frame-nav';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.textContent = 'Prev';
    prevBtn.addEventListener('click', () => shiftFrame(-1));
    framePrevBtn = prevBtn;
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.textContent = 'Next';
    nextBtn.addEventListener('click', () => shiftFrame(1));
    frameNextBtn = nextBtn;
    frameLabelEl = document.createElement('span');
    frameLabelEl.className = 'mask-frame-label';
    frameStatusEl = document.createElement('span');
    frameStatusEl.className = 'mask-frame-status';
    frameSlider = document.createElement('input');
    frameSlider.type = 'range';
    frameSlider.className = 'mask-frame-slider';
    if (frameState.kind === 'gif') {
      const total = frameState.entries.length || 1;
      frameSlider.min = '0';
      frameSlider.max = String(Math.max(0, total - 1));
      frameSlider.step = '1';
      frameSlider.value = String(frameState.index);
      frameSlider.disabled = total <= 1;
      frameSlider.addEventListener('input', () => setFrameIndex(Number(frameSlider.value), { updatePreview: true, syncSlider: false }));
    } else if (frameState.kind === 'video') {
      frameSlider.min = '0';
      frameSlider.max = String(Math.max(1, frameState.durationMs));
      frameSlider.step = String(MASK_VIDEO_FRAME_STEP_MS);
      frameSlider.value = String(frameState.timeMs);
      frameSlider.disabled = frameState.durationMs <= MASK_VIDEO_FRAME_STEP_MS;
      frameSlider.addEventListener('input', () => setFrameTimeMs(Number(frameSlider.value) || 0, { updatePreview: true, syncSlider: false }));
    }
    frameNav.append(prevBtn, frameSlider, nextBtn);
    previewWrap.appendChild(frameNav);
    const frameInfo = document.createElement('div');
    frameInfo.className = 'mask-frame-info';
    frameAppliedBadge = document.createElement('span');
    frameAppliedBadge.className = 'mask-frame-applied';
    frameAppliedBadge.hidden = true;
    frameAppliedBadge.textContent = 'Applied!';
    frameInfo.append(frameLabelEl, frameStatusEl, frameAppliedBadge);
    previewWrap.appendChild(frameInfo);
  }
  const previewHint = document.createElement('p');
  previewHint.className = 'mask-editor-hint';
  previewWrap.appendChild(previewHint);
  dialog.appendChild(previewWrap);

  const shapeBar = document.createElement('div');
  shapeBar.className = 'mask-editor-shapes';
  dialog.appendChild(shapeBar);

  const controls = document.createElement('div');
  controls.className = 'mask-editor-controls';
  dialog.appendChild(controls);
  let controlUpdaters = [];

  function registerControlUpdater(fn) {
    if (typeof fn === 'function') controlUpdaters.push(fn);
  }

  function syncControlValues() {
    for (const updater of controlUpdaters) {
      try {
        updater();
      } catch (err) {
        console.warn('mask control sync failed', err);
      }
    }
  }
  if (frameState.enabled) {
    const scopeToggle = document.createElement('div');
    scopeToggle.className = 'mask-editor-scope-toggle';
    const scopeLabel = document.createElement('span');
    scopeLabel.textContent = 'Mask scope:';
    const frameOption = document.createElement('label');
    frameOption.className = 'mask-scope-option';
    const frameInput = document.createElement('input');
    frameInput.type = 'radio';
    frameInput.name = 'mask-scope';
    frameInput.value = 'frame';
    frameInput.checked = state.scope === 'frame';
    frameInput.addEventListener('change', () => {
      if (frameInput.checked) setMaskScope('frame');
    });
    frameScopeInput = frameInput;
    const frameText = document.createElement('span');
    frameText.textContent = 'This frame';
    frameOption.append(frameInput, frameText);

    const clipOption = document.createElement('label');
    clipOption.className = 'mask-scope-option';
    const clipInput = document.createElement('input');
    clipInput.type = 'radio';
    clipInput.name = 'mask-scope';
    clipInput.value = 'clip';
    clipInput.checked = state.scope === 'clip';
    clipInput.addEventListener('change', () => {
      if (clipInput.checked) setMaskScope('clip');
    });
    clipScopeInput = clipInput;
    const clipText = document.createElement('span');
    clipText.textContent = 'Entire clip';
    clipOption.append(clipInput, clipText);

    scopeToggle.append(scopeLabel, frameOption, clipOption);
    dialog.insertBefore(scopeToggle, controls);
  }

  const freehandTools = document.createElement('div');
  freehandTools.className = 'mask-editor-freehand-tools';
  dialog.appendChild(freehandTools);

  const errorEl = document.createElement('div');
  errorEl.className = 'mask-editor-error';
  errorEl.hidden = true;
  dialog.appendChild(errorEl);

  let clearMaskBtn = null;
  const actionBar = document.createElement('div');
  actionBar.className = 'mask-editor-actions';
  dialog.appendChild(actionBar);
  const actionButtons = new Map();

  let frameOpsBar = null;
  let applyFrameBtn = null;
  let applyPrevBtn = null;
  let applyNextBtn = null;
  let applyClipBtn = null;
  if (frameState.enabled) {
    frameOpsBar = document.createElement('div');
    frameOpsBar.className = 'mask-editor-frame-ops';
    applyFrameBtn = document.createElement('button');
    applyFrameBtn.type = 'button';
    applyFrameBtn.textContent = 'Apply to This Frame';
    applyFrameBtn.addEventListener('click', () => runSelectedAction({ target: 'current', scopeOverride: 'frame', showIndicator: true }));
    applyPrevBtn = document.createElement('button');
    applyPrevBtn.type = 'button';
    applyPrevBtn.textContent = 'Apply to Previous Frame';
    applyPrevBtn.addEventListener('click', () => runSelectedAction({ target: 'prev', scopeOverride: 'frame' }));
    applyNextBtn = document.createElement('button');
    applyNextBtn.type = 'button';
    applyNextBtn.textContent = 'Apply to Next Frame';
    applyNextBtn.addEventListener('click', () => runSelectedAction({ target: 'next', scopeOverride: 'frame' }));
    applyClipBtn = document.createElement('button');
    applyClipBtn.type = 'button';
    applyClipBtn.textContent = 'Apply to All Frames';
    applyClipBtn.addEventListener('click', () => runSelectedAction({ target: 'clip-all', scopeOverride: 'clip' }));
    frameOpsBar.append(applyFrameBtn, applyPrevBtn, applyNextBtn, applyClipBtn);
    dialog.appendChild(frameOpsBar);
  }

  const footerBar = document.createElement('div');
  footerBar.className = 'mask-editor-footer';
  dialog.appendChild(footerBar);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const shapeButtons = new Map();
  const shapes = [
    { key: 'square', label: 'Square' },
    { key: 'ellipse', label: 'Ellipse' },
    { key: 'star', label: 'Star' },
    { key: 'freehand', label: 'Freehand' }
  ];

  let destroyed = false;

  const ctx = previewCanvas.getContext('2d');
  const pointerState = {
    isPanning: false,
    startX: 0,
    startY: 0,
    panStartX: 0,
    panStartY: 0,
    ignoreClick: false,
    didMove: false,
    spaceHeld: false,
    isTransforming: false,
    activeHandle: null,
    activeCursor: '',
    hoverCursor: '',
    startPointer: null,
    startShape: null,
    startRect: null,
    handleInfo: null,
    handleOffset: null
  };

  const TRANSFORMABLE_MASK_SHAPES = new Set(['square', 'circle', 'ellipse', 'star']);

  function isTransformableShape() {
    return TRANSFORMABLE_MASK_SHAPES.has(state.shape);
  }

  function ensurePreviewMetrics() {
    if (!Number.isFinite(state.scale)
      || !Number.isFinite(state.offsetX)
      || !Number.isFinite(state.offsetY)) {
      computePreviewGeometry();
    }
  }

  function assetToCanvasCoords(nx, ny) {
    ensurePreviewMetrics();
    const width = Math.max(1, state.assetWidth || 1);
    const height = Math.max(1, state.assetHeight || 1);
    return {
      x: state.offsetX + nx * width * state.scale,
      y: state.offsetY + ny * height * state.scale
    };
  }

  function pointerPositionFromEvent(ev) {
    const rect = previewCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const canvasX = (ev.clientX - rect.left) * scaleX;
    const canvasY = (ev.clientY - rect.top) * scaleY;
    ensurePreviewMetrics();
    const width = Math.max(1, state.assetWidth || 1);
    const height = Math.max(1, state.assetHeight || 1);
    const normX = (canvasX - state.offsetX) / (state.scale * width);
    const normY = (canvasY - state.offsetY) / (state.scale * height);
    return { canvasX, canvasY, normX, normY };
  }

  function deriveShapeStateFromMask(mask) {
    const preset = defaultMaskPreset();
    const toFinite = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const derived = {
      shape: preset.shape,
      square: { ...preset.square },
      circle: { ...preset.circle },
      ellipse: { ...preset.ellipse },
      star: { ...preset.star },
      freehand: { points: preset.freehand.points.map(p => ({ ...p })) },
      mode: state.mode
    };
    if (!mask || typeof mask !== 'object') return derived;
    const rawShape = normalizeMaskShapeName(mask.shape || mask.type || (Array.isArray(mask.points) ? 'freehand' : ''));
    const hasPoints = Array.isArray(mask.points) && mask.points.length >= 3;
    if (rawShape === 'square') {
      const rect = mask.rect || mask;
      derived.shape = 'square';
      derived.square = {
        x: clamp01(toFinite(rect.x, derived.square.x)),
        y: clamp01(toFinite(rect.y, derived.square.y)),
        width: clamp01(toFinite(rect.width, derived.square.width)),
        height: clamp01(toFinite(rect.height, derived.square.height))
      };
    } else if (rawShape === 'ellipse' && mask.ellipse) {
      derived.shape = 'ellipse';
      derived.ellipse = {
        cx: clamp01(toFinite(mask.ellipse.cx ?? mask.ellipse.x, derived.ellipse.cx)),
        cy: clamp01(toFinite(mask.ellipse.cy ?? mask.ellipse.y, derived.ellipse.cy)),
        rx: clamp(toFinite(mask.ellipse.rx ?? mask.ellipse.radiusX ?? mask.ellipse.width, derived.ellipse.rx), 0.02, 0.6),
        ry: clamp(toFinite(mask.ellipse.ry ?? mask.ellipse.radiusY ?? mask.ellipse.height, derived.ellipse.ry), 0.02, 0.6)
      };
    } else if (rawShape === 'circle' && mask.circle) {
      derived.shape = 'ellipse';
      const radius = clamp(toFinite(mask.circle.radius, derived.circle.radius), 0.02, 0.6);
      const cx = clamp01(toFinite(mask.circle.cx ?? mask.circle.x, derived.circle.cx));
      const cy = clamp01(toFinite(mask.circle.cy ?? mask.circle.y, derived.circle.cy));
      derived.ellipse = { cx, cy, rx: radius, ry: radius };
    } else if (rawShape === 'star' && mask.star) {
      derived.shape = 'star';
      derived.star = {
        cx: clamp01(toFinite(mask.star.cx ?? mask.star.x, derived.star.cx)),
        cy: clamp01(toFinite(mask.star.cy ?? mask.star.y, derived.star.cy)),
        outerRadius: clamp(toFinite(mask.star.outerRadius ?? mask.star.outer, derived.star.outerRadius), 0.05, 0.6),
        innerRadius: clamp(toFinite(mask.star.innerRadius ?? mask.star.inner, derived.star.innerRadius), 0.02, 0.55),
        points: clamp(Math.round(toFinite(mask.star.points, derived.star.points)), 3, 12)
      };
    } else if (rawShape === 'freehand' || hasPoints) {
      derived.shape = 'freehand';
      if (hasPoints) {
        derived.freehand.points = mask.points.map((p) => ({
          x: maskRoundCoord(p?.x ?? p?.[0] ?? 0.5),
          y: maskRoundCoord(p?.y ?? p?.[1] ?? 0.5)
        }));
      }
    } else if (rawShape === 'ellipse' && !mask.ellipse && mask.circle) {
      derived.shape = 'ellipse';
      const radius = clamp(toFinite(mask.circle.radius, derived.circle.radius), 0.02, 0.6);
      derived.ellipse = {
        cx: clamp01(toFinite(mask.circle.cx ?? mask.circle.x, derived.ellipse.cx)),
        cy: clamp01(toFinite(mask.circle.cy ?? mask.circle.y, derived.ellipse.cy)),
        rx: radius,
        ry: radius
      };
    } else if (rawShape) {
      derived.shape = rawShape;
    }
    if (typeof mask.mode === 'string') {
      derived.mode = mask.mode === 'remove' ? 'remove' : 'keep';
    }
    return derived;
  }

  function loadMaskIntoState(mask, { skipRender = false } = {}) {
    const sourceMask = mask
      || (state.scope === 'frame' ? lastMaskTemplate : null)
      || item.mask
      || null;
    const parsed = deriveShapeStateFromMask(sourceMask);
    const resolvedShape = parsed.shape || lastShapeKey || basePreset.shape;
    state.shape = resolvedShape;
    state.square = { ...parsed.square };
    state.circle = { ...parsed.circle };
    state.ellipse = { ...parsed.ellipse };
    state.star = { ...parsed.star };
    state.freehand = { points: parsed.freehand.points.map(p => ({ ...p })) };
    state.mode = parsed.mode || state.mode;
    if (resolvedShape) lastShapeKey = resolvedShape;
    if (!state.selectedAction || state.selectedAction === 'keep' || state.selectedAction === 'remove') {
      state.selectedAction = state.mode === 'remove' ? 'remove' : 'keep';
    }
    normalizeCurrentShape();
    if (!skipRender) {
      renderControls();
      renderPreview();
    }
    updateActionButtons();
    updateFrameApplyButtons();
  }

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function normalizeSquare() {
    const sq = state.square;
    sq.width = clamp01(sq.width || 0.6);
    sq.height = clamp01(sq.height || 0.6);
    sq.x = clamp(sq.x ?? 0.1, 0, 1 - sq.width);
    sq.y = clamp(sq.y ?? 0.1, 0, 1 - sq.height);
  }

  function normalizeCircle() {
    const c = state.circle;
    c.cx = clamp01(c.cx ?? 0.5);
    c.cy = clamp01(c.cy ?? 0.5);
    const limit = Math.max(0.05, Math.min(c.cx, 1 - c.cx, c.cy, 1 - c.cy));
    c.radius = clamp(c.radius ?? 0.4, 0.05, limit);
  }

  function normalizeEllipse() {
    const e = state.ellipse;
    e.cx = clamp01(e.cx ?? 0.5);
    e.cy = clamp01(e.cy ?? 0.5);
    const maxRx = Math.max(0.05, Math.min(e.cx, 1 - e.cx));
    const maxRy = Math.max(0.05, Math.min(e.cy, 1 - e.cy));
    e.rx = clamp(e.rx ?? 0.45, 0.05, maxRx);
    e.ry = clamp(e.ry ?? 0.35, 0.05, maxRy);
  }

  function normalizeStar() {
    const s = state.star;
    s.cx = clamp01(s.cx ?? 0.5);
    s.cy = clamp01(s.cy ?? 0.5);
    const limit = Math.max(0.05, Math.min(s.cx, 1 - s.cx, s.cy, 1 - s.cy));
    s.outerRadius = clamp(s.outerRadius ?? 0.45, 0.05, limit);
    const maxInner = Math.max(0.03, s.outerRadius - 0.02);
    s.innerRadius = clamp(s.innerRadius ?? s.outerRadius * 0.5, 0.03, maxInner);
    if (s.innerRadius >= s.outerRadius) s.innerRadius = Math.max(0.03, s.outerRadius * 0.6);
    s.points = clamp(Math.round(s.points ?? 5), 3, 12);
  }

  function normalizeFreehand() {
    state.freehand.points = state.freehand.points
      .map(p => ({ x: clamp01(p.x ?? 0.5), y: clamp01(p.y ?? 0.5) }))
      .filter((p, idx, arr) => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
        if (idx === 0) return true;
        const prev = arr[idx - 1];
        return !(Math.abs(prev.x - p.x) < 0.0001 && Math.abs(prev.y - p.y) < 0.0001);
      });
  }

  function normalizeCurrentShape() {
    if (state.shape === 'square') normalizeSquare();
    else if (state.shape === 'circle') normalizeCircle();
    else if (state.shape === 'ellipse') normalizeEllipse();
    else if (state.shape === 'star') normalizeStar();
    else if (state.shape === 'freehand') normalizeFreehand();
  }

  function getActiveShapeRect() {
    if (!isTransformableShape()) return null;
    if (state.shape === 'square' && state.square) {
      const { x = 0, y = 0, width = 0.2, height = 0.2 } = state.square;
      return { x, y, width, height };
    }
    if (state.shape === 'circle' && state.circle) {
      const { cx = 0.5, cy = 0.5, radius = 0.25 } = state.circle;
      return { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 };
    }
    if (state.shape === 'ellipse' && state.ellipse) {
      const { cx = 0.5, cy = 0.5, rx = 0.25, ry = 0.25 } = state.ellipse;
      return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
    }
    if (state.shape === 'star' && state.star) {
      const { cx = 0.5, cy = 0.5, outerRadius = 0.25 } = state.star;
      return { x: cx - outerRadius, y: cy - outerRadius, width: outerRadius * 2, height: outerRadius * 2 };
    }
    return null;
  }

  function pointWithinRect(nx, ny, rect) {
    if (!rect) return false;
    return nx >= rect.x
      && ny >= rect.y
      && nx <= rect.x + rect.width
      && ny <= rect.y + rect.height;
  }

  function buildHandleDescriptors(rect) {
    if (!rect) return [];
    const x1 = rect.x;
    const x2 = rect.x + rect.width;
    const y1 = rect.y;
    const y2 = rect.y + rect.height;
    const xm = x1 + rect.width / 2;
    const ym = y1 + rect.height / 2;
    return [
      { id: 'nw', normX: x1, normY: y1, cursor: 'nwse-resize' },
      { id: 'n', normX: xm, normY: y1, cursor: 'ns-resize' },
      { id: 'ne', normX: x2, normY: y1, cursor: 'nesw-resize' },
      { id: 'e', normX: x2, normY: ym, cursor: 'ew-resize' },
      { id: 'se', normX: x2, normY: y2, cursor: 'nwse-resize' },
      { id: 's', normX: xm, normY: y2, cursor: 'ns-resize' },
      { id: 'sw', normX: x1, normY: y2, cursor: 'nesw-resize' },
      { id: 'w', normX: x1, normY: ym, cursor: 'ew-resize' },
      { id: 'center', normX: xm, normY: ym, cursor: 'move' }
    ];
  }

  function getHandlePositions() {
    const rect = getActiveShapeRect();
    if (!rect) return [];
    const descriptors = buildHandleDescriptors(rect);
    return descriptors.map((desc) => {
      const canvas = assetToCanvasCoords(desc.normX, desc.normY);
      return { ...desc, canvasX: canvas.x, canvasY: canvas.y };
    });
  }

  function detectTransformHandle(pointerPos, { includeInterior = true } = {}) {
    if (!isTransformableShape() || !pointerPos) return null;
    const handles = getHandlePositions();
    const threshold = 12;
    for (const handle of handles) {
      if (!Number.isFinite(handle.canvasX) || !Number.isFinite(handle.canvasY)) continue;
      const dx = pointerPos.canvasX - handle.canvasX;
      const dy = pointerPos.canvasY - handle.canvasY;
      if (Math.abs(dx) <= threshold && Math.abs(dy) <= threshold) {
        if (handle.id === 'center') {
          return { ...handle, id: 'move', cursor: 'move' };
        }
        return handle;
      }
    }
    if (!includeInterior) return null;
    const rect = getActiveShapeRect();
    if (rect && pointWithinRect(pointerPos.normX, pointerPos.normY, rect)) {
      return { id: 'move', cursor: 'move', normX: pointerPos.normX, normY: pointerPos.normY };
    }
    return null;
  }

  function captureActiveShapeSnapshot() {
    if (state.shape === 'square') return { square: { ...state.square } };
    if (state.shape === 'circle') return { circle: { ...state.circle } };
    if (state.shape === 'ellipse') return { ellipse: { ...state.ellipse } };
    if (state.shape === 'star') return { star: { ...state.star } };
    return null;
  }

  function pointerWithHandleOffset(pointerPos) {
    if (!pointerPos) return null;
    const offset = pointerState.handleOffset || { x: 0, y: 0 };
    return {
      x: pointerPos.normX - offset.x,
      y: pointerPos.normY - offset.y
    };
  }

  function computeRectAfterTransform(handleId, pointerPos, { minWidth = 0.05, minHeight = 0.05 } = {}) {
    if (!pointerPos || !pointerState.startRect || !pointerState.startPointer) return null;
    const dx = pointerPos.normX - pointerState.startPointer.x;
    const dy = pointerPos.normY - pointerState.startPointer.y;
    const edges = {
      west: pointerState.startRect.x,
      east: pointerState.startRect.x + pointerState.startRect.width,
      north: pointerState.startRect.y,
      south: pointerState.startRect.y + pointerState.startRect.height
    };
    let x = pointerState.startRect.x;
    let y = pointerState.startRect.y;
    let width = pointerState.startRect.width;
    let height = pointerState.startRect.height;
    if (handleId === 'move') {
      const clampedX = clamp(edges.west + dx, 0, 1 - width);
      const clampedY = clamp(edges.north + dy, 0, 1 - height);
      return { x: clampedX, y: clampedY, width, height };
    }
    if (handleId.includes('e')) {
      const nextEast = clamp(edges.east + dx, edges.west + minWidth, 1);
      width = nextEast - edges.west;
    }
    if (handleId.includes('s')) {
      const nextSouth = clamp(edges.south + dy, edges.north + minHeight, 1);
      height = nextSouth - edges.north;
    }
    if (handleId.includes('w')) {
      const nextWest = clamp(edges.west + dx, 0, edges.east - minWidth);
      width = edges.east - nextWest;
      x = nextWest;
    }
    if (handleId.includes('n')) {
      const nextNorth = clamp(edges.north + dy, 0, edges.south - minHeight);
      height = edges.south - nextNorth;
      y = nextNorth;
    }
    width = clamp(width, minWidth, 1);
    height = clamp(height, minHeight, 1);
    x = clamp(x, 0, 1 - width);
    y = clamp(y, 0, 1 - height);
    return { x, y, width, height };
  }

  function applyRectTransformToSquare(handleId, pointerPos) {
    const rect = computeRectAfterTransform(handleId, pointerPos, { minWidth: 0.05, minHeight: 0.05 });
    if (!rect) return;
    state.square = state.square || {};
    state.square.x = rect.x;
    state.square.y = rect.y;
    state.square.width = rect.width;
    state.square.height = rect.height;
    normalizeSquare();
  }

  function applyRectTransformToEllipse(handleId, pointerPos, { enforceCircle = false } = {}) {
    const rect = computeRectAfterTransform(handleId, pointerPos, { minWidth: 0.05, minHeight: 0.05 });
    if (!rect) return;
    let cx = rect.x + rect.width / 2;
    let cy = rect.y + rect.height / 2;
    let rx = rect.width / 2;
    let ry = rect.height / 2;
    if (enforceCircle) {
      const radius = Math.max(rx, ry);
      rx = radius;
      ry = radius;
    }
    if (state.shape === 'circle') {
      state.circle = state.circle || {};
      state.circle.cx = clamp01(cx);
      state.circle.cy = clamp01(cy);
      state.circle.radius = clamp(rx, 0.02, 0.6);
      normalizeCircle();
    } else {
      state.ellipse = state.ellipse || {};
      state.ellipse.cx = clamp01(cx);
      state.ellipse.cy = clamp01(cy);
      state.ellipse.rx = clamp(rx, 0.02, 0.6);
      state.ellipse.ry = clamp(ry, 0.02, 0.6);
      normalizeEllipse();
    }
  }

  function applyStarTransform(handleId, pointerPos) {
    const snapshot = pointerState.startShape?.star;
    if (!snapshot || !pointerPos || !pointerState.startPointer) return;
    if (handleId === 'center') handleId = 'move';
    state.star = state.star || {};
    if (handleId === 'move') {
      const dx = pointerPos.normX - pointerState.startPointer.x;
      const dy = pointerPos.normY - pointerState.startPointer.y;
      state.star.cx = clamp01(snapshot.cx + dx);
      state.star.cy = clamp01(snapshot.cy + dy);
      normalizeStar();
      return;
    }
    const correctedPointer = pointerWithHandleOffset(pointerPos);
    if (!correctedPointer) return;
    const { cx, cy } = snapshot;
    let radius = snapshot.outerRadius;
    if (handleId === 'e' || handleId === 'w') {
      radius = Math.abs(correctedPointer.x - cx);
    } else if (handleId === 'n' || handleId === 's') {
      radius = Math.abs(correctedPointer.y - cy);
    } else {
      const dx = correctedPointer.x - cx;
      const dy = correctedPointer.y - cy;
      radius = Math.hypot(dx, dy);
    }
    state.star.outerRadius = clamp(radius, 0.05, 0.6);
    normalizeStar();
  }

  function currentFrameEntry() {
    if (!state.frame.enabled || state.frame.kind !== 'gif') return null;
    return state.frame.entries[state.frame.index] || null;
  }

  function getCurrentFrameKey() {
    if (!state.frame.enabled) return null;
    if (state.frame.kind === 'gif') {
      const entry = currentFrameEntry();
      return entry ? entry.key : null;
    }
    if (state.frame.kind === 'video') {
      return maskFrameKeyForVideo(state.frame.timeMs);
    }
    return null;
  }

  function getFrameLabel() {
    if (!state.frame.enabled) return '';
    if (state.frame.kind === 'gif') {
      const total = state.frame.entries.length;
      return total ? `Frame ${state.frame.index + 1} / ${total}` : 'Frame 0 / 0';
    }
    if (state.frame.kind === 'video') {
      const seconds = (state.frame.timeMs / 1000).toFixed(2);
      const totalSec = (state.frame.durationMs / 1000).toFixed(2);
      return `Time ${seconds}s / ${totalSec}s`;
    }
    return '';
  }

  function updateFrameStatusLabel() {
    let hasCustom = false;
    if (state.frame.enabled) {
      const key = getCurrentFrameKey();
      if (key && item.maskFrames && item.maskFrames[key]) {
        hasCustom = true;
        if (frameStatusEl) frameStatusEl.textContent = 'Custom frame mask';
      } else if (frameStatusEl) {
        frameStatusEl.textContent = item.mask ? 'Inheriting clip mask' : 'No mask set';
      }
      if (frameAppliedBadge) {
        frameAppliedBadge.hidden = !hasCustom;
        frameAppliedBadge.textContent = hasCustom ? 'Applied!' : '';
      }
    } else {
      if (frameStatusEl) frameStatusEl.textContent = '';
      if (frameAppliedBadge) frameAppliedBadge.hidden = true;
    }
    if (clearMaskBtn) {
      if (state.scope === 'frame' && state.frame.enabled) {
        clearMaskBtn.disabled = !hasCustom;
      } else {
        clearMaskBtn.disabled = !item.mask;
      }
    }
  }

  function updateFrameLabel() {
    if (!frameLabelEl) return;
    frameLabelEl.textContent = getFrameLabel();
    updateFrameStatusLabel();
    updateFrameApplyButtons();
  }

  function updateFrameApplyButtons() {
    if (!frameState.enabled || !frameOpsBar) return;
    const splitSelected = state.selectedAction === 'split';
    let hasFrameSelection = true;
    let hasPrev = true;
    let hasNext = true;
    if (state.frame.kind === 'gif') {
      const total = state.frame.entries.length;
      hasFrameSelection = total > 0;
      hasPrev = state.frame.index > 0;
      hasNext = total ? state.frame.index < total - 1 : false;
    } else if (state.frame.kind === 'video') {
      hasPrev = state.frame.timeMs > 0;
      hasNext = state.frame.timeMs < state.frame.durationMs;
    }
    if (applyFrameBtn) applyFrameBtn.disabled = splitSelected || !hasFrameSelection;
    if (applyPrevBtn) applyPrevBtn.disabled = splitSelected || !hasPrev;
    if (applyNextBtn) applyNextBtn.disabled = splitSelected || !hasNext;
    if (applyClipBtn) applyClipBtn.disabled = false;
  }

  function setFrameIndex(nextIndex, { updatePreview = true, syncSlider = true } = {}) {
    if (!state.frame.enabled || state.frame.kind !== 'gif') return;
    const total = state.frame.entries.length;
    if (!total) return;
    const clamped = clamp(Math.round(nextIndex), 0, total - 1);
    state.frame.index = clamped;
    const entry = currentFrameEntry();
    state.frame.timeMs = entry?.at || 0;
    if (frameSlider && syncSlider) {
      frameSlider.value = String(clamped);
    }
    const frameMask = getFrameMaskDefinition(item, getCurrentFrameKey());
    const maskToLoad = frameMask || (state.scope === 'frame' ? lastMaskTemplate : item.mask);
    loadMaskIntoState(maskToLoad || null);
    updateFrameLabel();
    updateFrameStatusLabel();
    if (updatePreview) refreshFramePreview({ immediateGif: true });
  }

  function setFrameTimeMs(nextMs, { updatePreview = true, syncSlider = true } = {}) {
    if (!state.frame.enabled || state.frame.kind !== 'video') return;
    const clamped = clamp(Math.round(nextMs), 0, Math.max(1, state.frame.durationMs));
    state.frame.timeMs = clamped;
    if (frameSlider && syncSlider) {
      frameSlider.value = String(clamped);
    }
    const frameMask = getFrameMaskDefinition(item, getCurrentFrameKey());
    const maskToLoad = frameMask || (state.scope === 'frame' ? lastMaskTemplate : item.mask);
    loadMaskIntoState(maskToLoad || null);
    updateFrameLabel();
    updateFrameStatusLabel();
    if (updatePreview) refreshFramePreview();
  }

  function shiftFrame(delta, { updatePreview = true } = {}) {
    if (!state.frame.enabled) return;
    if (state.frame.kind === 'gif') {
      setFrameIndex(state.frame.index + delta, { updatePreview });
    } else if (state.frame.kind === 'video') {
      const step = MASK_VIDEO_FRAME_STEP_MS * (delta || 1);
      setFrameTimeMs(state.frame.timeMs + step, { updatePreview });
    }
  }

  function resolveNeighborFrame(delta) {
    if (!state.frame.enabled) return null;
    if (state.frame.kind === 'gif') {
      const total = state.frame.entries.length;
      if (!total) return null;
      const targetIdx = clamp(state.frame.index + delta, 0, total - 1);
      if (targetIdx === state.frame.index) return null;
      return { key: state.frame.entries[targetIdx].key, index: targetIdx, kind: 'gif' };
    }
    if (state.frame.kind === 'video') {
      const newTime = clamp(state.frame.timeMs + delta * MASK_VIDEO_FRAME_STEP_MS, 0, state.frame.durationMs);
      if (newTime === state.frame.timeMs) return null;
      return { key: maskFrameKeyForVideo(newTime), timeMs: newTime, kind: 'video' };
    }
    return null;
  }

  function setMaskScope(nextScope) {
    if (!frameState.enabled) return;
    const scopeValue = nextScope === 'clip' ? 'clip' : 'frame';
    if (state.scope === scopeValue) return;
    state.scope = scopeValue;
    if (frameScopeInput) frameScopeInput.checked = scopeValue === 'frame';
    if (clipScopeInput) clipScopeInput.checked = scopeValue === 'clip';
    const key = scopeValue === 'frame' ? getCurrentFrameKey() : null;
    const maskDef = scopeValue === 'frame'
      ? (getFrameMaskDefinition(item, key) || lastMaskTemplate || item.mask)
      : item.mask;
    loadMaskIntoState(maskDef || null);
    updateFrameStatusLabel();
  }

  let videoPreviewToken = 0;
  function refreshFramePreview({ immediateGif = false } = {}) {
    if (!state.frame.enabled) {
      state.loading = false;
      return;
    }
    if (state.frame.kind === 'gif') {
      const entry = currentFrameEntry();
      if (entry?.bitmap) {
        state.previewSource = entry.bitmap;
        const bmp = entry.bitmap;
        const w = bmp.displayWidth || bmp.codedWidth || bmp.width || state.assetWidth;
        const h = bmp.displayHeight || bmp.codedHeight || bmp.height || state.assetHeight;
        state.assetWidth = Math.max(1, w);
        state.assetHeight = Math.max(1, h);
      }
      state.loading = false;
      if (immediateGif) renderPreview();
      return;
    }
    if (state.frame.kind === 'video') {
      const token = ++videoPreviewToken;
      state.loading = true;
      const absoluteTime = (item.start ?? 0) + state.frame.timeMs;
      captureVideoFrameForExport(item, absoluteTime).then((frame) => {
        if (destroyed || token !== videoPreviewToken) return;
        if (frame?.canvas) {
          state.previewSource = frame.canvas;
          state.assetWidth = frame.width || frame.canvas?.width || state.assetWidth;
          state.assetHeight = frame.height || frame.canvas?.height || state.assetHeight;
        }
      }).catch((err) => {
        console.warn('mask editor video preview failed', err);
      }).finally(() => {
        if (destroyed || token !== videoPreviewToken) return;
        state.loading = false;
        renderPreview();
      });
    }
  }

  if (state.frame.enabled) {
    if (state.frame.kind === 'gif' && state.frame.entries.length) {
      setFrameIndex(state.frame.index, { updatePreview: false });
    } else if (state.frame.kind === 'video') {
      setFrameTimeMs(state.frame.timeMs, { updatePreview: false });
    }
    updateFrameLabel();
    updateFrameStatusLabel();
  }
  const initialMaskDefinition = state.scope === 'frame'
    ? (getFrameMaskDefinition(item, getCurrentFrameKey()) || item.mask)
    : item.mask;
  const initialMask = initialMaskDefinition || item.mask || null;
  if (initialMask) rememberLastMaskTemplate(initialMask);
  loadMaskIntoState(initialMask || null, { skipRender: true });

  function computePreviewGeometry() {
    const width = Math.max(1, state.assetWidth || 1);
    const height = Math.max(1, state.assetHeight || 1);
    const minZoom = 0.5;
    const maxZoom = 8;
    state.zoom = clamp(state.zoom || 1, minZoom, maxZoom);
    const baseScale = Math.min(previewCanvas.width / width, previewCanvas.height / height);
    state.baseScale = baseScale;
    const scale = baseScale * state.zoom;
    state.scale = scale;
    const centeredX = (previewCanvas.width - width * scale) / 2;
    const centeredY = (previewCanvas.height - height * scale) / 2;
    state.offsetX = centeredX + state.panX;
    state.offsetY = centeredY + state.panY;
  }

  function buildMaskDefinition() {
    if (state.shape === 'square') {
      normalizeSquare();
      return { shape: 'square', rect: { ...state.square } };
    }
    if (state.shape === 'circle') {
      normalizeCircle();
      return { shape: 'circle', circle: { ...state.circle } };
    }
    if (state.shape === 'ellipse') {
      normalizeEllipse();
      return { shape: 'ellipse', ellipse: { ...state.ellipse } };
    }
    if (state.shape === 'star') {
      normalizeStar();
      return { shape: 'star', star: { ...state.star } };
    }
    normalizeFreehand();
    if (state.freehand.points.length >= 3) {
      return { shape: 'freehand', points: state.freehand.points.map(p => ({ x: maskRoundCoord(p.x), y: maskRoundCoord(p.y) })) };
    }
    return null;
  }

  if (!lastMaskTemplate) {
    const initialTemplateDef = buildMaskDefinition();
    if (initialTemplateDef) lastMaskTemplate = sanitizeMaskTemplate(initialTemplateDef);
  }

  function renderPreview() {
    if (!ctx) return;
    computePreviewGeometry();
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.fillStyle = '#10141d';
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (state.previewSource) {
      try {
        ctx.save();
        ctx.translate(state.offsetX, state.offsetY);
        ctx.scale(state.scale, state.scale);
        ctx.drawImage(state.previewSource, 0, 0, state.assetWidth, state.assetHeight);
        ctx.restore();
      } catch (err) {
        console.warn('mask preview draw failed', err);
      }
    } else if (state.loading) {
      ctx.fillStyle = '#2d333f';
      ctx.font = '18px system-ui';
      ctx.fillText('Loading preview…', 24, previewCanvas.height / 2);
    } else {
      ctx.fillStyle = '#2d333f';
      ctx.font = '18px system-ui';
      ctx.fillText('Preview unavailable', 24, previewCanvas.height / 2);
    }
    const maskDef = buildMaskDefinition();
    const points = maskDef ? normalizedMaskPoints(maskDef) : null;
    if (points && points.length >= 3) {
      ctx.save();
      ctx.translate(state.offsetX, state.offsetY);
      ctx.scale(state.scale, state.scale);
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const px = clamp01(points[i].x) * state.assetWidth;
        const py = clamp01(points[i].y) * state.assetHeight;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#5ea2ef';
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1.5 / state.scale, 1.2);
      ctx.strokeStyle = '#5ea2ef';
      ctx.stroke();
      if (state.shape === 'freehand') {
        ctx.fillStyle = '#5ea2ef';
        for (const pt of points) {
          const px = clamp01(pt.x) * state.assetWidth;
          const py = clamp01(pt.y) * state.assetHeight;
          ctx.beginPath();
          ctx.arc(px, py, 4 / state.scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    drawTransformHandles();
    cacheWorkingMaskTemplate();
  }

  function drawTransformHandles() {
    if (!ctx || !isTransformableShape()) return;
    const rect = getActiveShapeRect();
    if (!rect) return;
    const topLeft = assetToCanvasCoords(rect.x, rect.y);
    const bottomRight = assetToCanvasCoords(rect.x + rect.width, rect.y + rect.height);
    ctx.save();
    ctx.strokeStyle = '#f7f7f7';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      topLeft.x,
      topLeft.y,
      bottomRight.x - topLeft.x,
      bottomRight.y - topLeft.y
    );
    ctx.restore();
    const handles = getHandlePositions();
    if (!handles.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    handles.forEach((handle) => {
      if (handle.id === 'center') return;
      const size = 10;
      const half = size / 2;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#5ea2ef';
      ctx.beginPath();
      ctx.rect(handle.canvasX - half, handle.canvasY - half, size, size);
      ctx.fill();
      ctx.stroke();
    });
    const centerHandle = handles.find((handle) => handle.id === 'center');
    if (centerHandle) {
      ctx.beginPath();
      ctx.fillStyle = '#5ea2ef';
      ctx.strokeStyle = '#ffffff';
      ctx.arc(centerHandle.canvasX, centerHandle.canvasY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function updateHint() {
    if (state.shape === 'freehand') {
      previewHint.textContent = state.frame.enabled
        ? 'Click to add polygon points. Use the frame controls above, hold Space/middle-click to pan, and Ctrl+scroll to zoom.'
        : 'Click to add polygon points. Hold Space or use middle-click to pan; Ctrl+scroll to zoom.';
    } else {
      previewHint.textContent = state.frame.enabled
        ? 'Drag the mask or use sliders plus frame navigation. Ctrl+scroll to zoom; hold Space/middle-click to pan.'
        : 'Drag the mask or use sliders. Ctrl+scroll to zoom; hold Space or middle-click to pan the preview.';
    }
  }

  function refreshShapeButtons() {
    for (const [key, btn] of shapeButtons.entries()) {
      btn.classList.toggle('active', state.shape === key);
    }
  }

  function updateActionButtons() {
    for (const [key, btn] of actionButtons.entries()) {
      btn.classList.toggle('active', state.selectedAction === key);
    }
  }

  function selectAction(action) {
    state.selectedAction = action;
    state.pendingSplit = action === 'split';
    if (action === 'keep' || action === 'remove') {
      state.mode = action;
    }
    if (action !== 'split') {
      setError('');
    }
    updateActionButtons();
    updateFrameApplyButtons();
  }

  function runSelectedAction(options = {}) {
    const action = state.selectedAction || 'keep';
    if (action === 'split') {
      if (frameState.enabled && options.target !== 'clip-all' && options.scopeOverride !== 'clip') {
        setError('Split to new layer applies to the entire clip and runs when you click Finished.');
        return false;
      }
      setError('Click Finished to create the new layer.');
      return false;
    }
    const mode = action === 'remove' ? 'remove' : 'keep';
    performApply(mode, options);
  }

  function createPercentSlider(label, getter, setter, { min = 0, max = 100, step = 1 } = {}) {
    const row = document.createElement('label');
    row.className = 'mask-editor-control';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const valueEl = document.createElement('span');
    valueEl.className = 'mask-editor-control-value';
    const sync = () => {
      const val = clamp(getter(), 0, 1);
      const percent = clamp(Math.round(val * 100), min, max);
      input.value = String(percent);
      valueEl.textContent = percent + '%';
    };
    registerControlUpdater(sync);
    sync();
    input.addEventListener('input', () => {
      const percent = clamp(Number(input.value) || 0, min, max);
      setter(percent / 100);
      sync();
      setError('');
      renderPreview();
    });
    row.append(text, input, valueEl);
    controls.appendChild(row);
  }

  function renderControls() {
    controlUpdaters = [];
    controls.innerHTML = '';
    if (state.shape === 'square') {
      createPercentSlider('Left', () => state.square.x, (v) => { state.square.x = v; normalizeSquare(); });
      createPercentSlider('Top', () => state.square.y, (v) => { state.square.y = v; normalizeSquare(); });
      createPercentSlider('Width', () => state.square.width, (v) => { state.square.width = clamp(v, 0.05, 1); normalizeSquare(); }, { min: 5, max: 100 });
      createPercentSlider('Height', () => state.square.height, (v) => { state.square.height = clamp(v, 0.05, 1); normalizeSquare(); }, { min: 5, max: 100 });
    } else if (state.shape === 'circle') {
      createPercentSlider('Center X', () => state.circle.cx, (v) => { state.circle.cx = v; normalizeCircle(); });
      createPercentSlider('Center Y', () => state.circle.cy, (v) => { state.circle.cy = v; normalizeCircle(); });
      createPercentSlider('Radius', () => state.circle.radius, (v) => { state.circle.radius = clamp(v, 0.05, 0.6); normalizeCircle(); }, { min: 5, max: 60, step: 1 });
    } else if (state.shape === 'ellipse') {
      createPercentSlider('Center X', () => state.ellipse.cx, (v) => { state.ellipse.cx = v; normalizeEllipse(); });
      createPercentSlider('Center Y', () => state.ellipse.cy, (v) => { state.ellipse.cy = v; normalizeEllipse(); });
      createPercentSlider('Radius X', () => state.ellipse.rx, (v) => { state.ellipse.rx = clamp(v, 0.05, 0.6); normalizeEllipse(); }, { min: 5, max: 60 });
      createPercentSlider('Radius Y', () => state.ellipse.ry, (v) => { state.ellipse.ry = clamp(v, 0.05, 0.6); normalizeEllipse(); }, { min: 5, max: 60 });
    } else if (state.shape === 'star') {
      createPercentSlider('Center X', () => state.star.cx, (v) => { state.star.cx = v; normalizeStar(); });
      createPercentSlider('Center Y', () => state.star.cy, (v) => { state.star.cy = v; normalizeStar(); });
      createPercentSlider('Outer Radius', () => state.star.outerRadius, (v) => { state.star.outerRadius = clamp(v, 0.05, 0.6); normalizeStar(); }, { min: 5, max: 60 });
      const innerRow = document.createElement('label');
      innerRow.className = 'mask-editor-control';
      const innerLabel = document.createElement('span');
      innerLabel.textContent = 'Inner Radius';
      const innerInput = document.createElement('input');
      innerInput.type = 'range';
      innerInput.min = '10';
      innerInput.max = '90';
      innerInput.step = '1';
      const innerValue = document.createElement('span');
      innerValue.className = 'mask-editor-control-value';
      const updateInner = () => {
        const ratio = clamp(state.star.innerRadius / Math.max(state.star.outerRadius, 0.01), 0.1, 0.9);
        innerInput.value = String(Math.round(ratio * 100));
        innerValue.textContent = Math.round(ratio * 100) + '%';
      };
      registerControlUpdater(updateInner);
      updateInner();
      innerInput.addEventListener('input', () => {
        const ratio = clamp(Number(innerInput.value) / 100, 0.1, 0.9);
        state.star.innerRadius = clamp(state.star.outerRadius * ratio, 0.02, Math.max(0.02, state.star.outerRadius - 0.02));
        normalizeStar();
        updateInner();
        setError('');
        renderPreview();
      });
      innerRow.append(innerLabel, innerInput, innerValue);
      controls.appendChild(innerRow);

      const pointsRow = document.createElement('label');
      pointsRow.className = 'mask-editor-control mask-editor-control-inline';
      const pointsLabel = document.createElement('span');
      pointsLabel.textContent = 'Points';
      const pointsInput = document.createElement('input');
      pointsInput.type = 'number';
      pointsInput.min = '3';
      pointsInput.max = '12';
      pointsInput.value = String(clamp(Math.round(state.star.points), 3, 12));
      pointsInput.addEventListener('change', () => {
        const val = clamp(Math.round(Number(pointsInput.value) || 5), 3, 12);
        state.star.points = val;
        pointsInput.value = String(val);
        setError('');
        renderPreview();
      });
      pointsRow.append(pointsLabel, pointsInput);
      controls.appendChild(pointsRow);
    } else {
      const note = document.createElement('p');
      note.className = 'mask-editor-freehand-note';
      note.textContent = 'Use the preview to place freehand points. At least three points are required.';
      controls.appendChild(note);
    }
  }

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.textContent = 'Undo Point';
  undoBtn.addEventListener('click', () => {
    if (!state.freehand.points.length) return;
    state.freehand.points.pop();
    setError('');
    renderPreview();
    updateFreehandTools();
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear Points';
  clearBtn.addEventListener('click', () => {
    if (!state.freehand.points.length) return;
    state.freehand.points = [];
    setError('');
    renderPreview();
    updateFreehandTools();
  });
  freehandTools.append(undoBtn, clearBtn);

  function updateFreehandTools() {
    const visible = state.shape === 'freehand';
    freehandTools.hidden = !visible;
    undoBtn.disabled = !visible || state.freehand.points.length === 0;
    clearBtn.disabled = !visible || state.freehand.points.length === 0;
  }

  function updatePreviewCursor() {
    let cursor = 'default';
    if (pointerState.isPanning) {
      cursor = 'grabbing';
    } else if (pointerState.spaceHeld) {
      cursor = 'grab';
    } else if (pointerState.isTransforming && pointerState.activeCursor) {
      cursor = pointerState.activeCursor;
    } else if (pointerState.hoverCursor) {
      cursor = pointerState.hoverCursor;
    } else if (state.shape === 'freehand') {
      cursor = 'crosshair';
    }
    previewCanvas.style.cursor = cursor;
  }

  function canPan(ev) {
    if (ev.button === 1) return true;
    if (pointerState.spaceHeld && ev.button === 0) return true;
    return false;
  }

  function beginPan(ev) {
    ev.preventDefault();
    pointerState.isPanning = true;
    pointerState.startX = ev.clientX;
    pointerState.startY = ev.clientY;
    pointerState.panStartX = state.panX;
    pointerState.panStartY = state.panY;
    pointerState.didMove = false;
    try { previewCanvas.setPointerCapture(ev.pointerId); } catch {}
    updatePreviewCursor();
  }

  function endPan(ev) {
    pointerState.isPanning = false;
    try { previewCanvas.releasePointerCapture(ev.pointerId); } catch {}
    if (pointerState.didMove) {
      pointerState.ignoreClick = true;
      setTimeout(() => { pointerState.ignoreClick = false; }, 0);
    }
    pointerState.didMove = false;
    updatePreviewCursor();
  }

  function beginShapeTransform(handle, pointerPos, ev) {
    pointerState.isTransforming = true;
    pointerState.activeHandle = handle.id;
    pointerState.activeCursor = handle.cursor || '';
    pointerState.startPointer = { x: pointerPos.normX, y: pointerPos.normY };
    pointerState.startShape = captureActiveShapeSnapshot();
    pointerState.startRect = getActiveShapeRect();
    pointerState.handleInfo = handle;
    pointerState.handleOffset = (typeof handle.normX === 'number' && typeof handle.normY === 'number')
      ? { x: pointerPos.normX - handle.normX, y: pointerPos.normY - handle.normY }
      : null;
    try { previewCanvas.setPointerCapture(ev.pointerId); } catch {}
    updatePreviewCursor();
  }

  function updateShapeTransform(pointerPos) {
    if (!pointerState.isTransforming || !pointerPos) return;
    const handleId = pointerState.activeHandle || 'move';
    if (state.shape === 'square') {
      applyRectTransformToSquare(handleId, pointerPos);
    } else if (state.shape === 'circle') {
      applyRectTransformToEllipse(handleId, pointerPos, { enforceCircle: true });
    } else if (state.shape === 'ellipse') {
      applyRectTransformToEllipse(handleId, pointerPos);
    } else if (state.shape === 'star') {
      applyStarTransform(handleId, pointerPos);
    }
    setError('');
    renderPreview();
    syncControlValues();
  }

  function finishShapeTransform(ev) {
    pointerState.isTransforming = false;
    pointerState.activeHandle = null;
    pointerState.activeCursor = '';
    pointerState.startPointer = null;
    pointerState.startShape = null;
    pointerState.startRect = null;
    pointerState.handleInfo = null;
    pointerState.handleOffset = null;
    try { previewCanvas.releasePointerCapture(ev.pointerId); } catch {}
    syncControlValues();
    renderPreview();
    updatePreviewCursor();
  }

  function updateHoverCursor(pointerPos) {
    if (!isTransformableShape()) {
      if (pointerState.hoverCursor) {
        pointerState.hoverCursor = '';
        updatePreviewCursor();
      }
      return;
    }
    const handle = pointerPos ? detectTransformHandle(pointerPos) : null;
    const nextCursor = handle?.cursor || '';
    if (pointerState.hoverCursor !== nextCursor) {
      pointerState.hoverCursor = nextCursor;
      updatePreviewCursor();
    }
  }

  function onPreviewPointerDown(ev) {
    if (canPan(ev)) {
      beginPan(ev);
      return;
    }
    if (ev.button !== 0 || !isTransformableShape()) {
      updateHoverCursor(null);
      return;
    }
    const pointerPos = pointerPositionFromEvent(ev);
    const handle = detectTransformHandle(pointerPos);
    if (!handle) {
      updateHoverCursor(pointerPos);
      return;
    }
    ev.preventDefault();
    beginShapeTransform(handle, pointerPos, ev);
  }

  function onPreviewPointerMove(ev) {
    if (pointerState.isPanning) {
      const dx = ev.clientX - pointerState.startX;
      const dy = ev.clientY - pointerState.startY;
      state.panX = pointerState.panStartX + dx;
      state.panY = pointerState.panStartY + dy;
      pointerState.didMove = pointerState.didMove || Math.abs(dx) > 2 || Math.abs(dy) > 2;
      renderPreview();
      return;
    }
    if (pointerState.isTransforming) {
      ev.preventDefault();
      const pointerPos = pointerPositionFromEvent(ev);
      updateShapeTransform(pointerPos);
      return;
    }
    if (!isTransformableShape()) {
      updateHoverCursor(null);
      return;
    }
    const pointerPos = pointerPositionFromEvent(ev);
    updateHoverCursor(pointerPos);
  }

  function onPreviewPointerUp(ev) {
    if (pointerState.isPanning) {
      endPan(ev);
    }
    if (pointerState.isTransforming) {
      finishShapeTransform(ev);
    }
    if (!pointerState.isPanning && !pointerState.isTransforming) {
      if (ev.type === 'pointerleave' || ev.type === 'pointercancel') {
        updateHoverCursor(null);
      } else {
        updateHoverCursor(pointerPositionFromEvent(ev));
      }
    }
  }

  function ensureMaskReady() {
    const maskDef = buildMaskDefinition();
    const pts = maskDef ? normalizedMaskPoints(maskDef) : null;
    if (!maskDef || !pts || pts.length < 3) {
      setError(state.shape === 'freehand'
        ? 'Add at least three points for a freehand mask.'
        : 'Adjust the mask so it covers a visible area.');
      return null;
    }
    setError('');
    return maskDef;
  }

  const keepBtn = document.createElement('button');
  keepBtn.type = 'button';
  keepBtn.className = 'mask-editor-action-btn';
  keepBtn.textContent = 'Keep Inside Mask';
  actionButtons.set('keep', keepBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'mask-editor-action-btn';
  removeBtn.textContent = 'Remove Masked Area';
  actionButtons.set('remove', removeBtn);

  const splitBtn = document.createElement('button');
  splitBtn.type = 'button';
  splitBtn.className = 'mask-editor-action-btn';
  splitBtn.textContent = 'Split To New Layer';
  actionButtons.set('split', splitBtn);

  clearMaskBtn = document.createElement('button');
  clearMaskBtn.type = 'button';
  clearMaskBtn.textContent = 'Clear Mask';
  const initialFrameMask = frameState.enabled ? getFrameMaskDefinition(item, getCurrentFrameKey()) : null;
  clearMaskBtn.disabled = !item.mask && !initialFrameMask;

  const finishBtn = document.createElement('button');
  finishBtn.type = 'button';
  finishBtn.textContent = 'Finished';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';

  actionBar.append(keepBtn, removeBtn, splitBtn);
  footerBar.append(clearMaskBtn, cancelBtn, finishBtn);

  function performApply(mode, { target = 'current', scopeOverride = null, showIndicator = false } = {}) {
    const maskDef = ensureMaskReady();
    if (!maskDef) return;
    const scope = scopeOverride || (frameState.enabled ? state.scope : 'clip');
    const targets = [];
    if (scope === 'clip' || !frameState.enabled) {
      targets.push({ frameKey: null });
    } else {
      const frameKey = getCurrentFrameKey();
      if (!frameKey) {
        setError('Select a frame to apply this mask.');
        return;
      }
      if (target === 'prev' || target === 'next') {
        const delta = target === 'prev' ? -1 : 1;
        const neighbor = resolveNeighborFrame(delta);
        if (!neighbor) {
          setError(`No ${target === 'prev' ? 'previous' : 'next'} frame available.`);
          return;
        }
        targets.push({ frameKey: neighbor.key });
      } else {
        targets.push({ frameKey });
      }
    }
    if (!targets.length) {
      setError('No target frame available for this mask.');
      return;
    }
    const historySnapshot = snapshotProject();
    if (target === 'clip-all') {
      item.maskFrames = {};
      targets.splice(0, targets.length, { frameKey: null });
      setMaskScope('clip');
    }
    targets.forEach(({ frameKey }) => {
      const exists = frameKey && item.maskFrames && item.maskFrames[frameKey];
      if (exists && target !== 'current') {
        const confirmOverwrite = window.confirm('That frame already has a mask. Overwrite it?');
        if (!confirmOverwrite) return;
      }
      applyMaskDefinitionToItem(item, maskDef, { mode, frameKey });
    });
    state.mode = mode;
    rememberLastMaskTemplate(maskDef);
    refreshStageVisibility();
    renderTimeline();
    selectClip(item.id);
    updateFrameStatusLabel();
    pushHistoryWithSnapshot(historySnapshot, mode === 'remove' ? 'mask-remove' : 'mask-apply');
    scheduleAutosave(mode === 'remove' ? 'pushHistory:mask-remove' : 'pushHistory:mask-apply');
    if (target === 'prev') shiftFrame(-1);
    else if (target === 'next') shiftFrame(1);
    else if (showIndicator && frameAppliedBadge) {
      frameAppliedBadge.hidden = false;
      frameAppliedBadge.textContent = 'Applied!';
      setTimeout(() => {
        if (frameAppliedBadge) frameAppliedBadge.hidden = true;
      }, 1500);
    }
  }

  function performSplit() {
    const maskDef = ensureMaskReady();
    if (!maskDef) return false;
    const historySnapshot = snapshotProject();
    const clone = splitVisualItemIntoMaskedLayers(item, maskDef, {});
    if (!clone) {
      setError('Unable to split this mask.');
      return false;
    }
    clone.trackIndex = getNextTrackIndex('visual');
    PROJECT.items.push(clone);
    spawnStageItem(clone);
    positionStageItem(clone);
    refreshStageMaskPreview(clone);
    const cloneType = clone.mediaType || (isVideo(clone.path) ? 'video' : (isGifPath(clone.path) ? 'gif' : 'image'));
    if (cloneType === 'gif') {
      if (supportsImageDecoder) {
        prepareGif(clone).catch((err) => {
          console.warn('mask split gif prep failed', err);
          fallbackToImg(clone);
        });
      } else {
        fallbackToImg(clone);
      }
    } else if (cloneType === 'image' && clone._stageCanvas) {
      populateStageStaticCanvas(clone, clone._stageCanvas);
    } else if (cloneType === 'video') {
      syncStageVideoChroma(clone, { forceFrame: true });
    }
    refreshStageVisibility();
    renderActiveGifs();
    renderTimeline();
    selectClip(clone.id);
    pushHistoryWithSnapshot(historySnapshot, 'mask-split');
    scheduleAutosave('pushHistory:mask-split');
    state.pendingSplit = false;
    return true;
  }

  function performClear() {
    const historySnapshot = snapshotProject();
    if (state.scope === 'frame' && frameState.enabled) {
      const frameKey = getCurrentFrameKey();
      if (!frameKey) {
        setError('Select a frame to clear.');
        return;
      }
      clearItemMask(item, { frameKey });
    } else {
      const hadClipMask = !!item.mask;
      if (hadClipMask) clearItemMask(item);
      if (item.maskFrames && Object.keys(item.maskFrames).length) {
        item.maskFrames = {};
        invalidateItemMaskCache(item);
        positionStageItem(item);
        refreshStageMaskPreview(item);
      }
    }
    refreshStageVisibility();
    renderTimeline();
    selectClip(item.id);
    updateFrameStatusLabel();
    pushHistoryWithSnapshot(historySnapshot, 'mask-clear');
    scheduleAutosave('pushHistory:mask-clear');
    if (!frameState.enabled) close();
  }

  function close() {
    if (destroyed) return;
    destroyed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    overlay.removeEventListener('click', onOverlayClick);
    previewCanvas.removeEventListener('click', onPreviewClick);
    overlay.remove();
  }

  function onOverlayClick(ev) {
    if (ev.target === overlay) {
      ev.preventDefault();
      close();
    }
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.code === 'Space' && !ev.repeat) {
      ev.preventDefault();
      pointerState.spaceHeld = true;
      updatePreviewCursor();
    }
  }

  function onKeyUp(ev) {
    if (ev.code === 'Space') {
      pointerState.spaceHeld = false;
      updatePreviewCursor();
    }
  }

  function onPreviewClick(ev) {
    if (pointerState.ignoreClick) return;
    if (state.shape !== 'freehand') return;
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const localX = (ev.clientX - rect.left) * scaleX;
    const localY = (ev.clientY - rect.top) * scaleY;
    const assetX = (localX - state.offsetX) / (state.scale * state.assetWidth);
    const assetY = (localY - state.offsetY) / (state.scale * state.assetHeight);
    if (!Number.isFinite(assetX) || !Number.isFinite(assetY)) return;
    if (assetX < 0 || assetX > 1 || assetY < 0 || assetY > 1) return;
    state.freehand.points.push({ x: maskRoundCoord(assetX), y: maskRoundCoord(assetY) });
    setError('');
    renderPreview();
    updateFreehandTools();
  }

  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  previewCanvas.addEventListener('click', onPreviewClick);

  keepBtn.addEventListener('click', () => {
    selectAction('keep');
    if (!frameState.enabled) runSelectedAction();
  });
  removeBtn.addEventListener('click', () => {
    selectAction('remove');
    if (!frameState.enabled) runSelectedAction();
  });
  splitBtn.addEventListener('click', () => {
    selectAction('split');
    setError('');
  });
  clearMaskBtn.addEventListener('click', performClear);
  finishBtn.addEventListener('click', () => {
    if (state.selectedAction === 'split' && state.pendingSplit) {
      const ok = performSplit();
      if (!ok) return;
    }
    close();
  });
  cancelBtn.addEventListener('click', close);
  updateActionButtons();
  updateFrameApplyButtons();

  shapes.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mask-editor-shape-btn';
    btn.dataset.shape = key;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (state.shape === key) return;
      state.shape = key;
      lastShapeKey = key;
      pointerState.isTransforming = false;
      pointerState.activeHandle = null;
      pointerState.activeCursor = '';
      pointerState.hoverCursor = '';
      setError('');
      refreshShapeButtons();
      renderControls();
      updateHint();
      updateFreehandTools();
      renderPreview();
      updatePreviewCursor();
    });
    shapeBar.appendChild(btn);
    shapeButtons.set(key, btn);
  });

  refreshShapeButtons();
  renderControls();
  updateHint();
  updateFreehandTools();
  normalizeCurrentShape();
  updatePreviewCursor();
  function updateZoomControls() {
    const percent = Math.round((state.zoom || 1) * 100);
    zoomSlider.value = String(clamp(percent, 50, 800));
    zoomValue.textContent = `${(percent / 100).toFixed(2)}×`;
  }
  zoomSlider.addEventListener('input', () => {
    const value = clamp(Number(zoomSlider.value) || 100, 50, 800);
    state.zoom = clamp(value / 100, 0.5, 8);
    renderPreview();
    updateZoomControls();
  });
  updateZoomControls();
  previewCanvas.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    const delta = ev.deltaY > 0 ? -0.1 : 0.1;
    state.zoom = clamp((state.zoom || 1) + delta, 0.5, 8);
    updateZoomControls();
    renderPreview();
  }, { passive: false });
  previewCanvas.addEventListener('pointerdown', onPreviewPointerDown);
  previewCanvas.addEventListener('pointermove', onPreviewPointerMove);
  previewCanvas.addEventListener('pointerup', onPreviewPointerUp);
  previewCanvas.addEventListener('pointerleave', onPreviewPointerUp);
  previewCanvas.addEventListener('pointercancel', onPreviewPointerUp);
  previewCanvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  renderPreview();
  keepBtn.focus();

  if (state.frame.enabled) {
    refreshFramePreview({ immediateGif: state.frame.kind === 'gif' });
  } else {
    (async () => {
      try {
        if (isVideoClip(item)) {
          const frame = await captureVideoFrameForExport(item, currentTime);
          if (destroyed) return;
          if (frame?.canvas) {
            state.previewSource = frame.canvas;
            state.assetWidth = frame.width || frame.canvas.width || state.assetWidth;
            state.assetHeight = frame.height || frame.canvas.height || state.assetHeight;
          }
        } else {
          const img = await ensureStaticImageSource(item);
          if (destroyed) return;
          if (img) {
            state.previewSource = img;
            state.assetWidth = img.naturalWidth || img.width || state.assetWidth;
            state.assetHeight = img.naturalHeight || img.height || state.assetHeight;
          }
        }
      } catch (err) {
        console.warn('mask preview load failed', err);
      } finally {
        if (destroyed) return;
        state.loading = false;
        renderPreview();
      }
    })();
  }
}

function onStageContextMenu(e) {
  const origin = e.target;
  if (!(origin instanceof Element)) return;
  const stageItem = origin.closest('.stage-item');
  if (!stageItem) return;
  const id = stageItem.dataset.id;
  if (!id) return;
  const item = PROJECT.items.find(i => i.id === id);
  const text = item ? null : PROJECT.text.find(t => t.id === id);
  const target = item || text;
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  selectClip(id);
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.addEventListener('mousedown', ev => ev.stopPropagation());
  menu.addEventListener('click', ev => ev.stopPropagation());
  const rotateBtn = document.createElement('button');
  rotateBtn.textContent = 'Rotate...';
  const resizeBtn = document.createElement('button');
  resizeBtn.textContent = 'Resize...';
  const locked = isClipLocked(id);
  if (locked) {
    rotateBtn.disabled = true;
    rotateBtn.title = 'Unlock this clip to rotate it';
    resizeBtn.disabled = true;
    resizeBtn.title = 'Unlock this clip to resize it';
  }
  rotateBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenu();
    if (!locked) {
      openStageRotateDialog(target, { kind: item ? 'visual' : 'text' });
    }
  });
  resizeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenu();
    if (!locked) {
      openStageResizeDialog(target, { kind: item ? 'visual' : 'text' });
    }
  });
  menu.appendChild(rotateBtn);
  menu.appendChild(resizeBtn);
  if (item && item.kind === 'visual') {
    const maskBtn = document.createElement('button');
    maskBtn.textContent = item.mask ? 'Edit Mask...' : 'Add Mask...';
    if (locked) {
      maskBtn.disabled = true;
      maskBtn.title = 'Unlock this clip to modify its mask';
    }
    maskBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      if (!locked) {
        openMaskEditor(item);
      }
    });
    menu.appendChild(maskBtn);
  }
  if (item) {
    const weldInfo = getWeldInfo(item);
    const weldBtn = document.createElement('button');
    weldBtn.textContent = weldInfo ? 'Change Weld...' : 'Weld to...';
    const candidateParents = availableWeldParents(item);
    if (locked || !candidateParents.length) {
      weldBtn.disabled = true;
      weldBtn.title = locked
        ? 'Unlock this clip to change weld settings'
        : 'Add another visual clip to weld to';
    }
    weldBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      if (locked) return;
      openStageWeldDialog(item);
    });
    menu.appendChild(weldBtn);

    if (weldInfo) {
      const unweldBtn = document.createElement('button');
      unweldBtn.textContent = 'Remove Weld';
      if (locked) {
        unweldBtn.disabled = true;
        unweldBtn.title = 'Unlock this clip to remove the weld';
      }
      unweldBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMenu();
        if (locked) return;
        const historySnapshot = snapshotProject();
        detachWeld(item, { preserveWorld: true });
        pushHistoryWithSnapshot(historySnapshot, 'stage-unweld');
        scheduleAutosave('pushHistory:stage-unweld');
        positionStageItem(item);
        refreshStageVisibility();
        updateStageSizePanel();
      });
      menu.appendChild(unweldBtn);
    }
  }
  if (item && isVideoClip(item)) {
    const fitBtn = document.createElement('button');
    fitBtn.textContent = 'Fit to Screen';
    if (locked) {
      fitBtn.disabled = true;
      fitBtn.title = 'Unlock this clip to modify it';
    }
    fitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      if (locked) return;
      const snapshot = snapshotProject();
      fitVisualItemToStage(item);
      positionStageItem(item);
      refreshStageVisibility();
      pushHistoryWithSnapshot(snapshot, 'fit-to-screen');
      scheduleAutosave('pushHistory:fit-to-screen');
    });
    menu.appendChild(fitBtn);
  }
  attachAndFitMenu(menu, e.clientX, e.clientY);
}

function openStageResizeDialog(target, { kind = null } = {}) {
  if (!target) return;
  let resolvedKind = kind;
  if (!resolvedKind) {
    if (PROJECT.items.includes(target)) resolvedKind = 'visual';
    else if (PROJECT.text.includes(target)) resolvedKind = 'text';
  }
  if (!resolvedKind) return;
  const targetId = target.id;
  if (targetId && isClipLocked(targetId)) return;

  const supportsIndependentAxes = resolvedKind === 'visual';
  const historySnapshot = snapshotProject();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const form = document.createElement('form');
  form.className = 'stage-resize-dialog';
  const title = document.createElement('h2');
  title.textContent = 'Resize Item';
  const axisGrid = document.createElement('div');
  axisGrid.className = 'stage-resize-axis-grid';
  const linkRow = document.createElement('label');
  linkRow.className = 'stage-resize-link';
  const linkInput = document.createElement('input');
  linkInput.type = 'checkbox';
  linkInput.checked = true;
  const linkText = document.createElement('span');
  linkText.textContent = 'Link X and Y';
  linkRow.append(linkInput, linkText);
  if (!supportsIndependentAxes) linkRow.hidden = true;
  const note = document.createElement('p');
  note.className = 'stage-resize-note';
  note.textContent = supportsIndependentAxes
    ? 'Scroll wheel sizing still works. Unlink axes to stretch an image independently.'
    : 'Scroll wheel sizing still works; scaling remains linked for text.';
  const errorEl = document.createElement('div');
  errorEl.className = 'stage-resize-error';
  const actions = document.createElement('div');
  actions.className = 'stage-resize-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'submit';
  applyBtn.className = 'primary';
  applyBtn.textContent = 'Confirm';
  actions.append(cancelBtn, applyBtn);

  const initialAxes = getScaleAxes(target);
  const axes = {};
  const axisDefs = [
    { key: 'x', label: 'Scale X', initial: initialAxes.x },
    { key: 'y', label: 'Scale Y', initial: initialAxes.y }
  ];

  axisDefs.forEach(({ key, label, initial }) => {
    const row = document.createElement('label');
    row.className = 'stage-resize-axis';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.001';
    input.min = String(STAGE_SCALE_MIN);
    input.max = String(STAGE_SCALE_MAX);
    input.value = formatStageScaleValue(initial);
    input.addEventListener('input', () => {
      errorEl.textContent = '';
      if (!supportsIndependentAxes || linkInput.checked) {
        const otherKey = key === 'x' ? 'y' : 'x';
        if (axes[otherKey] && axes[otherKey].value !== input.value) {
          axes[otherKey].value = input.value;
        }
      }
      previewFromInputs({ silentError: true });
    });
    row.append(text, input);
    axisGrid.appendChild(row);
    axes[key] = input;
  });

  linkInput.addEventListener('change', () => {
    if (linkInput.checked) {
      axes.y.value = axes.x.value;
      previewFromInputs({ silentError: true });
    }
  });

  const overlayContent = [title, axisGrid];
  if (supportsIndependentAxes) overlayContent.push(linkRow);
  overlayContent.push(note, errorEl, actions);
  overlayContent.forEach(node => form.appendChild(node));
  overlay.appendChild(form);
  document.body.appendChild(overlay);

  const originalAxes = { ...initialAxes };
  let committed = false;
  target._editing = true;

  const restoreOriginalState = () => {
    setScaleAxes(target, originalAxes.x, originalAxes.y);
    if (resolvedKind === 'visual') positionStageItem(target);
    else positionTextItem(target);
    updateStageSizePanel();
  };

  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (!committed) restoreOriginalState();
      target._editing = false;
      cleanup();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      if (!committed) restoreOriginalState();
      target._editing = false;
      cleanup();
    }
  });

  cancelBtn.addEventListener('click', () => {
    if (!committed) restoreOriginalState();
    target._editing = false;
    cleanup();
  });

  function extractAxisValues() {
    const valX = clampStageScaleValue(axes.x.value);
    const valYRaw = clampStageScaleValue(axes.y.value);
    if (valX == null) return null;
    if (!supportsIndependentAxes || linkInput.checked) {
      return { x: valX, y: valX };
    }
    if (valYRaw == null) return null;
    return { x: valX, y: valYRaw };
  }

  function previewFromInputs({ silentError = false } = {}) {
    const values = extractAxisValues();
    if (!values) {
      if (!silentError) {
        errorEl.textContent = `Enter values between ${STAGE_SCALE_MIN} and ${STAGE_SCALE_MAX}.`;
      }
      return null;
    }
    if (supportsIndependentAxes) setScaleAxes(target, values.x, values.y);
    else setUniformScale(target, values.x);
    if (resolvedKind === 'visual') positionStageItem(target);
    else positionTextItem(target);
    updateStageSizePanel();
    return values;
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const values = previewFromInputs({ silentError: false });
    if (!values) return;
    const targetAxes = getScaleAxes(target);
    if (!haveScaleAxesChanged(originalAxes.x, originalAxes.y, targetAxes.x, targetAxes.y, STAGE_SCALE_EPS)) {
      target._editing = false;
      cleanup();
      return;
    }
    target._editing = false;
    const label = resolvedKind === 'visual' ? 'stage-scale' : 'text-scale';
    pushHistoryWithSnapshot(historySnapshot, label);
    scheduleAutosave(`pushHistory:${label}`);
    updateStageSizePanel();
    committed = true;
    cleanup();
  });

  setTimeout(() => {
    axes.x.focus({ preventScroll: true });
    axes.x.select();
  }, 10);
}

function openStageRotateDialog(target, { kind = null } = {}) {
  if (!target) return;
  let resolvedKind = kind;
  if (!resolvedKind) {
    if (PROJECT.items.includes(target)) resolvedKind = 'visual';
    else if (PROJECT.text.includes(target)) resolvedKind = 'text';
  }
  if (!resolvedKind) return;
  const targetId = target.id;
  if (targetId && isClipLocked(targetId)) return;

  const historySnapshot = snapshotProject();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const form = document.createElement('form');
  form.className = 'stage-resize-dialog stage-rotate-dialog';
  const title = document.createElement('h2');
  title.textContent = 'Rotate Item';

  const axisGrid = document.createElement('div');
  axisGrid.className = 'stage-resize-axis-grid';
  const row = document.createElement('label');
  row.className = 'stage-resize-axis';
  const text = document.createElement('span');
  text.textContent = 'Rotation (deg)';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.min = String(STAGE_ROTATION_MIN);
  input.max = String(STAGE_ROTATION_MAX);
  const weld = resolvedKind === 'visual' ? getWeldInfo(target) : null;
  const weldParent = weld ? getWeldParent(target) : null;
  const followRotation = !(weld && weld.followRotation === false);
  const parentPose = followRotation && weldParent
    ? resolvePoseRecursive(weldParent, {
        time: currentTime,
        includeEditing: true,
        visited: new Set([target.id])
      })
    : null;
  const parentRotationAtStart = parentPose ? Number(parentPose.rotation) || 0 : 0;
  const originalRotationLocal = getStageRotation(target);
  const originalRotationWorld = originalRotationLocal + parentRotationAtStart;
  input.value = formatStageRotationValue(originalRotationWorld);
  row.append(text, input);
  axisGrid.appendChild(row);

  const note = document.createElement('p');
  note.className = 'stage-resize-note';
  note.textContent = 'Drag a corner handle or enter an exact angle. Hold Shift while rotating to snap to 15 deg increments.';
  const errorEl = document.createElement('div');
  errorEl.className = 'stage-resize-error';
  const actions = document.createElement('div');
  actions.className = 'stage-resize-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'submit';
  applyBtn.className = 'primary';
  applyBtn.textContent = 'Confirm';
  actions.append(cancelBtn, applyBtn);

  form.append(title, axisGrid, note, errorEl, actions);
  overlay.appendChild(form);
  document.body.appendChild(overlay);

  let committed = false;
  target._editing = true;

  const previewFromInput = ({ silentError = false } = {}) => {
    const value = clampStageRotationValue(input.value);
    if (value == null) {
      if (!silentError) {
        errorEl.textContent = `Enter a value between ${STAGE_ROTATION_MIN} and ${STAGE_ROTATION_MAX} degrees.`;
      }
      return null;
    }
    errorEl.textContent = '';
    const parentRotation = followRotation && weldParent
      ? (resolvePoseRecursive(weldParent, {
          time: currentTime,
          includeEditing: true,
          visited: new Set([target.id])
        })?.rotation || parentRotationAtStart)
      : 0;
    const localValue = followRotation ? value - Number(parentRotation || 0) : value;
    setStageRotation(target, localValue);
    if (resolvedKind === 'visual') positionStageItem(target);
    else positionTextItem(target);
    updateStageSizePanel();
    return value;
  };

  const restoreOriginalState = () => {
    setStageRotation(target, originalRotationLocal);
    if (resolvedKind === 'visual') positionStageItem(target);
    else positionTextItem(target);
    updateStageSizePanel();
  };

  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (!committed) restoreOriginalState();
      target._editing = false;
      cleanup();
    }
  };

  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      if (!committed) restoreOriginalState();
      target._editing = false;
      cleanup();
    }
  });

  cancelBtn.addEventListener('click', () => {
    if (!committed) restoreOriginalState();
    target._editing = false;
    cleanup();
  });

  input.addEventListener('input', () => {
    previewFromInput({ silentError: true });
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = previewFromInput({ silentError: false });
    if (value == null) return;
    const currentRotation = getStageRotation(target);
    if (!haveStageRotationsChanged(originalRotationLocal, currentRotation, STAGE_ROTATION_EPS)) {
      target._editing = false;
      restoreOriginalState();
      cleanup();
      return;
    }
    target._editing = false;
    const label = resolvedKind === 'visual' ? 'stage-rotate' : 'text-rotate';
    pushHistoryWithSnapshot(historySnapshot, label);
    scheduleAutosave(`pushHistory:${label}`);
    updateStageSizePanel();
    committed = true;
    cleanup();
  });

  setTimeout(() => {
    input.focus({ preventScroll: true });
    input.select();
  }, 10);
}

function openStageWeldDialog(target) {
  if (!target) return;
  const targetId = target.id;
  if (!targetId) return;
  if (isClipLocked(targetId)) return;
  if (!PROJECT.items.includes(target)) return;

  const existingInfo = getWeldInfo(target);
  const candidates = availableWeldParents(target);

  if (!candidates.length) {
    alert('No overlapping clips available to weld with.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const form = document.createElement('form');
  form.className = 'stage-resize-dialog stage-weld-dialog';
  const title = document.createElement('h2');
  title.textContent = 'Weld Item';

  const parentRow = document.createElement('label');
  parentRow.className = 'stage-resize-axis';
  const parentText = document.createElement('span');
  parentText.textContent = 'Attach To';
  const parentSelect = document.createElement('select');
  parentSelect.required = true;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a parent clip';
  parentSelect.appendChild(placeholder);
  candidates.forEach(it => {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = visualItemDisplayName(it);
    if (existingInfo && existingInfo.parentId === it.id) {
      opt.selected = true;
    }
    parentSelect.appendChild(opt);
  });
  parentRow.append(parentText, parentSelect);

  const followRotationRow = document.createElement('label');
  followRotationRow.className = 'stage-resize-axis';
  const followRotationCheckbox = document.createElement('input');
  followRotationCheckbox.type = 'checkbox';
  followRotationCheckbox.checked = existingInfo ? existingInfo.followRotation !== false : true;
  const followRotationText = document.createElement('span');
  followRotationText.textContent = 'Follow rotation';
  followRotationRow.append(followRotationCheckbox, followRotationText);

  const followScaleRow = document.createElement('label');
  followScaleRow.className = 'stage-resize-axis';
  const followScaleCheckbox = document.createElement('input');
  followScaleCheckbox.type = 'checkbox';
  followScaleCheckbox.checked = existingInfo ? existingInfo.followScale !== false : true;
  const followScaleText = document.createElement('span');
  followScaleText.textContent = 'Follow scale';
  followScaleRow.append(followScaleCheckbox, followScaleText);

  const note = document.createElement('p');
  note.className = 'stage-resize-note';
  note.textContent = 'A welded clip follows the parent\'s position. You can optionally inherit rotation and scale.';

  const errorEl = document.createElement('div');
  errorEl.className = 'stage-resize-error';

  const actions = document.createElement('div');
  actions.className = 'stage-resize-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'submit';
  applyBtn.className = 'primary';
  applyBtn.textContent = existingInfo ? 'Update Weld' : 'Create Weld';
  actions.append(cancelBtn, applyBtn);

  form.append(title, parentRow, followRotationRow, followScaleRow, note, errorEl, actions);
  overlay.appendChild(form);
  document.body.appendChild(overlay);

  let committed = false;
  const historySnapshot = snapshotProject();

  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const restoreIfNeeded = () => {
    if (committed) return;
    if (existingInfo) {
      // no-op: existing weld remains unchanged
    }
  };

  const closeWithoutCommit = () => {
    restoreIfNeeded();
    cleanup();
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeWithoutCommit();
    }
  };

  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      closeWithoutCommit();
    }
  });

  cancelBtn.addEventListener('click', () => {
    closeWithoutCommit();
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const parentId = parentSelect.value;
    if (!parentId) {
      errorEl.textContent = 'Pick a clip to attach to.';
      return;
    }
    if (parentId === targetId || wouldCreateWeldCycle(target, parentId)) {
      errorEl.textContent = 'Unable to weld due to circular relationship.';
      return;
    }

    const followRotation = followRotationCheckbox.checked;
    const followScale = followScaleCheckbox.checked;
    const result = weldItemToParent(target, parentId, {
      followPosition: true,
      followRotation,
      followScale
    });
    if (!result) {
      errorEl.textContent = 'Unable to weld to the selected clip.';
      return;
    }

    const label = existingInfo ? 'stage-update-weld' : 'stage-weld';
    pushHistoryWithSnapshot(historySnapshot, label);
    scheduleAutosave(`pushHistory:${label}`);
    refreshStageVisibility();
    positionStageItem(target);
    updateStageSizePanel();

    committed = true;
    cleanup();
  });

  setTimeout(() => {
    parentSelect.focus({ preventScroll: true });
  }, 10);
}

function kfScaleX(kf) {
  if (!kf) return 1;
  const sx = Number(kf.scaleX);
  if (Number.isFinite(sx)) return clampStageScaleNumber(sx);
  const s = Number(kf.scale);
  return Number.isFinite(s) ? clampStageScaleNumber(s) : 1;
}

function kfScaleY(kf) {
  if (!kf) return 1;
  const sy = Number(kf.scaleY);
  if (Number.isFinite(sy)) return clampStageScaleNumber(sy);
  const s = Number(kf.scale);
  return Number.isFinite(s) ? clampStageScaleNumber(s) : 1;
}

function kfRotation(kf, fallback) {
  if (!kf) return fallback;
  const rot = Number(kf.rotation);
  if (Number.isFinite(rot)) return clampStageRotationNumber(rot);
  return fallback;
}

function getPoseAt(item, t) {
  return resolvePoseRecursive(item, { time: t, includeEditing: false });
}

function resolvePoseRecursive(item, { time = 0, includeEditing = false, visited = new Set() } = {}) {
  if (!item) {
    return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  }

  const itemId = item.id;
  if (itemId && visited.has(itemId)) {
    return {
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      scaleX: 1,
      scaleY: 1,
      rotation: getStageRotation(item)
    };
  }

  if (itemId) visited.add(itemId);

  let localPose;
  if (includeEditing && item._editing) {
    const axes = getScaleAxes(item);
    localPose = {
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      scaleX: axes.x,
      scaleY: axes.y,
      rotation: getStageRotation(item)
    };
  } else {
    localPose = getLocalPoseAt(item, time);
  }

  const weld = getWeldInfo(item);
  if (!weld) {
    if (itemId) visited.delete(itemId);
    return localPose;
  }

  const parent = getWeldParent(item);
  if (!parent) {
    if (itemId) visited.delete(itemId);
    return localPose;
  }

  const parentPose = resolvePoseRecursive(parent, { time, includeEditing, visited });
  if (itemId) visited.delete(itemId);
  return composePoseFromParent(parentPose, localPose, weld);
}

function getLocalPoseAt(item, t) {
  const axes = getScaleAxes(item);
  const baseRotation = getStageRotation(item);
  const base = {
    x: Number(item.x) || 0,
    y: Number(item.y) || 0,
    scaleX: axes.x,
    scaleY: axes.y,
    rotation: baseRotation
  };
  const kf = item.keyframes || [];
  if (!kf.length) return base;

  const first = kf[0];
  const last = kf[kf.length - 1];

  if (t <= first.t) {
    return {
      x: first.x,
      y: first.y,
      scaleX: kfScaleX(first),
      scaleY: kfScaleY(first),
      rotation: kfRotation(first, baseRotation)
    };
  }
  if (t >= last.t) {
    return {
      x: last.x,
      y: last.y,
      scaleX: kfScaleX(last),
      scaleY: kfScaleY(last),
      rotation: kfRotation(last, baseRotation)
    };
  }

  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (t >= a.t && t <= b.t) {
      const tt = (t - a.t) / Math.max(1, (b.t - a.t));
      const rotA = kfRotation(a, baseRotation);
      const rotB = kfRotation(b, baseRotation);
      return {
        x: lerp(a.x, b.x, tt),
        y: lerp(a.y, b.y, tt),
        scaleX: lerp(kfScaleX(a), kfScaleX(b), tt),
        scaleY: lerp(kfScaleY(a), kfScaleY(b), tt),
        rotation: lerp(rotA, rotB, tt)
      };
    }
  }
  return base;
}

function getWeldInfo(item) {
  if (!item || typeof item !== 'object') return null;
  const weld = item.weld;
  if (!weld || typeof weld !== 'object') return null;
  const parentId = typeof weld.parentId === 'string' ? weld.parentId.trim() : '';
  if (!parentId) return null;
  return {
    parentId,
    followPosition: weld.followPosition !== false,
    followRotation: weld.followRotation !== false,
    followScale: weld.followScale !== false
  };
}

function getWeldParent(item) {
  const weld = getWeldInfo(item);
  if (!weld) return null;
  return PROJECT.items.find(i => i.id === weld.parentId) || null;
}

function detachWeld(item, { preserveWorld = true } = {}) {
  if (!item || !item.weld) return;
  const weld = getWeldInfo(item);
  const parent = getWeldParent(item);
  if (preserveWorld && weld && parent) {
    const axes = getScaleAxes(item);
    const localPose = {
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      scaleX: axes.x,
      scaleY: axes.y,
      rotation: getStageRotation(item)
    };
    const parentPoseNow = resolvePoseRecursive(parent, {
      time: currentTime,
      includeEditing: true,
      visited: new Set([item.id])
    });
    const worldPose = composePoseFromParent(parentPoseNow, localPose, weld);
    item.x = worldPose.x;
    item.y = worldPose.y;
    setScaleAxes(item, worldPose.scaleX, worldPose.scaleY);
    setStageRotation(item, worldPose.rotation);
    if (Array.isArray(item.keyframes)) {
      for (const kf of item.keyframes) {
        if (!kf || typeof kf !== 'object') continue;
        const parentPoseAtT = getPoseAt(parent, kf.t);
        const localKeyframePose = {
          x: Number(kf.x) || 0,
          y: Number(kf.y) || 0,
          scaleX: kfScaleX(kf),
          scaleY: kfScaleY(kf),
          rotation: Number.isFinite(kf.rotation)
            ? clampStageRotationNumber(kf.rotation)
            : worldPose.rotation
        };
        const worldKeyframePose = composePoseFromParent(parentPoseAtT, localKeyframePose, weld);
        kf.x = worldKeyframePose.x;
        kf.y = worldKeyframePose.y;
        kf.scaleX = worldKeyframePose.scaleX;
        kf.scaleY = worldKeyframePose.scaleY;
        kf.scale = (kf.scaleX + kf.scaleY) / 2;
        kf.rotation = worldKeyframePose.rotation;
      }
    }
  }
  delete item.weld;
}

function detachWeldChildren(parentId, { preserveWorld = true } = {}) {
  if (!parentId) return;
  for (const it of PROJECT.items) {
    if (!it || !it.weld) continue;
    if (getWeldInfo(it)?.parentId === parentId) {
      detachWeld(it, { preserveWorld });
    }
  }
}

function visualItemDisplayName(item) {
  if (!item || typeof item !== 'object') return 'Visual Item';
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
  if (name) return name;
  const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : '';
  if (label) return label;
  const path = typeof item.path === 'string' ? item.path : '';
  const base = path ? basename(path) : '';
  if (base) return base;
  return item.id ? `Item ${item.id.slice(0, 6)}` : 'Visual Item';
}

function visualClipTimeRange(item) {
  if (!item) return { start: 0, end: 0 };
  const start = Number(item.start ?? item.t ?? 0) || 0;
  let end = Number(item.end);
  if (!Number.isFinite(end)) {
    const [tin, tout] = clipInOutMs(item);
    end = Number.isFinite(tout) ? tout : tin;
  }
  if (!Number.isFinite(end)) end = start;
  if (end < start) end = start;
  return { start, end };
}

function rangesOverlapMs(a, b) {
  if (!a || !b) return false;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start;
}

function availableWeldParents(child) {
  if (!child) return [];
  const childRange = visualClipTimeRange(child);
  return PROJECT.items.filter(it => {
    if (!it || it.id === child.id) return false;
    if (wouldCreateWeldCycle(child, it.id)) return false;
    const range = visualClipTimeRange(it);
    return rangesOverlapMs(childRange, range);
  });
}

function wouldCreateWeldCycle(child, parentId) {
  if (!child || !parentId) return true;
  const childId = child.id;
  if (!childId) return true;
  if (parentId === childId) return true;
  const visited = new Set([childId]);
  let current = PROJECT.items.find(i => i.id === parentId) || null;
  while (current) {
    const id = current.id;
    if (!id) break;
    if (visited.has(id)) return true;
    visited.add(id);
    const info = getWeldInfo(current);
    if (!info) break;
    current = PROJECT.items.find(i => i.id === info.parentId) || null;
  }
  return false;
}

function weldItemToParent(child, parentId, options = {}) {
  if (!child || !parentId) return false;
  const parent = PROJECT.items.find(i => i.id === parentId);
  if (!parent) return false;
  if (wouldCreateWeldCycle(child, parentId)) return false;

  const followPosition = options.followPosition !== false;
  const followRotation = options.followRotation !== false;
  const followScale = options.followScale !== false;

  const weld = { parentId, followPosition, followRotation, followScale };
  const parentPoseNow = resolvePoseRecursive(parent, {
    time: currentTime,
    includeEditing: true,
    visited: new Set([child.id])
  });
  const displayPose = resolveDisplayPose(child);
  const worldPose = {
    x: Number(displayPose?.x) || 0,
    y: Number(displayPose?.y) || 0,
    scaleX: Number.isFinite(displayPose?.scaleX) ? displayPose.scaleX : (Number.isFinite(displayPose?.scale) ? displayPose.scale : getScaleAxes(child).x),
    scaleY: Number.isFinite(displayPose?.scaleY) ? displayPose.scaleY : (Number.isFinite(displayPose?.scale) ? displayPose.scale : getScaleAxes(child).y),
    rotation: Number(displayPose?.rotation) || getStageRotation(child)
  };
  const localPose = worldToLocalPose(worldPose, parentPoseNow, weld);
  child.x = localPose.x;
  child.y = localPose.y;
  setScaleAxes(child, localPose.scaleX, localPose.scaleY);
  setStageRotation(child, localPose.rotation);

  if (Array.isArray(child.keyframes)) {
    for (const kf of child.keyframes) {
      if (!kf || typeof kf !== 'object') continue;
      const parentPoseAtT = getPoseAt(parent, kf.t);
      const worldKeyframePose = {
        x: Number(kf.x) || 0,
        y: Number(kf.y) || 0,
        scaleX: kfScaleX(kf),
        scaleY: kfScaleY(kf),
        rotation: Number.isFinite(kf.rotation)
          ? clampStageRotationNumber(kf.rotation)
          : worldPose.rotation
      };
      const localKeyframePose = worldToLocalPose(worldKeyframePose, parentPoseAtT, weld);
      kf.x = localKeyframePose.x;
      kf.y = localKeyframePose.y;
      kf.scaleX = localKeyframePose.scaleX;
      kf.scaleY = localKeyframePose.scaleY;
      kf.scale = (kf.scaleX + kf.scaleY) / 2;
      kf.rotation = localKeyframePose.rotation;
    }
  }

  child.weld = weld;
  return true;
}

function composePoseFromParent(parentPose, localPose, weld) {
  if (!parentPose) return { ...localPose };
  const followPosition = weld.followPosition !== false;
  const followRotation = weld.followRotation !== false;
  const followScale = weld.followScale !== false;

  const parentX = Number(parentPose?.x) || 0;
  const parentY = Number(parentPose?.y) || 0;
  const parentRotation = Number(parentPose?.rotation) || 0;
  const parentScaleX = Number.isFinite(parentPose?.scaleX) ? parentPose.scaleX : 1;
  const parentScaleY = Number.isFinite(parentPose?.scaleY) ? parentPose.scaleY : 1;

  const localX = Number(localPose?.x) || 0;
  const localY = Number(localPose?.y) || 0;

  const localScaleX = Number.isFinite(localPose?.scaleX) ? localPose.scaleX : 1;
  const localScaleY = Number.isFinite(localPose?.scaleY) ? localPose.scaleY : 1;

  const scaleX = localScaleX * (followScale ? parentScaleX : 1);
  const scaleY = localScaleY * (followScale ? parentScaleY : 1);

  const combinedRotation = (Number.isFinite(localPose?.rotation) ? localPose.rotation : 0) + (followRotation ? parentRotation : 0);

  if (!followPosition) {
    return {
      x: localX,
      y: localY,
      scaleX,
      scaleY,
      rotation: combinedRotation
    };
  }

  const angleForTranslation = followRotation ? parentRotation : 0;
  const rad = angleForTranslation * (Math.PI / 180);
  const scaleForPosX = followScale ? parentScaleX : 1;
  const scaleForPosY = followScale ? parentScaleY : 1;
  const scaledX = localX * scaleForPosX;
  const scaledY = localY * scaleForPosY;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const worldX = parentX + scaledX * cos - scaledY * sin;
  const worldY = parentY + scaledX * sin + scaledY * cos;

  return {
    x: worldX,
    y: worldY,
    scaleX,
    scaleY,
    rotation: combinedRotation
  };
}

function worldToLocalPose(worldPose, parentPose, weld) {
  if (!worldPose) {
    return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  }
  if (!parentPose || !weld) {
    return {
      x: Number(worldPose.x) || 0,
      y: Number(worldPose.y) || 0,
      scaleX: Number.isFinite(worldPose.scaleX) ? worldPose.scaleX : 1,
      scaleY: Number.isFinite(worldPose.scaleY) ? worldPose.scaleY : 1,
      rotation: Number(worldPose.rotation) || 0
    };
  }

  const followPosition = weld.followPosition !== false;
  const followRotation = weld.followRotation !== false;
  const followScale = weld.followScale !== false;

  const parentX = Number(parentPose?.x) || 0;
  const parentY = Number(parentPose?.y) || 0;
  const parentRotation = Number(parentPose?.rotation) || 0;
  const parentScaleX = Number.isFinite(parentPose?.scaleX) ? parentPose.scaleX : 1;
  const parentScaleY = Number.isFinite(parentPose?.scaleY) ? parentPose.scaleY : 1;

  const worldX = Number(worldPose?.x) || 0;
  const worldY = Number(worldPose?.y) || 0;

  let localX = worldX;
  let localY = worldY;

  if (followPosition) {
    const dx = worldX - parentX;
    const dy = worldY - parentY;
    const angle = followRotation ? parentRotation : 0;
    const rad = (-angle) * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotatedX = dx * cos - dy * sin;
    const rotatedY = dx * sin + dy * cos;
    const scaleForPosX = followScale ? parentScaleX : 1;
    const scaleForPosY = followScale ? parentScaleY : 1;
    const safeScaleX = Math.abs(scaleForPosX) > 1e-5 ? scaleForPosX : (scaleForPosX < 0 ? -1e-5 : 1e-5);
    const safeScaleY = Math.abs(scaleForPosY) > 1e-5 ? scaleForPosY : (scaleForPosY < 0 ? -1e-5 : 1e-5);
    localX = rotatedX / safeScaleX;
    localY = rotatedY / safeScaleY;
  }

  const worldScaleX = Number.isFinite(worldPose?.scaleX) ? worldPose.scaleX : 1;
  const worldScaleY = Number.isFinite(worldPose?.scaleY) ? worldPose.scaleY : 1;
  const safeParentScaleX = Math.abs(parentScaleX) > 1e-5 ? parentScaleX : (parentScaleX < 0 ? -1e-5 : 1e-5);
  const safeParentScaleY = Math.abs(parentScaleY) > 1e-5 ? parentScaleY : (parentScaleY < 0 ? -1e-5 : 1e-5);
  const localScaleX = followScale ? worldScaleX / safeParentScaleX : worldScaleX;
  const localScaleY = followScale ? worldScaleY / safeParentScaleY : worldScaleY;

  const worldRotation = Number(worldPose?.rotation) || 0;
  const localRotation = followRotation ? worldRotation - parentRotation : worldRotation;

  return {
    x: localX,
    y: localY,
    scaleX: localScaleX,
    scaleY: localScaleY,
    rotation: localRotation
  };
}

// ---------- Stage interactions ----------
function stageMouseDown(e) {
  const origin = e.target instanceof Element ? e.target : null;
  if (origin && origin.closest('.stage-rotate-handle')) return;

  const stageEl = origin?.closest('.stage-item');
  if (!stageEl) { clearSelection(); return; }

  const id = stageEl.dataset.id;
  if (!id) return;

  let item = PROJECT.items.find(i => i.id === id) || null;
  let text = item ? null : PROJECT.text.find(t => t.id === id) || null;
  if (!item && !text) return;

  selectClip(id);

  if (text) {
    if (isClipLocked(text.id)) return;
    const historySnapshot = snapshotProject();
    const startX = e.clientX, startY = e.clientY;
    const origX = text.x, origY = text.y;
    const scale = stagePreviewScale || 1;
    text._editing = true;
    let moved = false;
    function onMove(ev){
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      const nextX = origX + dx;
      const nextY = origY + dy;
      if (!moved && (Math.abs(nextX - origX) > 0.5 || Math.abs(nextY - origY) > 0.5)) moved = true;
      text.x = nextX;
      text.y = nextY;
      positionTextItem(text);
    }
    function onUp(){
      text._editing=false;
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
      positionTextItem(text);
      if (moved) {
        pushHistoryWithSnapshot(historySnapshot, 'text-move');
        scheduleAutosave('pushHistory:text-move');
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return;
  }

  const locked = isClipLocked(id);
  if (locked) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const historySnapshot = snapshotProject();
  const poseNow = resolveDisplayPose(item);
  const origX = poseNow.x;
  const origY = poseNow.y;
  const scale = stagePreviewScale || 1;
  const weld = getWeldInfo(item);
  const weldParent = weld ? getWeldParent(item) : null;

  item._editing = true;

  const state = { changed:false };

  function onMove(ev) {
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    const nextWorldX = origX + dx;
    const nextWorldY = origY + dy;
    if (!state.changed && (Math.abs(nextWorldX - origX) > 0.5 || Math.abs(nextWorldY - origY) > 0.5)) state.changed = true;
    if (weld && weldParent) {
      const parentPose = resolvePoseRecursive(weldParent, {
        time: currentTime,
        includeEditing: true,
        visited: new Set([item.id])
      });
      const localPose = worldToLocalPose({ x: nextWorldX, y: nextWorldY }, parentPose, weld);
      item.x = localPose.x;
      item.y = localPose.y;
    } else {
      item.x = nextWorldX;
      item.y = nextWorldY;
    }
    positionStageItem(item);
  }
  function onUp() {
    item._editing = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    positionStageItem(item);
    if (state.changed) {
      pushHistoryWithSnapshot(historySnapshot, 'stage-move');
      scheduleAutosave('pushHistory:stage-move');
    }
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function onStageRotateHandleMouseDown(ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const handle = ev.currentTarget;
  const stageItem = handle?.closest('.stage-item');
  if (!stageItem) return;
  const id = stageItem.dataset.id;
  if (!id) return;

  let target = PROJECT.items.find(i => i.id === id);
  let kind = 'visual';
  if (!target) {
    target = PROJECT.text.find(t => t.id === id);
    if (!target) return;
    kind = 'text';
  }

  if (isClipLocked(id)) return;

  selectClip(id);

  const historySnapshot = snapshotProject();
  const originalRotationLocal = getStageRotation(target);
  const rect = stageItem.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const startAngle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX);
  let changed = false;

  const weld = kind === 'visual' ? getWeldInfo(target) : null;
  const weldParent = weld ? getWeldParent(target) : null;
  const followRotation = !(weld && weld.followRotation === false);
  const parentPose = followRotation && weldParent
    ? resolvePoseRecursive(weldParent, {
        time: currentTime,
        includeEditing: true,
        visited: new Set([target.id])
      })
    : null;
  const parentRotationAtStart = parentPose ? Number(parentPose.rotation) || 0 : 0;
  const originalRotationWorld = originalRotationLocal + parentRotationAtStart;

  target._editing = true;
  handle.classList.add('active');

  const applyFromEvent = (event) => {
    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    let nextWorld = originalRotationWorld + (angle - startAngle) * (180 / Math.PI);
    if (event.shiftKey) {
      nextWorld = Math.round(nextWorld / 15) * 15;
    }
    const parentRotation = followRotation && weldParent
      ? (resolvePoseRecursive(weldParent, {
          time: currentTime,
          includeEditing: true,
          visited: new Set([target.id])
        })?.rotation || parentRotationAtStart)
      : 0;
    const nextLocal = followRotation ? nextWorld - Number(parentRotation || 0) : nextWorld;
    const applied = setStageRotation(target, nextLocal);
    if (kind === 'visual') positionStageItem(target);
    else positionTextItem(target);
    updateStageSizePanel();
    if (!changed && haveStageRotationsChanged(originalRotationLocal, applied, STAGE_ROTATION_EPS)) {
      changed = true;
    }
  };

  const onMove = (event) => {
    event.preventDefault();
    applyFromEvent(event);
  };

  const finalize = (commit) => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    handle.classList.remove('active');
    target._editing = false;
    if (commit) {
      if (kind === 'visual') positionStageItem(target);
      else positionTextItem(target);
      const label = kind === 'visual' ? 'stage-rotate' : 'text-rotate';
      pushHistoryWithSnapshot(historySnapshot, label);
      scheduleAutosave(`pushHistory:${label}`);
    } else {
      setStageRotation(target, originalRotationLocal);
      if (kind === 'visual') positionStageItem(target);
      else positionTextItem(target);
    }
    updateStageSizePanel();
  };

  const onUp = (event) => {
    event.preventDefault();
    const current = getStageRotation(target);
    const commit = changed && haveStageRotationsChanged(originalRotationLocal, current, STAGE_ROTATION_EPS);
    finalize(commit);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

const stageScaleHistory = new WeakMap();
let wheelEditTimer = null;
let wheelEditTarget = null;

function commitStageScaleHistory(target) {
  if (!target) return;
  const pending = stageScaleHistory.get(target);
  if (pending?.changed && pending.snapshot) {
    pushHistoryWithSnapshot(pending.snapshot, pending.label);
    scheduleAutosave(`pushHistory:${pending.label}`);
  }
  stageScaleHistory.delete(target);
}
function onStageWheel(e) {
  if (!selectedItemId && !selectedTextId) return;
  e.preventDefault();
  const item = selectedItemId ? PROJECT.items.find(i=>i.id===selectedItemId) : null;
  const text = selectedTextId ? PROJECT.text.find(t=>t.id===selectedTextId) : null;
  const target = item || text;
  if (!target) return;
  if (isClipLocked(target.id)) return;

  if (wheelEditTarget && wheelEditTarget !== target) {
    commitStageScaleHistory(wheelEditTarget);
    if (wheelEditTimer) {
      clearTimeout(wheelEditTimer);
      wheelEditTimer = null;
    }
  }
  wheelEditTarget = target;

  let pending = stageScaleHistory.get(target);
  if (!pending) {
    const originals = getScaleAxes(target);
    pending = {
      snapshot: snapshotProject(),
      originalX: originals.x,
      originalY: originals.y,
      changed: false,
      label: item ? 'stage-scale' : 'text-scale'
    };
    stageScaleHistory.set(target, pending);
  }

  const delta = Math.sign(e.deltaY || 0);
  target._editing = true;
  const currentAxes = getScaleAxes(target);
  const factor = delta < 0 ? 1.08 : 0.92;
  const nextX = clampStageScaleNumber(currentAxes.x * factor);
  const nextY = clampStageScaleNumber(currentAxes.y * factor);
  setScaleAxes(target, nextX, nextY);
  if (!pending.changed && haveScaleAxesChanged(pending.originalX, pending.originalY, nextX, nextY)) {
    pending.changed = true;
  }
  item ? positionStageItem(item) : positionTextItem(text);
  clearTimeout(wheelEditTimer);
  wheelEditTimer = setTimeout(()=>{
    target._editing = false;
    item ? positionStageItem(item) : positionTextItem(text);
    commitStageScaleHistory(target);
    wheelEditTarget = null;
    wheelEditTimer = null;
  }, 250);
}

function resolveDisplayPose(item) {
  return resolvePoseRecursive(item, { time: currentTime, includeEditing: true });
}

function positionStageItem(item) {
  const el = document.querySelector(`.stage-item[data-id="${item.id}"]`);
  const isSelected = selectedItemId === item.id;
  if (!el) {
    if (isSelected) updateStageSizePanel();
    return;
  }

  const pose = resolveDisplayPose(item);
  const scaleX = Number.isFinite(pose?.scaleX) ? pose.scaleX : Number.isFinite(pose?.scale) ? pose.scale : 1;
  const scaleY = Number.isFinite(pose?.scaleY) ? pose.scaleY : Number.isFinite(pose?.scale) ? pose.scale : 1;
  const rotation = Number.isFinite(pose?.rotation) ? pose.rotation : getStageRotation(item);
  const base = `translate(-50%,-50%) rotate(${rotation}deg) scale(${scaleX},${scaleY})`;
  const trackIdx = Number.isInteger(item.trackIndex) ? item.trackIndex : 0;
  el.style.zIndex = String(stageLayerZ(item.kind ?? 'visual', trackIdx));

  el.style.left = `${pose.x}px`;
  el.style.top  = `${pose.y}px`;
  el.style.transform = base;
  el.style.opacity = '1';
  applyStageMaskToElement(item, el);

  if (item.kind === 'visual') applyFxStyles(item, el);
  else el.style.removeProperty('filter');

  let visible = isActiveAt(currentTime, item.start, item.end, FRAME_RATE);
  const isLocked = isClipLocked(item.id);
  const forcePreview = !visible && isSelected && !playing;

  el.style.display = (visible || forcePreview) ? 'block' : 'none';
  el.classList.toggle('selected', isSelected);
  el.classList.toggle('is-locked', isLocked);
  el.classList.toggle('ghost-out-of-range', forcePreview);

  if (!visible && !forcePreview) {
    el.style.opacity = '0';
    el.style.transform = base;
    applyStageMaskToElement(item, el);
    if (isSelected) updateStageSizePanel();
    return;
  }

  if (forcePreview) {
    el.style.opacity = '0.35';
    el.style.transform = base;
    applyStageMaskToElement(item, el);
    if (item.kind === 'visual') applyFxStyles(item, el);
    else el.style.removeProperty('filter');
    if (isSelected) updateStageSizePanel();
    return;
  }

  if (item.kind === 'visual') {
    applyClipTransitionStyles(el, item, { baseTransform: base, baseOpacity: 1, effectiveEnd: item.end });
  }
  if (isSelected) updateStageSizePanel();
  if (item.mediaType === 'video') {
    syncStageVideoChroma(item);
  }
}

// ---------- Text stage ----------
function spawnTextItem(t) {
  const el = document.createElement('div');
  el.className = 'stage-item stage-text';
  el.dataset.id = t.id;
  const box = document.createElement('div');
  box.className = 'text-box';
  box.textContent = t.content || 'Text';
  el.appendChild(box);
  ensureStageItemHandles(el);
  $('#stage').appendChild(el);
  t._el = el;
  positionTextItem(t);
  applyTextStyle(t);
}

function positionTextItem(t) {
  const el = document.querySelector(`.stage-item[data-id="${t.id}"]`);
  const isSelected = selectedTextId === t.id;
  const isLocked = isClipLocked(t.id);
  if (!el) {
    if (isSelected) updateStageSizePanel();
    return;
  }

  const x = t.x ?? 480, y = t.y ?? 270, s = t.scale ?? 1;
  const rotation = getStageRotation(t);
  const base = `translate(-50%,-50%) rotate(${rotation}deg) scale(${s})`;
  const trackIdx = Number.isInteger(t.trackIndex) ? t.trackIndex : 0;
  el.style.zIndex = String(stageLayerZ('text', trackIdx));
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
  el.style.transform = base;

  const end = effectiveTextEnd(t); // ensure finite
  let visible = isActiveAt(currentTime, t.start ?? 0, end, FRAME_RATE);
  const forcePreview = !visible && isSelected && !playing;

  el.style.display = (visible || forcePreview) ? 'block' : 'none';
  el.classList.toggle('selected', isSelected);
  el.classList.toggle('is-locked', isLocked);
  el.classList.toggle('ghost-out-of-range', forcePreview);

  if (!visible && !forcePreview) {
    el.style.opacity = '0';
    el.style.removeProperty('clip-path');
    el.style.transform = base;
    if (isSelected) updateStageSizePanel();
    return;
  }

  if (forcePreview) {
    el.style.opacity = String(clamp01(t.style?.opacity ?? 1) * 0.35);
    el.style.removeProperty('clip-path');
    if (isSelected) updateStageSizePanel();
    return;
  }

  const baseOpacity = clamp01(t.style?.opacity ?? 1);
  applyClipTransitionStyles(el, t, { baseTransform: base, baseOpacity, effectiveEnd: end });
  if (isSelected) updateStageSizePanel();
}

function applyTextStyle(t) {
  const el = document.querySelector(`.stage-item[data-id="${t.id}"]`);
  if (!el) return;
  const box = el.querySelector('.text-box');
  const st = t.style || (t.style = {});
  box.textContent = t.content || 'Text';
  box.style.fontSize = (st.size ?? 36) + 'px';
  box.style.fontFamily = st.font || 'system-ui, Arial, sans-serif';
  box.style.color = st.color || '#ffffff';
  const sw = Math.max(0, +st.strokeW || 0);
  const sc = st.strokeColor || '#000';
  if (SUPPORTS_TEXT_STROKE && sw > 0) {
    box.style.setProperty('-webkit-text-stroke', `${sw}px ${sc}`);
    box.style.setProperty('text-stroke', `${sw}px ${sc}`);
  } else {
    box.style.removeProperty('-webkit-text-stroke');
    box.style.removeProperty('text-stroke');
  }
  const shx=+st.shadowX||0, shy=+st.shadowY||0, shb=+st.shadowBlur||0, shc=st.shadowColor||'transparent';
  const shadowParts = [];
  if (!(SUPPORTS_TEXT_STROKE && sw > 0) && sw > 0) shadowParts.push(`0 0 ${Math.max(1, sw)}px ${sc}`);
  if (shx||shy||shb) shadowParts.push(`${shx}px ${shy}px ${shb}px ${shc}`);
  box.style.textShadow = shadowParts.join(', ') || 'none';
  if (st.bgOn) {
    const rgb = hexToRgb(st.bgColor || '#000');
    const a = clamp01(+st.bgAlpha ?? 0.4);
    box.style.background = `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
    box.style.padding = (st.bgPad ?? 8) + 'px';
    box.style.borderRadius = (st.bgRadius ?? 8) + 'px';
  } else {
    box.style.background = 'transparent';
    box.style.padding = '0px';
    box.style.borderRadius = '0px';
  }
  box.style.textAlign = st.align || 'center';
  const opacity = clamp01(st.opacity ?? 1);
  el.style.opacity = String(opacity);
  el.dataset.baseOpacity = String(opacity);
}

function hexToRgb(hex) {
  const h = hex.replace('#','');
  const s = h.length===3 ? h.split('').map(c=>c+c).join('') : h;
  const n = parseInt(s,16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}
function clamp01(v){ return Math.max(0, Math.min(1, v)); }

function selectItem(id) {
  selectedItemId = id;
  for (const it of PROJECT.items) positionStageItem(it);
  updateStageSizePanel();
}

// ---------- Track helpers ----------
function getNextTrackIndex(kind) {
  if (kind === 'visual') {
    const u = uniqueSorted(PROJECT.items.map(i=>i.trackIndex).filter(i=>Number.isInteger(i)));
    return u.length ? u[u.length-1] + 1 : 0;
  } else if (kind === 'audio') {
    const u = uniqueSorted(PROJECT.audio.map(a=>a.trackIndex).filter(i=>Number.isInteger(i)));
    return u.length ? u[u.length-1] + 1 : 0;
  } else if (kind === 'text') {
    const u = uniqueSorted(PROJECT.text.map(t=>t.trackIndex).filter(i=>Number.isInteger(i)));
    return u.length ? u[u.length-1] + 1 : 0;
  }
}

function normalizeTrackIndices(kind) {
  const map = new Map();
  if (kind === 'visual') {
    const u = uniqueSorted(PROJECT.items.map(i=>i.trackIndex ?? 0));
    u.forEach((old, idx)=>map.set(old, idx));
    PROJECT.items.forEach(i=>i.trackIndex = map.get(i.trackIndex ?? 0));
    remapTrackNames('visual', map);
    remapTrackLocks('visual', map);
    remapTrackHeights('visual', map);
  } else if (kind === 'audio') {
    const u = uniqueSorted(PROJECT.audio.map(a=>a.trackIndex ?? 0));
    u.forEach((old, idx)=>map.set(old, idx));
    PROJECT.audio.forEach(a=>a.trackIndex = map.get(a.trackIndex ?? 0));
    remapTrackNames('audio', map);
    remapTrackLocks('audio', map);
    remapTrackHeights('audio', map);
  } else if (kind === 'text') {
    const u = uniqueSorted(PROJECT.text.map(t=>t.trackIndex ?? 0));
    u.forEach((old, idx)=>map.set(old, idx));
    PROJECT.text.forEach(t=>t.trackIndex = map.get(t.trackIndex ?? 0));
    remapTrackNames('text', map);
    remapTrackLocks('text', map);
    remapTrackHeights('text', map);
  }
}

function rowAtY(y) {
  const rows = $$('.track');
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) {
      return { row: r, kind: r.dataset.kind, trackIndex: Number(r.dataset.trackIndex ?? 0) };
    }
  }
  return null;
}

// ---------- Clip labels (thumbnail + name) ----------
function addClipLabel(clipEl, kind, data) {
  const old = clipEl.querySelector('.clip-inner');
  if (old) old.remove();

  const inner = document.createElement('div');
  inner.className = 'clip-inner';

  inner.style.cssText = `
    position:absolute; left:8px; right:8px; top:0; bottom:0;
    display:flex; align-items:center; gap:6px;
    overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    pointer-events:none; padding:0 2px; font-size:12px;
  `;

  const clipId = data?.id || clipEl.dataset.id;
  const locked = isClipLocked(clipId);
  clipEl.classList.toggle('is-locked', locked);
  if (locked) clipEl.setAttribute('data-locked', 'true');
  else clipEl.removeAttribute('data-locked');
  clipEl.style.cursor = locked ? 'not-allowed' : 'default';

  const thumb = document.createElement('div');
  thumb.style.cssText = `
    width:18px; height:18px; border-radius:3px;
    background:#0b0e12; border:1px solid #2a2f36; flex:0 0 auto;
    display:grid; place-items:center; overflow:hidden;
  `;

  if (kind === 'visual') {
    if (isVideoClip(data)) {
      thumb.textContent = 'VID';
      thumb.style.fontSize = '10px';
      thumb.style.fontWeight = '600';
      thumb.style.color = '#54a0ff';
    } else {
      const img = document.createElement('img');
      img.src = fileUrl(data.path);
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;';
      thumb.appendChild(img);
    }

} else if (kind === 'audio') {
  inner.style.top = '2px';
  inner.style.bottom = 'auto';
  inner.style.height = '18px';
  inner.style.alignItems = 'center';

  thumb.style.width = '14px';
  thumb.style.height = '14px';
  thumb.textContent = 'AUD';
  thumb.style.fontSize = '11px';

} else if (kind === 'bg') {
  if (data.path) {
    thumb.style.background = `url(${fileUrl(data.path)}) center / cover no-repeat #000`;
  } else {
    thumb.textContent = '--';
    thumb.title = 'No Background';
  }

} else if (kind === 'text') {
  thumb.textContent = 'T';
  thumb.style.fontWeight = '700';
}

  const lockIcon = document.createElement('span');
  lockIcon.className = 'clip-lock-icon';
  lockIcon.textContent = '??';
  lockIcon.hidden = !locked;
  lockIcon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.style.cssText = 'opacity:.95;';
  if (kind === 'visual') label.textContent = data.name || basename(data.path);
  else if (kind === 'audio') {
    const rawCharacter = sanitizeTtsCharacterName(data.characterName || '');
    const spoken = typeof data.dialogText === 'string' ? data.dialogText.trim() : '';
    const fallback = data.name || basename(data.path);
    const body = spoken || fallback;
    if (rawCharacter) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = rawCharacter;
      nameSpan.style.fontWeight = '700';
      nameSpan.style.color = '#ffd166';

      const colon = document.createElement('span');
      colon.textContent = ': ';
      colon.style.opacity = '0.85';

      const dialogSpan = document.createElement('span');
      dialogSpan.textContent = body;
      dialogSpan.style.opacity = '0.9';

      label.textContent = '';
      label.append(nameSpan, colon, dialogSpan);
    } else {
      label.textContent = body;
    }
  }
  else if (kind === 'bg')   label.textContent = data.path ? basename(data.path) : 'None';
  else if (kind === 'text') label.textContent = data.content || 'Text';

  inner.appendChild(thumb);
  inner.appendChild(lockIcon);
  inner.appendChild(label);
  clipEl.appendChild(inner);
}


// ---------- Clip selection ----------
function selectClip(id, {add=false, toggle=false} = {}) {
  if (toggle) {
    if (selectedClipIds.has(id)) selectedClipIds.delete(id);
    else selectedClipIds.add(id);
  } else if (add) {
    selectedClipIds.add(id);
  } else {
    selectedClipIds = new Set([id]);
  }
  if (selectedKeyframe && !selectedClipIds.has(selectedKeyframe.itemId)) clearSelectedKeyframe();

  // Keep legacy single selection fields compatible
  selectedClipId = [...selectedClipIds][0] || null;
  const vis = PROJECT.items.find(i=>i.id===selectedClipId);
  const tx  = PROJECT.text.find(t=>t.id===selectedClipId);
  selectedItemId = vis ? vis.id : null;
  selectedTextId = tx ? tx.id : null;

  updateClipSelectionStyles();
}

function clearSelection() {
  selectedClipIds.clear();
  selectedClipId = null;
  selectedItemId = null;
  clearSelectedKeyframe();
  updateClipSelectionStyles();
}

function updateClipSelectionStyles() {
  $$('.clip').forEach(c => c.classList.toggle('selected', selectedClipIds.has(c.dataset.id)));
  for (const it of PROJECT.items) positionStageItem(it);
  for (const t of PROJECT.text)  positionTextItem(t);
  updateKeyframeSelectionStyles();
  refreshAudioClipOverlays();
  updateStageSizePanel();
}


 // ---------- Timeline ----------
 
function setupTrackLabel(labelEl, { note = null, hasMeter = false } = {}) {
  if (!labelEl) return;
  labelEl.innerHTML = '';
  if (hasMeter) labelEl.classList.add('has-meter');
  else labelEl.classList.remove('has-meter');

  const header = document.createElement('div');
  header.className = 'track-label-header';

  const nameEl = document.createElement('span');
  nameEl.dataset.role = 'track-name';
  header.appendChild(nameEl);

  const lockEl = document.createElement('span');
  lockEl.className = 'track-label-lock';
  lockEl.dataset.role = 'track-lock';
  lockEl.textContent = '🔒';
  lockEl.setAttribute('aria-hidden', 'true');
  lockEl.style.visibility = 'hidden';
  header.appendChild(lockEl);

  labelEl.appendChild(header);

  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'track-label-note';
    noteEl.dataset.role = 'track-note';
    noteEl.textContent = note;
    labelEl.appendChild(noteEl);
  }
}

function renderTimeline() {
  const wrap = $('#tracks');
  if (!wrap) return;
  ensureTimelineAutoExtendBindings();
  const prevScrollLeft = wrap.scrollLeft;
   const prevScrollTop = wrap.scrollTop;
   wrap.innerHTML = '';
 
   ensureTrackLocks();
 
   // Ensure each item has a trackIndex
   PROJECT.items.forEach(i => { if (!Number.isInteger(i.trackIndex)) i.trackIndex = getNextTrackIndex('visual'); });
   PROJECT.audio.forEach(a => { if (!Number.isInteger(a.trackIndex)) a.trackIndex = getNextTrackIndex('audio'); });
   normalizeTrackIndices('visual');
   normalizeTrackIndices('audio');
 
  const baseEndMs = Math.max(projectEndMs(), TIMELINE_MIN_MS);
  const maxCap = Math.max(TIMELINE_MAX_MS, baseEndMs);
  let customEnd = Number(PROJECT.timelineCustomEndMs);
  if (Number.isFinite(customEnd)) {
    customEnd = clamp(customEnd, baseEndMs, maxCap);
    PROJECT.timelineCustomEndMs = customEnd > baseEndMs ? customEnd : null;
  } else {
    PROJECT.timelineCustomEndMs = null;
  }
  const defaultViewMs = Math.max(baseEndMs, TIMELINE_DEFAULT_VIEW_MS);
  const totalMs = PROJECT.timelineCustomEndMs ?? defaultViewMs;
  timelineViewMs = totalMs;
  const laneWidth = Math.max(timeToPx(totalMs), 1);

   const ruler = buildTimelineRuler(totalMs, laneWidth);

   if (ruler) wrap.appendChild(ruler);

   const labels = ensureTimelineLabels();
   if (labels.length > 0) {
     const labelRow = buildTimelineLabelRow(totalMs, laneWidth);
     if (labelRow) wrap.appendChild(labelRow);
   }

   // Background track
   if (PROJECT.bgClips && PROJECT.bgClips.length > 0) {
     const row = document.createElement('div');
     row.className = 'track';
     row.dataset.kind = 'bg';
     row.dataset.trackIndex = '0';
 
    const label = document.createElement('div');
    label.className = 'track-label';
    label.dataset.kind = 'bg';
    label.dataset.trackIndex = '0';
    setupTrackLabel(label, { note: null, hasMeter: false });
    const trackLocked = applyTrackLockStyles(label, row, 'bg', 0);
 
     const lane = document.createElement('div');
     lane.className = 'track-lane';
     lane.style.minWidth = `${laneWidth}px`;
     if (trackLocked) lane.classList.add('is-locked');
 
     const totalEnd = totalMs;
 
     for (const bg of PROJECT.bgClips) {
       const clip = document.createElement('div');
       clip.className='clip';
       clip.dataset.id = bg.id;
       clip.dataset.type='bg';
       clip.style.position='absolute';
       clip.style.cursor = trackLocked ? 'not-allowed' : 'default';
       clip.style.height = '100%';
 
       const l = document.createElement('div'); l.className='resize-handle left';
       const r = document.createElement('div'); r.className='resize-handle right';
       clip.appendChild(l); clip.appendChild(r);
 
       const left = timeToPx(bg.start);
       const effEnd = (bg.end == null) ? totalEnd : bg.end;
       const durationMs = Math.max(50, effEnd - bg.start);
       const width = Math.max(10, timeToPx(durationMs));
       clip.style.left = `${left}px`;
       clip.style.width = `${width}px`;
 
       clip.style.background = '#5b5b5b';
       clip.style.borderColor = '#8a8a8a';
 
       addClipLabel(clip, 'bg', bg);
 
       makeClipInteractive(clip);
       clip.addEventListener('contextmenu', (e)=>{
         e.preventDefault();
         e.stopPropagation();
         showClipMenu(e.clientX, e.clientY, bg.id);
       });
 
       lane.appendChild(clip);
     }
 
     label.addEventListener('contextmenu', (e)=>{
       e.preventDefault();
       e.stopPropagation();
       showBgTrackLabelMenu(e.clientX, e.clientY);
     });
 
  row.appendChild(label);
  row.appendChild(lane);
  attachTrackResizer(row, (typeof LANE_HEIGHT_BG !== 'undefined' ? LANE_HEIGHT_BG : 32), 'bg', 0);
     wrap.appendChild(row);
   }
 
   // Visual rows
   const visIdxs = uniqueSorted(PROJECT.items.map(i=>i.trackIndex));
   for (const idx of visIdxs) {
     const row = document.createElement('div');
     row.className = 'track';
     row.dataset.kind = 'visual';
     row.dataset.trackIndex = String(idx);
 
    const label = document.createElement('div');
    label.className = 'track-label';
    label.dataset.kind = 'visual';
    label.dataset.trackIndex = String(idx);
    setupTrackLabel(label, { note: null, hasMeter: false });
    const trackLocked = applyTrackLockStyles(label, row, 'visual', idx);
     label.addEventListener('contextmenu', (e)=>{
       e.preventDefault();
       e.stopPropagation();
       showTrackMenu(e.clientX, e.clientY, 'visual', idx);
     });
 
     const lane = document.createElement('div');
     lane.className = 'track-lane';
     lane.style.minWidth = `${laneWidth}px`;
     if (trackLocked) lane.classList.add('is-locked');
 
     const itemsOnRow = PROJECT.items.filter(i=>i.trackIndex === idx);
     for (const it of itemsOnRow) {
       const clip = document.createElement('div');
       clip.className='clip';
       clip.dataset.id = it.id;
       clip.dataset.type='visual';
       clip.style.position='absolute';
       clip.style.cursor = trackLocked ? 'not-allowed' : 'default';
       clip.style.height = '100%';
 
       const l = document.createElement('div'); l.className='resize-handle left';
       const r = document.createElement('div'); r.className='resize-handle right';
       clip.appendChild(l); clip.appendChild(r);
 
       const left = timeToPx(it.start);
       const width = Math.max(10, timeToPx(it.end - it.start));
       clip.style.left = `${left}px`;
       clip.style.width = `${width}px`;
 
       addClipLabel(clip, 'visual', it);
       renderKeyframeTicks(clip, it, { start: it.start, end: it.end });
 
       makeClipInteractive(clip);
       clip.addEventListener('contextmenu', (e) => {
         e.preventDefault();
         showClipMenu(e.clientX, e.clientY, it.id);
       });
       lane.appendChild(clip);
     }
 
      row.appendChild(label); row.appendChild(lane);
      attachTrackResizer(row, (typeof LANE_HEIGHT_VISUAL !== 'undefined' ? LANE_HEIGHT_VISUAL : 32), 'visual', idx);
     wrap.appendChild(row);
   }

  // Text rows
  const txtIdxs = uniqueSorted(PROJECT.text.map(t=>t.trackIndex ?? 0));
  for (const idx of txtIdxs) {
    const row = document.createElement('div');
    row.className = 'track';
    row.dataset.kind = 'text';
    row.dataset.trackIndex = String(idx);

    const label = document.createElement('div');
    label.className = 'track-label';
    label.dataset.kind = 'text';
    label.dataset.trackIndex = String(idx);
    setupTrackLabel(label, { note: null, hasMeter: false });
    const trackLocked = applyTrackLockStyles(label, row, 'text', idx);
    label.addEventListener('contextmenu', (e)=>{
      e.preventDefault();
      e.stopPropagation();
      showTrackMenu(e.clientX, e.clientY, 'text', idx);
    });

    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.style.minWidth = `${laneWidth}px`;
    if (trackLocked) lane.classList.add('is-locked');

    const txtOnRow = PROJECT.text.filter(t=>t.trackIndex === idx);
    for (const t of txtOnRow) {
      const clip = document.createElement('div');
      clip.className='clip';
      clip.dataset.id = t.id;
      clip.dataset.type='text';
      clip.style.position='absolute';
      clip.style.cursor = trackLocked ? 'not-allowed' : 'default';
      clip.style.height = '100%';

      const l = document.createElement('div'); l.className='resize-handle left';
      const r = document.createElement('div'); r.className='resize-handle right';
      clip.appendChild(l); clip.appendChild(r);

      const left = timeToPx(t.start);
      const width = Math.max(10, timeToPx((t.end ?? (t.start+t.duration)) - t.start));
      clip.style.left = `${left}px`;
      clip.style.width = `${width}px`;

      addClipLabel(clip, 'text', t);
      makeClipInteractive(clip);
      clip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showClipMenu(e.clientX, e.clientY, t.id);
      });
      lane.appendChild(clip);
    }

    row.appendChild(label); row.appendChild(lane);
    attachTrackResizer(row, (typeof LANE_HEIGHT_VISUAL !== 'undefined' ? LANE_HEIGHT_VISUAL : 32), 'text', idx);
    wrap.appendChild(row);
  }
 
   // Audio rows
   const audIdxs = uniqueSorted(PROJECT.audio.map(a=>a.trackIndex));
   for (const idx of audIdxs) {
     const row = document.createElement('div');
     row.className = 'track';
     row.dataset.kind = 'audio';
     row.dataset.trackIndex = String(idx);
 
    const label = document.createElement('div');
    label.className = 'track-label';
    label.dataset.kind = 'audio';
    label.dataset.trackIndex = String(idx);
    setupTrackLabel(label, { note: `Audio Track ${idx + 1}`, hasMeter: true });
    const trackLocked = applyTrackLockStyles(label, row, 'audio', idx);
    const displayName = label.dataset.trackName || `Audio Track ${idx + 1}`;
    label.addEventListener('contextmenu', (e)=>{
      e.preventDefault();
      e.stopPropagation();
      showTrackMenu(e.clientX, e.clientY, 'audio', idx);
    });

    const meter = document.createElement('div');
    meter.className = 'track-meter';
    meter.dataset.trackIndex = String(idx);
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', `${displayName} level`);
    meter.setAttribute('aria-valuemin', '-60');
    meter.setAttribute('aria-valuemax', '0');
    meter.setAttribute('aria-valuenow', '-60');
    const meterBar = document.createElement('div');
    meterBar.className = 'track-meter-bar';
    const meterFill = document.createElement('div');
    meterFill.className = 'track-meter-fill';
    meterFill.dataset.role = 'meter-fill';
    const meterPeak = document.createElement('div');
    meterPeak.className = 'track-meter-peak';
    meterPeak.dataset.role = 'meter-peak';
    meterBar.appendChild(meterFill);
    meterBar.appendChild(meterPeak);
    const meterValue = document.createElement('div');
    meterValue.className = 'track-meter-value';
    meterValue.dataset.role = 'meter-value';
    meterValue.textContent = '-inf dB';
    meter.appendChild(meterBar);
    meter.appendChild(meterValue);
    label.appendChild(meter);

    registerAudioMeter(`track:${idx}`, {
      kind: 'track',
      trackIndex: idx,
      el: meter,
      fill: meterFill,
      peak: meterPeak,
      valueEl: meterValue,
      minDb: -60,
      activeTarget: label
    });
 
     const lane = document.createElement('div');
     lane.className = 'track-lane';
     lane.style.minWidth = `${laneWidth}px`;
     if (trackLocked) lane.classList.add('is-locked');
 
     const audOnRow = PROJECT.audio.filter(a=>a.trackIndex === idx);
     for (const au of audOnRow) {
       const clip = document.createElement('div');
       clip.className='clip';
       clip.dataset.id = au.id;
       clip.dataset.type='audio';
       clip.style.position='absolute';
       clip.style.cursor = trackLocked ? 'not-allowed' : 'default';
       clip.style.height = '100%';
 
       const l = document.createElement('div'); l.className='resize-handle left';
       const r = document.createElement('div'); r.className='resize-handle right';
       clip.appendChild(l); clip.appendChild(r);
 
       const left = timeToPx(au.start);
       const width = Math.max(10, timeToPx(au.end - au.start));
       clip.style.left = `${left}px`;
       clip.style.width = `${width}px`;
 
       if (au.muted) { clip.style.opacity = '0.6'; clip.style.filter = 'grayscale(0.6)'; }
       else { clip.style.opacity = '1'; clip.style.filter = ''; }

       addAudioWaveCanvas(clip, au);
       addClipLabel(clip, 'audio', au);
       updateAudioClipOverlay(clip, au, selectedClipIds.has(au.id));

       makeClipInteractive(clip);
       clip.addEventListener('contextmenu', (e) => {
         e.preventDefault();
         showClipMenu(e.clientX, e.clientY, au.id);
       });
 
       lane.appendChild(clip);
     }
 
      row.appendChild(label); row.appendChild(lane);
      attachTrackResizer(row, (typeof LANE_HEIGHT_AUDIO !== 'undefined' ? LANE_HEIGHT_AUDIO : 64), 'audio', idx);
     wrap.appendChild(row);
   }
 
   // allow zoom handler to set a specific scrollLeft for this rebuild
  _suppressTimelineAutoExtend = true;
  try {
    if (renderTimeline._forceScrollLeft != null) {
      wrap.scrollLeft = renderTimeline._forceScrollLeft;
      renderTimeline._forceScrollLeft = null;
    } else {
      wrap.scrollLeft = prevScrollLeft;
    }
    wrap.scrollTop = prevScrollTop;
  } finally {
    _suppressTimelineAutoExtend = false;
  }
 
   // Re-apply multi-selection visual state
   for (const id of selectedClipIds) {
     const el = $(`.clip[data-id="${id}"]`);
     if (el) el.classList.add('selected');
   }
   // keep legacy single-selected behaviors (e.g., audio volume UI) via selectedClipId
 
  if (typeof updateKeyframeSelectionStyles === 'function') updateKeyframeSelectionStyles();

  // Any render that follows a state change will flow through here.
  // Debounced autosave avoids excessive writes.
  scheduleTimelineLabelGuideUpdate();
  scheduleAutosave('renderTimeline');
  scheduleSubtitlePreviewRebuild();
}
 function showBgTrackLabelMenu(x,y){
   closeMenu();
   const menu = document.createElement('div');
   menu.className = 'context-menu';
   menu.addEventListener('click', e=>e.stopPropagation());
   menu.addEventListener('mousedown', e=>e.stopPropagation());
 
   const locked = isTrackLocked('bg', 0);
 
   const rename = document.createElement('button');
   rename.textContent = 'Rename Background track...';
   rename.addEventListener('click', ()=>{
     if (menu.querySelector('.rn')) return;
     const row = document.createElement('div');
     row.className = 'rn';
     row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;';
     const input = document.createElement('input');
     input.type='text';
     input.value = PROJECT.bgTrackName || 'Background';
     input.style.cssText = 'flex:1;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
     const ok = document.createElement('button'); ok.textContent='Set';
     ok.addEventListener('click', ()=>{ PROJECT.bgTrackName = input.value.trim() || 'Background'; closeMenu(); renderTimeline(); });
     input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ PROJECT.bgTrackName = input.value.trim() || 'Background'; closeMenu(); renderTimeline(); } });
     row.append(input, ok);
     menu.appendChild(row);
     input.focus(); input.select();
     menu._refit?.();
   });
 
   menu.appendChild(rename);
 
   const lockBtn = document.createElement('button');
   lockBtn.textContent = locked ? 'Unlock track' : 'Lock track';
   lockBtn.addEventListener('click', ()=>{
     pushHistory(locked ? 'unlock-track' : 'lock-track');
     setTrackLocked('bg', 0, !locked);
     closeMenu();
     renderTimeline();
     refreshStageVisibility();
     drawPlayhead();
   });
   menu.appendChild(lockBtn);
   attachAndFitMenu(menu, x, y);
 }

// ---------- Track index helpers / insert / move ----------
function getTrackIndices(kind) {
  if (kind === 'visual') return uniqueSorted(PROJECT.items.map(i => i.trackIndex ?? 0));
  if (kind === 'audio')  return uniqueSorted(PROJECT.audio.map(a => a.trackIndex ?? 0));
  if (kind === 'text')   return uniqueSorted(PROJECT.text.map(t => t.trackIndex ?? 0));
  if (kind === 'bg')     return [0];
  return [];
}

function insertNewTrack(kind, atIndex) {
  if (kind === 'visual') {
    PROJECT.items.forEach(i => { if ((i.trackIndex ?? 0) >= atIndex) i.trackIndex = (i.trackIndex ?? 0) + 1; });
    normalizeTrackIndices('visual');
  } else if (kind === 'audio') {
    PROJECT.audio.forEach(a => { if ((a.trackIndex ?? 0) >= atIndex) a.trackIndex = (a.trackIndex ?? 0) + 1; });
    normalizeTrackIndices('audio');
  } else if (kind === 'text') {
    PROJECT.text.forEach(t => { if ((t.trackIndex ?? 0) >= atIndex) t.trackIndex = (t.trackIndex ?? 0) + 1; });
    normalizeTrackIndices('text');
  }
  return atIndex;
}

function moveClipToTrack(id, kind, targetIndex) {
  if (isClipLocked(id)) return;
  if (isTrackLocked(kind, targetIndex)) return;
  if (kind === 'visual') {
    const it = PROJECT.items.find(i=>i.id===id);
    if (!it) return;
    it.trackIndex = targetIndex;
    normalizeTrackIndices('visual');
  } else if (kind === 'audio') {
    const au = PROJECT.audio.find(a=>a.id===id);
    if (!au) return;
    const prevIdx = au.trackIndex ?? 0;
    au.trackIndex = targetIndex;
    normalizeTrackIndices('audio');
    if (prevIdx !== targetIndex) {
      normalizeAudioCrossfadesForTrack(prevIdx);
      normalizeAudioCrossfadesForTrack(targetIndex);
    }
  } else if (kind === 'text') {
    const tx = PROJECT.text.find(t=>t.id===id);
    if (!tx) return;
    tx.trackIndex = targetIndex;
    normalizeTrackIndices('text');
  }
  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
  scheduleAutosave('move-to-track');
}

// ---------- Track menus and merging/renaming ----------
function trackIndexList(kind){
  if (kind === 'visual') return uniqueSorted(PROJECT.items.map(i=>i.trackIndex ?? 0));
  if (kind === 'audio')  return uniqueSorted(PROJECT.audio.map(a=>a.trackIndex ?? 0));
  if (kind === 'text')   return uniqueSorted(PROJECT.text.map(t=>t.trackIndex ?? 0));
  return [];
}

function mergeTracks(kind, srcIndex, destIndex){
  if (destIndex < 0) return;
  if (isTrackLocked(kind, srcIndex) || isTrackLocked(kind, destIndex)) return;

  if (kind === 'visual') {
    const exists = PROJECT.items.some(i => (i.trackIndex ?? -1) === destIndex);
    if (!exists) return;
    for (const it of PROJECT.items) if ((it.trackIndex ?? -1) === srcIndex) it.trackIndex = destIndex;
    normalizeTrackIndices('visual');
  } else if (kind === 'audio') {
    const exists = PROJECT.audio.some(a => (a.trackIndex ?? -1) === destIndex);
    if (!exists) return;
    for (const au of PROJECT.audio) if ((au.trackIndex ?? -1) === srcIndex) au.trackIndex = destIndex;
    normalizeTrackIndices('audio');
    normalizeAudioCrossfadesForTrack(destIndex);
  } else if (kind === 'text') {
    const exists = PROJECT.text.some(t => (t.trackIndex ?? -1) === destIndex);
    if (!exists) return;
    for (const t of PROJECT.text) if ((t.trackIndex ?? -1) === srcIndex) t.trackIndex = destIndex;
    normalizeTrackIndices('text');
  }

  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
  scheduleAutosave('merge-tracks');
}

function showTrackMenu(x, y, kind, trackIndex){
  closeMenu();
  const m = document.createElement('div');
  m.className = 'context-menu';
  m.addEventListener('click', e=>e.stopPropagation());
  m.addEventListener('mousedown', e=>e.stopPropagation());

  const idxs = trackIndexList(kind);
  const locked = isTrackLocked(kind, trackIndex);
  const pos = idxs.indexOf(trackIndex);
  const upIdx = pos > 0 ? idxs[pos-1] : null;
  const hasBelow = pos >= 0 && pos < idxs.length-1;

  const title = document.createElement('button');
  title.textContent = `${kind.toUpperCase()} Track ${trackIndex+1}`;
  title.disabled = true;
  m.appendChild(title);

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename track...';
  renameBtn.addEventListener('click', ()=>{
    if (m.querySelector('.trn')) return;
    const row = document.createElement('div');
    row.className = 'trn';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;';
    const input = document.createElement('input');
    input.type='text';
    input.value = getTrackName(kind, trackIndex);
    input.style.cssText = 'flex:1;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
    const ok = document.createElement('button'); ok.textContent='Set';
    ok.addEventListener('click', ()=>{ setTrackName(kind, trackIndex, input.value); closeMenu(); renderTimeline(); });
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ setTrackName(kind, trackIndex, input.value); closeMenu(); renderTimeline(); } });
    row.append(input, ok);
    m.appendChild(row);
    input.focus(); input.select();
    m._refit?.();
  });
  m.appendChild(renameBtn);

  const lockBtn = document.createElement('button');
  lockBtn.textContent = locked ? 'Unlock track' : 'Lock track';
  lockBtn.addEventListener('click', ()=>{
    pushHistory(locked ? 'unlock-track' : 'lock-track');
    setTrackLocked(kind, trackIndex, !locked);
    closeMenu();
    renderTimeline();
    refreshStageVisibility();
    drawPlayhead();
    scheduleAutosave('track-lock-toggle');
  });
  m.appendChild(lockBtn);

  const hr1 = document.createElement('hr'); hr1.style.margin = '6px 0'; m.appendChild(hr1);

  const upBtn = document.createElement('button');
  upBtn.textContent = 'Merge Up';
  upBtn.disabled = (upIdx == null) || locked;
  upBtn.onclick = () => { if (upIdx != null && !locked) mergeTracks(kind, trackIndex, upIdx); closeMenu(); };
  m.appendChild(upBtn);

  const downBtn = document.createElement('button');
  downBtn.textContent = hasBelow ? 'Merge Down' : 'Move all to new track below';
  downBtn.disabled = locked;
  downBtn.onclick = () => {
    if (locked) { closeMenu(); return; }
    if (hasBelow) {
      mergeTracks(kind, trackIndex, idxs[pos+1]);
    } else {
      const newIdx = insertNewTrack(kind, trackIndex+1);
      mergeTracks(kind, trackIndex, newIdx);
    }
    closeMenu();
  };
  m.appendChild(downBtn);

  attachAndFitMenu(m, x, y);
}

// ---------- Splits / Trims ----------
function getClipRefById(id) {
  const i = PROJECT.items.findIndex(x=>x.id===id);
  if (i !== -1) return { kind:'visual', list: PROJECT.items, idx:i, ref: PROJECT.items[i] };
  const t = PROJECT.text.findIndex(x=>x.id===id);
  if (t !== -1) return { kind:'text', list: PROJECT.text, idx:t, ref: PROJECT.text[t] };
  const a = PROJECT.audio.findIndex(x=>x.id===id);
  if (a !== -1) return { kind:'audio', list: PROJECT.audio, idx:a, ref: PROJECT.audio[a] };
  const b = (PROJECT.bgClips||[]).findIndex(x=>x.id===id);
  if (b !== -1) return { kind:'bg', list: PROJECT.bgClips, idx:b, ref: PROJECT.bgClips[b] };
  return null;
}
function effectiveEnd(c) { return (c.end == null) ? timelineViewportEnd() : c.end; }

// finite end for text clips
function effectiveTextEnd(t) {
  if (Number.isFinite(t?.end)) return t.end;
  if (Number.isFinite(t?.duration)) return t.start + t.duration;
  return t.start; // zero-length if neither set
}

function neighborsOnSameTrack(kind, trackIndex, selfId) {
  if (kind === 'visual') {
    const arr = PROJECT.items.filter(i=>i.trackIndex===trackIndex).sort((a,b)=>a.start-b.start);
    const ix = arr.findIndex(i=>i.id===selfId);
    return { prev: arr[ix-1]||null, next: arr[ix+1]||null };
  }
  if (kind === 'audio') {
    const arr = PROJECT.audio.filter(a=>a.trackIndex===trackIndex).sort((a,b)=>a.start-b.start);
    const ix = arr.findIndex(a=>a.id===selfId);
    return { prev: arr[ix-1]||null, next: arr[ix+1]||null };
  }
  if (kind === 'text') {
    const arr = PROJECT.text.filter(t=>t.trackIndex===trackIndex).sort((a,b)=>a.start-b.start);
    const ix = arr.findIndex(t=>t.id===selfId);
    return { prev: arr[ix-1]||null, next: arr[ix+1]||null };
  }
  if (kind === 'bg') {
    const arr = (PROJECT.bgClips||[]).slice().sort((a,b)=>a.start-b.start);
    const ix = arr.findIndex(c=>c.id===selfId);
    return { prev: arr[ix-1]||null, next: arr[ix+1]||null };
  }
  return { prev:null, next:null };
}

function applyAudioCrossfade(prev, next, durMs) {
  if (!prev || !next) return false;
  const maxPrev = Math.max(0, (prev.end ?? 0) - (prev.start ?? 0));
  const maxNext = Math.max(0, (next.end ?? 0) - (next.start ?? 0));
  const limit = Math.max(0, Math.min(maxPrev, maxNext));
  const ms = clamp(Math.round(durMs || 0), 0, Math.max(0, limit));
  if (ms <= 0) {
    prev.crossfadeNextMs = 0;
    next.crossfadePrevMs = 0;
    return false;
  }
  prev.crossfadeNextMs = ms;
  next.crossfadePrevMs = ms;
  const targetStart = Math.max(0, (prev.end ?? 0) - ms);
  if (targetStart !== next.start) {
    next.start = targetStart;
  }
  prev._needsSeek = true;
  prev._prePrimed = false;
  next._needsSeek = true;
  next._prePrimed = false;
  normalizeAudioCrossfadesAround(prev);
  normalizeAudioCrossfadesAround(next);
  return true;
}

function clearAudioCrossfade(prev, next) {
  if (!prev || !next) return false;
  prev.crossfadeNextMs = 0;
  next.crossfadePrevMs = 0;
  const minStart = prev.end ?? 0;
  if (next.start < minStart) next.start = minStart;
  prev._needsSeek = true;
  prev._prePrimed = false;
  next._needsSeek = true;
  next._prePrimed = false;
  normalizeAudioCrossfadesAround(prev);
  normalizeAudioCrossfadesAround(next);
  return true;
}

function normalizeAudioCrossfadesAround(au) {
  if (!au) return;
  const trackIdx = au.trackIndex ?? 0;
  const { prev, next } = neighborsOnSameTrack('audio', trackIdx, au.id);
  if (prev) {
    const overlapPrev = Math.max(0, (prev.end ?? 0) - (au.start ?? 0));
    const prevDur = Math.max(0, (prev.end ?? 0) - (prev.start ?? 0));
    const selfDur = Math.max(0, (au.end ?? 0) - (au.start ?? 0));
    const val = Math.min(overlapPrev, prevDur, selfDur);
    prev.crossfadeNextMs = val;
    au.crossfadePrevMs = val;
  } else {
    au.crossfadePrevMs = 0;
  }
  if (next) {
    const overlapNext = Math.max(0, (au.end ?? 0) - (next.start ?? 0));
    const selfDur = Math.max(0, (au.end ?? 0) - (au.start ?? 0));
    const nextDur = Math.max(0, (next.end ?? 0) - (next.start ?? 0));
    const val = Math.min(overlapNext, selfDur, nextDur);
    au.crossfadeNextMs = val;
    next.crossfadePrevMs = val;
  } else {
    au.crossfadeNextMs = 0;
  }
}

function normalizeAudioCrossfadesForTrack(trackIdx) {
  const idx = Number.isInteger(trackIdx) ? trackIdx : (trackIdx ?? 0);
  const clips = PROJECT.audio
    .filter(a => (a.trackIndex ?? 0) === idx)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  for (const clip of clips) {
    normalizeAudioCrossfadesAround(clip);
  }
}

function computeMergeCrossfadeMs(first, second) {
  if (!first || !second) return 0;
  const startA = Math.round(first.start ?? 0);
  const endA = Math.round(first.end ?? startA);
  const startB = Math.round(second.start ?? 0);
  const endB = Math.round(second.end ?? startB);
  const durA = Math.max(50, endA - startA);
  const durB = Math.max(50, endB - startB);
  const overlap = Math.max(0, endA - startB);
  const base = overlap > 0 ? overlap : 750;
  return Math.max(50, Math.min(base, durA, durB));
}

async function mergeAudioPairWithCrossfade(firstClip, secondClip, customSeconds = null) {
  if (audioMergeInProgress) return;
  audioMergeInProgress = true;
  try {
    if (!firstClip || !secondClip) return;
    if (!PATHS) {
      try { PATHS = await window.suAPI.getPaths(); }
      catch (err) { console.warn('mergeAudioPairWithCrossfade getPaths failed', err); }
    }
    const outputRootRaw = PATHS?.userAudioOut || PATHS?.audio || PATHS?.base || '';
    const outputRoot = outputRootRaw ? outputRootRaw.replace(/[\\/]+$/,'') : '';
    if (!outputRoot) {
      alert('Audio output folder is not available.');
      return;
    }
    if (!window.suAPI?.mergeAudioClips) {
      alert('Audio merging is not available in this build.');
      return;
    }

    const startA = Math.round(firstClip.start ?? 0);
    const endA = Math.round(firstClip.end ?? startA);
    const startB = Math.round(secondClip.start ?? 0);
    const endB = Math.round(secondClip.end ?? startB);
    const durA = Math.max(50, endA - startA);
    const durB = Math.max(50, endB - startB);
    const maxAllowedMs = Math.max(50, Math.min(durA, durB));

    let crossfadeMs = computeMergeCrossfadeMs(firstClip, secondClip);
    if (customSeconds != null) {
      const requestedMs = Math.round(Math.max(0, Number(customSeconds) || 0) * 1000);
      if (requestedMs > 0) crossfadeMs = requestedMs;
    }
    crossfadeMs = Math.min(crossfadeMs, maxAllowedMs);
    if (!Number.isFinite(crossfadeMs) || crossfadeMs <= 0) {
      alert('Selected clips are too short to merge with a crossfade.');
      return;
    }

    const makeClipPayload = (clip) => {
      const start = Math.round(clip.start ?? 0);
      const end = Math.round(clip.end ?? start);
      const durationMs = Math.max(50, end - start);
      return {
        path: clip.path,
        durationMs,
        playbackRate: clip.playbackRate ?? 1,
        mediaOffsetMs: Math.max(0, Math.round(clip.mediaOffset || 0)),
        volume: clip.volume ?? 1,
        muted: !!clip.muted,
        fadeInSec: clip.fadeInSec ?? 0,
        fadeOutSec: clip.fadeOutSec ?? 0,
        reversed: !!clip.reversed,
        effects: cloneAudioEffectsSettings(clip)
      };
    };

    const clipLabel = (clip) => {
      const byName = typeof clip?.name === 'string' ? clip.name.trim() : '';
      if (byName) return byName;
      const fromPath = (clip?.path || '').split(/[\\/]/).pop() || 'audio';
      return fromPath.replace(/\.[^.]+$/, '');
    };

    const suggestedBase = textToSafeFilename(`${clipLabel(firstClip)}-${clipLabel(secondClip)}-merged`, 72) || 'merged-audio';
    const suggestedName = `${suggestedBase}.wav`;

    const mergeResult = await window.suAPI.mergeAudioClips({
      first: makeClipPayload(firstClip),
      second: makeClipPayload(secondClip),
      crossfadeMs,
      outputDir: outputRoot,
      suggestedName
    });

    if (!mergeResult || !mergeResult.ok) {
      throw new Error(mergeResult?.error || 'Unable to merge those clips.');
    }

    const historySnapshot = snapshotProject();

    const spanStart = Math.min(firstClip.start ?? 0, secondClip.start ?? 0);
    const spanEnd = Math.max(
      firstClip.end ?? firstClip.start ?? 0,
      secondClip.end ?? secondClip.start ?? 0
    );
    const originalDuration = Math.max(0, spanEnd - spanStart);

    const mergedDurationMs = Math.max(1, Math.round(Number(mergeResult.durationMs) || 0));
    const newEnd = spanStart + mergedDurationMs;
    const delta = originalDuration - mergedDurationMs;
    const trackIdx = firstClip.trackIndex ?? secondClip.trackIndex ?? getNextTrackIndex('audio');

    const removeIds = new Set([firstClip.id, secondClip.id]);
    for (let i = PROJECT.audio.length - 1; i >= 0; i--) {
      if (removeIds.has(PROJECT.audio[i]?.id)) {
        PROJECT.audio.splice(i, 1);
      }
    }

    const mergedFileName = mergeResult.fileName || suggestedName;
    const mergedPath = mergeResult.outputPath || (outputRoot ? `${outputRoot}\\${mergedFileName}` : mergedFileName);
    if (!mergedPath) throw new Error('Merged audio path was not returned.');
    const mergedName = `Merged: ${clipLabel(firstClip)} + ${clipLabel(secondClip)}`;
    const mergedClip = {
      id: uid(),
      kind: 'audio',
      name: mergedName,
      path: mergedPath,
      start: spanStart,
      end: newEnd,
      type: 'audio',
      trackIndex: trackIdx,
      volume: 1,
      muted: false,
      playbackRate: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      crossfadePrevMs: 0,
      crossfadeNextMs: 0,
      effects: cloneAudioEffectDefaults(),
      mediaOffset: 0,
      reversed: false,
      srcDurationMs: mergedDurationMs
    };

    PROJECT.audio.push(mergedClip);
    PROJECT.audio.sort((a, b) => {
      const ta = a.trackIndex ?? 0;
      const tb = b.trackIndex ?? 0;
      if (ta !== tb) return ta - tb;
      return (a.start ?? 0) - (b.start ?? 0);
    });

    hydrateAudioEffectsObject(mergedClip);
    initializeAudioRuntimeState(mergedClip, { waveSource: null });
    mergedClip._needsSeek = true;
    mergedClip._prePrimed = false;
    ensureWaveform(mergedClip).catch(()=>{});

    if (delta > 0.5) {
      for (const clip of PROJECT.audio) {
        if (clip.id === mergedClip.id) continue;
        if ((clip.trackIndex ?? 0) !== trackIdx) continue;
        if ((clip.start ?? 0) >= spanEnd - 0.0001) {
          const duration = Math.max(50, (clip.end ?? clip.start ?? 0) - (clip.start ?? 0));
          const newStart = Math.max(0, (clip.start ?? 0) - delta);
          clip.start = newStart;
          clip.end = newStart + duration;
        }
      }
    } else if (delta < -0.5) {
      const expand = -delta;
      for (const clip of PROJECT.audio) {
        if (clip.id === mergedClip.id) continue;
        if ((clip.trackIndex ?? 0) !== trackIdx) continue;
        if ((clip.start ?? 0) >= spanEnd - 0.0001) {
          clip.start = (clip.start ?? 0) + expand;
          clip.end = (clip.end ?? clip.start ?? 0) + expand;
        }
      }
    }

    normalizeAudioCrossfadesForTrack(trackIdx);

    renderTimeline();
    selectClip(mergedClip.id);
    scheduleAutosave('audio-merge');
    pushHistoryWithSnapshot(historySnapshot, 'merge-audio');
  } catch (error) {
    console.error('mergeAudioPairWithCrossfade error', error);
    alert(error?.message || 'Unable to merge those clips.');
  } finally {
    audioMergeInProgress = false;
  }
}

function insertKfAtBoundaryIfVisual(item, t) {
  if (!item || !Array.isArray(item.keyframes)) return;
  const pose = getPoseAt(item, t);
  upsertKeyframe(item, t, pose);
}

function splitClipAtPlayhead(id) {
  if (isClipLocked(id)) return;
  const ref = getClipRefById(id);
  if (!ref) return;
  const { kind, list, idx } = ref;
  const src = list[idx];
  const t = Math.round(currentTime);

  const start = src.start;
  const end = effectiveEnd(src);
  if (!(t > start && t < end)) return;

  if (kind === 'visual') {
    const origKf = (src.keyframes||[]).slice();
    const oldEnd = src.end;
    src.end = t;
    src.keyframes = origKf.filter(k=>k.t <= t + 0.0001);
    insertKfAtBoundaryIfVisual(src, t);

    const clone = { ...src };
    clone.mask = cloneMask(src.mask);
    clone.id = uid();
    clone.start = t;
    clone.end   = oldEnd;
    clone._editing = false;
    clone._gif = null;
    resetVisualRuntimeState(clone);
    clone.keyframes = origKf.filter(k=>k.t >= t - 0.0001);
    clone.fx = cloneFx(src.fx);
    hydrateFx(clone);
    clone.chromaKey = cloneChromaKey(src.chromaKey);
    hydrateChromaKey(clone);
    insertKfAtBoundaryIfVisual(clone, t);

    list.splice(idx+1, 0, clone);
    spawnStageItem(clone);
    selectClip(clone.id);
  } else if (kind === 'audio') {
    const oldEnd = src.end;
    const origOffset = src.mediaOffset || 0;
    const rate = src.playbackRate || 1;

    src.end = t;
    src.crossfadeNextMs = 0;
    src._needsSeek = true;
    src._prePrimed = false;

    const clone = { ...src, id: uid(), start: t, end: oldEnd, _el: null };
    clone.effects = cloneAudioEffectsSettings(src);
    hydrateAudioEffectsObject(clone);
    clone.mediaOffset = origOffset + (t - start) * rate;
    clone.fadeInSec = 0; // right-hand clip starts fresh
    clone.crossfadePrevMs = 0;
    clone.crossfadeNextMs = 0;
    clone._needsSeek = true;
    clone._prePrimed = false;
    initializeAudioRuntimeState(clone, { waveSource: src });
    list.splice(idx+1, 0, clone);
    ensureWaveform(clone);
    normalizeAudioCrossfadesAround(src);
    normalizeAudioCrossfadesAround(clone);
    selectClip(clone.id);
  } else {
    const oldEnd = src.end;
    src.end = t;
    const clone = { ...src, id: uid(), start: t, end: oldEnd };
    clone.mask = cloneMask(src.mask);
    if (kind === 'bg') {
      clone.fx = cloneFx(src.fx);
      hydrateFx(clone);
      clone.chromaKey = cloneChromaKey(src.chromaKey);
      hydrateChromaKey(clone);
      resetVisualRuntimeState(clone);
    }
    list.splice(idx+1, 0, clone);
    selectClip(clone.id);
  }

  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
  applyBackgroundForTime(currentTime);
  scheduleAutosave('delete-item');
}

function trimBeforePlayhead(id) {
  if (isClipLocked(id)) return;
  const ref = getClipRefById(id);
  if (!ref) return;
  const { kind, ref: clip } = ref;
  let t = Math.round(currentTime);

  const end = effectiveEnd(clip);
  if (t <= clip.start) return;
  if (t >= end) t = end - 50;

  const { prev } = neighborsOnSameTrack(kind, clip.trackIndex ?? 0, clip.id);
  if (prev) t = Math.max(t, effectiveEnd(prev));

  const oldStart = clip.start;
  clip.start = Math.min(t, end-50);

  if (kind === 'visual') {
    clip.keyframes = (clip.keyframes||[]).filter(k=>k.t >= clip.start - 0.0001);
    insertKfAtBoundaryIfVisual(clip, clip.start);
  } else if (kind === 'audio') {
    const rate = clip.playbackRate || 1;
    const delta = clip.start - oldStart;
    clip.mediaOffset = Math.max(0, (clip.mediaOffset || 0) + delta * rate);
    normalizeAudioCrossfadesAround(clip);
    const neigh = neighborsOnSameTrack('audio', clip.trackIndex ?? 0, clip.id);
    if (neigh.prev) normalizeAudioCrossfadesAround(neigh.prev);
    if (neigh.next) normalizeAudioCrossfadesAround(neigh.next);
  }
  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
  applyBackgroundForTime(currentTime);
  scheduleAutosave('delete-item');
}

function trimAfterPlayhead(id) {
  if (isClipLocked(id)) return;
  const ref = getClipRefById(id);
  if (!ref) return;
  const { kind, ref: clip } = ref;
  let t = Math.round(currentTime);

  if (t >= effectiveEnd(clip)) return;
  if (t <= clip.start) t = clip.start + 50;

  const { next } = neighborsOnSameTrack(kind, clip.trackIndex ?? 0, clip.id);
  if (next) t = Math.min(t, next.start);

  clip.end = Math.max(t, clip.start+50);

  if (kind === 'visual') {
    clip.keyframes = (clip.keyframes||[]).filter(k=>k.t <= clip.end + 0.0001);
    insertKfAtBoundaryIfVisual(clip, clip.end);
  } else if (kind === 'audio') {
    normalizeAudioCrossfadesAround(clip);
    const neigh = neighborsOnSameTrack('audio', clip.trackIndex ?? 0, clip.id);
    if (neigh.prev) normalizeAudioCrossfadesAround(neigh.prev);
    if (neigh.next) normalizeAudioCrossfadesAround(neigh.next);
  }
  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
  applyBackgroundForTime(currentTime);
  scheduleAutosave('delete-item');
}

// ---------- Snapping ----------
function msThreshold() { return (SNAP_PX / pxPerSecond) * 1000; }

function snapCandidates(kind, selfId) {
  const t = [];
  for (const it of PROJECT.items) {
    if (kind==='visual' && it.id === selfId) continue;
    t.push(it.start, it.end);
  }
  for (const au of PROJECT.audio) {
    if (kind==='audio' && au.id === selfId) continue;
    t.push(au.start, au.end);
  }
  for (const bg of (PROJECT.bgClips||[])) {
    if (kind==='bg' && bg.id === selfId) continue;
    t.push(bg.start);
    if (bg.end != null) t.push(bg.end);
  }
  t.push(currentTime); // snap to playhead in both directions
  return t.filter(v=>Number.isFinite(v));
}

function findSnap(ms, targets) {
  const thr = msThreshold();
  let best = null, bestDiff = Infinity;
  for (const tt of targets) {
    const d = Math.abs(ms - tt);
    if (d <= thr && d < bestDiff) { best = tt; bestDiff = d; }
  }
  return best;
}

function noOverlapBounds(kind, trackIndex, selfId) {
  const { prev, next } = neighborsOnSameTrack(kind, trackIndex, selfId);
  const selfAudio = kind === 'audio' ? PROJECT.audio.find(a=>a.id===selfId) : null;
  let minStart = prev ? effectiveEnd(prev) : 0;
  let maxEnd   = next ? next.start : Infinity;
  if (kind === 'audio') {
    if (prev) {
      const overlapPrev = Math.max(
        Math.max(0, prev.crossfadeNextMs || 0),
        Math.max(0, selfAudio?.crossfadePrevMs || 0)
      );
      if (overlapPrev > 0) {
        minStart = Math.max(0, (prev.end ?? minStart) - overlapPrev);
      }
    }
    if (next) {
      const overlapNext = Math.max(
        Math.max(0, selfAudio?.crossfadeNextMs || 0),
        Math.max(0, next.crossfadePrevMs || 0)
      );
      if (overlapNext > 0) {
        maxEnd = (next.start ?? maxEnd) + overlapNext;
      }
    }
  }
  return { minStart, maxEnd, hasNext: !!next };
}

function getAudioAllowedDurMs(au, mediaOffsetMs = null, rate = null) {
  const srcMs = au.srcDurationMs;
  if (!srcMs || !Number.isFinite(srcMs)) return Infinity;
  const off = (mediaOffsetMs != null ? mediaOffsetMs : (au.mediaOffset || 0));
  const r = (rate != null ? rate : (au.playbackRate || 1));
  const remain = Math.max(0, srcMs - off);
  return Math.max(50, Math.floor(remain / Math.max(0.05, r)));
}

function expandOrClampAudioForRate(au) {
  if (!au) return;
  const allowed = getAudioAllowedDurMs(au);
  const cur = au.end - au.start;
  if (cur > allowed) {
    au.end = au.start + allowed;
    normalizeAudioCrossfadesAround(au);
    const neigh = neighborsOnSameTrack('audio', au.trackIndex ?? 0, au.id);
    if (neigh.prev) normalizeAudioCrossfadesAround(neigh.prev);
    if (neigh.next) normalizeAudioCrossfadesAround(neigh.next);
    return;
  }
  // try to expand to allowed if space permits
  const { next } = neighborsOnSameTrack('audio', au.trackIndex ?? 0, au.id);
  const maxEnd = next ? next.start : Infinity;
  const desired = au.start + allowed;
  au.end = Math.min(desired, maxEnd);
  normalizeAudioCrossfadesAround(au);
  if (next) normalizeAudioCrossfadesAround(next);
}

// ---------- Clip menu ----------
function showClipMenu(x, y, id) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.addEventListener('click', e => e.stopPropagation());
  menu.addEventListener('mousedown', e => e.stopPropagation());

  const it = PROJECT.items.find(i=>i.id===id);
  const au = !it ? PROJECT.audio.find(a=>a.id===id) : null;
  const tx = (!it && !au) ? PROJECT.text.find(t=>t.id===id) : null;
  const bg = (!it && !au && !tx) ? (PROJECT.bgClips||[]).find(b=>b.id===id) : null;
  const refData = getClipRefById(id);
  const clipSelfLocked = !!refData?.ref?.locked;

  const kind = it ? 'visual' : (au ? 'audio' : (tx ? 'text' : 'bg'));
  const trackIndex = it ? it.trackIndex : au ? au.trackIndex : tx ? (tx.trackIndex ?? 0) : 0;
  const trackLocked = kind === 'bg' ? isTrackLocked('bg', 0) : isTrackLocked(kind, trackIndex);
  const clipLocked = clipSelfLocked || trackLocked;

  // Track ops for visual/audio only
  if (kind !== 'bg') {
    const idxs = getTrackIndices(kind);
    const pos = idxs.indexOf(trackIndex);
    const hasAbove = pos > 0;
    const hasBelow = pos >= 0 && pos < idxs.length - 1;

    if (hasAbove) {
      const aboveBtn = document.createElement('button');
      aboveBtn.textContent = 'Merge with above track';
      aboveBtn.disabled = trackLocked;
      aboveBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        if (trackLocked) return;
        // apply to all selected clips of this kind; fallback to clicked one
        const targets = (selectedClipIds && selectedClipIds.size)
          ? [...selectedClipIds]
          : [id];
        for (const cid of targets) {
          const ref = getClipRefById(cid);
          if (!ref || ref.kind !== kind) continue;
          const curIdx = ref.ref.trackIndex ?? 0;
          const curPos = idxs.indexOf(curIdx);
          const destPos = curPos - 1;
          if (destPos >= 0) {
            const destIdx = idxs[destPos];
            if (!isTrackLocked(kind, destIdx)) moveClipToTrack(cid, kind, destIdx);
          }
        }
        closeMenu();
      });
      menu.appendChild(aboveBtn);
    }

    const belowBtn = document.createElement('button');
    belowBtn.textContent = hasBelow ? 'Merge with below track' : 'Move to new track below';
    belowBtn.disabled = trackLocked;
    belowBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      if (trackLocked) return;
      const applyTo = (selectedClipIds && selectedClipIds.size)
        ? [...selectedClipIds]
        : [id];
      if (hasBelow) {
        for (const cid of applyTo) {
          const ref = getClipRefById(cid);
          if (!ref || ref.kind !== kind) continue;
          const curIdx = ref.ref.trackIndex ?? 0;
          const curPos = idxs.indexOf(curIdx);
          const destPos = curPos + 1;
          if (destPos < idxs.length) {
            const destIdx = idxs[destPos];
            if (!isTrackLocked(kind, destIdx)) moveClipToTrack(cid, kind, destIdx);
          }
        }
      } else {
        const newIdx = insertNewTrack(kind, trackIndex + 1);
        for (const cid of applyTo) {
          const ref = getClipRefById(cid);
          if (!ref || ref.kind !== kind) continue;
          if (!isTrackLocked(kind, newIdx)) moveClipToTrack(cid, kind, newIdx);
        }
      }
      closeMenu();
    });
    menu.appendChild(belowBtn);
  }

  const lockBtn = document.createElement('button');
  lockBtn.textContent = clipSelfLocked ? 'Unlock clip' : 'Lock clip';
  if (trackLocked) lockBtn.textContent += ' (track locked)';
  lockBtn.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    pushHistory(clipSelfLocked ? 'unlock-clip' : 'lock-clip');
    setClipLocked(id, !clipSelfLocked);
    closeMenu();
    renderTimeline();
    refreshStageVisibility();
    scheduleAutosave('clip-lock-toggle');
  });
  menu.appendChild(lockBtn);

  if (tx) {
    const hrEdit = document.createElement('hr'); hrEdit.style.margin = '6px 0'; menu.appendChild(hrEdit);
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Change Text...';
    if (clipLocked) editBtn.disabled = true;
    editBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      if (clipLocked) return;
      closeMenu();
      editTextObject(tx).catch(err=>console.error('edit text failed', err));
    });
    menu.appendChild(editBtn);
  }

  if (kind === 'visual') {
    const chromaBtn = document.createElement('button');
    chromaBtn.textContent = 'Chroma Key...';
    chromaBtn.disabled = clipLocked || !it?.path;
    chromaBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      closeMenu();
      if (clipLocked || !it) return;
      void editChromaKeyForClip(it, 'visual');
    });
    menu.appendChild(chromaBtn);

    const fxBtn = document.createElement('button');
    fxBtn.textContent = 'Visual Effects...';
    fxBtn.disabled = clipLocked;
    fxBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      closeMenu();
      if (it) void editFxForClip(it, 'visual');
    });
    menu.appendChild(fxBtn);

    const hrKF = document.createElement('hr'); hrKF.style.margin = '6px 0'; menu.appendChild(hrKF);
    const addKfBtn = document.createElement('button');
    addKfBtn.textContent = 'Add Keyframe at Playhead';
    addKfBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      addKeyframeForClipId(id);
      closeMenu();
    });
    menu.appendChild(addKfBtn);
  }

  // GIF options only for visual GIFs
  if (it && isGifPath(it.path)) {
    const hr0 = document.createElement('hr'); hr0.style.margin = '6px 0'; menu.appendChild(hr0);

    if (!it.loopMode) it.loopMode = (it.loop === false) ? 'once' : 'infinite';
    const setMode = (mode)=>{ it.loopMode = mode; if (mode!=='count') delete it.loopCount; };

    const loopBtn = document.createElement('button');
    loopBtn.textContent = it.loopMode === 'infinite' ? 'Loop (current)' : 'Loop';
    loopBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); setMode('infinite'); closeMenu(); });
    menu.appendChild(loopBtn);

    const onceBtn = document.createElement('button');
    onceBtn.textContent = it.loopMode === 'once' ? 'Play once (current)' : 'Play once (hold last)';
    onceBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); setMode('once'); closeMenu(); });
    menu.appendChild(onceBtn);

    const countBtn = document.createElement('button');
    const hasCount = it.loopMode === 'count' && Number.isInteger(it.loopCount);
    countBtn.textContent = `Loop N times...${hasCount ? ` (current: ${it.loopCount})` : ''}`;
    countBtn.addEventListener('click', (ev)=>{
      ev.preventDefault(); ev.stopPropagation();
      if (menu.querySelector('.loop-count-row')) return;

      const row = document.createElement('div');
      row.className = 'loop-count-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '1'; input.step = '1';
      input.value = hasCount ? String(it.loopCount) : '2';
      input.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
      const ok = document.createElement('button');
      ok.textContent = 'Set';
      ok.addEventListener('click', (e2)=>{
        e2.stopPropagation();
        const n = parseInt(input.value, 10);
        if (Number.isInteger(n) && n >= 1) { it.loopMode = 'count'; it.loopCount = n; }
        closeMenu();
      });
      input.addEventListener('keydown', (e2)=>{
        if (e2.key === 'Enter') {
          const n = parseInt(input.value, 10);
          if (Number.isInteger(n) && n >= 1) { it.loopMode = 'count'; it.loopCount = n; }
          closeMenu();
        } else if (e2.key === 'Escape') {
          closeMenu();
        }
      });
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', (e2)=>{ e2.stopPropagation(); closeMenu(); });

      row.append(input, ok, cancel);
      menu.appendChild(row);
      input.focus();
      input.select();
      menu._refit?.();
    });
    menu.appendChild(countBtn);

    if (it._gif?.mode === 'mirror') {
      const note = document.createElement('button');
      note.textContent = 'Note: exact counts need WebCodecs.';
      note.disabled = true;
      menu.appendChild(note);
    }
  }

  // --- Visual/Text transitions ---
  const transitionTarget = it || tx;
  if (transitionTarget) {
    const hrT = document.createElement('hr'); hrT.style.margin = '6px 0'; menu.appendChild(hrT);

    function uiTransition(which) {
      if (menu.querySelector(`.trans-${which}`)) return;
      const row = document.createElement('div');
      row.className = `trans-${which}`;
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;flex-wrap:wrap;';

      const label = document.createElement('span');
      label.textContent = which === 'in' ? 'Transition In:' : 'Transition Out:';

      const sel = document.createElement('select');
      sel.style.cssText = 'min-width:160px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
      const types = ['none','fade','slide-left','slide-right','slide-up','slide-down','wipe-left'];
      types.forEach(t=>{
        const o = document.createElement('option');
        o.value = t; o.textContent = t==='none' ? '(none)' : (TRANSITION_LABELS[t] || t);
        sel.appendChild(o);
      });

      const dur = document.createElement('input');
      dur.type = 'number'; dur.min='50'; dur.step='50';
      dur.value = String((which==='in' ? (transitionTarget.transIn?.dur||300) : (transitionTarget.transOut?.dur||300)));
      dur.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';

      sel.value = (which==='in' ? (transitionTarget.transIn?.type || 'none') : (transitionTarget.transOut?.type || 'none'));

      const apply = document.createElement('button'); apply.textContent='Set';
      apply.addEventListener('click', ()=>{
        pushHistory('set-transition');
        const t = sel.value;
        const d = Math.max(50, parseInt(dur.value,10) || 300);
        if (t==='none') {
          if (which==='in') transitionTarget.transIn = null; else transitionTarget.transOut = null;
        } else {
          const obj = { type:t, dur:d };
          if (which==='in') transitionTarget.transIn = obj; else transitionTarget.transOut = obj;
        }
        closeMenu(); renderTimeline(); refreshStageVisibility();
        scheduleAutosave((tx ? 'text' : 'visual') + '-transition-set');
      });

      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.addEventListener('click', ()=>{
        pushHistory('remove-transition');
        if (which==='in') transitionTarget.transIn = null; else transitionTarget.transOut = null;
        closeMenu(); renderTimeline(); refreshStageVisibility();
        scheduleAutosave((tx ? 'text' : 'visual') + '-transition-remove');
      });

      row.append(label, sel, dur, apply, remove);
      menu.appendChild(row);
      menu._refit?.();
    }

    const inBtn = document.createElement('button');
    inBtn.textContent = 'Transition In...';
    inBtn.disabled = clipLocked;
    inBtn.addEventListener('click', ()=> uiTransition('in'));
    menu.appendChild(inBtn);

    const outBtn = document.createElement('button');
    outBtn.textContent = 'Transition Out...';
    outBtn.disabled = clipLocked;
    outBtn.addEventListener('click', ()=> uiTransition('out'));
    menu.appendChild(outBtn);
  }

  // --- Audio-only controls: Fade, Mute, Speed, Reverse ---
  if (au) {
    const fx = hydrateAudioEffectsObject(au);
    const hrA = document.createElement('hr'); hrA.style.margin = '6px 0'; menu.appendChild(hrA);

    let selectedAudioPair = null;
    if (selectedClipIds.size === 2 && selectedClipIds.has(au.id)) {
      const pair = [...selectedClipIds].map(cid => PROJECT.audio.find(a => a.id === cid)).filter(Boolean);
      if (pair.length === 2 && !pair.some(c => isClipLocked(c.id))) {
        const sortedPair = pair.slice().sort((a, b) => {
          const ta = a.trackIndex ?? 0;
          const tb = b.trackIndex ?? 0;
          if (ta !== tb) return ta - tb;
          return (a.start ?? 0) - (b.start ?? 0);
        });
        if ((sortedPair[0].trackIndex ?? 0) === (sortedPair[1].trackIndex ?? 0)) {
          const trackIdx = sortedPair[0].trackIndex ?? 0;
          const onTrack = PROJECT.audio
            .filter(c => (c.trackIndex ?? 0) === trackIdx)
            .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
          const leftIdx = onTrack.findIndex(c => c.id === sortedPair[0].id);
          const rightIdx = onTrack.findIndex(c => c.id === sortedPair[1].id);
          if (leftIdx !== -1 && rightIdx !== -1 && Math.abs(leftIdx - rightIdx) === 1) {
            selectedAudioPair = leftIdx < rightIdx
              ? { first: onTrack[leftIdx], second: onTrack[rightIdx] }
              : { first: onTrack[rightIdx], second: onTrack[leftIdx] };
          }
        }
      }
    }

    if (selectedAudioPair) {
      const mergeBtn = document.createElement('button');
      mergeBtn.textContent = 'Merge selected pair with crossfade';
      mergeBtn.disabled = clipLocked;
      mergeBtn.addEventListener('click', () => {
        if (menu.querySelector('.merge-crossfade-row')) return;
        const defaultMs = computeMergeCrossfadeMs(selectedAudioPair.first, selectedAudioPair.second);
        const defaultSec = Math.max(0.05, defaultMs / 1000);

        const row = document.createElement('div');
        row.className = 'merge-crossfade-row';
        row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;';

        const lbl = document.createElement('span');
        lbl.textContent = 'Crossfade seconds:';

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0.05';
        input.step = '0.05';
        input.value = defaultSec.toFixed(2).replace(/\.?0+$/, match => match === '.00' ? '' : match.replace(/0+$/,''));
        input.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';

        const ok = document.createElement('button');
        ok.textContent = 'Merge';
        ok.addEventListener('click', async () => {
          const parsed = parseFloat(input.value);
          const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSec;
          closeMenu();
          await mergeAudioPairWithCrossfade(selectedAudioPair.first, selectedAudioPair.second, seconds);
        });

        input.addEventListener('keydown', async (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const parsed = parseFloat(input.value);
            const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSec;
            closeMenu();
            await mergeAudioPairWithCrossfade(selectedAudioPair.first, selectedAudioPair.second, seconds);
          } else if (e.key === 'Escape') {
            row.remove();
            menu._refit?.();
          }
        });

        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => {
          row.remove();
          menu._refit?.();
        });

        row.append(lbl, input, ok, cancel);
        menu.appendChild(row);
        input.focus();
        input.select();
        menu._refit?.();
      });
      menu.appendChild(mergeBtn);
    }

    const fiBtn = document.createElement('button');
    fiBtn.textContent = 'Fade in...';
    fiBtn.addEventListener('click', ()=>{
      if (menu.querySelector('.fadein-row')) return;
      const row = document.createElement('div');
      row.className = 'fadein-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;';
      const lbl = document.createElement('span'); lbl.textContent = 'Seconds:';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.step = '0.1';
      input.value = au.fadeInSec ? String(au.fadeInSec) : '1.0';
      input.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
      const ok = document.createElement('button'); ok.textContent = 'Set';
      ok.addEventListener('click', ()=>{
        const v = Math.max(0, parseFloat(input.value) || 0);
        const maxSec = Math.max(0.0, (au.end - au.start)/1000 - 0.05);
        au.fadeInSec = Math.min(v, maxSec);
        closeMenu(); renderTimeline();
      });
      input.addEventListener('keydown', (e)=>{
        if (e.key==='Enter') {
          const v = Math.max(0, parseFloat(input.value) || 0);
          const maxSec = Math.max(0.0, (au.end - au.start)/1000 - 0.05);
          au.fadeInSec = Math.min(v, maxSec);
          closeMenu(); renderTimeline();
        } else if (e.key==='Escape') closeMenu();
      });
      row.append(lbl, input, ok);
      menu.appendChild(row);
      input.focus(); input.select();
      menu._refit?.();
    });
    menu.appendChild(fiBtn);

    if (au.fadeInSec && au.fadeInSec > 0) {
      const undoFI = document.createElement('button');
      undoFI.textContent = 'Remove fade in';
      undoFI.addEventListener('click', ()=>{ au.fadeInSec = 0; closeMenu(); renderTimeline(); });
      menu.appendChild(undoFI);
    }

    const foBtn = document.createElement('button');
    foBtn.textContent = 'Fade out...';
    foBtn.addEventListener('click', ()=>{
      if (menu.querySelector('.fadeout-row')) return;
      const row = document.createElement('div');
      row.className = 'fadeout-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;';
      const lbl = document.createElement('span'); lbl.textContent = 'Seconds:';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.step = '0.1';
      input.value = au.fadeOutSec ? String(au.fadeOutSec) : '1.0';
      input.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
      const ok = document.createElement('button'); ok.textContent = 'Set';
      ok.addEventListener('click', ()=>{
        const v = Math.max(0, parseFloat(input.value) || 0);
        const maxSec = Math.max(0.0, (au.end - au.start)/1000 - 0.05);
        au.fadeOutSec = Math.min(v, maxSec);
        closeMenu(); renderTimeline();
      });
      input.addEventListener('keydown', (e)=>{
        if (e.key==='Enter') {
          const v = Math.max(0, parseFloat(input.value) || 0);
          const maxSec = Math.max(0.0, (au.end - au.start)/1000 - 0.05);
          au.fadeOutSec = Math.min(v, maxSec);
          closeMenu(); renderTimeline();
        } else if (e.key==='Escape') closeMenu();
      });
      row.append(lbl, input, ok);
      menu.appendChild(row);
      input.focus(); input.select();
      menu._refit?.();
    });
    menu.appendChild(foBtn);

    if (au.fadeOutSec && au.fadeOutSec > 0) {
      const undoFO = document.createElement('button');
      undoFO.textContent = 'Remove fade out';
      undoFO.addEventListener('click', ()=>{ au.fadeOutSec = 0; closeMenu(); renderTimeline(); });
      menu.appendChild(undoFO);
    }
    const hrM = document.createElement('hr'); hrM.style.margin = '6px 0'; menu.appendChild(hrM);

    const muteBtn = document.createElement('button');
    muteBtn.textContent = au.muted ? 'Unmute audio' : 'Mute audio';
    muteBtn.addEventListener('click', ()=>{ au.muted = !au.muted; closeMenu(); renderTimeline(); });
    menu.appendChild(muteBtn);

    // Playback speed
    const speedBtn = document.createElement('button');
    speedBtn.textContent = 'Playback speed...';
    speedBtn.addEventListener('click', ()=>{
      if (menu.querySelector('.speed-row')) return;
      const row = document.createElement('div');
      row.className = 'speed-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;flex-wrap:wrap;';
      const lbl = document.createElement('span'); lbl.textContent = 'Rate (0.1-4):';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0.1'; input.max = '4'; input.step = '0.1';
      input.value = String(au.playbackRate || 1);
      input.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
      const set = document.createElement('button'); set.textContent = 'Set';
      function apply(v){
        const rate = clamp(parseFloat(v)||1, 0.1, 4);
        au.playbackRate = rate;
        expandOrClampAudioForRate(au);
        au._needsSeek = true; // force retime on next tick
        au._prePrimed = false;
        closeMenu(); renderTimeline();
      }
      set.addEventListener('click', ()=> apply(input.value));
      input.addEventListener('keydown', (e)=>{
        if (e.key==='Enter') apply(input.value);
        if (e.key==='Escape') closeMenu();
      });

      const presets = [0.25, 0.5, 1, 1.5, 2, 3, 4];
      const grid = document.createElement('div');
      grid.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      presets.forEach(r=>{
        const b = document.createElement('button');
        b.textContent = `${r}x`;
        b.addEventListener('click', ()=> apply(r));
        grid.appendChild(b);
      });

      row.append(lbl, input, set, grid);
      menu.appendChild(row);
      input.focus(); input.select();
      menu._refit?.();
    });
    menu.appendChild(speedBtn);

    // Reverse audio toggle
    const revBtn = document.createElement('button');
    revBtn.textContent = au.reversed ? 'Disable reverse' : 'Reverse audio';
    revBtn.addEventListener('click', async ()=>{
      au.reversed = !au.reversed;
      if (au.reversed) await ensureReversedUrl(au);
      au._currentSrcKey = null; // force src swap once
      au._needsSeek = true;
      au._prePrimed = false;
      closeMenu(); renderTimeline();
    });
    menu.appendChild(revBtn);

    const hrFx = document.createElement('hr'); hrFx.style.margin = '6px 0'; menu.appendChild(hrFx);

    const fxBtn = document.createElement('button');
    fxBtn.textContent = 'Audio effects...';
    fxBtn.addEventListener('click', ()=>{
      if (menu.querySelector('.audio-effects-panel')) return;
      ensureMediaGraph(au);
      const panel = document.createElement('div');
      panel.className = 'audio-effects-panel';
      panel.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:10px;background:#111820;border:1px solid #27303a;border-radius:10px;margin:6px 0;color:#d8e0f0;font-size:13px;line-height:1.3;';

      const title = document.createElement('div');
      title.textContent = 'Clip Effects';
      title.style.cssText = 'font-weight:600;color:#eef3ff;';
      panel.appendChild(title);

      const sliderRefreshers = [];
      const toggleRefreshers = [];
      const scheduleFxUpdate = ()=>{
        updateAudioGraphEffects(au);
        scheduleAutosave('audio-effects-change');
      };

      function makeSectionHeading(text) {
        const h = document.createElement('div');
        h.textContent = text;
        h.style.cssText = 'font-weight:600;color:#b6c7ff;margin-top:4px;';
        panel.appendChild(h);
      }

      function makeToggleRow({ label, getter, setter }) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = !!getter();
        chk.addEventListener('change', ()=>{
          setter(chk.checked);
          scheduleFxUpdate();
          sliderRefreshers.forEach(fn => fn());
        });
        const span = document.createElement('span');
        span.textContent = label;
        row.append(chk, span);
        panel.appendChild(row);
        const refresh = ()=>{ chk.checked = !!getter(); };
        toggleRefreshers.push(refresh);
      }

      function makeSliderRow({ label, min, max, step, getter, setter, enabled = ()=>true, format = (v)=>v.toFixed(1) }) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'flex:0 0 130px;color:#9fb3cc;';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.style.cssText = 'flex:1;';
        const valueLabel = document.createElement('span');
        valueLabel.style.cssText = 'width:64px;text-align:right;color:#d8e0f0;';
        const apply = (raw)=>{
          const num = clamp(Number(raw) || 0, min, max);
          setter(num);
          slider.value = String(num);
          valueLabel.textContent = format(num);
          scheduleFxUpdate();
        };
        slider.addEventListener('input', ()=> apply(slider.value));
        row.append(lbl, slider, valueLabel);
        panel.appendChild(row);
        const refresh = ()=>{
          const ena = !!enabled();
          slider.disabled = !ena;
          const current = clamp(Number(getter()) || 0, min, max);
          slider.value = String(current);
          valueLabel.textContent = format(current);
        };
        sliderRefreshers.push(refresh);
        refresh();
      }

      // EQ controls
      makeSectionHeading('Equalizer');
      makeToggleRow({
        label: 'Enable EQ',
        getter: ()=>fx.eq.enabled,
        setter: (v)=>{ fx.eq.enabled = v; }
      });
      makeSliderRow({
        label: 'Low shelf (dB)',
        min: -12,
        max: 12,
        step: 0.5,
        getter: ()=>fx.eq.lowGain,
        setter: (v)=>{ fx.eq.lowGain = v; },
        enabled: ()=>fx.eq.enabled,
        format: (v)=>`${v.toFixed(1)}`
      });
      makeSliderRow({
        label: 'Mid bell (dB)',
        min: -12,
        max: 12,
        step: 0.5,
        getter: ()=>fx.eq.midGain,
        setter: (v)=>{ fx.eq.midGain = v; },
        enabled: ()=>fx.eq.enabled,
        format: (v)=>`${v.toFixed(1)}`
      });
      makeSliderRow({
        label: 'High shelf (dB)',
        min: -12,
        max: 12,
        step: 0.5,
        getter: ()=>fx.eq.highGain,
        setter: (v)=>{ fx.eq.highGain = v; },
        enabled: ()=>fx.eq.enabled,
        format: (v)=>`${v.toFixed(1)}`
      });

      // Reverb controls
      makeSectionHeading('Reverb');
      makeToggleRow({
        label: 'Enable reverb',
        getter: ()=>fx.reverb.enabled,
        setter: (v)=>{ fx.reverb.enabled = v; }
      });
      makeSliderRow({
        label: 'Amount',
        min: 0,
        max: 1,
        step: 0.05,
        getter: ()=>fx.reverb.amount,
        setter: (v)=>{ fx.reverb.amount = v; },
        enabled: ()=>fx.reverb.enabled,
        format: (v)=>`${Math.round(v * 100)}%`
      });
      makeSliderRow({
        label: 'Tail length (s)',
        min: 0.3,
        max: 6,
        step: 0.1,
        getter: ()=>fx.reverb.time,
        setter: (v)=>{ fx.reverb.time = v; },
        enabled: ()=>fx.reverb.enabled,
        format: (v)=>`${v.toFixed(1)}s`
      });
      makeSliderRow({
        label: 'Decay',
        min: 0.5,
        max: 6,
        step: 0.1,
        getter: ()=>fx.reverb.decay,
        setter: (v)=>{ fx.reverb.decay = v; },
        enabled: ()=>fx.reverb.enabled,
        format: (v)=>`${v.toFixed(1)}`
      });

      // Compression controls
      makeSectionHeading('Compression');
      makeToggleRow({
        label: 'Enable compression',
        getter: ()=>fx.compression.enabled,
        setter: (v)=>{ fx.compression.enabled = v; }
      });
      makeSliderRow({
        label: 'Threshold (dB)',
        min: -60,
        max: 0,
        step: 1,
        getter: ()=>fx.compression.threshold,
        setter: (v)=>{ fx.compression.threshold = v; },
        enabled: ()=>fx.compression.enabled,
        format: (v)=>`${Math.round(v)} dB`
      });
      makeSliderRow({
        label: 'Ratio',
        min: 1,
        max: 12,
        step: 0.1,
        getter: ()=>fx.compression.ratio,
        setter: (v)=>{ fx.compression.ratio = v; },
        enabled: ()=>fx.compression.enabled,
        format: (v)=>`${v.toFixed(1)}x`
      });
      makeSliderRow({
        label: 'Attack (ms)',
        min: 1,
        max: 200,
        step: 1,
        getter: ()=> (fx.compression.attack || 0.003) * 1000,
        setter: (v)=>{ fx.compression.attack = clamp(v, 1, 200) / 1000; },
        enabled: ()=>fx.compression.enabled,
        format: (v)=>`${Math.round(v)} ms`
      });
      makeSliderRow({
        label: 'Release (ms)',
        min: 20,
        max: 1000,
        step: 5,
        getter: ()=> (fx.compression.release || 0.25) * 1000,
        setter: (v)=>{ fx.compression.release = clamp(v, 20, 1000) / 1000; },
        enabled: ()=>fx.compression.enabled,
        format: (v)=>`${Math.round(v)} ms`
      });

      // Noise reduction controls
      makeSectionHeading('Noise Reduction');
      makeToggleRow({
        label: 'Enable noise reduction',
        getter: ()=>fx.denoise.enabled,
        setter: (v)=>{ fx.denoise.enabled = v; }
      });
      makeSliderRow({
        label: 'Amount',
        min: 0,
        max: 1,
        step: 0.05,
        getter: ()=>fx.denoise.amount,
        setter: (v)=>{ fx.denoise.amount = v; },
        enabled: ()=>fx.denoise.enabled,
        format: (v)=>`${Math.round(v * 100)}%`
      });

      panel.addEventListener('mousedown', e=>e.stopPropagation());
      panel.addEventListener('click', e=>e.stopPropagation());
      menu.appendChild(panel);
      toggleRefreshers.forEach(fn=>fn());
      sliderRefreshers.forEach(fn=>fn());
      menu._refit?.();
    });
    menu.appendChild(fxBtn);
  }

  // --- Background transitions (fade only) ---
  if (bg) {
    const fxBtn = document.createElement('button');
    fxBtn.textContent = 'Background Effects...';
    fxBtn.disabled = clipLocked;
    fxBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      closeMenu();
      if (bg) void editFxForClip(bg, 'bg');
    });
    menu.appendChild(fxBtn);

    const hrT = document.createElement('hr'); hrT.style.margin = '6px 0'; menu.appendChild(hrT);

    function uiBgTransition(which) {
      if (menu.querySelector(`.bg-trans-${which}`)) return;
      const row = document.createElement('div');
      row.className = `bg-trans-${which}`;
      row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 4px;flex-wrap:wrap;';

      const label = document.createElement('span');
      label.textContent = which==='in' ? 'Background In:' : 'Background Out:';

      const sel = document.createElement('select');
      sel.style.cssText = 'min-width:160px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';
      const optionDefs = (which === 'in')
        ? [
            { value: 'none', label: '(none)' },
            { value: 'fade', label: 'Fade from black' },
            { value: 'fade-white', label: 'Fade from white' },
            { value: 'slide-left', label: 'Slide in from left' },
            { value: 'slide-right', label: 'Slide in from right' },
            { value: 'slide-up', label: 'Slide in from top' },
            { value: 'slide-down', label: 'Slide in from bottom' },
          ]
        : [
            { value: 'none', label: '(none)' },
            { value: 'fade', label: 'Fade to black' },
            { value: 'fade-white', label: 'Fade to white' },
            { value: 'slide-left', label: 'Slide out to left' },
            { value: 'slide-right', label: 'Slide out to right' },
            { value: 'slide-up', label: 'Slide out to top' },
            { value: 'slide-down', label: 'Slide out to bottom' },
          ];
      optionDefs.forEach(({ value, label }) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
      });

      const dur = document.createElement('input');
      dur.type='number'; dur.min='50'; dur.step='50';
      dur.value = String(which==='in' ? (bg.transIn?.dur||300) : (bg.transOut?.dur||300));
      dur.style.cssText = 'width:90px;background:#12161b;border:1px solid #2a2f36;color:#ddd;border-radius:6px;padding:4px 6px;';

      sel.value = which==='in' ? (bg.transIn?.type||'none') : (bg.transOut?.type||'none');

      const apply = document.createElement('button'); apply.textContent='Set';
      apply.onclick = () => {
        pushHistory('set-bg-transition');
        const t = sel.value;
        const d = Math.max(50, parseInt(dur.value,10) || 300);
        if (t==='none') {
          if (which==='in') bg.transIn=null; else bg.transOut=null;
        } else {
          const obj = { type:t, dur:d };
          if (which==='in') bg.transIn=obj; else bg.transOut=obj;
        }
        closeMenu(); renderTimeline(); applyBackgroundForTime(currentTime);
        scheduleAutosave('bg-transition-set');
      };

      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.onclick = () => {
        pushHistory('remove-bg-transition');
        if (which==='in') bg.transIn=null; else bg.transOut=null;
        closeMenu(); renderTimeline(); applyBackgroundForTime(currentTime);
        scheduleAutosave('bg-transition-remove');
      };

      row.append(label, sel, dur, apply, remove);
      menu.appendChild(row);
      menu._refit?.();
    }

    const bgInBtn = document.createElement('button');
    bgInBtn.textContent = 'Background Transition In...';
    bgInBtn.onclick = ()=> uiBgTransition('in');
    menu.appendChild(bgInBtn);

    const bgOutBtn = document.createElement('button');
    bgOutBtn.textContent = 'Background Transition Out...';
    bgOutBtn.onclick = ()=> uiBgTransition('out');
    menu.appendChild(bgOutBtn);
  }

  // --- Split / Trim ---
  const tNow = Math.round(currentTime);
  let cStart, cEndEff;
  if (it) { cStart = it.start; cEndEff = it.end; }
  else if (au) { cStart = au.start; cEndEff = au.end; }
  else if (tx) { cStart = tx.start ?? 0; cEndEff = effectiveTextEnd(tx); }
  else { const bgRef = (PROJECT.bgClips||[]).find(b=>b.id===id); cStart = bgRef?.start ?? 0; cEndEff = bgRef ? effectiveEnd(bgRef) : timelineViewportEnd(); }

  const canSplit = (tNow > cStart && tNow < (cEndEff ?? timelineViewportEnd()));
  const canTrimBefore = (tNow > cStart);
  const canTrimAfter  = (tNow < (cEndEff ?? timelineViewportEnd()));

  const hrSplit = document.createElement('hr'); hrSplit.style.margin = '6px 0'; menu.appendChild(hrSplit);

  const splitBtn = document.createElement('button');
  splitBtn.textContent = 'Split at playhead';
  splitBtn.disabled = !canSplit;
  splitBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); splitClipAtPlayhead(id); closeMenu(); });
  menu.appendChild(splitBtn);

  const trimBeforeBtn = document.createElement('button');
  trimBeforeBtn.textContent = 'Trim before playhead';
  trimBeforeBtn.disabled = !canTrimBefore;
  trimBeforeBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); trimBeforePlayhead(id); closeMenu(); });
  menu.appendChild(trimBeforeBtn);

  const trimAfterBtn = document.createElement('button');
  trimAfterBtn.textContent = 'Trim after playhead';
  trimAfterBtn.disabled = !canTrimAfter;
  trimAfterBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); trimAfterPlayhead(id); closeMenu(); });
  menu.appendChild(trimAfterBtn);

  // Delete
  const hr = document.createElement('hr'); hr.style.margin = '6px 0'; menu.appendChild(hr);
  const delClip = document.createElement('button');
  delClip.textContent = 'Remove from timeline';
  delClip.style.color = '#c0392b';
  delClip.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    if (!_pendingHistorySnapshot) pushHistory('delete'); // record undo step
    deleteItemById(id);
    updateClipSelectionStyles(); // tidy selection after removal
    closeMenu();
  });
  menu.appendChild(delClip);

  const delClipRipple = document.createElement('button');
  delClipRipple.textContent = 'Remove from timeline with ripple';
  delClipRipple.style.color = '#c0392b';
  delClipRipple.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    rippleDeleteClip(id);
    updateClipSelectionStyles();
    closeMenu();
  });
  menu.appendChild(delClipRipple);

  if (clipLocked || trackLocked) {
    menu.querySelectorAll('button').forEach(btn => {
      if (btn === lockBtn) return;
      btn.disabled = true;
    });
    menu.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
  }

  attachAndFitMenu(menu, x, y);
}


// Build (or rebuild) keyframe ticks into a visual clip
function renderKeyframeTicks(clipEl, item, tr) {
  clipEl.querySelectorAll('.kf-tick').forEach(n=>n.remove());
  if (!item?.keyframes?.length) return;

  for (const k of item.keyframes) {
    if (k.t < tr.start || k.t > tr.end) continue;
    const tick = document.createElement('div');
    tick.className = 'kf-tick';
    tick.dataset.kfTime = String(k.t);
    tick.dataset.itemId = item.id;
    const leftPx = timeToPx(k.t - tr.start);
    tick.style.cssText = `
      position:absolute; top:0; height:100%;
      width:6px; transform:translateX(-3px);
      left:${leftPx}px; background:#ff4757; border-radius:2px; cursor:pointer;
      box-shadow:0 0 0 1px rgba(0,0,0,.25) inset;
    `;
    if (selectedKeyframe && selectedKeyframe.itemId === item.id && approxEqual(selectedKeyframe.t, k.t)) {
      tick.classList.add('selected');
    }
    tick.title = `Keyframe @ ${msToLabel(k.t)}s\nTip: Alt-click to delete`;

    tick.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev.altKey || ev.metaKey) {
        if (isClipLocked(item.id)) return;
        pushHistory('delete-keyframe');
        const it2 = PROJECT.items.find(i=>i.id===item.id);
        deleteKeyframe(it2, k.t);
        clearSelectedKeyframe();
        renderTimeline();
        refreshStageVisibility();
        drawPlayhead();
        renderActiveGifs();
        applyBackgroundForTime(currentTime);
        scheduleAutosave('add-keyframe');
      } else {
        selectClip(item.id);
        selectItem(item.id);
        scheduleAutosave('drop-visual');
        setSelectedKeyframe(item.id, k.t);
        currentTime = clamp(k.t, 0, timelineViewportEnd());
        drawPlayhead();
        refreshStageVisibility();
        renderActiveGifs();
        applyBackgroundForTime(currentTime);
        scheduleAutosave('delete-keyframe');
      }
    });

    clipEl.appendChild(tick);
  }
}

// Remove a clip (visual or audio or bg)
function deleteItemById(id, opts = {}) {
  const { skipRefresh = false } = opts || {};
  if (isClipLocked(id)) return;
  const visIndex = PROJECT.items.findIndex(i=>i.id===id);
  if (visIndex !== -1) {
    const vis = PROJECT.items[visIndex];
    detachWeldChildren(id, { preserveWorld: true });
    const el = document.querySelector(`.stage-item[data-id="${id}"]`);
    if (el) el.remove();
    disposeFxFilter(vis);
    PROJECT.items.splice(visIndex, 1);
  }
  const txIdx = PROJECT.text.findIndex(t=>t.id===id);
  if (txIdx !== -1) {
    const tx = PROJECT.text[txIdx];
    const el = document.querySelector(`.stage-item[data-id="${id}"]`);
    if (el) el.remove();
    if (tx && tx._el) {
      try { tx._el.remove(); } catch {}
      tx._el = null;
    }
    PROJECT.text.splice(txIdx,1);
  }
  const auIndex = PROJECT.audio.findIndex(a=>a.id===id);
  if (auIndex !== -1) {
    const au = PROJECT.audio[auIndex];
    const trackIdx = au?.trackIndex ?? 0;
    try { au?._el?.pause(); } catch {}
    PROJECT.audio.splice(auIndex, 1);
    normalizeAudioCrossfadesForTrack(trackIdx);
  }
  const bi = (PROJECT.bgClips||[]).findIndex(b=>b.id===id);
  if (bi !== -1) {
    const [bgClip] = PROJECT.bgClips.splice(bi,1);
    if (bgClip) disposeFxFilter(bgClip);
  }

  if (selectedItemId === id) selectedItemId = null;
  if (selectedClipId === id) selectedClipId = null;
  if (selectedTextId === id) selectedTextId = null;
  if (selectedKeyframe && selectedKeyframe.itemId === id) clearSelectedKeyframe();
  if (selectedClipIds?.has?.(id)) selectedClipIds.delete(id);

  if (!skipRefresh) {
    renderTimeline();
    refreshStageVisibility();
    drawPlayhead();
    applyBackgroundForTime(currentTime);
    scheduleAutosave('delete-item');
  }
}

function rippleDeleteClip(id) {
  if (!id) return;
  if (isClipLocked(id)) return;
  const model = getClipModel(id);
  if (!model) return;

  const kind = model.kind;
  const trackIndex = Number.isFinite(model.trackIndex) ? model.trackIndex : 0;
  const start = Math.max(0, Math.round(Number(model.start ?? 0)));
  const end = Math.max(start, Math.round(Number(model.end ?? start)));
  const shiftMs = Math.max(0, end - start);

  if (!_pendingHistorySnapshot) pushHistory('delete-ripple');

  deleteItemById(id, { skipRefresh: true });

  if (shiftMs > 0) {
    let list = [];
    if (kind === 'visual') list = PROJECT.items;
    else if (kind === 'audio') list = PROJECT.audio;
    else if (kind === 'text') list = PROJECT.text;
    else if (kind === 'bg') list = PROJECT.bgClips || [];

    const originalEnd = end;
    for (const clip of list || []) {
      if (!clip) continue;
      const clipTrack = Number.isFinite(clip.trackIndex) ? clip.trackIndex : 0;
      if (clipTrack !== trackIndex) continue;
      const clipStart = Math.round(Number(clip.start ?? 0));
      if (clipStart < originalEnd) continue;

      const newStart = Math.max(0, clipStart - shiftMs);
      clip.start = newStart;

      if (clip.end != null && Number.isFinite(clip.end)) {
        const newEnd = Math.max(newStart + 50, Math.round(clip.end - shiftMs));
        clip.end = newEnd;
      } else if (clip.end == null && Number.isFinite(clip.duration)) {
        const dur = Math.max(10, Math.round(clip.duration));
        clip.end = newStart + dur;
      }

      if (Array.isArray(clip.keyframes)) {
        for (const kf of clip.keyframes) {
          if (!Number.isFinite(kf.t)) continue;
          kf.t = Math.max(0, Math.round(kf.t - shiftMs));
        }
      }
    }

    if (kind === 'audio') {
      normalizeAudioCrossfadesForTrack(trackIndex);
    }
  }

  currentTime = clamp(currentTime, 0, timelineViewportEnd());
  renderTimeline();
  refreshStageVisibility();
  drawPlayhead();
  applyBackgroundForTime(currentTime);
  scheduleAutosave('delete-item');
}

// ---------- Drag/Resize with snapping, no-overlap, and audio bounds ----------
function makeClipInteractive(clip) {
  let state = null;
  const kindOf = clip.dataset.type; // 'visual' | 'audio' | 'bg' | 'text'

  clip.addEventListener('mousedown', (e)=>{
    if (e.button !== 0) return;
    e.stopPropagation();

    const isLeft = e.target.classList.contains('left');
    const isRight = e.target.classList.contains('right');
    const isHandle = isLeft || isRight;

    // Selection behavior first
    const id = clip.dataset.id;
    if (e.ctrlKey || e.metaKey) {
      selectClip(id, { toggle:true });
    } else if (!clip.classList.contains('selected')) {
      selectClip(id);
    }

    const selIds = [...selectedClipIds];
    if (selIds.some(isClipLocked)) return;

    // Prepare history snapshot at drag start
    _pendingHistorySnapshot = snapshotProject();

    const startPx = parseFloat(clip.style.left) || 0;
    const widthPx = parseFloat(clip.style.width) || 0;
    const type = isLeft ? 'resize-left' : isRight ? 'resize-right' : 'move';
    state = { type, mx:e.clientX, my:e.clientY, startPx, widthPx, movedY:false, lastY:e.clientY, changed:false };

    // For group move, cache initial positions (ms) of all selected clips
    const selModels = selIds.map(getClipModel).filter(Boolean);
    const initial = selModels.map(m => ({ id:m.id, kind:m.kind, start:m.start, end:m.end, trackIndex:m.trackIndex }));
    const primary = initial.find(m => m.id === clip.dataset.id) || initial[0];
    const initialById = new Map(initial.map(m => [m.id, m]));

    const onMove = (ev)=>{
      const dx = ev.clientX - state.mx;
      state.lastY = ev.clientY;

      if (state.type === 'move') {
        // Convert dx px -> dt ms
        let dt = Math.round(pxToMs(dx));

        // Clamp dt to avoid overlapping with non-selected on same track
        dt = clampGroupDelta(initial, dt);

        if (primary) {
          const desiredStart = primary.start + dt;
          const snapTargets = snapCandidates(primary.kind, primary.id);
          const snapped = findSnap(desiredStart, snapTargets);
          if (snapped != null) {
            dt = clampGroupDelta(initial, snapped - primary.start);
          }
        }

        // Apply to each selected clip
        for (const m of initial) {
          const mEnd = (m.end != null) ? m.end : (typeof effectiveEnd === 'function' ? effectiveEnd(m) : (m.start + 100));
          const newStart = Math.max(0, m.start + dt);
          const dur = Math.max(10, mEnd - m.start);
          const newEnd = Math.max(newStart + dur, newStart + 10);
          setClipTimes(m.id, m.kind, newStart, newEnd);
        }

        // update visuals as we drag
        for (const id of selIds) {
          const el = $(`.clip[data-id="${id}"]`);
          if (!el) continue;
          const model = getClipModel(id);
          const w = Math.max(10, timeToPx(model.end - model.start));
          el.style.left = `${timeToPx(model.start)}px`;
          el.style.width = `${w}px`;
        }
        drawPlayhead();
        refreshStageVisibility();
        if (!state.changed) {
          for (const id of selIds) {
            const baseline = initialById.get(id);
            if (!baseline) continue;
            const model = getClipModel(id);
            if (!model) continue;
            if (Math.round(model.start) !== Math.round(baseline.start)
              || Math.round(model.end) !== Math.round(baseline.end)) {
              state.changed = true;
              break;
            }
          }
        }

        if (Math.abs(ev.clientY - state.my) > 6) state.movedY = true;

      } else if (state.type === 'resize-left') {
        const rightPx = state.startPx + state.widthPx;
        let newLeft = Math.max(0, Math.min(rightPx - 10, state.startPx + dx));
        let newWidth = rightPx - newLeft;

        const ref = getClipRefById(clip.dataset.id);
        if (ref) {
          const snapTargets = snapCandidates(ref.kind, clip.dataset.id);
          const snappedMs = findSnap(pxToMs(newLeft), snapTargets);
          if (snappedMs != null) {
            const snappedLeftPx = timeToPx(snappedMs);
            const snappedWidthPx = rightPx - snappedLeftPx;
            if (snappedLeftPx >= 0 && snappedWidthPx >= 10) {
              newLeft = snappedLeftPx;
              newWidth = snappedWidthPx;
            }
          }
        }

        clip.style.left = `${newLeft}px`;
        clip.style.width = `${newWidth}px`;
        syncClipToModel(clip);
        if (!state.changed) {
          const baseline = initialById.get(clip.dataset.id);
          const model = getClipModel(clip.dataset.id);
          if (baseline && model) {
            if (Math.round(model.start) !== Math.round(baseline.start)
              || Math.round(model.end) !== Math.round(baseline.end)) {
              state.changed = true;
            }
          }
        }

        // ensure text clips have a concrete end after resize
        if (clip.dataset.type === 'text') {
          const t = PROJECT.text.find(x=>x.id===clip.dataset.id);
          if (t) {
            const startMs = pxToMs(newLeft);
            const endMs = pxToMs(newLeft + newWidth);
            t.start = Math.max(0, Math.round(startMs));
            t.end = Math.max(t.start + 10, Math.round(endMs));
          }
        }

        const item = PROJECT.items.find(i=>i.id===clip.dataset.id);
        if (item && clip.dataset.type==='visual') renderKeyframeTicks(clip, item, { start:item.start, end:item.end });
        drawPlayhead();
        refreshStageVisibility();

      } else if (state.type === 'resize-right') {
        const startPxNow = parseFloat(clip.style.left) || state.startPx;
        let newWidth = Math.max(10, state.widthPx + dx);

        const ref = getClipRefById(clip.dataset.id);
        if (ref) {
          const snapTargets = snapCandidates(ref.kind, clip.dataset.id);
          const snappedMs = findSnap(pxToMs(startPxNow + newWidth), snapTargets);
          if (snappedMs != null) {
            const snappedWidthPx = timeToPx(snappedMs) - startPxNow;
            if (snappedWidthPx >= 10) newWidth = snappedWidthPx;
          }
        }

        clip.style.width = `${newWidth}px`;
        syncClipToModel(clip);
        if (!state.changed) {
          const baseline = initialById.get(clip.dataset.id);
          const model = getClipModel(clip.dataset.id);
          if (baseline && model) {
            if (Math.round(model.start) !== Math.round(baseline.start)
              || Math.round(model.end) !== Math.round(baseline.end)) {
              state.changed = true;
            }
          }
        }

        // ensure text clips have a concrete end after resize
        if (clip.dataset.type === 'text') {
          const t = PROJECT.text.find(x=>x.id===clip.dataset.id);
          if (t) {
            const endMs = pxToMs(startPxNow + newWidth);
            t.end = Math.max((t.start ?? 0) + 10, Math.round(endMs));
          }
        }

        const item = PROJECT.items.find(i=>i.id===clip.dataset.id);
        if (item && clip.dataset.type==='visual') renderKeyframeTicks(clip, item, { start:item.start, end:item.end });
        drawPlayhead();
        refreshStageVisibility();
      }
    };

    const onUp = ()=>{
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);

      // vertical cross-track move (only when dragging a single)
      if (state?.type === 'move' && state.movedY && selectedClipIds.size === 1) {
        const hit = rowAtY(state.lastY);
        const srcId = clip.dataset.id;
        if (hit && !isTrackLocked(hit.kind, hit.trackIndex)) {
          if (hit.kind === 'visual' && clip.dataset.type==='visual') {
            const it = PROJECT.items.find(i=>i.id===srcId);
            if (it) it.trackIndex = hit.trackIndex;
            normalizeTrackIndices('visual');
            const baseline = initialById.get(srcId);
            if (baseline && baseline.trackIndex !== hit.trackIndex) state.changed = true;
          } else if (hit.kind === 'audio' && clip.dataset.type==='audio') {
            const au = PROJECT.audio.find(a=>a.id===srcId);
            if (au) {
              const prevTrack = au.trackIndex ?? 0;
              au.trackIndex = hit.trackIndex;
              normalizeTrackIndices('audio');
              if (prevTrack !== hit.trackIndex) {
                normalizeAudioCrossfadesForTrack(prevTrack);
                normalizeAudioCrossfadesForTrack(hit.trackIndex);
                state.changed = true;
              }
            }
          } else if (hit.kind === 'text' && clip.dataset.type==='text') {
            const tx = PROJECT.text.find(t=>t.id===srcId);
            if (tx) tx.trackIndex = hit.trackIndex;
            normalizeTrackIndices('text');
            const baseline = initialById.get(srcId);
            if (baseline && baseline.trackIndex !== hit.trackIndex) state.changed = true;
          }
        }
      }

      renderTimeline();
      refreshStageVisibility();
      drawPlayhead();

      // Commit history entry if we started from snapshot
      if (_pendingHistorySnapshot) {
        if (state?.changed) {
          const historyLabel = (state?.type === 'move')
            ? 'clip-move'
            : ((state?.type === 'resize-left' || state?.type === 'resize-right') ? 'clip-resize' : 'clip-transform');
          pushHistoryWithSnapshot(_pendingHistorySnapshot, historyLabel);
          scheduleAutosave('pushHistory:'+historyLabel);
        }
        _pendingHistorySnapshot = null;
      }
      state = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // keep context menu
  clip.addEventListener('auxclick', (e)=>{ if (e.button !== 0) e.preventDefault(); });
  clip.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    e.stopPropagation();
    showClipMenu(e.clientX, e.clientY, clip.dataset.id);
  });
}


// Helpers used above
function getClipModel(id) {
  const it = PROJECT.items.find(i=>i.id===id);
  if (it) return { id:it.id, kind:'visual', start:it.start, end:it.end, trackIndex:it.trackIndex };
  const tx = PROJECT.text.find(t=>t.id===id);
  if (tx) return { id:tx.id, kind:'text', start:tx.start, end:(tx.end ?? (tx.start+tx.duration)), trackIndex:tx.trackIndex };
  const au = PROJECT.audio.find(a=>a.id===id);
  if (au) return { id:au.id, kind:'audio', start:au.start, end:au.end, trackIndex:au.trackIndex };
  const bg = (PROJECT.bgClips||[]).find(b=>b.id===id);
  if (bg) return { id:bg.id, kind:'bg', start:bg.start, end:(bg.end ?? timelineViewportEnd()), trackIndex:0 };
  return null;
}
function setClipTimes(id, kind, start, end) {
  if (kind==='visual') { const it = PROJECT.items.find(i=>i.id===id); if (it){ it.start=start; it.end=end; } }
  else if (kind==='text') { const tx = PROJECT.text.find(t=>t.id===id); if (tx){ tx.start=start; tx.end=end; } }
  else if (kind==='audio') { const au = PROJECT.audio.find(a=>a.id===id); if (au){ au.start=start; au.end=end; } }
  else if (kind==='bg') { const bg = (PROJECT.bgClips||[]).find(b=>b.id===id); if (bg){ bg.start=start; bg.end=end; } }
}

// Prevent group overlap with non-selected neighbors on same track
function clampGroupDelta(initialList, dt) {
  // Build lookup of non-selected clips per track/kind
  const selIds = new Set(initialList.map(m=>m.id));
  function neighbors(kind, trackIndex) {
    if (kind==='visual') return PROJECT.items.filter(i=>i.trackIndex===trackIndex && !selIds.has(i.id))
      .map(i=>({start:i.start, end:i.end}));
    if (kind==='text') return PROJECT.text.filter(t=>t.trackIndex===trackIndex && !selIds.has(t.id))
      .map(t=>({start:t.start, end:(t.end ?? (t.start+t.duration))}));
    if (kind==='audio') return PROJECT.audio.filter(a=>a.trackIndex===trackIndex && !selIds.has(a.id))
      .map(a=>({start:a.start, end:a.end}));
    if (kind==='bg') return (PROJECT.bgClips||[]).filter(b=>!selIds.has(b.id)).map(b=>({start:b.start, end:(b.end??timelineViewportEnd())}));
    return [];
  }
  let minDt = dt, maxDt = dt;
  for (const m of initialList) {
    const others = neighbors(m.kind, m.trackIndex).sort((a,b)=>a.start-b.start);
    // Find nearest blockers around [start+dt, end+dt]
    const leftBlock  = others.filter(o=>o.end <= m.start).pop();
    const rightBlock = others.find(o=>o.start >= m.end);
    if (leftBlock) {
      // start+dt >= leftBlock.end  => dt >= leftBlock.end - start
      const minAllowed = leftBlock.end - m.start;
      if (minDt < minAllowed) minDt = Math.max(minDt, minAllowed);
    }
    if (rightBlock) {
      // end+dt <= rightBlock.start => dt <= rightBlock.start - end
      const maxAllowed = rightBlock.start - m.end;
      if (maxDt > maxAllowed) maxDt = Math.min(maxDt, maxAllowed);
    }
  }
  return clamp(dt, minDt, maxDt);
}


function syncClipToModel(clip) {
  const id = clip.dataset.id;
  const leftMs = parseFloat(clip.style.left) / pxPerSecond * 1000;
  const durMs  = parseFloat(clip.style.width) / pxPerSecond * 1000;
  let start = Math.round(leftMs);
  let end   = Math.round(leftMs + durMs);

  start = Math.max(0, start);
  end   = Math.max(start + 50, end);

  const ref = getClipRefById(id);
  if (ref) {
    const kind = ref.kind;
    const bounds = noOverlapBounds(kind, ref.ref.trackIndex ?? 0, id);
    start = clamp(start, bounds.minStart, Number.isFinite(bounds.maxEnd) ? bounds.maxEnd - 50 : start);
    if (Number.isFinite(bounds.maxEnd)) end = clamp(end, start + 50, bounds.maxEnd);

    if (kind === 'audio') {
      const au = ref.ref;
      if (au.srcDurationMs) {
        const allowed = getAudioAllowedDurMs(au);
        const cur = end - start;
        if (cur > allowed) end = start + allowed;
      }
    }
  }

  const vis = PROJECT.items.find(i=>i.id===id);
  if (vis) { vis.start = start; vis.end = end; positionStageItem(vis); }
  const au = PROJECT.audio.find(a=>a.id===id);
  if (au) { au.start = start; au.end = end;
    const canvas = $(`.clip[data-id="${id}"] canvas.waveform`);
    if (canvas) paintAudioWaveOnCanvas(canvas, au, null, null, null);
    normalizeAudioCrossfadesAround(au);
    const neigh = neighborsOnSameTrack('audio', au.trackIndex ?? 0, au.id);
    if (neigh.prev) normalizeAudioCrossfadesAround(neigh.prev);
    if (neigh.next) normalizeAudioCrossfadesAround(neigh.next);
  }

  const bg = (PROJECT.bgClips||[]).find(b=>b.id===id);
  if (bg) { bg.start = start; bg.end = end; }
}

// ---------- Playback ----------
function play() {
  if (playing) return;
  const ac = getAudioCtx();
  if (ac && typeof ac.resume === 'function' && ac.state === 'suspended') {
    ac.resume().catch(()=>{});
  }
  const masterVolume = clamp(previewVolume, 0, 1);
  for (const au of PROJECT.audio) {
    if (!au?._el) continue;
    try { au._el.muted = !!au.muted; } catch {}
    try { au._el.volume = masterVolume; } catch {}
    au._needsSeek = true;
    au._prePrimed = false;
  }
  for (const it of PROJECT.items) {
    if (!isVideoClip(it)) continue;
    it._videoNeedsSeek = true;
    it._videoPlaying = false;
  }
  playing = true;
  t0 = performance.now() - currentTime;
  if (playheadRAF) cancelAnimationFrame(playheadRAF);
  driveAudios();
  driveVideos();
  const step = (ts) => {
    if (!playing) return;
    const endCap = timelineViewportEnd();
    currentTime = clamp(ts - t0, 0, endCap);
    drawPlayhead();
    refreshStageVisibility();
    renderActiveGifs();
    driveAudios();
    applyBackgroundForTime(currentTime);
    if (currentTime >= endCap) { stop(); return; }
    playheadRAF = requestAnimationFrame(step);
  };
  playheadRAF = requestAnimationFrame(step);
  updateFullscreenPlaybackUI();
}

function pause() {
  if (!playing) return;
  playing = false;
  if (playheadRAF) { cancelAnimationFrame(playheadRAF); playheadRAF = null; }
  stopAllAudios({ pauseOnly: true });
  stopAllVideos({ pauseOnly: true });
  drawPlayhead();
  refreshStageVisibility();
  renderActiveGifs();
  applyBackgroundForTime(currentTime);
  updateFullscreenPlaybackUI();
}

function stop() {
  playing = false;
  if (playheadRAF) { cancelAnimationFrame(playheadRAF); playheadRAF = null; }
  stopAllAudios({ pauseOnly: false });
  stopAllVideos({ pauseOnly: false });
  for (const au of PROJECT.audio) {
    if (au) {
      au._needsSeek = true;
      au._prePrimed = false;
    }
  }
  for (const it of PROJECT.items) {
    if (!isVideoClip(it)) continue;
    it._videoNeedsSeek = true;
    it._videoPlaying = false;
  }
  currentTime = 0;
  drawPlayhead();
  refreshStageVisibility();
  renderActiveGifs();
  applyBackgroundForTime(currentTime);
  updateFullscreenPlaybackUI();
}

function tick() {
  if (!playing) return;
  const now = performance.now();
  const endCap = timelineViewportEnd();
  const elapsed = now - t0;
  const q = Math.round(elapsed / FRAME_MS) * FRAME_MS;
  currentTime = clamp(q, 0, endCap);

  drawPlayhead();
  refreshStageVisibility();
  renderActiveGifs();
  driveAudios();
  applyBackgroundForTime(currentTime);

  if (currentTime >= endCap) { stop(); return; }
  playheadRAF = requestAnimationFrame(tick);
}



// --- GIF: render currently-visible frames (supports WebCodecs + fallback) ---
function renderActiveGifs() {
  for (const it of PROJECT.items) {
    if (!isGifPath(it.path) || !it._gif) continue;

    const visible = currentTime >= (it.start ?? 0) && currentTime < (it.end ?? 0);
    const holder = document.querySelector(`.stage-item[data-id="${it.id}"]`);
    const canvas = holder?.querySelector('canvas[data-role="gif-canvas"]');
    if (!canvas || !visible) continue;

    const ctx = canvas.getContext('2d');
    const mode = it.loopMode ?? (it.loop === false ? 'once' : 'infinite');
    const tInto = currentTime - (it.start ?? 0);

    if (it._gif.mode === 'decoder' && it._gif.frames) {
      const total = it._gif.totalDur || 1000;
      let animT;

      if (mode === 'infinite') {
        animT = (tInto % total + total) % total;
      } else if (mode === 'once') {
        animT = Math.min(Math.max(0, tInto), total - 1);
      } else if (mode === 'count') {
        const n = Math.max(1, Math.floor(it.loopCount ?? 1));
        const limit = total * n;
        animT = Math.min(Math.max(0, tInto), limit - 1) % total;
      } else {
        animT = (tInto % total + total) % total;
      }

      const frames = it._gif.frames;
      const lastIdx = frames.length - 1;
      let f = frames[0];
      let frameIndex = 0;
      for (let i = 0; i < frames.length; i++) {
        const a = frames[i].at;
        const b = (i < lastIdx) ? frames[i + 1].at : total;
        if (animT >= a && animT < b) { f = frames[i]; frameIndex = frames[i].index ?? i; break; }
      }
      const maskOpts = { frameKey: maskFrameKeyForGif(frameIndex) };
      drawBitmapToCanvas(ctx, f, it, maskOpts);
    } else if (it._gif.mode === 'mirror' && it._gif.img) {
      // already painted in fallback; nothing to advance per-frame
    }
  }
}

function driveVideos() {
  for (const it of PROJECT.items) {
    if (!isVideoClip(it)) continue;
    const video = it._videoEl;
    if (!(video instanceof HTMLVideoElement)) continue;
    if (!it._videoReady && video.readyState < 1) continue;
    const windowStart = it.start ?? 0;
    const windowEnd = it.end ?? windowStart;
    const duration = it._videoDurationMs && it._videoDurationMs > 0
      ? it._videoDurationMs
      : Math.max(0, windowEnd - windowStart);
    const loopMode = it.loopMode || (it.loop === false ? 'once' : 'infinite');
    const relMs = currentTime - windowStart;
    let targetMs;
    if (duration > 0) {
      if (loopMode === 'infinite') {
        targetMs = ((relMs % duration) + duration) % duration;
      } else if (loopMode === 'count') {
        const n = Math.max(1, Math.floor(it.loopCount ?? 1));
        const limit = duration * n;
        const clamped = clamp(relMs, 0, limit);
        targetMs = ((clamped % duration) + duration) % duration;
      } else {
        targetMs = clamp(relMs, 0, duration);
      }
    } else {
      targetMs = Math.max(0, relMs);
    }

    const targetSec = targetMs / 1000;
    const inWindow = currentTime >= windowStart && currentTime < windowEnd;
    const preWindowStart = Math.max(0, windowStart - VIDEO_PREROLL_MS);
    const preWindow = currentTime >= preWindowStart && currentTime < windowEnd;

    if (!playing) {
      if (isFinite(targetSec) && Math.abs((video.currentTime || 0) - targetSec) > 0.02) {
        try { video.currentTime = targetSec; } catch {}
      }
      try { video.pause(); } catch {}
      it._videoPlaying = false;
      it._videoNeedsSeek = true;
      continue;
    }

    if (!preWindow) {
      if (isFinite(targetSec) && Math.abs((video.currentTime || 0) - targetSec) > 0.08) {
        try { video.currentTime = targetSec; } catch {}
      }
      if (it._videoPlaying) {
        try { video.pause(); } catch {}
        it._videoPlaying = false;
      }
      it._videoNeedsSeek = true;
      continue;
    }

    if (it._videoNeedsSeek && isFinite(targetSec)) {
      try { video.currentTime = targetSec; } catch {}
      it._videoNeedsSeek = false;
    } else if (isFinite(targetSec) && Math.abs((video.currentTime || 0) - targetSec) > 0.12) {
      try { video.currentTime = targetSec; } catch {}
    }

    try { video.muted = true; } catch {}

    if (inWindow) {
      if (!it._videoPlaying) {
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(()=>{});
        it._videoPlaying = true;
      }
    } else if (it._videoPlaying) {
      try { video.pause(); } catch {}
      it._videoPlaying = false;
    }
  }
}


// ---------- Playback ----------
function stopAllAudios({ pauseOnly = false } = {}) {
  for (const au of PROJECT.audio) {
    if (!au?._el) continue;
    try {
      au._el.pause();
      if (!pauseOnly) au._el.currentTime = 0;
    } catch {}
  }
}


function refreshStageVisibility() {
  for (const it of PROJECT.items) positionStageItem(it);
  for (const t of PROJECT.text) positionTextItem(t);
  renderSubtitlePreviewOverlay();
  updateStageSizePanel();
  driveVideos();
}


// --- add these helpers (used by play/pause/stop) if missing ---
function stopAllAudios({ pauseOnly = false } = {}) {
  for (const au of PROJECT.audio) {
    if (!au._el) continue;
    try {
      au._el.pause();
      if (!pauseOnly) au._el.currentTime = 0;
    } catch {}
  }
}

// --- AUDIO: drive playback each tick (called from tick()) ---
function driveAudios(nowMs) {
  const masterVolume = clamp(previewVolume, 0, 1);
  for (const au of PROJECT.audio) {
    // lazy graph build
    ensureMediaGraph(au);
    const el = au._el;
    if (!el) continue;
    const gainParam = au._gain?.gain ?? null;
    const hasGraph = !!gainParam;

    const rate = clamp(au.playbackRate || 1, 0.1, 4);
    const crossInMs = Math.max(0, au.crossfadePrevMs || 0);
    const crossOutMs = Math.max(0, au.crossfadeNextMs || 0);
    const windowStart = au.start ?? 0;
    const windowEnd = au.end ?? windowStart;
    const preWindowStart = Math.max(0, windowStart - AUDIO_PREROLL_MS);
    const inWindow = currentTime >= windowStart && currentTime < windowEnd;
    const preWindow = currentTime >= preWindowStart && currentTime < windowEnd;

    // choose correct source (forward vs reversed)
    const wantKey = au.reversed ? 'rev' : 'fwd';
    if (au._currentSrcKey !== wantKey) {
      if (!au.reversed) {
        el.src = fileUrl(au.path || '');
        au._currentSrcKey = 'fwd';
      } else if (au._revUrl) {
        el.src = au._revUrl;
        au._currentSrcKey = 'rev';
      } else {
        // kick off build; will swap once ready
        ensureReversedUrl(au).then((url)=>{
          if (url && au.reversed) {
            el.src = url;
            au._currentSrcKey = 'rev';
            au._needsSeek = true;
            au._prePrimed = false;
          }
        }).catch(()=>{});
      }
    }

    // playback rate
    try { el.playbackRate = rate; } catch {}

    const relMs = currentTime - windowStart;
    const targetSrcMs = Math.max(0,
      (au.mediaOffset || 0) + Math.max(0, relMs) * rate
    );

    // seek if needed or on first drive
    if (au._needsSeek && preWindow) {
      try { el.currentTime = targetSrcMs / 1000; } catch {}
      au._needsSeek = false;
      au._prePrimed = false;
    } else if (!au._needsSeek && preWindow) {
      const diff = Math.abs((el.currentTime || 0) * 1000 - targetSrcMs);
      if (diff > 10) {
        try { el.currentTime = targetSrcMs / 1000; } catch {}
      }
    }

    if (preWindow && !au._prePrimed) {
      const attempt = el.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(()=>{});
      }
      try { el.pause(); } catch {}
      au._prePrimed = true;
    }

    // envelope / volume
    let vol = au.muted ? 0 : clamp(au.volume ?? 1, 0, 1);
    const fi = Math.max(Math.max(0, (au.fadeInSec || 0) * 1000), crossInMs);
    const fo = Math.max(Math.max(0, (au.fadeOutSec || 0) * 1000), crossOutMs);
    if (inWindow) {
      const pos = currentTime - windowStart;
      const remain = windowEnd - currentTime;
      vol *= fadeInCurve(pos, fi) * fadeOutCurve(remain, fo);
    } else {
      vol = 0;
    }
    if (hasGraph) {
      gainParam.value = vol * masterVolume;
    } else {
      el.volume = vol * masterVolume;
    }

    const shouldPlay = inWindow;
    if (shouldPlay) {
      if (el.paused) { el.play().catch(()=>{}); }
    } else if (!el.paused) {
      try { el.pause(); } catch {}
      au._needsSeek = true;
      au._prePrimed = false;
    }
  }
}




function stopAllAudios({ pauseOnly = false } = {}) {
  for (const au of PROJECT.audio) {
    try {
      if (au?._el) {
        au._el.pause();
        if (!pauseOnly) {
          au._el.currentTime = 0;
        }
        au._needsSeek = true;
        au._prePrimed = false;
      }
    } catch {}
  }
}

function stopAllVideos({ pauseOnly = false } = {}) {
  for (const it of PROJECT.items) {
    if (!isVideoClip(it) || !(it._videoEl instanceof HTMLVideoElement)) continue;
    try {
      it._videoEl.pause();
      if (!pauseOnly) {
        try { it._videoEl.currentTime = 0; } catch {}
      }
    } catch {}
    it._videoPlaying = false;
    it._videoNeedsSeek = true;
  }
}


// ---------- Timeline scrubbing ----------
function onTimelineMouseDown(e) {
  if (e.button !== 0) return; // left only
  const tracks = $('#tracks');
  const rect = tracks.getBoundingClientRect();
  const totalWidth = timelineViewportEnd() / 1000 * pxPerSecond;

  const offsetX = e.clientX - rect.left + tracks.scrollLeft - (tracksPad + labelWidth + trackGap);
  const clampedPx = clamp(offsetX, 0, totalWidth);
  currentTime = clampedPx / pxPerSecond * 1000;

  if (playing) t0 = performance.now() - currentTime;
  markAllAudioNeedSeek({ pause: false });
  markAllVideosNeedSeek({ pause: false });

  drawPlayhead();
  refreshStageVisibility();
  renderActiveGifs();
  applyBackgroundForTime(currentTime);

  const onMove = (ev) => {
    const moveOffsetX = ev.clientX - rect.left + tracks.scrollLeft - (tracksPad + labelWidth + trackGap);
    const nx = clamp(moveOffsetX, 0, timelineViewportEnd() / 1000 * pxPerSecond);
    currentTime = nx / pxPerSecond * 1000;
    if (playing) t0 = performance.now() - currentTime;
    markAllAudioNeedSeek({ pause: false });
    markAllVideosNeedSeek({ pause: false });
    drawPlayhead();
    refreshStageVisibility();
    renderActiveGifs();
    applyBackgroundForTime(currentTime);
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}



