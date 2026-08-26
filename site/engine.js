/* vendored from graph-engine — edit there, then ./sync.sh */
/* graph-engine — force layout, canvas renderer, interaction, detail panel.
 *
 * Domain-neutral. Two globals drive it:
 *   window.GRAPH        generated payload  {nodes, edges, types}
 *   window.GRAPH_CONFIG per-site config    (see README.md § Config)
 *
 * No dependencies, no build step, CSP-safe (no eval, no remote fetch).
 */
(function () {
'use strict';

const G = window.GRAPH;
const C = window.GRAPH_CONFIG;
const KINDS = C.kinds;                      // { code: {name, plural, shape, color, ...} }
const ORDER = C.kindOrder || Object.keys(KINDS);
const QUOTED = new Set(C.quoteKinds || []); // kinds rendered as “…” in serif italic

/* ---------- model ---------- */
const nodes = G.nodes.map(n => Object.assign({}, n, {
  x: 0, y: 0, vx: 0, vy: 0, deg: 0, r: 4, pinned: false, hidden: false
}));
const byId = new Map(nodes.map(n => [n.id, n]));
const links = [];
for (const [a, b, t, g] of G.edges) {
  const s = byId.get(a), d = byId.get(b);
  if (!s || !d) continue;
  links.push({ s, d, t, g: g || 0, rest: (C.rest && C.rest[t]) || C.restDefault || 100 });
  s.deg++; d.deg++;
}
const adj = new Map(nodes.map(n => [n.id, []]));
for (const l of links) {
  adj.get(l.s.id).push({ o: l.d, t: l.t, dir: 1, l });
  adj.get(l.d.id).push({ o: l.s, t: l.t, dir: -1, l });
}
for (const n of nodes) {
  const k = KINDS[n.k] || {};
  n.r = (k.size || 4) + Math.sqrt(n.deg) * (k.grow || 1.25);
  if (k.rmax) n.r = Math.min(n.r, k.rmax);
}

/* ---------- seeding: anchors on a ring, everyone else near their anchor ---- */
const ANCHOR = C.clusterKind;
const anchors = nodes.filter(n => n.k === ANCHOR);
anchors.forEach((s, i) => {
  const a = (i / (anchors.length || 1)) * Math.PI * 2;
  s.x = Math.cos(a) * (C.seedRadius || 620); s.y = Math.sin(a) * (C.seedRadius || 620);
});
const clusterEdges = new Set(C.clusterEdges || []);
const homeOf = new Map();
for (const l of links) {
  if (clusterEdges.has(l.t) && l.d.k === ANCHOR && !homeOf.has(l.s.id)) homeOf.set(l.s.id, l.d);
}
for (const n of nodes) {
  if (n.k === ANCHOR) continue;
  let h = homeOf.get(n.id);
  if (!h && n.by) {                              // inherit the home of whoever you belong to
    h = homeOf.get(n.by);
    if (!h) { const o = byId.get(n.by); if (o) h = homeOf.get(o.id); }
  }
  const j = () => (Math.random() - 0.5) * 130;
  n.x = (h ? h.x : 0) + j(); n.y = (h ? h.y : 0) + j();
  n.home = h || null;
}
for (const n of nodes) if (n.k !== ANCHOR && !n.home) { const p = byId.get(n.by); if (p) n.home = p.home || null; }

/* deterministic vertical lane for timeline mode: a band per kind, spread within it */
const BANDS = (C.timeline && C.timeline.bands) || {};
{
  const seen = {};
  for (const n of nodes) {
    seen[n.k] = (seen[n.k] || 0) + 1;
    const jitter = ((seen[n.k] * 137.508) % 440) - 220;   // golden-angle spread
    n.laneY = (BANDS[n.k] || 0) + jitter;
  }
}

/* ---------- state ---------- */
const S = {
  show: {}, sel: null, hover: null, focus: null, focusSet: null,
  trace: null, traceFrom: null, tracePath: null,
  timeline: false, map: null, alpha: 1, drag: null,
  gate: (C.gate && C.gate.default) || 0,
  cam: { x: 0, y: 0, z: 0.62 },
};
for (const k of ORDER) S.show[k] = true;

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
}
window.addEventListener('resize', () => { resize(); kick(0.3); });

function visible(n) { return S.show[n.k] && !n.hidden && (n.g || 0) <= S.gate; }
function linkVisible(l) { return (l.g || 0) <= S.gate && visible(l.s) && visible(l.d); }
function kick(a) { S.alpha = Math.max(S.alpha, a); }

/* ---------- the timeline scale ----------
   config gives stops [[value, x], …]; between them the scale is linear, so a
   dense stretch of story time can be given as much axis as it deserves. */
const STOPS = (C.timeline && C.timeline.stops) || [[0, -2000], [1, 2000]];
function timeX(v) {
  if (v <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [v0, x0] = STOPS[i - 1], [v1, x1] = STOPS[i];
    if (v <= v1) return x0 + ((v - v0) / ((v1 - v0) || 1)) * (x1 - x0);
  }
  return STOPS[STOPS.length - 1][1];
}
function nodeTime(n) {
  const t = C.time ? C.time(n, byId) : n.t0;
  return t == null ? ((C.timeline && C.timeline.fallback) || 0) : t;
}

/* ---------- map mode ----------
   The payload can carry real basemaps (G.map.frames) and real coordinates per
   anchor node (G.geo). Places are pinned to their true projected position;
   anything outside the frame is pinned to the frame edge on its true bearing
   with its true distance; everything else springs to the place it belongs to.
   No tiles, no network: the geometry is baked in at build time. */
const MAP = G.map || null;
const GEO = G.geo || null;
const MAPFRAMES = MAP ? MAP.frames : {};
const EARTH_MI = 3958.8;

function frameWorld(fr) {                       // bbox -> world rectangle
  const p = fr.proj, [s0, w0, n0, e0] = fr.bbox;
  const px = (lat, lon) => [(lon - p.lon0) * p.k * p.scale, -(lat - p.lat0) * p.scale];
  const a = px(n0, w0), b = px(s0, e0);
  return { x0: a[0], y0: a[1], x1: b[0], y1: b[1] };
}
function project(fr, lat, lon) {
  const p = fr.proj;
  return { x: (lon - p.lon0) * p.k * p.scale, y: -(lat - p.lat0) * p.scale };
}
function haversineMi(a, b, c, d) {
  const R = Math.PI / 180, dl = (c - a) * R, dn = (d - b) * R;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin(dn / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Precompute, per frame: a pinned world position (and off-map metadata) per node.
const MAPPOS = {};
if (MAP && GEO) for (const key of Object.keys(MAPFRAMES)) {
  const fr = MAPFRAMES[key], rect = frameWorld(fr), pins = {};
  const origin = (GEO.origin && GEO.origin[key]) || [fr.proj.lat0, fr.proj.lon0];

  // First pass: everything that really is inside the frame, at its real spot.
  const off = [];
  for (const [id, g] of Object.entries(GEO[key] || {})) {
    const pt = project(fr, g[0], g[1]);
    if (pt.x > rect.x0 && pt.x < rect.x1 && pt.y > rect.y0 && pt.y < rect.y1) {
      pins[id] = { x: pt.x, y: pt.y, real: g[2] || null, off: false };
    } else off.push([id, g, pt]);
  }

  // The town occupies a fraction of the county. Ring the distant places around
  // *it*, not around the frame, so the whole thing stays readable at one zoom —
  // on the true bearing, with the true great-circle distance.
  let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const id in pins) {
    const p = pins[id];
    b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y);
    b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
  }
  if (!isFinite(b.x0)) b = { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const rx = Math.max(360, (b.x1 - b.x0) * 0.95), ry = Math.max(300, (b.y1 - b.y0) * 0.95);
  for (const [id, g, pt] of off) {
    const dx = pt.x - cx, dy = pt.y - cy;
    const t = Math.min(rx / (Math.abs(dx) || 1e-9), ry / (Math.abs(dy) || 1e-9));
    pins[id] = { x: cx + dx * t, y: cy + dy * t, real: g[2] || null, off: true,
                 mi: Math.round(haversineMi(origin[0], origin[1], g[0], g[1])) };
  }
  // the places that are not on any map, in a row of their own beneath it all
  const nowhere = GEO.nowhere || [];
  nowhere.forEach((id, i) => {
    pins[id] = { x: cx + (i - (nowhere.length - 1) / 2) * (rx * 0.5),
                 y: cy + ry * 1.16, nowhere: true, off: false };
  });
  MAPPOS[key] = { pins, rect, box: { cx, cy, rx, ry } };
}
function mapPin(n) {
  const m = S.map && MAPPOS[S.map];
  return m ? m.pins[n.id] : null;
}

/* ---------- forces ---------- */
function tick() {
  const a = S.alpha;
  if (a < 0.002) return;
  const act = nodes.filter(visible);

  // repulsion (O(n^2) with a distance cutoff; n is small enough)
  for (let i = 0; i < act.length; i++) {
    const p = act[i];
    for (let j = i + 1; j < act.length; j++) {
      const q = act[j];
      let dx = q.x - p.x, dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 90000 || d2 === 0) continue;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const d = Math.sqrt(d2);
      const f = (260 * (p.r + q.r) * 0.11) / d2 * a;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      p.vx -= fx; p.vy -= fy; q.vx += fx; q.vy += fy;
    }
  }
  // anchors repel one another strongly, so regions stay distinct
  const sc = anchors.filter(visible);
  for (let i = 0; i < sc.length; i++) for (let j = i + 1; j < sc.length; j++) {
    const p = sc[i], q = sc[j];
    let dx = q.x - p.x, dy = q.y - p.y;
    let d2 = dx * dx + dy * dy;
    if (d2 === 0) { dx = Math.random(); dy = Math.random(); d2 = 1; }
    if (d2 > 700000) continue;
    const d = Math.sqrt(d2);
    const f = ((C.anchorRepel || 260000) / d2) * a;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    p.vx -= fx; p.vy -= fy; q.vx += fx; q.vy += fy;
  }
  // link springs
  for (const l of links) {
    if (!linkVisible(l)) continue;
    const dx = l.d.x - l.s.x, dy = l.d.y - l.s.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = ((d - l.rest) / d) * 0.055 * a;
    const fx = dx * f, fy = dy * f;
    l.s.vx += fx; l.s.vy += fy; l.d.vx -= fx; l.d.vy -= fy;
  }
  // cluster pull + gravity, or the timeline rail, or the map
  for (const n of act) {
    if (S.map) {
      const pin = mapPin(n);
      if (pin) {                                  // a real place at a real position
        n.vx += (pin.x - n.x) * 0.34 * a;
        n.vy += (pin.y - n.y) * 0.34 * a;
      } else if (n.home && visible(n.home)) {     // orbit whatever you belong to
        n.vx += (n.home.x - n.x) * 0.055 * a;
        n.vy += (n.home.y - n.y) * 0.055 * a;
      } else {                                    // nowhere in particular
        const bx = MAPPOS[S.map].box;
        n.vx += (bx.cx - n.x) * 0.018 * a;
        n.vy += (bx.cy + bx.ry * 1.44 - n.y) * 0.018 * a;
      }
    } else if (S.timeline) {
      const tx = timeX(nodeTime(n));
      n.vx += (tx - n.x) * 0.14 * a;
      n.vy += (n.laneY - n.y) * 0.020 * a;
    } else {
      if (n.home && visible(n.home)) {
        n.vx += (n.home.x - n.x) * 0.030 * a;
        n.vy += (n.home.y - n.y) * 0.030 * a;
      }
      const g = n.k === ANCHOR ? 0.0009 : 0.0022;
      n.vx += -n.x * g * a; n.vy += -n.y * g * a;
    }
  }
  // integrate
  for (const n of act) {
    if (n.pinned) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.82; n.vy *= 0.82;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > 26) { n.vx = n.vx / sp * 26; n.vy = n.vy / sp * 26; }
    n.x += n.vx; n.y += n.vy;
  }
  S.alpha *= 0.988;
}

