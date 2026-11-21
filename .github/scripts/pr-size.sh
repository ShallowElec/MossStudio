#!/usr/bin/env bash
# Measures a pull request and fails when it is too big to review (CONTRIBUTING.md, "Size and scope").
#
#   BASE   base commit of the pull request
#   HEAD   head commit of the pull request
#   LARGE  "true" when a maintainer added the `large-change` label
#
# "Source" lines are additions + deletions outside tests, docs, release notes, the lockfile and
# binary files: what a reviewer has to read as code. "Total" counts every text file except the lockfile.
# A renamed or moved file counts only the lines that changed in it, and a deleted file counts as one
# line, since neither takes long to review.
set -euo pipefail

SOURCE_WARN=800
SOURCE_LIMIT=1500
TOTAL_LIMIT=3000
NOT_SOURCE='(^|/)(test|tests|e2e|__snapshots__)/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|^docs/|\.md$|^release/notes/|(^|/)pnpm-lock\.yaml$'
NOT_COUNTED='(^|/)pnpm-lock\.yaml$'

source=0
total=0
declare -A by_area=()
count() {
  local lines=$1 path=$2
  [[ "$path" =~ $NOT_COUNTED ]] && return 0
  total=$((total + lines))
  if [[ ! "$path" =~ $NOT_SOURCE ]]; then
    source=$((source + lines))
    local area
    area="$(cut -d/ -f1-3 <<< "$path")"
    by_area[$area]=$(( ${by_area[$area]:-0} + lines ))
  fi
}

declare -A deleted_files=()
while IFS= read -r -d '' path; do deleted_files[$path]=1; done \
  < <(git diff -z --name-only --diff-filter=D -M "$BASE...$HEAD")

# With -z, a rename is "added<TAB>deleted<TAB>" followed by NUL, old path, NUL, new path, NUL;
# any other file is "added<TAB>deleted<TAB>path" followed by NUL.
while IFS= read -r -d '' record; do
  IFS=$'\t' read -r added deleted path <<< "$record"
  if [[ -z "$path" ]]; then
    IFS= read -r -d '' _old
    IFS= read -r -d '' path
  fi
  # Binary files show "-" and are not counted.
  [[ "$added" == "-" ]] && continue
  if [[ -n "${deleted_files[$path]:-}" ]]; then
    count 1 "$path"
  else
    count $((added + deleted)) "$path"
  fi
done < <(git diff -z --numstat -M "$BASE...$HEAD")

echo "Source lines changed: $source (warn above $SOURCE_WARN, limit $SOURCE_LIMIT)"
echo "All lines changed except the lockfile: $total (limit $TOTAL_LIMIT)"
if ((${#by_area[@]})); then
  echo "Source lines by area:"
  for area in "${!by_area[@]}"; do printf '  %6d  %s\n' "${by_area[$area]}" "$area"; done | sort -rn
fi

if ((source > SOURCE_LIMIT || total > TOTAL_LIMIT)); then
  if [[ "${LARGE:-false}" == "true" ]]; then
    echo "::warning::This PR is over the size limit; a maintainer allowed it with the large-change label."
    exit 0
  fi
  echo "::error::This PR changes $source source lines ($total in all). Split it: one change per PR, big features in slices behind a setting (CONTRIBUTING.md, \"Size and scope\"). A maintainer can allow an exception agreed beforehand with the large-change label."
  exit 1
fi
if ((source > SOURCE_WARN)); then
  echo "::warning::This PR changes $source source lines. Say in the description why it cannot be smaller."
fi
