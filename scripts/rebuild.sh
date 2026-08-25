#!/usr/bin/env bash
# Recreate everything from scratch: db/philosophy.db and site/graph.js.
#
#   ./scripts/rebuild.sh            # offline rebuild from committed inputs
#   ./scripts/rebuild.sh --fetch    # also refresh the SEP index + summaries first
#
# Inputs (committed, hand-editable):
#   db/source.json        the curated dataset
#   db/sep_index.tsv      authoritative SEP slug index
#   db/sep_summaries.json cached SEP entry excerpts (optional)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--fetch" ]]; then
  ./scripts/fetch_sep_index.sh
  python3 scripts/fetch_sep_summaries.py
fi

python3 scripts/seed.py
python3 scripts/build.py
echo "rebuild complete"
