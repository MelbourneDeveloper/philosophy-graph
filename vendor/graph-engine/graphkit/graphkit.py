#!/usr/bin/env python3
"""graphkit — the domain-neutral half of the pipeline.

    db/source.json  --seed-->  db/<name>.db  --build-->  site/graph.js

Everything specific to a dataset lives in source.json's `meta` block: the node
kinds, the relation taxonomy, the derived-edge rules, and where the citation
slugs are validated against. graphkit itself knows nothing about philosophers
or Douglas firs.

The seed step is where the sourcing rules are *enforced*: an unknown slug, a
dangling edge endpoint or a domain/range mismatch is a hard failure, never a
warning, so a bad row cannot reach a browser.

Used by both sites via a two-line wrapper - see scripts/seed.py.
"""
import json, os, sqlite3, sys

# Every column a node row may declare. Kinds pick the subset they use, in
# order, via meta.kinds[].fields - rows are positional so the source file stays
# hand-editable and diffable.
NODE_COLS = ['id', 'kind', 'label', 't0', 't1', 'where_', 'src', 'blurb',
             'by', 'via', 'ref', 'flag', 'alias', 'gate']

SCHEMA = """
PRAGMA foreign_keys = ON;
DROP TABLE IF EXISTS edge;
DROP TABLE IF EXISTS node;
DROP TABLE IF EXISTS src_entry;
DROP TABLE IF EXISTS edge_type;

-- Authoritative slug index for the citation source. Every `src` reference in
-- the data must resolve here or the build fails.
CREATE TABLE src_entry (
  slug    TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  summary TEXT,               -- opening excerpt, for the panel
  authors TEXT                -- attribution
);

CREATE TABLE node (
  id     TEXT PRIMARY KEY,
  kind   TEXT NOT NULL,       -- one of meta.kinds[].code
  label  TEXT NOT NULL,
  t0     REAL,                -- start of the node on the time axis
  t1     REAL,                -- end; NULL = open
  where_ TEXT,                -- region / home / place of record
  src    TEXT REFERENCES src_entry(slug),
  blurb  TEXT,
  by     TEXT,                -- primary owner: author, speaker, occupant
  via    TEXT,                -- secondary reference: source work, host episode
  ref    TEXT,                -- citation locus / production code
  flag   TEXT,                -- 'disputed', 'apocryphal', …
  alias  TEXT,                -- extra search terms
  gate   INTEGER DEFAULT 0    -- spoiler tier: 0 = knowable from the premise
);

-- The relation taxonomy is data, not magic strings.
CREATE TABLE edge_type (
  type      TEXT PRIMARY KEY,
  domain    TEXT NOT NULL,    -- node kind code
  range     TEXT NOT NULL,
  label_fwd TEXT NOT NULL,    -- how a → b reads from a's side
  label_rev TEXT NOT NULL,    -- how it reads from b's side
  directed  INTEGER NOT NULL, -- 1 = arrowed
  style     TEXT NOT NULL,    -- solid | dashed | dotted
  ord       INTEGER NOT NULL  -- taxonomy order; drives panel section order
);

CREATE TABLE edge (
  a    TEXT NOT NULL REFERENCES node(id),
  b    TEXT NOT NULL REFERENCES node(id),
  type TEXT NOT NULL REFERENCES edge_type(type),
  gate INTEGER,                -- spoiler tier; NULL = inherit from the endpoints
  note TEXT,
  PRIMARY KEY (a, b, type)
);

CREATE INDEX idx_edge_a ON edge(a);
CREATE INDEX idx_edge_b ON edge(b);
CREATE INDEX idx_node_kind ON node(kind);
CREATE INDEX idx_node_by ON node(by);
"""


def load(root):
    return json.load(open(os.path.join(root, 'db', 'source.json')))


