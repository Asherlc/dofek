#!/bin/bash
set -euo pipefail

# Minimum coverage thresholds (percentage)
MIN_LINE_COVERAGE=90
MIN_FUNCTION_COVERAGE=90

PACKAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PACKAGE_DIR"

echo "Running Swift tests with coverage..."
swift test --enable-code-coverage 2>&1

XCTEST_PATH=".build/debug/HealthKitLibPackageTests.xctest/Contents/MacOS/HealthKitLibPackageTests"
PROFDATA=".build/debug/codecov/default.profdata"

if [ ! -f "$PROFDATA" ]; then
  echo "ERROR: Coverage data not found at $PROFDATA"
  exit 1
fi

echo ""
echo "=== Swift Code Coverage Report ==="
echo ""

# Source files are positional arguments (not --sources, which isn't supported on older llvm-cov)
SOURCES="ios/HealthKitQueries.swift ios/HealthKitTypes.swift"

# Show per-file report
xcrun llvm-cov report "$XCTEST_PATH" \
  --instr-profile "$PROFDATA" \
  $SOURCES

# Extract total line and function coverage
TOTALS=$(xcrun llvm-cov report "$XCTEST_PATH" \
  --instr-profile "$PROFDATA" \
  $SOURCES \
  | grep "^TOTAL")

LINE_COVER=$(echo "$TOTALS" | awk '{print $(NF-3)}' | sed 's/%//')
FUNC_COVER=$(echo "$TOTALS" | awk '{print $(NF-6)}' | sed 's/%//')

echo ""
echo "Line coverage:     ${LINE_COVER}% (minimum: ${MIN_LINE_COVERAGE}%)"
echo "Function coverage: ${FUNC_COVER}% (minimum: ${MIN_FUNCTION_COVERAGE}%)"

FAILED=0

if (( $(echo "$LINE_COVER < $MIN_LINE_COVERAGE" | bc -l) )); then
  echo "FAIL: Line coverage ${LINE_COVER}% is below threshold ${MIN_LINE_COVERAGE}%"
  FAILED=1
fi

if (( $(echo "$FUNC_COVER < $MIN_FUNCTION_COVERAGE" | bc -l) )); then
  echo "FAIL: Function coverage ${FUNC_COVER}% is below threshold ${MIN_FUNCTION_COVERAGE}%"
  FAILED=1
fi

if [ $FAILED -eq 1 ]; then
  exit 1
fi

echo "PASS: All coverage thresholds met."
