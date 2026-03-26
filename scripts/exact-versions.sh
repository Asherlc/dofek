#!/usr/bin/env bash
# Ensures all package.json files use exact dependency versions (no ^ or ~ prefixes).
# Runs as part of `pnpm lint` to prevent reintroduction.

set -euo pipefail

found=0

for pkg in package.json packages/*/package.json; do
  if [ ! -f "$pkg" ]; then
    continue
  fi

  # Extract all version strings from dependencies and devDependencies,
  # skipping workspace: references
  ranges=$(node -e "
    const pkg = require('./$pkg');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('^') || version.startsWith('~')) {
        console.log(name + ': ' + version);
      }
    }
  " 2>/dev/null || true)

  if [ -n "$ranges" ]; then
    echo "ERROR: $pkg has version ranges:"
    echo "$ranges" | sed 's/^/  /'
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  echo ""
  echo "All dependencies must use exact versions (no ^ or ~ prefixes)."
  echo "Use 'pnpm add <pkg>' — .npmrc enforces save-exact=true."
  exit 1
fi

echo "All dependency versions are exact."