# --------------------------------------------------------------------------- seed
def seed(root, db_path, extra=None):
    src = load(root)
    meta = src['meta']
    errors = []

    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)

    # --- the citation slug index -------------------------------------------
    slugs = set()
    idx = meta.get('source', {}).get('index')
    if idx:
        path = os.path.join(root, 'db', idx)
        rows = []
        with open(path) as f:
            for line in f:
                if '\t' not in line:
                    continue
                s, t = line.rstrip('\n').split('\t')[:2]
                rows.append((s, t))
        summaries = {}
        sname = meta['source'].get('summaries')
        spath = os.path.join(root, 'db', sname) if sname else None
        if spath and os.path.isfile(spath):
            summaries = json.load(open(spath))
        con.executemany('INSERT OR IGNORE INTO src_entry VALUES (?,?,?,?)',
                        [(s, t, summaries.get(s, {}).get('text'),
                          summaries.get(s, {}).get('authors')) for s, t in rows])
        slugs = {s for s, _ in rows}

    # --- the relation taxonomy ---------------------------------------------
    etypes = meta['edge_types']
    con.executemany('INSERT INTO edge_type VALUES (?,?,?,?,?,?,?,?)',
                    [tuple(t) + (i,) for i, t in enumerate(etypes)])
    dom = {t[0]: (t[1], t[2]) for t in etypes}

    # --- nodes --------------------------------------------------------------
    kinds = {k['code']: k for k in meta['kinds']}
    kind_of = {}
    for kd in meta['kinds']:
        code, fields = kd['code'], kd['fields']
        bad = [f for f in fields if f not in NODE_COLS or f == 'kind']
        if bad:
            raise SystemExit(f'kind {code}: unknown field(s) {bad}')
        for row in src['nodes'].get(code, []):
            if len(row) != len(fields):
                errors.append(f'{code}: row {row[0] if row else "?"} has {len(row)} '
                              f'values, expected {len(fields)} {fields}')
                continue
            rec = dict(zip(fields, row))
            rec['kind'] = code
            if rec.get('src') and slugs and rec['src'] not in slugs:
                errors.append(f'{code} {rec["id"]}: slug "{rec["src"]}" not in the source index')
                rec['src'] = None
            if rec['id'] in kind_of:
                errors.append(f'duplicate id "{rec["id"]}"')
                continue
            kind_of[rec['id']] = code
            con.execute('INSERT INTO node (%s) VALUES (%s)'
                        % (','.join(NODE_COLS), ','.join('?' * len(NODE_COLS))),
                        tuple(rec.get(c) for c in NODE_COLS))

    # by/via must point at real nodes
    for nid, by, via in con.execute('SELECT id, by, via FROM node').fetchall():
        for field, ref in (('by', by), ('via', via)):
            if ref and ref not in kind_of:
                errors.append(f'node {nid}: {field} -> unknown node "{ref}"')

    # --- explicit edges -----------------------------------------------------
    n_explicit = 0
    for e in src['edges']:
        a, b, t = e[0], e[1], e[2]
        gate = e[3] if len(e) > 3 else None
        note = e[4] if len(e) > 4 else None
        if t not in dom:
            errors.append(f'edge {a}->{b}: unknown type "{t}"'); continue
        if a not in kind_of or b not in kind_of:
            errors.append(f'edge {a}-[{t}]->{b}: dangling endpoint'); continue
        d, r = dom[t]
        if kind_of[a] != d or kind_of[b] != r:
            errors.append(f'edge {a}-[{t}]->{b}: domain/range mismatch '
                          f'({kind_of[a]}->{kind_of[b]}, taxonomy says {d}->{r})'); continue
        if a == b:
            errors.append(f'edge {a}-[{t}]->{a}: self-loop'); continue
        con.execute('INSERT OR IGNORE INTO edge VALUES (?,?,?,?,?)', (a, b, t, gate, note))
        n_explicit += 1

    # --- derived edges ------------------------------------------------------
    # Authorship, utterance and containment are already implied by by/via, so
    # they are derived rather than hand-listed and cannot drift out of sync.
    for d in meta.get('derive', []):
        field, t, flip = d['via'], d['type'], d.get('dir', 'in') == 'in'
        cols = f'{field}, id' if flip else f'id, {field}'
        con.execute(f'INSERT OR IGNORE INTO edge SELECT {cols}, ?, NULL, NULL FROM node '
                    f'WHERE kind = ? AND {field} IS NOT NULL', (t, d['kind']))
    for sql in meta.get('derive_sql', []):
        con.execute(sql)

    # An edge can never be revealed before both of its endpoints are. Explicit
    # gates raise a link above its nodes (the fact lands later than the people);
    # nothing lowers it below them.
    con.execute('''UPDATE edge SET gate = MAX(
                     COALESCE(gate, 0),
                     COALESCE((SELECT gate FROM node WHERE id = edge.a), 0),
                     COALESCE((SELECT gate FROM node WHERE id = edge.b), 0))''')

    # derived edges bypass the domain/range check above - verify after the fact
    for a, b, t in con.execute('SELECT a, b, type FROM edge').fetchall():
        d, r = dom[t]
        if kind_of.get(a) != d or kind_of.get(b) != r:
            errors.append(f'derived edge {a}-[{t}]->{b}: domain/range mismatch')

    if extra:
        errors += extra(con, src, kind_of) or []

    con.commit()

    counts = {k['name']: con.execute('SELECT count(*) FROM node WHERE kind=?',
                                     (k['code'],)).fetchone()[0] for k in meta['kinds']}
    n_edges = con.execute('SELECT count(*) FROM edge').fetchone()[0]
    n_types = con.execute('SELECT count(DISTINCT type) FROM edge').fetchone()[0]
    print('  '.join(f'{k}={v}' for k, v in counts.items()))
    print(f'edges={n_edges} ({n_explicit} explicit, {n_edges - n_explicit} derived) '
          f'across {n_types}/{len(etypes)} relation types')

    unused = [t[0] for t in etypes
              if not con.execute('SELECT 1 FROM edge WHERE type=? LIMIT 1', (t[0],)).fetchone()]
    if unused:
        print('relation types declared but unused:', ', '.join(unused), file=sys.stderr)

    if errors:
        print(f'\n{len(errors)} validation error(s):', file=sys.stderr)
        for e in errors[:60]:
            print('  -', e, file=sys.stderr)
        sys.exit(1)
    print('validation: clean')
    return con


