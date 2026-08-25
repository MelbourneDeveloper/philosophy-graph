/* The Lineage Engine — force layout, canvas renderer, interaction.
   Data comes from window.GRAPH (generated: scripts/build.py). */
(function () {
'use strict';

const G = window.GRAPH;
const KIND = {
  p: { name: 'Thinker', css: '--person' },
  w: { name: 'Work',    css: '--work'   },
  q: { name: 'Quote',   css: '--quote'  },
  m: { name: 'School',  css: '--school' },
};
const REST = { wrote: 46, said: 34, from: 30, member: 92, founded: 78, precursor: 100,
               critic: 110, keytext: 90, taught: 84, influenced: 128, read: 130,
               friend: 70, partner: 46, rival: 120, correspondent: 86, colleague: 78,
               translated: 100, commentary: 96, descends: 140, reacts: 150, family: 60 };

/* ---------- model ---------- */
const nodes = G.nodes.map(n => Object.assign({}, n, {
  x: 0, y: 0, vx: 0, vy: 0, deg: 0, r: 4, pinned: false, hidden: false
}));
const byId = new Map(nodes.map(n => [n.id, n]));
const links = [];
for (const [a, b, t] of G.edges) {
  const s = byId.get(a), d = byId.get(b);
  if (!s || !d) continue;
  links.push({ s, d, t, rest: REST[t] || 100 });
  s.deg++; d.deg++;
}
const adj = new Map(nodes.map(n => [n.id, []]));
for (const l of links) {
  adj.get(l.s.id).push({ o: l.d, t: l.t, dir: 1, l });
  adj.get(l.d.id).push({ o: l.s, t: l.t, dir: -1, l });
}
for (const n of nodes) {
  const base = n.k === 'm' ? 7 : n.k === 'p' ? 4.2 : n.k === 'w' ? 3.4 : 2.6;
  n.r = base + Math.sqrt(n.deg) * (n.k === 'm' ? 1.5 : 1.25);
  if (n.k === 'q') n.r = Math.min(n.r, 5.5);
}
// seed positions: schools on a ring, everyone else near their school
const schools = nodes.filter(n => n.k === 'm');
schools.forEach((s, i) => {
  const a = (i / schools.length) * Math.PI * 2;
  s.x = Math.cos(a) * 620; s.y = Math.sin(a) * 620;
});
const homeOf = new Map();
for (const l of links) {
  if (l.t === 'member' || l.t === 'founded' || l.t === 'precursor') {
    if (!homeOf.has(l.s.id)) homeOf.set(l.s.id, l.d);
  }
}
for (const n of nodes) {
  if (n.k === 'm') continue;
  let h = homeOf.get(n.id);
  if (!h && n.by) h = homeOf.get(n.by);
  if (!h && n.k === 'q') { const w = byId.get(n.by); if (w) h = homeOf.get(w.id); }
  const j = () => (Math.random() - 0.5) * 130;
  n.x = (h ? h.x : 0) + j(); n.y = (h ? h.y : 0) + j();
  n.home = h || null;
}
for (const n of nodes) if (n.k !== 'm' && !n.home) { const p = byId.get(n.by); if (p) n.home = p.home || null; }

// deterministic vertical lane for timeline mode: bands by kind, spread within band
{
  const band = { m: -900, p: -260, w: 380, q: 880 };
  const seen = {};
  for (const n of nodes) {
    seen[n.k] = (seen[n.k] || 0) + 1;
    const jitter = ((seen[n.k] * 137.508) % 440) - 220;   // golden-angle spread
    n.laneY = band[n.k] + jitter;
  }
}

/* ---------- state ---------- */
const S = {
  show: { p: true, w: true, q: true, m: true },
  sel: null, hover: null, focus: null, focusSet: null,
  trace: null, traceFrom: null, tracePath: null,
  timeline: false, alpha: 1, drag: null,
  cam: { x: 0, y: 0, z: 0.62 }, t: 0,
};

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

function visible(n) { return S.show[n.k] && !n.hidden; }
function kick(a) { S.alpha = Math.max(S.alpha, a); }

/* ---------- forces ---------- */
const YEAR_MIN = -650, YEAR_MAX = 2050;
function timeX(y) { return ((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 4200 - 2100; }
function nodeYear(n) {
  if (n.born != null) return n.born;
  const p = byId.get(n.by); return p && p.born != null ? p.born : 1900;
}

function tick() {
  const a = S.alpha;
  if (a < 0.002) return;
  const act = nodes.filter(visible);

  // repulsion (O(n^2) with cutoff; n is small enough)
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
  // schools repel one another strongly to keep regions distinct
  const sc = schools.filter(visible);
  for (let i = 0; i < sc.length; i++) for (let j = i + 1; j < sc.length; j++) {
    const p = sc[i], q = sc[j];
    let dx = q.x - p.x, dy = q.y - p.y;
    let d2 = dx * dx + dy * dy;
    if (d2 === 0) { dx = Math.random(); dy = Math.random(); d2 = 1; }
    if (d2 > 700000) continue;
    const d = Math.sqrt(d2);
    const f = (260000 / d2) * a;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    p.vx -= fx; p.vy -= fy; q.vx += fx; q.vy += fy;
  }

  // link springs
  for (const l of links) {
    if (!visible(l.s) || !visible(l.d)) continue;
    const dx = l.d.x - l.s.x, dy = l.d.y - l.s.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = ((d - l.rest) / d) * 0.055 * a;
    const fx = dx * f, fy = dy * f;
    l.s.vx += fx; l.s.vy += fy; l.d.vx -= fx; l.d.vy -= fy;
  }
  // school clustering + gravity, or the timeline rail
  for (const n of act) {
    if (S.timeline) {
      // x is pinned to the date; y is free so the column can breathe
      const tx = timeX(nodeYear(n));
      n.vx += (tx - n.x) * 0.14 * a;
      n.vy += (n.laneY - n.y) * 0.020 * a;
    } else {
      if (n.home && visible(n.home)) {
        n.vx += (n.home.x - n.x) * 0.030 * a;
        n.vy += (n.home.y - n.y) * 0.030 * a;
      }
      const g = n.k === 'm' ? 0.0009 : 0.0022;
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

/* ---------- neighbourhood highlight ---------- */
function neighbourhood(n) {
  if (!n) return null;
  const s = new Set([n.id]);
  for (const e of adj.get(n.id)) s.add(e.o.id);
  return s;
}
function ego(n, hops) {
  const s = new Set([n.id]); let frontier = [n];
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const f of frontier) for (const e of adj.get(f.id)) {
      if (!s.has(e.o.id)) { s.add(e.o.id); next.push(e.o); }
    }
    frontier = next;
  }
  return s;
}

/* ---------- render ---------- */
const css = getComputedStyle(document.documentElement);
function col(name) { return css.getPropertyValue(name).trim(); }
let PAL = {};
function refreshPalette() {
  const c = getComputedStyle(document.documentElement);
  PAL = { p: c.getPropertyValue('--person').trim(), w: c.getPropertyValue('--work').trim(),
          q: c.getPropertyValue('--quote').trim(), m: c.getPropertyValue('--school').trim(),
          ink: c.getPropertyValue('--ink').trim(), ink2: c.getPropertyValue('--ink-2').trim(),
          ink3: c.getPropertyValue('--ink-3').trim(), line: c.getPropertyValue('--line').trim() };
}
refreshPalette();
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(
    () => { refreshPalette(); });
}

function toScreen(n) {
  return { x: (n.x - S.cam.x) * S.cam.z + W / 2, y: (n.y - S.cam.y) * S.cam.z + H / 2 };
}
function toWorld(sx, sy) {
  return { x: (sx - W / 2) / S.cam.z + S.cam.x, y: (sy - H / 2) / S.cam.z + S.cam.y };
}

function labelFor(n) {
  if (n.k !== 'q') return n.label;
  const t = n.label;
  return t.length > 46 ? '“' + t.slice(0, 44).trim() + '…”' : '“' + t + '”';
}

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

  // ---- links ----
  ctx.lineCap = 'round';
  for (const l of links) {
    if (!visible(l.s) || !visible(l.d)) continue;
    const a = toScreen(l.s), b = toScreen(l.d);
    if (Math.max(a.x, b.x) < -60 || Math.min(a.x, b.x) > W + 60) continue;
    if (Math.max(a.y, b.y) < -60 || Math.min(a.y, b.y) > H + 60) continue;

    const onPath = pathEdges.has(l.s.id + '|' + l.d.id) || pathEdges.has(l.d.id + '|' + l.s.id);
    const lit = active ? (active.has(l.s.id) && active.has(l.d.id)) : false;
    let alpha = active ? (onPath ? 1 : lit ? 0.75 : dim * 0.45) : 0.24;
    if (S.tracePath && !onPath) alpha = 0.05;

    const meta = G.types[l.t] || {};
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = onPath ? PAL.p : (lit ? PAL[l.s.k] : PAL.ink3);
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

    ctx.beginPath();
    if (n.k === 'p') {
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    } else if (n.k === 'w') {
      const s = r * 1.72, rad = Math.min(2.6, s / 3);
      roundRect(ctx, p.x - s / 2, p.y - s / 2, s, s, rad);
      ctx.fillStyle = c; ctx.fill();
    } else if (n.k === 'q') {
      const s = r * 1.25;
      ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y);
      ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s, p.y);
      ctx.closePath(); ctx.fillStyle = c; ctx.fill();
    } else {
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = c; ctx.lineWidth = Math.max(1.6, r * 0.32); ctx.stroke();
    }
    if (isSel) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke();
    }
    ctx.restore();

    const wantLabel = isSel || isHov || (active && active.has(n.id) && z > 0.3)
      || (!active && (n.k === 'm' ? z > 0.28 : n.deg >= 9 ? z > 0.5 : z > 1.0));
    if (wantLabel) labelled.push({ n, p, r, lit });
  }

  // ---- labels on top ----
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const boxes = [];
  labelled.sort((a, b) => (b.n.deg - a.n.deg));
  for (const { n, p, r, lit } of labelled) {
    const isM = n.k === 'm';
    const size = isM ? 12.5 : n.k === 'p' ? 11.5 : 10.5;
    ctx.font = (isM ? '500 ' : '400 ') + size + 'px ' +
      (n.k === 'q' ? 'Newsreader, Georgia, serif' : 'IBM Plex Sans, system-ui, sans-serif');
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
    ctx.save();
    ctx.globalAlpha = lit ? 1 : 0.15;
    ctx.lineWidth = 3.2; ctx.strokeStyle = col('--bg');
    ctx.strokeText(text, x, y);
    ctx.fillStyle = (S.sel === n || S.hover === n) ? PAL[n.k] : PAL.ink2;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // timeline axis
  if (S.timeline) drawAxis();
}

function roundRect(c, x, y, w, h, r) {
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
}

function drawAxis() {
  ctx.save();
  // band labels down the left edge
  const band = { m: -900, p: -260, w: 380, q: 880 };
  ctx.font = '500 10px IBM Plex Mono, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const k of ['m', 'p', 'w', 'q']) {
    const sy = (band[k] - S.cam.y) * S.cam.z + H / 2;
    if (sy < 10 || sy > H - 30) continue;
    ctx.globalAlpha = 0.5; ctx.fillStyle = PAL[k];
    ctx.fillText(PLURAL[k].toUpperCase(), 12, sy);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.font = '10px IBM Plex Mono, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.strokeStyle = PAL.line; ctx.fillStyle = PAL.ink3; ctx.lineWidth = 1;
  const marks = [-600, -400, -200, 1, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1700, 1800, 1900, 2000];
  for (const m of marks) {
    const sx = (timeX(m) - S.cam.x) * S.cam.z + W / 2;
    if (sx < 30 || sx > W - 30) continue;
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H - 22); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(m < 0 ? Math.abs(m) + ' BCE' : m, sx, H - 8);
  }
  ctx.restore();
}

