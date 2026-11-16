#!/usr/bin/env bash
# usage: refresh.sh
# Rebuilds the workflow playground page, and the before/after page when playground/baseline/ exists.
# The before/after page's label and output path come from baseline/baseline.json.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
python3 "$here/build.py" || exit 1
if [ -d "$here/baseline" ]; then
  python3 "$here/build.py" --baseline "$here/baseline" --no-link || exit 1
fi