/* ---------- neighbourhoods ---------- */
function shown(e) { return (e.l.g || 0) <= S.gate && visible(e.o); }
function neighbourhood(n) {
  if (!n) return null;
  const s = new Set([n.id]);
  for (const e of adj.get(n.id)) if (shown(e)) s.add(e.o.id);
  return s;
}
function ego(n, hops) {
  const s = new Set([n.id]); let frontier = [n];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const f of frontier) for (const e of adj.get(f.id)) {
      if (shown(e) && !s.has(e.o.id)) { s.add(e.o.id); next.push(e.o); }
    }
    frontier = next;
  }
  return s;
}

/* ---------- palette ---------- */
const css = getComputedStyle(document.documentElement);
function col(name) { return css.getPropertyValue(name).trim(); }
let PAL = {};
function refreshPalette() {
  const c = getComputedStyle(document.documentElement);
  PAL = { ink: c.getPropertyValue('--ink').trim(), ink2: c.getPropertyValue('--ink-2').trim(),
          ink3: c.getPropertyValue('--ink-3').trim(), line: c.getPropertyValue('--line').trim(),
          bg: c.getPropertyValue('--bg').trim(), accent: c.getPropertyValue('--accent').trim() };
  for (const k of ORDER) PAL[k] = c.getPropertyValue(KINDS[k].color).trim();
}
refreshPalette();
const _rp = refreshPalette;
refreshPalette = function () { MAPCOL = null; _rp(); };
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(refreshPalette);
}

