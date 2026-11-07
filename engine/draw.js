// Рендерер титров на Canvas 2D. Детерминированный: кадр зависит только от эпизода и времени t.
// Один и тот же код рисует предпросмотр в монтажной и кадры для MP4 на сервере.
import { MOODS, PERIODS, creditRows, dateLabel } from './episode.js';

export const DEFAULT_DURATION = 24;

const C = {
  hall: '#15120F',
  light: '#F1E9DA',
  dust: '#8E8576',
  role: '#A39985',
  axis: 'rgba(241,233,218,0.16)',
};
const F = {
  display: '"Forum", "Cormorant Garamond", Georgia, serif',
  mono: '"JetBrains Mono", Menlo, Consolas, monospace',
};

/**
 * Таймлайн ролика в секундах. Всё считается от общей длительности.
 * v1 — исходный; v2 — по разбору моушн-дизайнера GPT (7.11): ровно 1,5 с пустой темноты
 * между уходом титров и сценой после титров и 3,5 с полной видимости последней фразы.
 */
export function timeline(duration = DEFAULT_DURATION, variant = 'v1') {
  const d = Math.max(14, duration);
  if (variant === 'v2') {
    return {
      duration: d, variant,
      fadeIn: 0.8,
      titleHold: 3.2,
      rollEnd: d - 7.8,          // «Конец сцены» в центре
      endHold: 1.2,
      blackStart: d - 6.6,       // начало ухода титров
      sceneFade: 0.6,            // титры полностью ушли к d - 6.0
      postStart: d - 4.5,        // ровно 1,5 с пустой темноты
      postFadeIn: 0.5,           // полная видимость с d - 4.0 до d - 0.5 = 3,5 с
      fadeOut: 0.5,
    };
  }
  return {
    duration: d, variant: 'v1',
    fadeIn: 0.8,
    titleHold: 3.2,              // название стоит, титры ещё не поехали
    rollEnd: d - 6.2,            // «Конец сцены» доезжает до центра
    endHold: 1.3,                // пауза на «Конец сцены»
    blackStart: d - 4.9,         // уход в темноту
    sceneFade: 0.9,
    postStart: d - 3.4,          // сцена после титров
    postFadeIn: 0.7,
    fadeOut: 0.5,
  };
}

// Типографика строк: v1 — исходная; v2 — роли крупнее (≈10,7 px при показе шириной 320 px), значения ≈18 px.
export const TYPO = {
  v1: { role: 28, roleLh: 38, value: 54, valueLh: 60 },
  v2: { role: 34, roleLh: 44, value: 58, valueLh: 64 },
};

/**
 * Положение прокрутки 0..1. smooth — исходная S-кривая (в середине до 1,5× средней скорости);
 * linear — ровная скорость с короткими разгоном и торможением по краям (ramp — доля времени).
 */
