#!/usr/bin/env python3
"""Fetch the opening summary of each SEP entry referenced by the dataset.

Writes db/sep_summaries.json  {slug: {"text":..., "title":..., "authors":...}}

Polite by construction: serial requests with a delay, a descriptive User-Agent,
and a cache — re-running only fetches slugs not already stored, so the whole
pipeline stays re-runnable without hammering plato.stanford.edu.

  python3 scripts/fetch_sep_summaries.py            # fill in what's missing
  python3 scripts/fetch_sep_summaries.py --refresh  # re-fetch everything

Only a short excerpt is stored (first ~2 sentences), attributed and linked back
to the entry in the UI. SEP content is (c) its authors and the Metaphysics
Research Lab; this is a citation, not a copy.
"""
import argparse, html, json, os, re, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, 'db', 'sep_summaries.json')
UA   = 'LineageEngine/1.0 (educational philosophy graph; contact: local)'
MAXLEN = 420

def slugs_needed():
    src = json.load(open(os.path.join(ROOT, 'db', 'source.json')))
    s = set()
    for p in src['people']:
        if p[5]: s.add(p[5])
    for sc in src['schools']:
        if sc[4]: s.add(sc[4])
    return sorted(s)

def strip(frag):
    frag = re.sub(r'<script.*?</script>', ' ', frag, flags=re.S | re.I)
    frag = re.sub(r'<[^>]+>', ' ', frag)
    frag = html.unescape(frag)
    return re.sub(r'\s+', ' ', frag).strip()

def trim(text, limit=MAXLEN):
    """Cut to a sentence boundary at or under `limit` characters."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for end in ('. ', '.” ', '.) '):
        i = cut.rfind(end)
        if i > limit * 0.45:
            return cut[:i + 1].strip()
    i = cut.rfind(' ')
    return (cut[:i] if i > 0 else cut).strip() + '…'

def fetch(slug):
    url = f'https://plato.stanford.edu/entries/{slug}/'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        doc = r.read().decode('utf-8', 'replace')

    m = re.search(r'<div id="preamble">(.*?)</div>', doc, re.S)
    if not m:
        m = re.search(r'<div id="aueditable">(.*?)</div>', doc, re.S)
    text = trim(strip(m.group(1))) if m else ''

    t = re.search(r'<title>(.*?)</title>', doc, re.S)
    title = strip(t.group(1)).replace(' (Stanford Encyclopedia of Philosophy)', '') if t else slug

    a = re.search(r'<div id="article-copyright">(.*?)</div>', doc, re.S)
    authors = ''
    if a:
        authors = strip(a.group(1))
        authors = re.sub(r'^Copyright\s*&?c?;?\s*©?\s*\d{4}\s*by\s*', '', authors, flags=re.I)
        authors = re.sub(r'\s*<.*$', '', authors).strip(' .')
    return {'text': text, 'title': title, 'authors': authors[:160]}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='re-fetch every slug')
    ap.add_argument('--delay', type=float, default=1.0, help='seconds between requests')
    args = ap.parse_args()

    cache = {}
    if os.path.exists(OUT) and not args.refresh:
        cache = json.load(open(OUT))

    want = slugs_needed()
    todo = [s for s in want if s not in cache or not cache[s].get('text')]
    print(f'{len(want)} slugs referenced · {len(cache)} cached · {len(todo)} to fetch')

    ok = fail = 0
    for i, slug in enumerate(todo, 1):
        try:
            cache[slug] = fetch(slug)
            ok += 1
            print(f'  [{i}/{len(todo)}] {slug}: {len(cache[slug]["text"])} chars')
        except Exception as e:
            fail += 1
            print(f'  [{i}/{len(todo)}] {slug}: FAILED {e}', file=sys.stderr)
        if i % 25 == 0:
            json.dump(cache, open(OUT, 'w'), indent=1, ensure_ascii=False)
        time.sleep(args.delay)

    json.dump(cache, open(OUT, 'w'), indent=1, ensure_ascii=False)
    have = sum(1 for s in want if cache.get(s, {}).get('text'))
    print(f'done: {ok} fetched, {fail} failed · {have}/{len(want)} slugs have a summary')

if __name__ == '__main__':
    main()