function toScreen(n) {
  return { x: (n.x - S.cam.x) * S.cam.z + W / 2, y: (n.y - S.cam.y) * S.cam.z + H / 2 };
}
function toWorld(sx, sy) {
  return { x: (sx - W / 2) / S.cam.z + S.cam.x, y: (sy - H / 2) / S.cam.z + S.cam.y };
}
function labelFor(n) {
  if (!QUOTED.has(n.k)) return n.label;
  const t = n.label;
  return t.length > 46 ? '“' + t.slice(0, 44).trim() + '…”' : '“' + t + '”';
}

/* ---------- render ---------- */
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const z = S.cam.z;

  const active = S.tracePath ? new Set(S.tracePath.map(n => n.id))
               : S.focusSet ? S.focusSet
               : (S.hover ? neighbourhood(S.hover) : (S.sel ? neighbourhood(S.sel) : null));
  const dim = active ? 0.1 : 1;
  const pathEdges = new Set();
  if (S.tracePath) for (let i = 0; i < S.tracePath.length - 1; i++)
    pathEdges.add(S.tracePath[i].id + '|' + S.tracePath[i + 1].id);

  if (S.map) drawBasemap();

  // ---- links ----
  ctx.lineCap = 'round';
  for (const l of links) {
    if (!linkVisible(l)) continue;
    const a = toScreen(l.s), b = toScreen(l.d);
    if (Math.max(a.x, b.x) < -60 || Math.min(a.x, b.x) > W + 60) continue;
    if (Math.max(a.y, b.y) < -60 || Math.min(a.y, b.y) > H + 60) continue;

    const onPath = pathEdges.has(l.s.id + '|' + l.d.id) || pathEdges.has(l.d.id + '|' + l.s.id);
    const lit = active ? (active.has(l.s.id) && active.has(l.d.id)) : false;
    let alpha = active ? (onPath ? 1 : lit ? 0.75 : dim * 0.45) : (C.edgeAlpha || 0.24);
    if (S.tracePath && !onPath) alpha = 0.05;

    const meta = G.types[l.t] || {};
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = onPath ? PAL.accent : (lit ? PAL[l.s.k] : PAL.ink3);
    ctx.lineWidth = onPath ? 2.4 : (lit ? 1.4 : 0.8);
    if (meta.s === 'dashed') ctx.setLineDash([5, 4]);
    else if (meta.s === 'dotted') ctx.setLineDash([1.5, 3.5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);

    if (meta.dir && (lit || onPath) && z > 0.4) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const tipX = b.x - ux * (l.d.r * z + 4), tipY = b.y - uy * (l.d.r * z + 4);
      const s = 6;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * s + uy * s * 0.5, tipY - uy * s - ux * s * 0.5);
      ctx.lineTo(tipX - ux * s - uy * s * 0.5, tipY - uy * s + ux * s * 0.5);
      ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
    }
    ctx.restore();
  }

  // ---- nodes ----
  const labelled = [];
  for (const n of nodes) {
    if (!visible(n)) continue;
    const p = toScreen(n);
    const r = Math.max(2, n.r * z);
    if (p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) continue;
    const lit = !active || active.has(n.id);
    const isSel = S.sel === n, isHov = S.hover === n;

    ctx.save();
    ctx.globalAlpha = lit ? 1 : dim;
    const c = PAL[n.k];

    if (isSel || isHov) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.globalAlpha = (lit ? 1 : dim) * 0.16; ctx.fill();
      ctx.globalAlpha = lit ? 1 : dim;
    }
    drawShape(p, r, KINDS[n.k].shape, c);
    if (isSel) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke();
    }
    ctx.restore();

    const wantLabel = isSel || isHov || (active && active.has(n.id) && z > 0.3)
      || (!active && (n.k === ANCHOR ? (S.map || z > 0.28) : n.deg >= 9 ? z > 0.5 : z > 1.0));
    if (wantLabel) labelled.push({ n, p, r, lit });
  }

  // ---- labels on top ----
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const boxes = [];
  labelled.sort((a, b) => (b.n.deg - a.n.deg));
  const fUi = C.fontUI || 'system-ui, sans-serif';
  const fQ = C.fontQuote || 'Georgia, serif';
  for (const { n, p, r, lit } of labelled) {
    const isA = n.k === ANCHOR;
    const size = isA ? 12.5 : (KINDS[n.k].label || 11);
    ctx.font = (isA ? '500 ' : '400 ') + size + 'px ' + (QUOTED.has(n.k) ? fQ : fUi);
    let text = labelFor(n);
    if (text.length > 40) text = text.slice(0, 38) + '…';
    const w = ctx.measureText(text).width;
    const x = p.x, y = p.y + r + 4;
    const box = [x - w / 2 - 2, y - 1, w + 4, size + 3];
    let clash = false;
    for (const b of boxes) {
      if (box[0] < b[0] + b[2] && box[0] + box[2] > b[0] &&
          box[1] < b[1] + b[3] && box[1] + box[3] > b[1]) { clash = true; break; }
    }
    if (clash && !(S.sel === n || S.hover === n)) continue;
    boxes.push(box);
    if (S.map) {
      const pin = mapPin(n);
      if (pin && (pin.off || pin.nowhere)) {
        ctx.save();
        ctx.font = '9px ' + (C.fontMono || 'monospace');
        ctx.globalAlpha = (lit ? 1 : 0.15) * 0.75;
        ctx.fillStyle = PAL.ink3;
        ctx.fillText(pin.nowhere ? 'NOT ON ANY MAP'
                                 : '↗ ' + pin.mi.toLocaleString() + ' mi', x, y + size + 4);
        ctx.restore();
      }
    }
    ctx.save();
    ctx.globalAlpha = lit ? 1 : 0.15;
    ctx.lineWidth = 3.2; ctx.strokeStyle = col('--bg');
    ctx.strokeText(text, x, y);
    ctx.fillStyle = (S.sel === n || S.hover === n) ? PAL[n.k] : PAL.ink2;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  if (S.timeline) drawAxis();
}

