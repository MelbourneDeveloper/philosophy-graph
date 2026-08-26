/* The Lineage Engine — everything the shared engine needs to know about this
   particular world. The engine is domain-neutral; this file is the entire
   domain. See ../../graph-engine/README.md § Config. */
window.GRAPH_CONFIG = (function () {
'use strict';

function yr(v) { return v == null ? '' : (v < 0 ? Math.abs(v) + ' BCE' : String(v)); }
function span(n, open) {
  if (n.t0 == null) return '';
  return yr(n.t0) + ' – ' + (n.t1 == null ? open : yr(n.t1));
}

return {
  title: 'The Lineage Engine',
  opener: 'nietzsche',
  fontUI: 'IBM Plex Sans, system-ui, sans-serif',
  fontQuote: 'Newsreader, Georgia, serif',
  fontMono: 'IBM Plex Mono, monospace',

  kinds: {
    p: { name: 'Thinker', plural: 'Thinkers', shape: 'circle',  color: '--person', size: 4.2, grow: 1.25, label: 11.5 },
    w: { name: 'Work',    plural: 'Works',    shape: 'square',  color: '--work',   size: 3.4, grow: 1.25, label: 10.5 },
    q: { name: 'Quote',   plural: 'Quotes',   shape: 'diamond', color: '--quote',  size: 2.6, grow: 1.25, rmax: 5.5, label: 10.5 },
    m: { name: 'School',  plural: 'Schools',  shape: 'ring',    color: '--school', size: 7.0, grow: 1.50, label: 12.5 },
  },
  kindOrder: ['p', 'w', 'q', 'm'],
  quoteKinds: ['q'],

  /* Schools are the gravity wells: members settle around the school they
     belong to, so the graph resolves into readable regions rather than a
     hairball. */
  clusterKind: 'm',
  clusterEdges: ['member', 'founded', 'precursor'],

  restDefault: 100,
  rest: {
    wrote: 46, said: 34, from: 30, member: 92, founded: 78, precursor: 100,
    critic: 110, keytext: 90, taught: 84, influenced: 128, read: 130,
    friend: 70, partner: 46, rival: 120, correspondent: 86, colleague: 78,
    translated: 100, commentary: 96, descends: 140, reacts: 150, family: 60,
  },

  timeline: {
    fallback: 1900,
    bands: { m: -900, p: -260, w: 380, q: 880 },
    stops: [[-650, -2100], [2050, 2100]],
    marks: [-600, -400, -200, 1, 200, 400, 600, 800, 1000, 1200, 1400, 1600,
            1700, 1800, 1900, 2000],
    label: yr,
  },
  // a work sits at its year; a quote sits with whoever said it
  time(n, byId) {
    if (n.t0 != null) return n.t0;
    const a = byId.get(n.by);
    return a && a.t0 != null ? a.t0 : 1900;
  },

  meta(n, H) {
    const out = [];
    if (n.k === 'p') { const s = span(n, 'present'); if (s) out.push(s); if (n.where) out.push(n.where); }
    else if (n.k === 'w') { if (n.t0 != null) out.push(yr(n.t0)); }
    else if (n.k === 'm') { const s = span(n, 'ongoing'); if (s) out.push(s); }
    else if (n.k === 'q' && n.ref) out.push(n.ref);
    return out;
  },
  sub(n, H) {
    if (n.k === 'p') return span(n, 'present');
    if (n.k === 'm') return span(n, 'ongoing');
    const a = H.get(n.by);
    if (n.k === 'w') return [a ? a.label : '', yr(n.t0)].filter(Boolean).join(' · ');
    if (n.k === 'q') return [a ? a.label : '', n.ref].filter(Boolean).join(' · ');
    return '';
  },

  /* Eight popular misattributions ship deliberately, flagged rather than
     silently dropped. */
  flagNote(n, H) {
    if (n.flag !== 'apocryphal') return '';
    return '<p class="blurb" style="border-left:2px solid var(--work);padding-left:10px">' +
      '<strong>Probably not theirs.</strong> Widely attributed, but not located in ' +
      'their work. ' + (n.ref ? H.esc(n.ref) + '.' : '') + '</p>';
  },

  source: {
    label: 'Stanford Encyclopedia of Philosophy',
    url: slug => 'https://plato.stanford.edu/entries/' + slug + '/',
    pretty: slug => 'plato.stanford.edu/entries/' + slug,
  },

  focusMsg: l => 'Isolated: ' + l + ' and everything within two steps.',
  txt: {
    traceOn: 'Trace mode: click any two nodes to find the shortest chain between them.',
    traceFrom: 'Tracing from %s. Now click where you want to end up.',
    traceNone: 'No chain of association connects those two — try widening the filters.',
  },
};
})();
