#!/usr/bin/env bash
# best_yt.sh — for a given band name, find the most-viewed YouTube video.
# Usage: echo "Band Name" | ./best_yt.sh
# Outputs: BAND_NAME\tBEST_ID\tVIEWS\tTITLE
set -euo pipefail

name="$1"

# Search for 8 candidates; sort descending by view count; take the top 11-char video ID.
result=$(yt-dlp "ytsearch8:${name}" \
  --print "%(view_count)s	%(id)s	%(title)s" \
  --no-playlist \
  --ignore-errors \
  2>/dev/null \
  | grep -v '^NA' \
  | sort -t$'\t' -k1 -rn \
  | head -1)

if [[ -z "$result" ]]; then
  echo "${name}	NOTFOUND	0	"
  exit 0
fi

views=$(echo "$result" | cut -f1)
vid=$(echo "$result" | cut -f2)
title=$(echo "$result" | cut -f3-)

echo "${name}	${vid}	${views}	${title}"