/* ---------- loop ---------- */
let raf;
function loop() { tick(); draw(); raf = requestAnimationFrame(loop); }

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

/* ---------- pointer ---------- */
let pointer = { down: false, moved: false, sx: 0, sy: 0, node: null, lastT: 0 };
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  const n = nodeAt(e.offsetX, e.offsetY);
  pointer = { down: true, moved: false, sx: e.offsetX, sy: e.offsetY, node: n, lastT: Date.now() };
  if (n) { n.pinned = true; S.drag = n; }
  cv.classList.add('grabbing');
});
cv.addEventListener('pointermove', e => {
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
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n !== S.hover) { S.hover = n; cv.classList.toggle('pointing', !!n); }
  showTip(n, e.offsetX, e.offsetY);
});
cv.addEventListener('pointerup', e => {
  cv.classList.remove('grabbing');
  const wasDrag = pointer.moved;
  const n = pointer.node;
  if (S.drag) S.drag = null;
  pointer.down = false;
  if (!wasDrag) {
    if (n) {
      if (S.trace) { pickTrace(n); }
      else select(n);
    } else if (!S.trace) { select(null); }
  }
});
cv.addEventListener('pointerleave', () => { S.hover = null; hideTip(); });
cv.addEventListener('dblclick', e => {
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n) { setFocus(S.focus === n ? null : n); }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0016);
  zoomAt(e.offsetX, e.offsetY, f);
}, { passive: false });

