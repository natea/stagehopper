#!/usr/bin/env bash
# best_yt.sh — for a given band name, find YouTube video candidates sorted by views.
# Usage: ./best_yt.sh "Band Name"
# Outputs one line per candidate: BAND_NAME\tVID\tVIEWS\tTITLE (up to 8 lines)
set -euo pipefail

name="$1"

# Search for 8 candidates; sort descending by view count; output all of them.
results=$(yt-dlp "ytsearch8:${name}" \
  --print "%(view_count)s	%(id)s	%(title)s" \
  --no-playlist \
  --ignore-errors \
  2>/dev/null \
  | grep -v '^NA' \
  | sort -t$'\t' -k1 -rn)

if [[ -z "$results" ]]; then
  echo "${name}	NOTFOUND	0	"
  exit 0
fi

while IFS=$'\t' read -r views vid title; do
  echo "${name}	${vid}	${views}	${title}"
done <<< "$results"
