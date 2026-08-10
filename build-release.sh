#!/bin/zsh
# Usage: ./build-release.sh 14.04b-test
# Builds $SCRATCH_OUT/<version>/module.zip + module.json from a clean archive of
# HEAD -- never from the working tree, so a dirty checkout can never leak into
# (or be missing from) a release.
set -e
V=$1; [ -n "$V" ] || { echo "usage: build-release.sh <version>"; exit 1; }
OUT=${SCRATCH_OUT:-/tmp/mej-release}/$V
rm -rf "$OUT" && mkdir -p "$OUT/src"
git archive HEAD | tar -x -C "$OUT/src"
cd "$OUT/src"
# Dev-only tracked paths that must not ship. Reconciled against `git ls-files`
# on this branch: .gitattributes, .gitignore and .github/ are the only tracked
# non-runtime paths here (there is no test/, docs/ or CLAUDE.md at this commit);
# build-release.sh is itself tracked once committed.
rm -rf .github .gitattributes .gitignore build-release.sh
python3 - "$V" <<'PY'
import json, sys
v = sys.argv[1]
m = json.load(open('module.json'))
m['version'] = v
m['manifest'] = f"https://github.com/bularzik/monks-enhanced-journal/releases/download/{v}/module.json"
m['download'] = f"https://github.com/bularzik/monks-enhanced-journal/releases/download/{v}/module.zip"
json.dump(m, open('module.json','w'), indent=2)
PY
zip -rq "$OUT/module.zip" .
cp module.json "$OUT/module.json"
echo "built: $OUT/module.zip ($(unzip -l $OUT/module.zip | tail -1 | awk '{print $2}') files)"