/* ---------- basemap ---------- */
const MAPSTYLE = {                       // class -> [css var, width, dash]
  wood:  ['--map-wood',  0,   null],
  water: ['--map-water', 0,   null],
  river: ['--map-water', 2.2, null],
  creek: ['--map-water', 1.0, null],
  hwy:   ['--map-road',  2.6, null],
  road:  ['--map-road',  1.8, null],
  lane:  ['--map-lane',  0.9, null],
  rail:  ['--map-rail',  1.2, [6, 4]],
  border:['--map-border',2.0, [9, 5]],
  stateline: ['--map-line', 1.2, [3, 5]],
};
let MAPCOL = null;
function mapColours() {
  if (MAPCOL) return MAPCOL;
  const c = getComputedStyle(document.documentElement);
  MAPCOL = {};
  for (const k of Object.keys(MAPSTYLE)) MAPCOL[k] = c.getPropertyValue(MAPSTYLE[k][0]).trim() || PAL.ink3;
  MAPCOL.label = c.getPropertyValue('--map-label').trim() || PAL.ink3;
  return MAPCOL;
}
function drawBasemap() {
  const fr = MAPFRAMES[S.map];
  if (!fr) return;
  const z = S.cam.z, col = mapColours();
  const sx = x => (x - S.cam.x) * z + W / 2, sy = y => (y - S.cam.y) * z + H / 2;

  // filled areas first: woods, then water
  ctx.save();
  for (const pass of ['wood', 'water']) {
    ctx.fillStyle = col[pass];
    ctx.globalAlpha = pass === 'wood' ? 0.5 : 0.85;
    for (const a of fr.areas) {
      if (a.c !== pass) continue;
      ctx.beginPath();
      ctx.moveTo(sx(a.p[0][0]), sy(a.p[0][1]));
      for (let i = 1; i < a.p.length; i++) ctx.lineTo(sx(a.p[i][0]), sy(a.p[i][1]));
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // lines, thin classes first so the highway lands on top
  const order = ['lane', 'creek', 'rail', 'road', 'river', 'hwy', 'stateline', 'border'];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const cls of order) {
    const [, w, dash] = MAPSTYLE[cls];
    ctx.strokeStyle = col[cls];
    ctx.lineWidth = Math.max(0.5, w * Math.min(1.6, Math.max(0.55, z)));
    ctx.globalAlpha = cls === 'lane' ? 0.5 : cls === 'border' ? 0.95 : 0.8;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    for (const l of fr.lines) {
      if (l.c !== cls) continue;
      ctx.moveTo(sx(l.p[0][0]), sy(l.p[0][1]));
      for (let i = 1; i < l.p.length; i++) ctx.lineTo(sx(l.p[i][0]), sy(l.p[i][1]));
    }
    ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;

  // peaks and real towns, so you can see the map is a real map
  ctx.font = '500 9.5px ' + (C.fontMono || 'monospace');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = col.label;
  if (z > 0.32) for (const pk of fr.peaks) {
    const x = sx(pk.x), y = sy(pk.y);
    if (x < 0 || x > W || y < 0 || y > H) continue;
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y + 3); ctx.lineTo(x - 4, y + 3);
    ctx.closePath(); ctx.fill();
    if (z > 0.6) ctx.fillText(pk.n + (pk.e ? '  ' + Math.round(pk.e * 3.28081) + '′' : ''), x, y + 12);
  }
  if (z > 0.45) for (const t of fr.towns) {
    const x = sx(t.x), y = sy(t.y);
    if (x < 0 || x > W || y < 0 || y > H) continue;
    ctx.globalAlpha = 0.7;
    ctx.fillText(t.n.toUpperCase(), x, y);
  }
  ctx.globalAlpha = 1;

  // the frame itself, plus the credit
  const m = MAPPOS[S.map];
  if (m) {
    ctx.strokeStyle = col.label; ctx.globalAlpha = 0.25; ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.strokeRect(sx(m.rect.x0), sy(m.rect.y0),
                   (m.rect.x1 - m.rect.x0) * z, (m.rect.y1 - m.rect.y0) * z);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.8;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.font = '9px ' + (C.fontMono || 'monospace');
    ctx.fillText((MAP.credit || '') + ' · ' + fr.title, 12, H - 8);
  }
  ctx.restore();
}

function drawShape(p, r, shape, c) {
  ctx.beginPath();
  if (shape === 'square') {
    const s = r * 1.72, rad = Math.min(2.6, s / 3);
    roundRect(ctx, p.x - s / 2, p.y - s / 2, s, s, rad);
    ctx.fillStyle = c; ctx.fill();
  } else if (shape === 'diamond') {
    const s = r * 1.25;
    ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y);
    ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s, p.y);
    ctx.closePath(); ctx.fillStyle = c; ctx.fill();
  } else if (shape === 'ring') {
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = c; ctx.lineWidth = Math.max(1.6, r * 0.32); ctx.stroke();
  } else if (shape === 'triangle') {
    const s = r * 1.5;
    ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s * 0.92, p.y + s * 0.62);
    ctx.lineTo(p.x - s * 0.92, p.y + s * 0.62);
    ctx.closePath(); ctx.fillStyle = c; ctx.fill();
  } else if (shape === 'chevron') {                 // two stacked arrows — the zigzag
    const s = r * 1.5;
    ctx.moveTo(p.x - s, p.y + s * 0.15); ctx.lineTo(p.x, p.y - s * 0.75);
    ctx.lineTo(p.x + s, p.y + s * 0.15); ctx.lineTo(p.x + s, p.y + s * 0.85);
    ctx.lineTo(p.x, p.y - s * 0.05); ctx.lineTo(p.x - s, p.y + s * 0.85);
    ctx.closePath(); ctx.fillStyle = c; ctx.fill();
  } else {
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
  }
}

