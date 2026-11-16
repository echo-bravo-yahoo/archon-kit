#!/usr/bin/env bash
# usage: install.sh [--link] [--prefix DIR]
#
# Installs the kit into $ARCHON_HOME (default ~/.archon): the workflows under workflows/kit/, the
# scripts under scripts/, the run profiles under profiles/ and the templates under kit/templates/,
# and links the `archon-kit` command into DIR (default ~/.local/bin).
#   --link    link each file to this clone instead of copying it, so an edit in the clone takes
#             effect at once. Archon finds fixtures only in a real directory, so a workflow's
#             directories are real and its files are links.
#   --prefix  the directory that receives the `archon-kit` link.
# It writes config.yaml from config/config.yaml.template and an empty kit.json only when they are
# absent, and records what it installed in $ARCHON_HOME/kit-installed.json. Running it again
# upgrades in place. It refuses, and changes nothing, when a destination holds a regular file that
# differs from the kit's and that the record does not list. Each replacement renames a finished
# file over the old one, so a run that reads a script during an upgrade sees the old or the new
# file and never a partial one.
set -euo pipefail

USAGE='usage: install.sh [--link] [--prefix DIR]'
MODE=copy
BIN=$HOME/.local/bin
while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE='link'; shift ;;
    --prefix) BIN=${2:?$USAGE}; shift 2 ;;
    -h | --help) printf '%s\n' "$USAGE"; exit 0 ;;
    *) printf '%s\n' "$USAGE" >&2; exit 2 ;;
  esac
done
for tool in jq git; do
  command -v "$tool" > /dev/null 2>&1 || { printf 'install.sh: %s is required\n' "$tool" >&2; exit 1; }
done

SRC=$(cd "$(dirname "$0")" && pwd)
AH=${ARCHON_HOME:-$HOME/.archon}
RECORD=$AH/kit-installed.json
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
OPS=$WORK/ops        # one "source<TAB>destination" line for each file to install
OLD=$WORK/old        # the destinations the record lists
: > "$OPS"
: > "$OLD"

# Every file under a source directory goes to the same relative path under a destination.
add_tree() {
  local from=$1 to=$2 f
  [ -d "$from" ] || return 0
  while IFS= read -r f; do
    printf '%s\t%s\n' "$from/$f" "$to/$f" >> "$OPS"
  done < <(cd "$from" && find . -type f ! -name '*.pyc' ! -path '*/__pycache__/*' | sed 's#^\./##' | LC_ALL=C sort)
}

for dir in "$SRC"/workflows/*/; do
  [ -d "$dir" ] || continue
  add_tree "${dir%/}" "$AH/workflows/kit/$(basename "$dir")"
done
add_tree "$SRC/scripts" "$AH/scripts"
add_tree "$SRC/profiles" "$AH/profiles"
add_tree "$SRC/templates" "$AH/kit/templates"
LINK_DEST=$BIN/archon-kit
LINK_TARGET=$AH/scripts/archon-kit

if [ -f "$RECORD" ]; then
  jq -r '.files[]?' "$RECORD" > "$OLD" 2> /dev/null || : > "$OLD"
fi

is_recorded() { grep -qxF -- "$1" "$OLD"; }

# A destination is free when it is absent, was installed by an earlier run, already links to the
# source, or already holds the same bytes.
conflicts=0
check_dest() {
  local src=$1 dst=$2
  if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then return 0; fi
  if is_recorded "$dst"; then return 0; fi
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then return 0; fi
  if [ -f "$dst" ] && [ ! -L "$dst" ] && cmp -s "$src" "$dst"; then return 0; fi
  printf 'install.sh: %s exists and the kit did not install it\n' "$dst" >&2
  conflicts=$((conflicts + 1))
}
while IFS=$'\t' read -r src dst; do
  check_dest "$src" "$dst"
done < "$OPS"
check_dest "$LINK_TARGET" "$LINK_DEST"
if [ "$conflicts" -gt 0 ]; then
  printf 'install.sh: %d conflict(s); nothing was changed. Move those files away, or remove them, and run it again.\n' "$conflicts" >&2
  exit 1
fi

# Writes the new file beside the destination and renames it over the old one.
put() {
  local src=$1 dst=$2 tmp
  mkdir -p "$(dirname "$dst")"
  tmp=$dst.kit-new.$$
  rm -f "$tmp"
  if [ "$MODE" = link ]; then
    ln -s "$src" "$tmp"
  else
    cp -p "$src" "$tmp"
  fi
  mv -f "$tmp" "$dst"
}

while IFS=$'\t' read -r src dst; do
  put "$src" "$dst"
done < "$OPS"
mkdir -p "$BIN"
tmp=$LINK_DEST.kit-new.$$
rm -f "$tmp"
ln -s "$LINK_TARGET" "$tmp"
mv -f "$tmp" "$LINK_DEST"

# Files that an earlier install put down and this one no longer ships.
while IFS= read -r old; do
  [ -n "$old" ] || continue
  if ! cut -f2 "$OPS" | grep -qxF -- "$old" && [ "$old" != "$LINK_DEST" ]; then
    rm -f -- "$old"
  fi
done < "$OLD"

[ -f "$AH/config.yaml" ] || cp "$SRC/config/config.yaml.template" "$AH/config.yaml"
[ -f "$AH/kit.json" ] || printf '{}\n' > "$AH/kit.json"

{ cut -f2 "$OPS"; printf '%s\n' "$LINK_DEST"; } | LC_ALL=C sort > "$WORK/files"
jq -n --arg source "$SRC" --arg mode "$MODE" --arg version "$(git -C "$SRC" describe --tags --always --dirty 2> /dev/null || printf unknown)" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --rawfile files "$WORK/files" \
  '{source: $source, mode: $mode, version: $version, installed_at: $at, files: ($files | split("\n") | map(select(length > 0)))}' > "$WORK/record.json"
mv -f "$WORK/record.json" "$RECORD"

# Directories a removed file left empty.
find "$AH/workflows/kit" "$AH/scripts" "$AH/profiles" "$AH/kit" -type d -empty -delete 2> /dev/null || true

printf 'installed %s files (%s) from %s into %s\n' "$(wc -l < "$OPS" | tr -d ' ')" "$MODE" "$SRC" "$AH"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) printf 'note: %s is not on PATH, so the archon-kit command is not found yet\n' "$BIN" ;;
esac
if [ -x "$AH/scripts/archon-kit" ]; then
  "$AH/scripts/archon-kit" doctor || true
fi