function zoomAt(sx, sy, f) {
  const before = toWorld(sx, sy);
  S.cam.z = Math.min(4.5, Math.max(0.12, S.cam.z * f));
  const after = toWorld(sx, sy);
  S.cam.x += before.x - after.x; S.cam.y += before.y - after.y;
}

/* ---------- tooltip ---------- */
const tip = document.getElementById('tooltip');
function showTip(n, x, y) {
  if (!n) return hideTip();
  const k = KIND[n.k];
  let sub = '';
  if (n.k === 'p') sub = years(n);
  else if (n.k === 'w') { const a = byId.get(n.by); sub = (a ? a.name || a.label : '') + (n.born != null ? ' · ' + yr(n.born) : ''); }
  else if (n.k === 'q') { const a = byId.get(n.by); sub = a ? a.label : ''; }
  else if (n.k === 'm') sub = span(n);
  tip.innerHTML = '<span class="tk">' + k.name + (sub ? ' · ' + esc(sub) : '') + '</span>' +
    (n.k === 'q' ? '<span class="tq">“' + esc(n.label) + '”</span>' : esc(n.label));
  tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  let tx = x + 14, ty = y + 14;
  if (tx + r.width > W - 8) tx = x - r.width - 12;
  if (ty + r.height > H - 8) ty = y - r.height - 12;
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
}
function hideTip() { tip.classList.remove('on'); }

