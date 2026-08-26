"""Locate the shared graph-engine checkout.

The engine and the build pipeline are shared with the philosophy graph and live
in their own repo. Order of search:

  1. $GRAPH_ENGINE                      explicit
  2. ./vendor/graph-engine              vendored copy (what CI uses)
  3. ../graph-engine                    sibling checkout (what a laptop uses)
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CANDIDATES = [os.environ.get('GRAPH_ENGINE'),
              os.path.join(ROOT, 'vendor', 'graph-engine'),
              os.path.join(os.path.dirname(ROOT), 'graph-engine')]

ENGINE = next((os.path.abspath(c) for c in CANDIDATES
               if c and os.path.isdir(os.path.join(c, 'graphkit'))), None)
if not ENGINE:
    sys.exit('graph-engine not found. Clone it next to this repo, vendor it into\n'
             'vendor/graph-engine, or set $GRAPH_ENGINE.')
sys.path.insert(0, os.path.join(ENGINE, 'graphkit'))
import graphkit                                       # noqa: E402,F401
