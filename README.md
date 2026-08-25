# The Lineage Engine

An interactive graph of philosophy: thinkers, their books, their sentences, and
the schools they made — connected by **typed associations** rather than tables.

Open `index.html` (or serve the folder) and start anywhere.

## What's in it

| | count |
|---|---|
| Thinkers | 171 |
| Works | 146 |
| Quotes | 108 |
| Schools | 45 |
| **Associations** | **946** across **21 relation types** |

Relations are not a single "related to" edge. They are `taught`, `studied under`,
`influenced`, `friend`, `partner`, `rival`, `correspondent`, `colleague`,
`translated`, `commentary`, `founded`, `member`, `precursor`, `critic`,
`descends`, `reacts`, `wrote`, `said`, `from`, `keytext`, `read` — each rendered
differently and labelled direction-aware in the panel.

Coverage runs Thales → Butler, and includes the Chinese, Indian, Islamic and
Jewish traditions alongside the Western canon, plus the scientists whose work
forced philosophy to move: Copernicus, Galileo, Newton, Darwin, Freud, Einstein,
Bohr, Heisenberg, Gödel, Turing, Hawking.

## Sourcing

Every thinker and school carries a **Stanford Encyclopedia of Philosophy** slug,
validated at build time against the live SEP entry index (2,170 entries). A slug
that doesn't resolve fails the build — 206 nodes link straight to their SEP
entry; the rest carry `NULL` rather than a fabricated link.

Quotes record their citation locus (`Apology 38a`, `Twilight of the Idols,
Maxims and Arrows 8`). Eight popular misattributions ship deliberately, flagged
**disputed** — including the Voltaire quote that is actually Evelyn Beatrice
Hall, and the two most-quoted "Gandhi" lines he never wrote.

## The database

SQLite is the source of truth. The site is a generated artefact.

```
db/schema.sql          tables + the relation taxonomy
db/source.json         curated content, hand-editable
db/sep_index.tsv       authoritative SEP slugs
db/sep_summaries.json  cached SEP entry excerpts (attributed in the UI)
db/philosophy.db       built store
```

Rebuild end to end:

```bash
./scripts/rebuild.sh           # offline: source.json -> philosophy.db -> site/graph.js
./scripts/rebuild.sh --fetch   # also refresh the SEP index + entry summaries first
```

Or stage by stage: `fetch_sep_index.sh` (slug index), `fetch_sep_summaries.py`
(polite, cached, resumable — only fetches what's missing), `seed.py`, `build.py`.

`seed.py` enforces the sourcing rules: dangling endpoints, unknown edge types,
domain/range mismatches and bad SEP slugs are hard failures, not warnings.
Authorship, utterance and key-text edges are *derived* from the tables rather
than hand-listed, so they can't drift.

Query it directly:

```bash
sqlite3 db/philosophy.db "SELECT p.name, count(*) c FROM edge e
  JOIN person p ON p.id=e.b WHERE e.type='influenced'
  GROUP BY 1 ORDER BY c DESC LIMIT 10;"
```

## Using it

- **Click** a node for its dossier · **double-click** to isolate two hops
- **Drag** to pin, **scroll** to zoom, **`/`** to search
- **Trace a lineage** — pick any two nodes for the shortest chain of association
  between them. *Buddhism → Buddha → Schopenhauer → Nietzsche.*
- **Timeline** — swap the force layout for the chronological axis
- Keys: `/` search · `f` focus · `t` trace · `r` random · `Esc` clear

## Files

```
index.html      shell, styles, markup
site/app.js     force simulation, canvas renderer, interaction
site/graph.js   GENERATED payload — do not edit
db/, scripts/   the database and its build pipeline
SPEC.md         data model, relation taxonomy, sourcing rules
```

No dependencies, no build step for the page itself, no server required.