export function rollPosition(u, ease = 'smooth', ramp = 0.08) {
  u = Math.min(1, Math.max(0, u));
  if (ease !== 'linear') return u * u * (3 - 2 * u);
  const r = Math.min(0.4, Math.max(0.001, ramp));
  const v = 1 / (1 - r);
  if (u < r) return (v * u * u) / (2 * r);
  if (u > 1 - r) return 1 - (v * (1 - u) * (1 - u)) / (2 * r);
  return v * (u - r / 2);
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function setFont(ctx, size, family, spacing = 0) {
  ctx.font = `${size}px ${family}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Зерно плёнки: заранее сгенерированная шумовая текстура, детерминированная по seed.
const grainCache = new Map();
function grainTile(size = 192) {
  if (grainCache.has(size)) return grainCache.get(size);
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  let s = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = s & 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  grainCache.set(size, c);
  return c;
}

/** Раскладка всех элементов ролика по вертикали в «бумажных» координатах (до прокрутки). */
let layoutCache = { key: '', value: null };
export function layout(ctx, ep, w, h, typo = 'v1') {
  const ty = TYPO[typo] || TYPO.v1;
  const key = `${typo}|${w}x${h}|${ep.period}|${ep.date}|${ep.title}|${ep.genre}|${ep.lead}|${ep.music}|`
    + JSON.stringify((ep.rows || []).map((r) => [r.role, r.value])) + `|${ep.post && ep.post.text}`;
  if (layoutCache.key === key) return layoutCache.value;

  const s = h / 1920;
  const axis = w / 2;
  const gap = 30 * s;
  const colW = w / 2 - gap - 70 * s;
  const items = [];
  let y = 0;
  const push = (it) => { items.push({ ...it, y }); y += it.h; };

  // Шапка: дата, название, жанр
  setFont(ctx, 26 * s, F.mono, 6 * s);
  push({ kind: 'label', text: `${PERIODS[ep.period] || 'титры'} · ${dateLabel(ep.date, ep.period)}`.toUpperCase(), size: 26 * s, h: 60 * s });
  setFont(ctx, 100 * s, F.display);
  const titleLines = wrap(ctx, `«${ep.title}»`, w - 160 * s);
  push({ kind: 'title', lines: titleLines, size: 100 * s, lh: 108 * s, h: titleLines.length * 108 * s + 26 * s });
  push({ kind: 'genre', text: `жанр: ${ep.genre}`.toUpperCase(), size: 28 * s, h: 40 * s });
  const titleBlockEnd = y;

  y += 170 * s;
  push({ kind: 'head', text: 'В РОЛЯХ', size: 26 * s, h: 80 * s });

  for (const row of creditRows(ep)) {
    setFont(ctx, ty.role * s, F.mono, 4 * s);
    const roleLines = wrap(ctx, row.role.toUpperCase(), colW);
    setFont(ctx, ty.value * s, F.display);
    const valueLines = wrap(ctx, row.value, colW);
    const lh = ty.valueLh * s;
    const rh = Math.max(valueLines.length * lh, roleLines.length * ty.roleLh * s);
    push({ kind: 'row', roleLines, valueLines, lh, axis, gap, ty, h: rh + 44 * s });
  }

  y += 160 * s;
  const endY = y;
  push({ kind: 'end', text: 'Конец сцены', size: 72 * s, h: 90 * s });

  setFont(ctx, 66 * s, F.display);
  const postLines = ep.post && ep.post.text ? wrap(ctx, ep.post.text, w - 200 * s) : [];

  const value = {
    key, s, items, postLines,
    titleCenter: titleBlockEnd / 2,
    endCenter: endY + 45 * s,
    total: y,
  };
  layoutCache = { key, value };
  return value;
}

function drawBackground(ctx, w, h, accent, t, opts) {
  ctx.fillStyle = C.hall;
  ctx.fillRect(0, 0, w, h);
  const breathe = opts.still ? 0 : Math.sin(t * 0.35) * 0.03;
  let g = ctx.createRadialGradient(w * 0.5, h * 0.74, 0, w * 0.5, h * 0.74, w * (0.95 + breathe));
  g.addColorStop(0, rgba(accent, 0.20));
  g.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  g = ctx.createRadialGradient(w * 0.18, h * 0.12, 0, w * 0.18, h * 0.12, w * 0.7);
  g.addColorStop(0, rgba(accent, 0.07));
  g.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawGrain(ctx, w, h, frame) {
  const tile = grainTile();
  ctx.save();
  ctx.globalAlpha = 0.045;
  ctx.globalCompositeOperation = 'screen';
  const ox = (frame * 37) % tile.width;
  const oy = (frame * 61) % tile.height;
  const pat = ctx.createPattern(tile, 'repeat');
  ctx.translate(-ox, -oy);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w + tile.width, h + tile.height);
  ctx.restore();
  // виньетка
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

function drawChrome(ctx, w, h, ep, s, alpha, opts) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.dust;
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 22 * s, F.mono, 6 * s);
  ctx.textAlign = 'left';
  ctx.fillText('ТИТРЫ', 64 * s, 104 * s);
  ctx.textAlign = 'right';
  ctx.fillText(dateLabel(ep.date, ep.period).toUpperCase(), w - 64 * s, 104 * s);
  ctx.textAlign = 'left';
  ctx.fillText((PERIODS[ep.period] || '').toUpperCase(), 64 * s, h - 84 * s);
  if (opts.watermark) {
    ctx.textAlign = 'right';
    ctx.fillText(String(opts.watermark).toUpperCase(), w - 64 * s, h - 84 * s);
  }
  ctx.restore();
}

function drawItems(ctx, w, h, L, offset, accent, baseAlpha = 1) {
  const s = L.s;
  const top = 150 * s;
  const bottom = h - 150 * s;
  for (const it of L.items) {
    const y = it.y + offset;
    if (y + it.h < top - 40 * s || y > bottom + 40 * s) continue;
    // мягкое затухание у краёв кадра, как маска у настоящих титров
    const mid = y + it.h / 2;
    const edge = Math.min(mid - top, bottom - mid);
    const a = clamp(edge / (150 * s));
    if (a <= 0) continue;
    ctx.save();
    ctx.globalAlpha = a * baseAlpha; // общая прозрачность сцены умножается, а не затирается
    ctx.textBaseline = 'top';
    if (it.kind === 'label') {
      setFont(ctx, it.size, F.mono, 6 * s); ctx.fillStyle = C.dust; ctx.textAlign = 'center';
      ctx.fillText(it.text, w / 2, y);
    } else if (it.kind === 'title') {
      setFont(ctx, it.size, F.display); ctx.fillStyle = C.light; ctx.textAlign = 'center';
      it.lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y + i * it.lh));
    } else if (it.kind === 'genre' || it.kind === 'head') {
      setFont(ctx, it.size, F.mono, 7 * s); ctx.fillStyle = accent; ctx.textAlign = 'center';
      ctx.fillText(it.text, w / 2, y);
    } else if (it.kind === 'row') {
      ctx.fillStyle = C.axis;
      ctx.fillRect(it.axis - 0.75 * s, y + 4 * s, Math.max(1, 1.5 * s), it.h - 44 * s);
      setFont(ctx, it.ty.role * s, F.mono, 4 * s); ctx.fillStyle = C.role; ctx.textAlign = 'right';
      it.roleLines.forEach((ln, i) => ctx.fillText(ln, it.axis - it.gap, y + 16 * s + i * it.ty.roleLh * s));
      setFont(ctx, it.ty.value * s, F.display); ctx.fillStyle = C.light; ctx.textAlign = 'left';
      it.valueLines.forEach((ln, i) => ctx.fillText(ln, it.axis + it.gap, y + i * it.lh));
    } else if (it.kind === 'end') {
      setFont(ctx, it.size, F.display); ctx.fillStyle = C.light; ctx.textAlign = 'center';
      ctx.fillText(it.text, w / 2, y);
    }
    ctx.restore();
  }
}

function drawPost(ctx, w, h, L, accent, alpha) {
  if (!L.postLines.length || alpha <= 0) return;
  const s = L.s;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lh = 74 * s;
  const blockH = 70 * s + L.postLines.length * lh;
  let y = h / 2 - blockH / 2;
  setFont(ctx, 24 * s, F.mono, 7 * s);
  ctx.fillStyle = accent;
  ctx.fillText('СЦЕНА ПОСЛЕ ТИТРОВ', w / 2, y);
  y += 70 * s;
  setFont(ctx, 66 * s, F.display);
  ctx.fillStyle = C.light;
  L.postLines.forEach((ln, i) => ctx.fillText(ln, w / 2, y + i * lh));
  ctx.restore();
}

/** Неподвижный режим (уменьшенное движение): страницы со склейками без анимации. */
function stillOffset(L, h, t, T) {
  const rows = L.items.filter((it) => it.kind === 'row');
  const pages = [L.titleCenter];
  for (let i = 0; i < rows.length; i += 3) {
    const chunk = rows.slice(i, i + 3);
    const a = chunk[0].y;
    const b = chunk[chunk.length - 1].y + chunk[chunk.length - 1].h;
    pages.push((a + b) / 2 - (i === 0 ? 40 * L.s : 0));
  }
  pages.push(L.endCenter);
  const span = (T.blackStart - T.fadeIn) / pages.length;
  const idx = clamp(Math.floor((t - T.fadeIn) / span), 0, pages.length - 1);
  return h / 2 - pages[idx];
}

/**
 * Нарисовать кадр.
 * opts: { duration, still (без движения), watermark (строка или false), frame (номер для зерна),
 *         timing: 'v1'|'v2', typo: 'v1'|'v2', ease: 'smooth'|'linear' }
 */
export function drawFrame(ctx, w, h, ep, t, opts = {}) {
  const T = timeline(opts.duration || DEFAULT_DURATION, opts.timing);
  const mood = MOODS[ep.mood] || MOODS.warm;
  const accent = mood.accent;
  const L = layout(ctx, ep, w, h, opts.typo);
  const frame = opts.frame ?? Math.round(t * 30);

  drawBackground(ctx, w, h, accent, t, opts);

  // Прокрутка: название стоит по центру, потом ровный подъём до «Конец сцены» в центре.
  let offset;
  if (opts.still) offset = stillOffset(L, h, t, T);
  else {
    const u = clamp((t - T.titleHold) / (T.rollEnd - T.titleHold));
    const from = h / 2 - L.titleCenter;
    const to = h / 2 - L.endCenter;
    offset = from + (to - from) * rollPosition(u, opts.ease, 0.8 / Math.max(1, T.rollEnd - T.titleHold));
  }

  const sceneIn = opts.still ? (t > 0 ? 1 : 0) : clamp(t / T.fadeIn);
  const sceneOut = opts.still ? (t < T.blackStart ? 1 : 0) : 1 - clamp((t - T.blackStart) / T.sceneFade);
  const sceneA = Math.min(sceneIn, sceneOut);

  if (sceneA > 0) {
    drawItems(ctx, w, h, L, offset, accent, sceneA);
  }

  const hasPost = L.postLines.length > 0;
  let postA = 0;
  if (hasPost) {
    postA = opts.still ? (t >= T.postStart ? 1 : 0)
      : clamp((t - T.postStart) / T.postFadeIn) * (1 - clamp((t - (T.duration - T.fadeOut)) / T.fadeOut));
    drawPost(ctx, w, h, L, accent, postA);
  }

  const chromeA = opts.still ? 1 : clamp(t / T.fadeIn) * (1 - clamp((t - (T.duration - T.fadeOut)) / T.fadeOut));
  drawChrome(ctx, w, h, ep, L.s, chromeA, opts);
  drawGrain(ctx, w, h, opts.still ? 0 : frame);
}

/** Кадр-афиша для фильмотеки и превью: название на своём месте. */
export function drawPoster(ctx, w, h, ep, opts = {}) {
  drawFrame(ctx, w, h, ep, timeline(opts.duration, opts.timing).titleHold - 0.5, { ...opts, frame: 0 });
}
