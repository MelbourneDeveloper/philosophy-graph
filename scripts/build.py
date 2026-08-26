#!/usr/bin/env python3
"""Export db/philosophy.db into site/graph.js (the payload index.html loads)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from engine_path import graphkit                     # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
graphkit.build(ROOT, os.path.join(ROOT, 'db', 'philosophy.db'))
