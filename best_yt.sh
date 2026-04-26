#!/usr/bin/env bash
# best_yt.sh — for a given band name, find YouTube video candidates sorted by views.
# Usage: ./best_yt.sh "Band Name"
# Outputs one line per candidate: BAND_NAME\tVID\tVIEWS\tTITLE (up to 8 lines)
# Adds "music" to the search query and filters out news/media channels.
set -euo pipefail

name="$1"
# Optional second arg: stage/context hint (e.g. "New Orleans" or stage name)
# Helps disambiguate band names that collide with famous song titles.
context="${2:-New Orleans music}"

# Channel name patterns to reject (news outlets, talk shows, TV stations).
# NPR and PBS are intentionally excluded from this filter — NPR Music (Tiny Desk)
# and PBS (Austin City Limits) are premier music performance channels we want.
NEWS_PAT='news|nbc|cbs|abc|cnn|fox|msnbc|bbc|reuters|associated press|ap news|guardian|washington post|new york times|today show|tonight show|late show|late night|daily show|colbert|fallon|kimmel|letterman|conan|60 minutes|dateline|nightline|morning joe|good morning|wdsu|wvue|wdaf|wral|wbtv|khou|ksat|ktvu|wsb|wfaa|kxan|tegna|nexstar|gray tv|sinclair|hearst'

# Title keyword patterns to reject (crime, legal, missing persons, obits, interviews about non-music topics)
TITLE_PAT='missing|found dead|murder|homicide|arrest|arrested|charged|guilty|pleads|suspect|victim|search for|body found|shooting|stabbing|overdose|obituary|funeral|kidnap|abduct|police|sheriff|fbi|indicted|convicted|sentenc|trial|lawsuit|mug shot|mugshot|breaking news|amber alert'

# Put the name in quotes to match as a phrase, then append context.
# Quoting prevents "Boyfriend" from matching Justin Bieber's song "Boyfriend".
results=$(yt-dlp "ytsearch8:\"${name}\" ${context}" \
  --print "%(view_count)s	%(id)s	%(channel)s	%(title)s" \
  --no-playlist \
  --ignore-errors \
  2>/dev/null \
  | grep -v '^NA' \
  | awk -F'\t' -v npat="$NEWS_PAT" -v tpat="$TITLE_PAT" \
      '{ if (tolower($3) !~ npat && tolower($4) !~ tpat) print $1"\t"$2"\t"$4 }' \
  | sort -t$'\t' -k1 -rn)

if [[ -z "$results" ]]; then
  echo "${name}	NOTFOUND	0	"
  exit 0
fi

while IFS=$'\t' read -r views vid title; do
  echo "${name}	${vid}	${views}	${title}"
done <<< "$results"
