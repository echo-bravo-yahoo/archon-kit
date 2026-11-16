#!/usr/bin/env bash
# usage: slug.sh make --run ID [--prefix P] [--model TEXT] [--text TEXT] [--fallback WORD] [--keep FILE]
#
# make prints the slug that names a report's directory under ~/.archon/designs/<repo>/, as
# [<prefix>-]<name>-<run6>, where run6 is the first six characters of the run id. The name is
# --model, the name a model chose, cleaned to lowercase letters and digits joined by hyphens and cut at
# a hyphen to at most 40 characters. A leading <prefix>- on the name is dropped, because the prefix
# already says it. When --model leaves nothing, the name is the first five words of the first line
# of --text, without filler words, and when that leaves nothing it is --fallback, else `report`.
#
# --keep FILE makes the rounds of one run share one address: a non-empty FILE is printed as it is, and
# otherwise the slug is written to FILE as well as printed.
#
# Exits 0 with one line on stdout, or 2 with a usage line on stderr.
set -uo pipefail
export LC_ALL=C

USAGE='usage: slug.sh make --run ID [--prefix P] [--model TEXT] [--text TEXT] [--fallback WORD] [--keep FILE]'

# Words that carry no meaning in a name taken from a message.
FILLER=" a an the of to in on at by for from with and or but if so uh um ok okay is it its are was be been we i you my our this that these those there here let lets can could would should do does how what why just please now actually "
CURLY=$(printf '\342\200\231')

# clean TEXT prints TEXT in lowercase letters and digits joined by single hyphens. An apostrophe
# disappears, so "let's" becomes "lets".
clean() {
  local s=$1
  s=${s//"'"/}
  s=${s//"$CURLY"/}
  printf '%s' "$s" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//'
}

# strip_prefix NAME removes a leading "<prefix>-", and everything when NAME is the prefix itself.
strip_prefix() {
  local n=$1
  if [ -n "$prefix" ]; then
    case "$n" in
      "$prefix") n="" ;;
      "$prefix"-*) n=${n#"$prefix"-} ;;
    esac
  fi
  printf '%s' "$n"
}

# cut_name NAME prints NAME cut to at most 40 characters, at a hyphen unless one word is longer.
cut_name() {
  local n=$1 next
  if [ "${#n}" -gt 40 ]; then
    next=${n:40:1}
    n=${n:0:40}
    if [ "$next" != "-" ] && [[ "$n" == *-* ]]; then n=${n%-*}; fi
    n=${n%-}
  fi
  printf '%s' "$n"
}

# words_of TEXT prints the first five words of TEXT's first line that are not filler, joined by hyphens.
words_of() {
  local first=${1%%$'\n'*} cleaned w out="" count=0
  cleaned=$(strip_prefix "$(clean "$first")")
  [ -n "$cleaned" ] || return 0
  local IFS=-
  for w in $cleaned; do
    case "$FILLER" in *" $w "*) continue ;; esac
    out="${out:+$out-}$w"
    count=$((count + 1))
    [ "$count" -lt 5 ] || break
  done
  printf '%s' "$out"
}

make() {
  local run="" prefix="" model="" text="" fallback="" keep="" name run6 slug
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --run) run=${2-}; shift 2 || return 2 ;;
      --prefix) prefix=${2-}; shift 2 || return 2 ;;
      --model) model=${2-}; shift 2 || return 2 ;;
      --text) text=${2-}; shift 2 || return 2 ;;
      --fallback) fallback=${2-}; shift 2 || return 2 ;;
      --keep) keep=${2-}; shift 2 || return 2 ;;
      *) return 2 ;;
    esac
  done
  [ -n "$run" ] || return 2
  if [ -n "$keep" ] && [ -s "$keep" ]; then
    cat "$keep"
    return 0
  fi
  name=$(cut_name "$(strip_prefix "$(clean "$model")")")
  [ -n "$name" ] || name=$(words_of "$text")
  [ -n "$name" ] || name=$(clean "$fallback")
  [ -n "$name" ] || name=report
  run6=$(printf '%s' "$run" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | cut -c1-6)
  slug="${prefix:+$prefix-}$name${run6:+-$run6}"
  if [ -n "$keep" ]; then
    printf '%s\n' "$slug" > "$keep" || printf 'slug.sh: cannot write %s\n' "$keep" >&2
  fi
  printf '%s\n' "$slug"
}

case "${1-}" in
  make) shift; make "$@" || { rc=$?; printf '%s\n' "$USAGE" >&2; exit "$rc"; } ;;
  *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
esac