/* ---------- formatting ---------- */
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function yr(y) { return y == null ? '' : (y < 0 ? Math.abs(y) + ' BCE' : String(y)); }
function years(n) {
  if (n.born == null) return '';
  return yr(n.born) + ' – ' + (n.died == null ? 'present' : yr(n.died));
}
function span(n) {
  if (n.born == null) return '';
  return yr(n.born) + ' – ' + (n.died == null ? 'ongoing' : yr(n.died));
}

/* ---------- detail panel ---------- */
const panel = document.getElementById('panel');
const pKind = document.getElementById('pkind');
const pTitle = document.getElementById('ptitle');
const pMeta = document.getElementById('pmeta');
const pBody = document.getElementById('pbody');
document.getElementById('pclose').onclick = () => select(null);

function dotFor(k) {
  const cls = k === 'w' ? 'dot sq' : k === 'q' ? 'dot di' : k === 'm' ? 'dot ri' : 'dot';
  const style = k === 'm' ? 'color:var(' + KIND[k].css + ')' : 'background:var(' + KIND[k].css + ')';
  return '<span class="' + cls + '" style="' + style + '"></span>';
}

function select(n) {
  S.sel = n;
  document.getElementById('zoomctl').classList.toggle('shift', !!n);
  if (!n) { panel.classList.remove('open'); return; }
  panel.classList.add('open');
  const k = KIND[n.k];
  pKind.innerHTML = dotFor(n.k) + '<span>' + k.name + '</span>';
  pTitle.className = 'p-title' + (n.k === 'q' ? ' q' : '');
  pTitle.textContent = n.k === 'q' ? '“' + n.label + '”' : n.label;

  const meta = [];
  if (n.k === 'p') { if (years(n)) meta.push(years(n)); if (n.region) meta.push(n.region); }
  if (n.k === 'w') { if (n.born != null) meta.push(yr(n.born)); }
  if (n.k === 'm') { if (span(n)) meta.push(span(n)); }
  if (n.k === 'q' && n.ref) meta.push(n.ref);
  meta.push(n.deg + ' link' + (n.deg === 1 ? '' : 's'));
  pMeta.innerHTML = meta.map(esc).join('<span style="opacity:.4">/</span>');

  let html = '';
  if (n.flag === 'apocryphal') {
    html += '<p class="blurb" style="border-left:2px solid var(--work);padding-left:10px">' +
      '<strong>Probably not theirs.</strong> Widely attributed, but not located in their work. ' +
      (n.ref ? esc(n.ref) + '.' : '') + '</p>';
  }
  if (n.blurb) html += '<p class="blurb">' + esc(n.blurb) + '</p>';

  // group relations by type, direction-aware
  const groups = new Map();
  for (const e of adj.get(n.id)) {
    const meta2 = G.types[e.t];
    if (!meta2) continue;
    const label = e.dir === 1 ? meta2.f : meta2.b;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(e.o);
  }
  const order = ['Wrote', 'Said', 'Taught', 'Studied under', 'Influenced', 'Influenced by',
    'Friend of', 'Partner of', 'Colleague of', 'Corresponded with', 'Argued against',
    'Attacked by', 'Read', 'Read by', 'Transmitted', 'Transmitted by',
    'Wrote commentary on', 'Commented on by', 'Founded', 'Belonged to', 'Anticipated',
    'From', 'Contains', 'Key text of', 'Key texts', 'Members', 'Founded by',
    'Anticipated by', 'Critics', 'Gave rise to', 'Descends from', 'Provoked', 'Reacts against'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const key of keys) {
    const items = groups.get(key);
    items.sort((a, b) => (a.born ?? 9999) - (b.born ?? 9999));
    html += '<div class="sect"><h3>' + esc(key) + ' <span style="color:var(--ink-3)">' +
      items.length + '</span></h3><div class="list">';
    for (const o of items) {
      let t2 = '';
      if (o.k === 'p') t2 = years(o);
      else if (o.k === 'w') { const a = byId.get(o.by); t2 = [a ? a.label : '', yr(o.born)].filter(Boolean).join(' · '); }
      else if (o.k === 'q') { const a = byId.get(o.by); t2 = [a ? a.label : '', o.ref].filter(Boolean).join(' · '); }
      else if (o.k === 'm') t2 = span(o);
      html += '<button class="item' + (o.k === 'q' ? ' qi' : '') + '" data-go="' + esc(o.id) + '">' +
        dotFor(o.k) + '<span class="txt"><span class="t1">' +
        esc(o.k === 'q' ? '“' + trunc(o.label, 90) + '”' : o.label) + '</span>' +
        (t2 ? '<span class="t2">' + esc(t2) + '</span>' : '') + '</span>' +
        (o.flag === 'apocryphal' ? '<span class="pill">disputed</span>' : '') + '</button>';
    }
    html += '</div></div>';
  }

  if (n.sep) {
    html += '<div class="sect"><h3>Source</h3><a class="item" style="text-decoration:none" ' +
      'href="https://plato.stanford.edu/entries/' + esc(n.sep) + '/" target="_blank" rel="noopener">' +
      '<span class="dot" style="background:var(--ink-3)"></span><span class="txt">' +
      '<span class="t1">Stanford Encyclopedia of Philosophy &#8599;</span>' +
      '<span class="t2">plato.stanford.edu/entries/' + esc(n.sep) + '</span></span></a></div>';
  }
  pBody.innerHTML = html;
  pBody.scrollTop = 0;
  pBody.querySelectorAll('[data-go]').forEach(b => {
    b.onclick = () => { const t = byId.get(b.dataset.go); if (t) { flyTo(t); select(t); } };
  });
}
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; }

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
  if (n) { status('Isolated: ' + n.label + ' and everything within two steps.'); flyTo(n, 0.85); }
  else hideStatus();
  kick(0.5);
}
function fitAll() {
  const act = nodes.filter(visible);
  if (!act.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of act) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const pad = 80;
  const panelW = document.getElementById('panel').classList.contains('open')
    ? document.getElementById('panel').getBoundingClientRect().width : 0;
  const availW = W - panelW;
  S.cam.z = Math.min(2.5, Math.max(0.12,
    Math.min((availW - pad * 2) / (x1 - x0 || 1), (H - pad * 2) / (y1 - y0 || 1))));
  S.cam.x = (x0 + x1) / 2 + (panelW / 2) / S.cam.z;
  S.cam.y = (y0 + y1) / 2;
}

