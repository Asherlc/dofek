#!/usr/bin/env bash
# Prevents common status color hex values from drifting into source files.
# These specific Tailwind -500 shades are the ones developers copy from docs
# instead of importing from @dofek/scoring/colors.
#
# Runs as part of `pnpm lint` to keep web and mobile colors consistent.

set -euo pipefail

# The banned hex values and their correct shared constant.
# Format: hex|replacement
BANNED=(
  '#22c55e|statusColors.positive'
  '#ef4444|statusColors.danger'
  '#eab308|statusColors.warning'
  '#f97316|statusColors.elevated'
  '#f59e0b|chartColors.amber'
  '#8b5cf6|chartColors.purple'
)

# Find all .ts/.tsx source files, excluding color definitions, tests, and generated files.
files=$(find src/ packages/*/src/ packages/mobile/ \
  -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -name '*.test.ts' \
  ! -name '*.test.tsx' \
  ! -name 'colors.ts' \
  ! -name 'chart-theme.ts' \
  ! -name 'zones.ts' \
  ! -name 'routeTree.gen.ts' \
  ! -path '*/node_modules/*' \
  2>/dev/null)

if [ -z "$files" ]; then
  echo "No source files found to check."
  exit 0
fi

found=0
for entry in "${BANNED[@]}"; do
  hex="${entry%%|*}"
  replacement="${entry##*|}"
  matches=$(echo "$files" | xargs grep -Hn "$hex" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "$matches"
    echo "  ^^^ Use $replacement instead of $hex"
    echo ""
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  echo "ERROR: Found hardcoded hex colors that have shared constants."
  echo "Import from @dofek/scoring/colors or @dofek/scoring/scoring instead."
  exit 1
fi

echo "No hardcoded color drift detected."