function roundRect(c, x, y, w, h, r) {
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
}

function drawAxis() {
  const T = C.timeline || {};
  ctx.save();
  ctx.font = '500 10px ' + (C.fontMono || 'monospace');
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const k of ORDER) {
    if (!(k in BANDS)) continue;
    const sy = (BANDS[k] - S.cam.y) * S.cam.z + H / 2;
    if (sy < 10 || sy > H - 30) continue;
    ctx.globalAlpha = 0.5; ctx.fillStyle = PAL[k];
    ctx.fillText((KINDS[k].plural || KINDS[k].name).toUpperCase(), 12, sy);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.font = '10px ' + (C.fontMono || 'monospace');
  ctx.strokeStyle = PAL.line; ctx.fillStyle = PAL.ink3; ctx.lineWidth = 1;
  for (const m of (T.marks || [])) {
    const v = Array.isArray(m) ? m[0] : m;
    const text = Array.isArray(m) ? m[1] : (T.label ? T.label(v) : String(v));
    const sx = (timeX(v) - S.cam.x) * S.cam.z + W / 2;
    if (sx < 30 || sx > W - 30) continue;
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H - 22); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(text, sx, H - 8);
  }
  ctx.restore();
}

/* ---------- loop ---------- */
function loop() { tick(); draw(); requestAnimationFrame(loop); }

/* ---------- hit testing ---------- */
function nodeAt(sx, sy) {
  let best = null, bd = Infinity;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const p = toScreen(n);
    const d = Math.hypot(p.x - sx, p.y - sy);
    const hit = Math.max(9, n.r * S.cam.z + 5);
    if (d < hit && d < bd) { bd = d; best = n; }
  }
  return best;
}

/* ---------- pointer (mouse + multi-touch) ---------- */
let pointer = { down: false, moved: false, sx: 0, sy: 0, node: null };
const pts = new Map();          // live pointers, for pinch
let pinch = null;
let lastTap = { t: 0, node: null };

function pinchState() {
  const a = [...pts.values()];
  return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2,
           d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
}

cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pts.size === 2) {                    // second finger down: pinch, not tap/drag
    if (S.drag) S.drag = null;
    pointer.down = false; pointer.node = null; pointer.moved = true;
    hideTip();
    pinch = pinchState();
    return;
  }
  if (pts.size > 2) return;
  const n = nodeAt(e.offsetX, e.offsetY);
  pointer = { down: true, moved: false, sx: e.offsetX, sy: e.offsetY, node: n };
  if (n) { n.pinned = true; S.drag = n; }
  cv.classList.add('grabbing');
  if (e.pointerType === 'touch') hideTip();
});

cv.addEventListener('pointermove', e => {
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (pinch && pts.size >= 2) {            // pinch to zoom + two-finger pan
    const m = pinchState();
    if (pinch.d > 8 && m.d > 8) zoomAt(m.x, m.y, m.d / pinch.d);
    S.cam.x -= (m.x - pinch.x) / S.cam.z;
    S.cam.y -= (m.y - pinch.y) / S.cam.z;
    pinch = m;
    return;
  }
  if (pointer.down) {
    const dx = e.offsetX - pointer.sx, dy = e.offsetY - pointer.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
    if (S.drag) {
      const w = toWorld(e.offsetX, e.offsetY);
      S.drag.x = w.x; S.drag.y = w.y; S.drag.vx = S.drag.vy = 0;
      kick(0.35);
    } else {
      S.cam.x -= dx / S.cam.z; S.cam.y -= dy / S.cam.z;
      pointer.sx = e.offsetX; pointer.sy = e.offsetY;
    }
    return;
  }
  if (e.pointerType === 'touch') return;   // no hover state on touch
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n !== S.hover) { S.hover = n; cv.classList.toggle('pointing', !!n); }
  showTip(n, e.offsetX, e.offsetY);
});

function endPointer(e) {
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  if (pts.size > 0) { pointer.down = false; return; }
  cv.classList.remove('grabbing');
  const wasDrag = pointer.moved, wasDown = pointer.down, n = pointer.node;
  if (S.drag) S.drag = null;
  pointer.down = false;
  if (e.pointerType === 'touch') { S.hover = null; hideTip(); }
  if (!wasDown || wasDrag) return;
  if (e.pointerType === 'touch' && n && !S.trace) {   // double-tap = isolate
    const now = Date.now();
    if (lastTap.node === n && now - lastTap.t < 340) {
      lastTap = { t: 0, node: null };
      setFocus(S.focus === n ? null : n);
      return;
    }
    lastTap = { t: now, node: n };
  }
  if (n) { if (S.trace) pickTrace(n); else select(n); }
  else if (!S.trace) select(null);
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('pointerleave', e => {
  if (e.pointerType === 'touch') return;
  S.hover = null; hideTip();
});
cv.addEventListener('dblclick', e => {
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n) setFocus(S.focus === n ? null : n);
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0016));
}, { passive: false });

function zoomAt(sx, sy, f) {
  const before = toWorld(sx, sy);
  S.cam.z = Math.min(4.5, Math.max(0.12, S.cam.z * f));
  const after = toWorld(sx, sy);
  S.cam.x += before.x - after.x; S.cam.y += before.y - after.y;
}

/* ---------- formatting helpers exposed to config ---------- */
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; }
const H_ = { esc, trunc, byId, get: id => byId.get(id), adj: id => adj.get(id) || [] };
C.h = H_;
function sub(n) { return (C.sub && C.sub(n, H_)) || ''; }

/* ---------- tooltip ---------- */
const tip = document.getElementById('tooltip');
function showTip(n, x, y) {
  if (!n) return hideTip();
  const k = KINDS[n.k];
  const s = sub(n);
  const gloss = n.blurb ? '<span class="tb">' + esc(trunc(n.blurb, 110)) + '</span>' : '';
  tip.innerHTML = '<span class="tk">' + esc(k.name) + (s ? ' · ' + esc(s) : '') + '</span>' +
    (QUOTED.has(n.k) ? '<span class="tq">“' + esc(n.label) + '”</span>'
                     : '<b>' + esc(n.label) + '</b>') + gloss;
  tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  let tx = x + 14, ty = y + 14;
  if (tx + r.width > W - 8) tx = x - r.width - 12;
  if (ty + r.height > H - 8) ty = y - r.height - 12;
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
}
function hideTip() { tip.classList.remove('on'); }