/* ---------- status bar ---------- */
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusTxt');
document.getElementById('statusX').onclick = () => { clearModes(); };
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
        if (!visible(e.o) || prev.has(e.o.id)) continue;
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
    status('Tracing from <b>' + esc(n.label) + '</b>. Now click where you want to end up.');
    return;
  }
  const path = shortestPath(S.traceFrom, n);
  if (!path) { status('No chain of association connects those two — try widening the filters.'); return; }
  S.tracePath = path;
  const hops = path.length - 1;
  const chain = path.map((p, i) => {
    if (i === 0) return '<b>' + esc(p.label) + '</b>';
    const prev = path[i - 1];
    const e = adj.get(prev.id).find(x => x.o === p);
    const meta = e ? G.types[e.t] : null;
    const verb = meta ? (e.dir === 1 ? meta.f : meta.b).toLowerCase() : 'links to';
    return '<span style="color:var(--ink-3)"> ' + esc(verb) + ' </span><b>' + esc(trunc(p.label, 40)) + '</b>';
  }).join('');
  status(hops + ' step' + (hops === 1 ? '' : 's') + ': ' + chain);
  S.traceFrom = null; S.trace = false;
  document.getElementById('traceBtn').classList.remove('on');
  select(null);
}
function clearModes() {
  S.trace = false; S.traceFrom = null; S.tracePath = null;
  S.focus = null; S.focusSet = null;
  document.getElementById('traceBtn').classList.remove('on');
  hideStatus(); kick(0.3);
}

