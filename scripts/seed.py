#!/usr/bin/env python3
"""Rebuild db/philosophy.db from db/source.json + db/sep_index.tsv.

Thin wrapper: the pipeline itself lives in the shared graph-engine repo
(graphkit/graphkit.py), which both this site and the Twin Peaks atlas run on.
See scripts/engine_path.py for how it is located.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine_path import graphkit                     # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def house_rules(con, src, kind_of):
    """SPEC.md §3, enforced rather than trusted."""
    errors = []
    # A slug must resolve in the SEP index - graphkit enforces that - but a
    # thinker with no entry is allowed to carry NULL. SPEC.md is explicit: the
    # rest carry NULL rather than a fabricated link.
    # A quote must have a speaker; a work must have an author.
    for nid, kind, by in con.execute(
            "SELECT id, kind, by FROM node WHERE kind IN ('w','q') AND by IS NULL"):
        errors.append(f'{kind} {nid}: no author')
    # Only 'apocryphal' is a legal flag - see SPEC.md §1.
    for nid, flag in con.execute(
            "SELECT id, flag FROM node WHERE flag IS NOT NULL AND flag <> 'apocryphal'"):
        errors.append(f'node {nid}: unknown flag "{flag}"')
    return errors


if __name__ == '__main__':
    graphkit.seed(ROOT, os.path.join(ROOT, 'db', 'philosophy.db'), extra=house_rules)