/* ---------- detail panel ---------- */
const panel = document.getElementById('panel');
const pKind = document.getElementById('pkind');
const pTitle = document.getElementById('ptitle');
const pMeta = document.getElementById('pmeta');
const pBody = document.getElementById('pbody');
document.getElementById('pclose').onclick = () => select(null);

function dotFor(k) {
  const shape = KINDS[k].shape;
  const cls = 'dot' + (shape === 'square' ? ' sq' : shape === 'diamond' ? ' di'
            : shape === 'ring' ? ' ri' : shape === 'triangle' ? ' tr'
            : shape === 'chevron' ? ' ch' : '');
  const style = (shape === 'ring' ? 'color:var(' : 'background:var(') + KINDS[k].color + ')';
  return '<span class="' + cls + '" style="' + style + '"></span>';
}

// relation groups follow the taxonomy order in the payload, not an ad-hoc list
const typeIx = new Map(Object.keys(G.types).map((t, i) => [t, i]));

function select(n) {
  S.sel = n;
  document.getElementById('zoomctl').classList.toggle('shift', !!n);
  document.body.classList.toggle('sheet-open', !!n);
  if (!n) { panel.classList.remove('open'); return; }
  panel.classList.add('open');
  const k = KINDS[n.k];
  pKind.innerHTML = dotFor(n.k) + '<span>' + esc(k.name) + '</span>';
  pTitle.className = 'p-title' + (QUOTED.has(n.k) ? ' q' : '');
  pTitle.textContent = QUOTED.has(n.k) ? '“' + n.label + '”' : n.label;

  const meta = (C.meta ? C.meta(n, H_) : []).filter(Boolean);
  meta.push(n.deg + ' link' + (n.deg === 1 ? '' : 's'));
  pMeta.innerHTML = meta.map(esc).join('<span style="opacity:.4">/</span>');

  let html = '';
  if (n.flag && C.flagNote) html += C.flagNote(n, H_) || '';
  if (n.blurb) html += '<p class="blurb">' + esc(n.blurb) + '</p>';
  if (C.extra) html += C.extra(n, H_) || '';

  // sourced excerpt, attributed
  const srcNode = n.srcSum ? n : (byId.get(n.by) || {});
  if (srcNode.srcSum) {
    const who = srcNode === n ? '' : '<span class="sep-note">On ' + esc(srcNode.label) + ' — </span>';
    html += '<div class="sep-x">' + who + '<p>' + esc(srcNode.srcSum) + '</p>' +
      '<div class="sep-cred">' + esc(C.source.label) +
      (srcNode.srcAuth ? ' · ' + esc(srcNode.srcAuth) : '') + '</div></div>';
  }

  const groups = new Map();
  for (const e of adj.get(n.id)) {
    const m2 = G.types[e.t];
    if (!m2 || !shown(e)) continue;
    const label = e.dir === 1 ? m2.f : m2.b;
    if (!groups.has(label)) groups.set(label, { items: [], ix: typeIx.get(e.t) * 2 + (e.dir === 1 ? 0 : 1) });
    groups.get(label).items.push(e.o);
  }
  const keys = [...groups.keys()].sort((a, b) => groups.get(a).ix - groups.get(b).ix);
  for (const key of keys) {
    const items = groups.get(key).items;
    items.sort((a, b) => (a.t0 ?? 99999) - (b.t0 ?? 99999));
    html += '<div class="sect"><h3>' + esc(key) + ' <span style="color:var(--ink-3)">' +
      items.length + '</span></h3><div class="list">';
    for (const o of items) {
      const t2 = sub(o);
      html += '<button class="item' + (QUOTED.has(o.k) ? ' qi' : '') + '" data-go="' + esc(o.id) + '">' +
        dotFor(o.k) + '<span class="txt"><span class="t1">' +
        esc(QUOTED.has(o.k) ? '“' + trunc(o.label, 90) + '”' : o.label) + '</span>' +
        (t2 ? '<span class="t2">' + esc(t2) + '</span>' : '') + '</span>' +
        (o.flag ? '<span class="pill">' + esc(o.flag) + '</span>' : '') + '</button>';
    }
    html += '</div></div>';
  }

  if (n.src && C.source) {
    html += '<div class="sect"><h3>Source</h3><a class="item" style="text-decoration:none" ' +
      'href="' + esc(C.source.url(n.src)) + '" target="_blank" rel="noopener">' +
      '<span class="dot" style="background:var(--ink-3)"></span><span class="txt">' +
      '<span class="t1">' + esc(C.source.label) + ' &#8599;</span>' +
      '<span class="t2">' + esc(C.source.pretty(n.src)) + '</span></span></a></div>';
  }
  pBody.innerHTML = html;
  pBody.scrollTop = 0;
  pBody.querySelectorAll('[data-go]').forEach(b => {
    b.onclick = () => { const t = byId.get(b.dataset.go); if (t) { flyTo(t); select(t); } };
  });
}