/* ---------- filter chips ---------- */
const counts = { p: 0, w: 0, q: 0, m: 0 };
for (const n of nodes) counts[n.k]++;
const PLURAL = { p: 'Thinkers', w: 'Works', q: 'Quotes', m: 'Schools' };
['p','w','q','m'].forEach(k => {
  const el = document.getElementById('n' + k);
  if (el) el.textContent = counts[k];
});
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

/* ---------- legend footer ---------- */
(function () {
  const lg = document.getElementById('legend');
  if (!lg) return;
  const d = document.createElement('div');
  d.className = 'lr';
  d.style.cssText = 'margin-top:2px;padding-top:6px;border-top:1px solid var(--line-soft)';
  d.innerHTML = '<span style="font-family:var(--font-mono);font-size:10px;color:var(--ink-3)">' +
    nodes.length + ' nodes · ' + links.length + ' associations · ' +
    Object.keys(G.types).length + ' relation types</span>';
  lg.appendChild(d);
})();

/* ---------- search ---------- */
const qEl = document.getElementById('q');
const resEl = document.getElementById('results');
let resSel = 0, resList = [];
function searchNodes(term) {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const out = [];
  for (const n of nodes) {
    const hay = n.label.toLowerCase();
    let score = -1;
    if (hay.startsWith(t)) score = 0;
    else if (hay.includes(t)) score = 1;
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
  resEl.innerHTML = resList.map((n, i) => {
    let sub = n.k === 'p' ? years(n)
      : n.k === 'w' ? (byId.get(n.by) || {}).label || ''
      : n.k === 'q' ? (byId.get(n.by) || {}).label || ''
      : span(n);
    return '<div class="row' + (i === resSel ? ' sel' : '') + '" data-i="' + i + '">' +
      dotFor(n.k) + '<span class="nm">' + esc(n.k === 'q' ? '“' + trunc(n.label, 60) + '”' : n.label) +
      '</span><span class="yr">' + esc(sub) + '</span></div>';
  }).join('');
  resEl.classList.add('on');
  resEl.querySelectorAll('.row').forEach(r => {
    r.onclick = () => go(resList[+r.dataset.i]);
  });
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
  else if (e.key === 'Enter') { go(resList[resSel]); }
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
  if (S.trace) status('Trace mode: click any two nodes to find the shortest chain between them.');
  else hideStatus();
};
const btnTime = document.getElementById('timeBtn');
btnTime.onclick = () => {
  S.timeline = !S.timeline;
  if (S.timeline) { S.tracePath = null; S.focus = null; S.focusSet = null; select(null); }
  btnTime.classList.toggle('on', S.timeline);
  kick(1);
  if (S.timeline) { setTimeout(() => { fitAll(); }, 900); }
  else setTimeout(fitAll, 400);
};
document.getElementById('btnRand').onclick = () => {
  const pool = nodes.filter(n => visible(n) && n.deg > 2);
  const n = pool[Math.floor(Math.random() * pool.length)];
  go(n);
};
document.getElementById('btnReset').onclick = () => {
  clearModes(); select(null);
  S.show = { p: true, w: true, q: true, m: true }; syncChips();
  for (const n of nodes) n.pinned = false;
  if (S.timeline) { S.timeline = false; btnTime.classList.remove('on'); }
  kick(1); setTimeout(fitAll, 300);
};
document.getElementById('zin').onclick = () => zoomAt(W / 2, H / 2, 1.35);
document.getElementById('zout').onclick = () => zoomAt(W / 2, H / 2, 1 / 1.35);
document.getElementById('zfit').onclick = fitAll;

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '/') { e.preventDefault(); qEl.focus(); qEl.select(); }
  else if (e.key === 'Escape') { clearModes(); select(null); }
  else if (e.key === 'f' && S.sel) setFocus(S.focus === S.sel ? null : S.sel);
  else if (e.key === 't') btnTrace.click();
  else if (e.key === 'r') document.getElementById('btnRand').click();
});

/* ---------- go ---------- */
resize();
for (let i = 0; i < 600; i++) { S.alpha = 1; tick(); }
S.alpha = 0.6;
fitAll();
loop();
kick(1);

// open on something worth opening
const opener = byId.get('nietzsche');
if (opener) setTimeout(() => { select(opener); flyTo(opener, 0.9); }, 420);
})();
