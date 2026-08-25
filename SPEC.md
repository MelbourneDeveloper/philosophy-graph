# The Lineage Engine — Data & Design Spec

An interactive graph of philosophy. Not tables — **associations**. You enter at any
node (a person, a book, a sentence, a school) and travel outward along typed edges.

---

## 1. Node kinds

| kind | code | shape in canvas | colour role | example |
|---|---|---|---|---|
| Thinker | `p` | filled circle | `--person` (blue) | Baruch Spinoza |
| Work | `w` | rounded square | `--work` (amber) | *Thus Spoke Zarathustra* |
| Quote | `q` | diamond | `--quote` (magenta) | "I think, therefore I am" |
| School | `m` | open ring | `--school` (green) | Stoicism |

Radius scales with degree (how connected the node is), clamped so leaves stay legible.

### Field schema

```
person  { id, k:'p', name, born, died, region, sep, blurb, alias? }
work    { id, k:'w', title, by, year, sep?, blurb }        // year: -380 = 380 BCE
quote   { id, k:'q', text, by, from?, ref?, flag? }        // ref = locus e.g. "Apology 38a"
school  { id, k:'m', name, from, to, sep?, blurb }         // from/to = active span
```

`born`/`died`/`year` are integers; negative = BCE; `null` = living or unknown.
`flag:'apocryphal'` marks a quote popularly attributed to the person but **not**
found in their work — shown in the UI with a warning, never silently dropped.

---

## 2. Relation taxonomy

The whole point. Edges are typed, directed, and rendered differently.

### Person → Person
| type | meaning | rendering |
|---|---|---|
| `taught` | A was B's teacher (documented, direct) | solid, arrowed |
| `influenced` | documented intellectual debt, no contact required | solid, arrowed, thin |
| `read` | A demonstrably read/annotated B across an era gap | dashed, arrowed |
| `friend` | personal friendship | solid, no arrow (mutual) |
| `rival` | sustained public opposition / polemic | dashed, no arrow |
| `correspondent` | exchanged letters | dotted, no arrow |
| `colleague` | same circle, institution, or salon | dotted, no arrow |
| `partner` | life partner | solid, no arrow, thick |
| `family` | blood or marriage | solid, no arrow |
| `translated` | A carried B into another language/tradition | dashed, arrowed |
| `commentary` | A wrote a commentary on B | dashed, arrowed |

### Person → Work `wrote` · Person → Quote `said` · Quote → Work `from`
### Person → School `founded` | `member` | `precursor` | `critic`
### Work → School `keytext`
### School → School `descends` | `reacts` (reacts against)
### Work → Work `responds` (a book written at another book)

Edges are stored once and traversed both ways; the panel shows the correct
direction-aware label for each side ("taught" vs "studied under").

---

## 3. Sourcing rules — non-negotiable

1. **Every thinker and school node carries a `sep` slug** resolving to
   `https://plato.stanford.edu/entries/<slug>/`. Slugs are validated against the
   live SEP table of contents (`plato.stanford.edu/contents.html`, 2,170 entries,
   pulled 2026-08-25) — a slug not in that index does not ship. The panel exposes
   it as a "Stanford Encyclopedia" link so any claim is one click from an
   authority.
2. **Dates** follow SEP entry consensus. Where scholarship is unsettled
   (Laozi, Pythagoras, Bodhidharma) the date is prefixed `c.` in display.
3. **Quotes** must be locatable in a named work; `ref` records the standard
   citation locus (Bekker/Stephanus number, section, aphorism, part/prop).
   Translations are the common English renderings; a quote with no locatable
   source is either dropped or shipped with `flag:'apocryphal'`.
4. **Relations** are drawn from the SEP entry for the person, plus standard
   scholarly consensus. A relation nobody would defend in a seminar does not ship.
   `influenced` is not "vaguely similar vibes" — it means a documented debt.

---

## 4. Interaction spec

- **Hover** — neighbourhood lights, everything else falls to 12% opacity; tooltip.
- **Click** — select; detail panel opens with blurb, dates, SEP link, and every
  relation grouped by type, each row a jump target.
- **Double-click** — *focus*: isolate the node's neighbourhood to 2 hops.
- **Drag node** — pin it. **Drag canvas** — pan. **Wheel/pinch** — zoom to cursor.
- **Search** (`/`) — typeahead over every node kind; Enter flies to the node.
- **Kind filters** — chips toggle thinkers / works / quotes / schools.
- **Trace** — pick two nodes, get the shortest chain of association between them
  (BFS), animated along the path. Answers "how does Buddhism reach Schopenhauer?"
- **Timeline** — swap force layout for chronological: x = year, y = relaxed.
- **Escape** — clear selection, focus, and trace.

## 5. Layout engine

Hand-rolled velocity-Verlet force sim on canvas (no libraries; CSP-safe):
link springs with per-type rest length, O(n²) repulsion with a distance cutoff,
weak centring gravity, and a **school-cluster force** pulling members toward
their school's centroid so the graph resolves into readable regions instead of a
hairball. Alpha decays to rest and re-heats on interaction.

## 6. Non-goals

No server, no build step, no dependencies. One `index.html`. Data lives in the
`DATA` block at the top of the script and is designed to be appended to by hand.