# -------------------------------------------------------------------------- build
def build(root, db_path, out='site/graph.js', attach=None):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    meta = load(root)['meta']
    kinds = [k['code'] for k in meta['kinds']]

    nodes = []
    q = ('SELECT n.*, s.summary AS s_sum, s.authors AS s_auth FROM node n '
         'LEFT JOIN src_entry s ON s.slug = n.src ORDER BY n.kind, n.t0, n.label')
    for r in con.execute(q):
        n = {'id': r['id'], 'k': r['kind'], 'label': r['label']}
        for key, col in (('t0', 't0'), ('t1', 't1'), ('where', 'where_'), ('by', 'by'),
                         ('via', 'via'), ('ref', 'ref'), ('flag', 'flag'),
                         ('alias', 'alias'), ('blurb', 'blurb'), ('src', 'src'), ('g', 'gate'),
                         ('srcSum', 's_sum'), ('srcAuth', 's_auth')):
            v = r[col]
            if v is not None and v != '' and not (key == 'g' and not v):
                n[key] = v
        if attach:
            attach(n, r)
        nodes.append(n)

    order = {k: i for i, k in enumerate(kinds)}
    nodes.sort(key=lambda n: (order.get(n['k'], 99), n.get('t0') if n.get('t0') is not None else 1e9))

    edges = [[r['a'], r['b'], r['type']] + ([r['gate']] if r['gate'] else [])
             for r in con.execute('SELECT * FROM edge ORDER BY type, a, b')]
    types = {r['type']: {'d': r['domain'], 'r': r['range'], 'f': r['label_fwd'],
                         'b': r['label_rev'], 'dir': r['directed'], 's': r['style']}
             for r in con.execute('SELECT * FROM edge_type ORDER BY ord')}

    payload = {'nodes': nodes, 'edges': edges, 'types': types}
    for name in meta.get('bundle', []):          # extra JSON baked into the payload
        p = os.path.join(root, 'db', name + '.json')
        if os.path.exists(p):
            payload[name] = json.load(open(p))

    path = os.path.join(root, out)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write('/* GENERATED by scripts/build.py via graphkit - do not edit. */\n')
        f.write('window.GRAPH = ')
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'), sort_keys=False)
        f.write(';\n')
    print(f'{out}  {len(nodes)} nodes  {len(edges)} edges  {os.path.getsize(path) // 1024} KB')
    return payload