/* ---------- navigation ---------- */
function flyTo(n, z) {
  if (!n) return;
  S.show[n.k] = true; syncChips();
  const tz = z || Math.max(S.cam.z, 1.05);
  const sx = S.cam.x, sy = S.cam.y, sz = S.cam.z;
  const t0 = performance.now(), dur = 480;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { S.cam.x = n.x; S.cam.y = n.y; S.cam.z = tz; kick(0.15); return; }
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    S.cam.x = sx + (n.x - sx) * e; S.cam.y = sy + (n.y - sy) * e;
    S.cam.z = sz + (tz - sz) * e;
    if (k < 1) requestAnimationFrame(step);
  })(t0);
  kick(0.12);
}
function setFocus(n) {
  S.focus = n;
  S.focusSet = n ? ego(n, 2) : null;
  if (n) { status((C.focusMsg || (l => 'Isolated: ' + l + ' and everything within two steps.'))(esc(n.label))); flyTo(n, 0.85); }
  else hideStatus();
  kick(0.5);
}
function fitAll() {
  const act = nodes.filter(visible);
  if (!act.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const m = S.map && MAPPOS[S.map];
  if (m) {
    const b = m.box;
    x0 = b.cx - b.rx * 1.2; x1 = b.cx + b.rx * 1.2;
    y0 = b.cy - b.ry * 1.2; y1 = b.cy + b.ry * 1.7;
  } else
  for (const n of act) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const pad = 80;
  const pw = panel.classList.contains('open') && window.innerWidth > 820
    ? panel.getBoundingClientRect().width : 0;
  const availW = W - pw;
  S.cam.z = Math.min(2.5, Math.max(0.12,
    Math.min((availW - pad * 2) / (x1 - x0 || 1), (H - pad * 2) / (y1 - y0 || 1))));
  S.cam.x = (x0 + x1) / 2 + (pw / 2) / S.cam.z;
  S.cam.y = (y0 + y1) / 2;
}

/* ---------- status bar ---------- */
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusTxt');
document.getElementById('statusX').onclick = () => clearModes();
function status(msg) { statusText.innerHTML = msg; statusEl.classList.add('on'); }
function hideStatus() { statusEl.classList.remove('on'); }

/* ---------- trace ---------- */
function shortestPath(a, b) {
  const prev = new Map([[a.id, null]]);
  let frontier = [a];
  while (frontier.length) {
    const next = [];
    for (const n of frontier) {
      for (const e of adj.get(n.id)) {
        if (!shown(e) || prev.has(e.o.id)) continue;
        prev.set(e.o.id, n);
        if (e.o === b) {
          const path = [b]; let c = b;
          while (prev.get(c.id)) { c = prev.get(c.id); path.unshift(c); }
          return path;
        }
        next.push(e.o);
      }
    }
    frontier = next;
  }
  return null;
}
function pickTrace(n) {
  if (!S.traceFrom) {
    S.traceFrom = n;
    status(C.txt.traceFrom.replace('%s', '<b>' + esc(n.label) + '</b>'));
    return;
  }
  const path = shortestPath(S.traceFrom, n);
  if (!path) { status(C.txt.traceNone); return; }
  S.tracePath = path;
  const hops = path.length - 1;
  const chain = path.map((p, i) => {
    if (i === 0) return '<b>' + esc(trunc(p.label, 40)) + '</b>';
    const prev = path[i - 1];
    const e = adj.get(prev.id).find(x => x.o === p);
    const m = e ? G.types[e.t] : null;
    const verb = m ? (e.dir === 1 ? m.f : m.b).toLowerCase() : 'links to';
    return '<span style="color:var(--ink-3)"> ' + esc(verb) + ' </span><b>' + esc(trunc(p.label, 40)) + '</b>';
  }).join('');
  status(hops + ' step' + (hops === 1 ? '' : 's') + ': ' + chain);
  S.traceFrom = null; S.trace = false;
  btnTrace.classList.remove('on');
  select(null);
}
function clearModes() {
  S.trace = false; S.traceFrom = null; S.tracePath = null;
  S.focus = null; S.focusSet = null;
  btnTrace.classList.remove('on');
  hideStatus(); kick(0.3);
}

/* ---------- chips + legend, generated from config ---------- */
const counts = {};
function refreshCounts() {
  for (const k of ORDER) counts[k] = 0;
  for (const n of nodes) if ((n.g || 0) <= S.gate) counts[n.k] = (counts[n.k] || 0) + 1;
  for (const k of ORDER) {
    const el = document.querySelector('.chip[data-kind="' + k + '"] .n');
    if (el) el.textContent = counts[k];
  }
}
for (const n of nodes) counts[n.k] = (counts[n.k] || 0) + 1;
document.getElementById('chips').innerHTML = ORDER.map(k =>
  '<button class="chip" data-kind="' + k + '" aria-pressed="true">' + dotFor(k) +
  esc(KINDS[k].plural || KINDS[k].name) + ' <span class="n">' + (counts[k] || 0) + '</span></button>'
).join('');
const chipEls = [...document.querySelectorAll('.chip[data-kind]')];
chipEls.forEach(b => {
  b.onclick = () => {
    const k = b.dataset.kind;
    S.show[k] = !S.show[k];
    if (S.sel && !S.show[S.sel.k]) select(null);
    syncChips(); kick(0.55);
  };
});
function syncChips() {
  chipEls.forEach(b => b.setAttribute('aria-pressed', S.show[b.dataset.kind] ? 'true' : 'false'));
}
{
  const lg = document.getElementById('legend');
  if (lg) {
    lg.innerHTML = ORDER.map(k =>
      '<div class="lr">' + dotFor(k) + esc(KINDS[k].name) +
      '<span class="k">' + esc(KINDS[k].shape) + '</span></div>').join('') +
      '<div class="lr" style="margin-top:2px;padding-top:6px;border-top:1px solid var(--line-soft)">' +
      '<span style="font-family:var(--font-mono);font-size:10px;color:var(--ink-3)">' +
      nodes.length + ' nodes · ' + links.length + ' links · ' +
      Object.keys(G.types).length + ' relation types</span></div>';
  }
}

/* ---------- search ---------- */
const qEl = document.getElementById('q');
const resEl = document.getElementById('results');
let resSel = 0, resList = [];
function searchNodes(term) {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const out = [];
  for (const n of nodes) {
    if ((n.g || 0) > S.gate) continue;
    const hay = n.label.toLowerCase();
    let score = -1;
    if (hay.startsWith(t)) score = 0;
    else if (hay.includes(t)) score = 1;
    else if (n.alias && n.alias.toLowerCase().includes(t)) score = 2;
    else {
      const a = byId.get(n.by);
      if (a && a.label.toLowerCase().includes(t)) score = 3;
    }
    if (score >= 0) out.push({ n, score: score - Math.min(n.deg, 20) / 100 });
  }
  out.sort((a, b) => a.score - b.score || b.n.deg - a.n.deg);
  return out.slice(0, 40).map(o => o.n);
}
function renderResults() {
  if (!resList.length) { resEl.classList.remove('on'); return; }
  resEl.innerHTML = resList.map((n, i) =>
    '<div class="row' + (i === resSel ? ' sel' : '') + '" data-i="' + i + '">' +
    dotFor(n.k) + '<span class="nm">' +
    esc(QUOTED.has(n.k) ? '“' + trunc(n.label, 60) + '”' : n.label) +
    '</span><span class="yr">' + esc(sub(n)) + '</span></div>').join('');
  resEl.classList.add('on');
  resEl.querySelectorAll('.row').forEach(r => { r.onclick = () => go(resList[+r.dataset.i]); });
}
function go(n) {
  if (!n) return;
  resEl.classList.remove('on'); qEl.blur();
  flyTo(n); select(n);
}
qEl.addEventListener('input', () => { resList = searchNodes(qEl.value); resSel = 0; renderResults(); });
qEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { resSel = Math.min(resSel + 1, resList.length - 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { resSel = Math.max(resSel - 1, 0); renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter') go(resList[resSel]);
  else if (e.key === 'Escape') { qEl.value = ''; resEl.classList.remove('on'); qEl.blur(); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.search')) resEl.classList.remove('on');
});

/* ---------- toolbar ---------- */
const btnTrace = document.getElementById('traceBtn');
btnTrace.onclick = () => {
  S.trace = !S.trace; S.traceFrom = null; S.tracePath = null;
  btnTrace.classList.toggle('on', S.trace);
  if (S.trace) status(C.txt.traceOn); else hideStatus();
};
/* map buttons, one per real frame, built from the payload */
const tools = document.querySelector('.tools');
const mapBtns = [];
if (MAP && C.map) {
  for (const f of C.map.frames) {
    if (!MAPFRAMES[f.key]) continue;
    const b = document.createElement('button');
    b.className = 'tbtn'; b.textContent = f.label; b.title = f.title || '';
    b.onclick = () => {
      const on = S.map === f.key;
      S.map = on ? null : f.key;
      document.body.classList.toggle('map-on', !!S.map);
      if (S.map) { S.timeline = false; btnTime.classList.remove('on'); S.tracePath = null;
                   S.focus = null; S.focusSet = null; select(null); }
      mapBtns.forEach(x => x.el.classList.toggle('on', x.key === S.map));
      if (S.map) status(f.note || f.title || ''); else hideStatus();
      kick(1); setTimeout(fitAll, 700);
      if (S.map) setTimeout(fitAll, 1900);
    };
    tools.insertBefore(b, document.getElementById('btnRand'));
    mapBtns.push({ key: f.key, el: b });
  }
}

const btnTime = document.getElementById('timeBtn');
btnTime.onclick = () => {
  S.timeline = !S.timeline;
  if (S.timeline) { S.tracePath = null; S.focus = null; S.focusSet = null; select(null); }
  if (S.timeline) { S.map = null; document.body.classList.remove('map-on');
                    mapBtns.forEach(x => x.el.classList.remove('on')); }
  hideStatus();
  btnTime.classList.toggle('on', S.timeline);
  kick(1);
  // the rail takes a while to settle; fit once it has, then once more
  setTimeout(fitAll, S.timeline ? 900 : 400);
  if (S.timeline) setTimeout(fitAll, 2400);
};
document.getElementById('btnRand').onclick = () => {
  const pool = nodes.filter(n => visible(n) && n.deg > 2);
  go(pool[Math.floor(Math.random() * pool.length)]);
};
document.getElementById('btnReset').onclick = () => {
  clearModes(); select(null);
  for (const k of ORDER) S.show[k] = true;
  syncChips();
  for (const n of nodes) n.pinned = false;
  if (S.timeline) { S.timeline = false; btnTime.classList.remove('on'); }
  S.map = null; document.body.classList.remove('map-on');
  mapBtns.forEach(x => x.el.classList.remove('on'));
  kick(1); setTimeout(fitAll, 300);
};
document.getElementById('zin').onclick = () => zoomAt(W / 2, H / 2, 1.35);
document.getElementById('zout').onclick = () => zoomAt(W / 2, H / 2, 1 / 1.35);
document.getElementById('zfit').onclick = fitAll;

/* ---------- the spoiler gate ----------
   Every node and every link carries the tier at which it stops being a
   spoiler. The gate shows only what a viewer at that point in the story could
   already know, so the graph can be explored by someone who has not finished
   it — or has not started. */
const gateHost = document.getElementById('gate');
if (C.gate && gateHost) {
  gateHost.innerHTML =
    '<label class="gate"><span class="gk">' + esc(C.gate.label || 'Spoilers') + '</span>' +
    '<select id="gateSel">' + C.gate.levels.map((l, i) =>
      '<option value="' + i + '"' + (i === S.gate ? ' selected' : '') + '>' + esc(l) + '</option>'
    ).join('') + '</select></label>';
  const sel = document.getElementById('gateSel');
  sel.onchange = () => { setGate(+sel.value); };
}
function hiddenCount() {
  let n = 0, e = 0;
  for (const x of nodes) if ((x.g || 0) > S.gate) n++;
  for (const l of links) if ((l.g || 0) > S.gate) e++;
  return { n, e };
}
function setGate(g) {
  S.gate = g;
  if (S.sel && !visible(S.sel)) select(null);
  if (S.focus && !visible(S.focus)) { S.focus = null; S.focusSet = null; }
  S.tracePath = null;
  refreshCounts();
  const h = hiddenCount();
  if (h.n) status(C.gate.note.replace('%n', h.n).replace('%e', h.e)
                  .replace('%l', esc(C.gate.levels[S.gate])));
  else hideStatus();
  kick(1);
  setTimeout(fitAll, 500);
}

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '/') { e.preventDefault(); qEl.focus(); qEl.select(); }
  else if (e.key === 'Escape') { clearModes(); select(null); }
  else if (e.key === 'f' && S.sel) setFocus(S.focus === S.sel ? null : S.sel);
  else if (e.key === 't') btnTrace.click();
  else if (e.key === 'r') document.getElementById('btnRand').click();
});

/* ---------- public handle, for site-specific chrome ---------- */
window.ENGINE = {
  nodes, links, byId, state: S, select, flyTo, setFocus, fitAll, go, kick, setGate,
  count: k => counts[k] || 0, hiddenCount,
  setMap: key => { const b = mapBtns.find(x => x.key === key); if (b) b.el.click(); }
};

/* ---------- go ---------- */
resize();
for (let i = 0; i < 600; i++) { S.alpha = 1; tick(); }
S.alpha = 0.6;
fitAll();
loop();
kick(1);

if (C.gate) { refreshCounts(); const h = hiddenCount();
  if (h.n) setTimeout(() => status(C.gate.note.replace('%n', h.n).replace('%e', h.e)
    .replace('%l', esc(C.gate.levels[S.gate]))), 1200); }

const opener = byId.get(C.opener);
if (opener) setTimeout(() => { select(opener); flyTo(opener, 0.9); }, C.openerDelay ?? 420);
})();
