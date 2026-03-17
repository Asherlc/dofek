#!/usr/bin/env bash
# Checks for lint/type-check suppression comments that should not be in the codebase.
# Runs as part of `pnpm lint` to prevent reintroduction.

set -euo pipefail

PATTERNS=(
  '@ts-ignore'
  '@ts-expect-error'
  '@ts-nocheck'
  'biome-ignore'
  'eslint-disable'
)

# Find all .ts/.tsx files, excluding generated files, node_modules, and this checker's companion script.
# Includes cypress/ and root-level config files to prevent suppressions in unchecked paths.
files=$(find src/ packages/*/src/ scripts/ cypress/ \
  -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -name 'routeTree.gen.ts' \
  ! -name 'fix-ts-expect-errors.ts' \
  ! -path '*/node_modules/*' \
  2>/dev/null)

# Also check root-level .ts config files (vitest.config.ts, cypress.config.ts, etc.)
root_ts=$(find . -maxdepth 1 -name '*.ts' -type f 2>/dev/null)
if [ -n "$root_ts" ]; then
  files="$files
$root_ts"
fi

if [ -z "$files" ]; then
  echo "No source files found to check."
  exit 0
fi

found=0
for pattern in "${PATTERNS[@]}"; do
  if echo "$files" | xargs grep -Hn "$pattern" 2>/dev/null; then
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  echo ""
  echo "ERROR: Found suppression comments. Fix the underlying issue instead of suppressing."
  echo "Banned patterns: ${PATTERNS[*]}"
  exit 1
fi

echo "No suppression comments found."
