#!/usr/bin/env python3
"""Rebuild db/philosophy.db from db/source.json + db/sep_index.tsv.

Idempotent: drops and recreates every table, then validates. Any dangling
reference, unknown SEP slug, or unknown edge type is a hard failure - the
sourcing rules in SPEC.md are enforced here, not by hand.
"""
import json, os, sqlite3, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB   = os.path.join(ROOT, 'db', 'philosophy.db')

# The relation taxonomy (SPEC.md §2): type, domain, range, forward label,
# reverse label, directed, line style.
EDGE_TYPES = [
    ('taught',       'p','p', 'Taught',              'Studied under',       1, 'solid'),
    ('influenced',   'p','p', 'Influenced',          'Influenced by',       1, 'solid'),
    ('read',         'p','p', 'Read',                'Read by',             1, 'dashed'),
    ('friend',       'p','p', 'Friend of',           'Friend of',           0, 'solid'),
    ('rival',        'p','p', 'Argued against',      'Attacked by',         0, 'dashed'),
    ('correspondent','p','p', 'Corresponded with',   'Corresponded with',   0, 'dotted'),
    ('colleague',    'p','p', 'Colleague of',        'Colleague of',        0, 'dotted'),
    ('partner',      'p','p', 'Partner of',          'Partner of',          0, 'solid'),
    ('family',       'p','p', 'Family of',           'Family of',           0, 'solid'),
    ('translated',   'p','p', 'Transmitted',         'Transmitted by',      1, 'dashed'),
    ('commentary',   'p','p', 'Wrote commentary on', 'Commented on by',     1, 'dashed'),
    ('wrote',        'p','w', 'Wrote',               'Written by',          1, 'solid'),
    ('said',         'p','q', 'Said',                'Said by',             1, 'solid'),
    ('from',         'q','w', 'From',                'Contains',            1, 'dotted'),
    ('founded',      'p','m', 'Founded',             'Founded by',          1, 'solid'),
    ('member',       'p','m', 'Belonged to',         'Members',             1, 'solid'),
    ('precursor',    'p','m', 'Anticipated',         'Anticipated by',      1, 'dashed'),
    ('critic',       'p','m', 'Argued against',      'Critics',             1, 'dashed'),
    ('keytext',      'w','m', 'Key text of',         'Key texts',           1, 'solid'),
    ('descends',     'm','m', 'Gave rise to',        'Descends from',       1, 'solid'),
    ('reacts',       'm','m', 'Provoked',            'Reacts against',      1, 'dashed'),
]

def main():
    src = json.load(open(os.path.join(ROOT, 'db', 'source.json')))
    con = sqlite3.connect(DB)
    con.executescript(open(os.path.join(ROOT, 'db', 'schema.sql')).read())

    with open(os.path.join(ROOT, 'db', 'sep_index.tsv')) as f:
        sep = [tuple(l.rstrip('\n').split('\t')[:2]) for l in f if '\t' in l]
    con.executemany('INSERT OR IGNORE INTO sep_entry VALUES (?,?)', sep)
    slugs = {s for s, _ in sep}

    con.executemany('INSERT INTO edge_type VALUES (?,?,?,?,?,?,?)', EDGE_TYPES)

    errors = []

    # --- people -------------------------------------------------------------
    for pid, name, born, died, region, s, blurb in src['people']:
        if s and s not in slugs:
            errors.append(f'person {pid}: sep slug "{s}" not in SEP index')
            s = None
        con.execute('INSERT INTO person VALUES (?,?,?,?,?,?,?)',
                    (pid, name, born, died, region, s, blurb))

    for sid, name, a, b, s, blurb in src['schools']:
        if s and s not in slugs:
            errors.append(f'school {sid}: sep slug "{s}" not in SEP index')
            s = None
        con.execute('INSERT INTO school VALUES (?,?,?,?,?,?)', (sid, name, a, b, s, blurb))

    people = {r[0] for r in con.execute('SELECT id FROM person')}
    schools = {r[0] for r in con.execute('SELECT id FROM school')}

    for wid, title, by, year, blurb in src['works']:
        if by not in people:
            errors.append(f'work {wid}: unknown author "{by}"'); continue
        con.execute('INSERT INTO work VALUES (?,?,?,?,?)', (wid, title, by, year, blurb))

    works = {r[0] for r in con.execute('SELECT id FROM work')}

    for qid, text, by, wk, ref, flag in src['quotes']:
        if by not in people:
            errors.append(f'quote {qid}: unknown speaker "{by}"'); continue
        if wk and wk not in works:
            errors.append(f'quote {qid}: unknown work "{wk}"'); wk = None
        con.execute('INSERT INTO quote VALUES (?,?,?,?,?,?)', (qid, text, by, wk, ref, flag))

    # --- edges: explicit associations ---------------------------------------
    types = {t[0] for t in EDGE_TYPES}
    kind = {}
    kind.update({i: 'p' for i in people}); kind.update({i: 'm' for i in schools})
    kind.update({i: 'w' for i in works})
    kind.update({r[0]: 'q' for r in con.execute('SELECT id FROM quote')})
    dom = {t[0]: (t[1], t[2]) for t in EDGE_TYPES}

    n = 0
    for a, b, t in src['edges']:
        if t not in types:
            errors.append(f'edge {a}->{b}: unknown type "{t}"'); continue
        if a not in kind or b not in kind:
            errors.append(f'edge {a}->{b}: dangling endpoint'); continue
        d, r = dom[t]
        if kind[a] != d or kind[b] != r:
            errors.append(f'edge {a}-[{t}]->{b}: type mismatch '
                          f'({kind[a]}->{kind[b]}, expected {d}->{r})'); continue
        con.execute('INSERT OR IGNORE INTO edge VALUES (?,?,?,NULL)', (a, b, t))
        n += 1

    # --- edges: derived from the tables (authorship, utterance, source) ------
    for wid, by in con.execute('SELECT id, by FROM work').fetchall():
        con.execute('INSERT OR IGNORE INTO edge VALUES (?,?,?,NULL)', (by, wid, 'wrote'))
    for qid, by, wk in con.execute('SELECT id, by, work FROM quote').fetchall():
        con.execute('INSERT OR IGNORE INTO edge VALUES (?,?,?,NULL)', (by, qid, 'said'))
        if wk:
            con.execute('INSERT OR IGNORE INTO edge VALUES (?,?,?,NULL)', (qid, wk, 'from'))
    # a work is a key text of every school its author founded or belonged to
    con.execute('''INSERT OR IGNORE INTO edge
                   SELECT w.id, e.b, 'keytext', NULL FROM work w
                   JOIN edge e ON e.a = w.by AND e.type IN ('founded','member')''')

    con.commit()

    counts = {t: con.execute('SELECT count(*) FROM %s' % t).fetchone()[0]
              for t in ('person', 'school', 'work', 'quote', 'edge')}
    print('  '.join(f'{k}={v}' for k, v in counts.items()))
    print('edge types in use:',
          con.execute('SELECT count(DISTINCT type) FROM edge').fetchone()[0])

    if errors:
        print(f'\n{len(errors)} validation error(s):', file=sys.stderr)
        for e in errors[:40]:
            print('  -', e, file=sys.stderr)
        sys.exit(1)
    print('validation: clean')

if __name__ == '__main__':
    main()
