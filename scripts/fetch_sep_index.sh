#!/usr/bin/env bash
# Re-pull the authoritative SEP entry index. Run this to refresh db/sep_index.tsv.
set -euo pipefail
cd "$(dirname "$0")/.."
curl -sL --max-time 60 https://plato.stanford.edu/contents.html -o /tmp/sep_contents.html
perl -ne 'while(/<a href="entries\/([^\/"]+)\/">(.*?)<\/a>/g){my($s,$t)=($1,$2); $t=~s/<[^>]+>//g; $t=~s/&amp;/&/g; print "$s\t$t\n"}' \
  /tmp/sep_contents.html | sort -u > db/sep_index.tsv
echo "SEP index: $(wc -l < db/sep_index.tsv) entries"
