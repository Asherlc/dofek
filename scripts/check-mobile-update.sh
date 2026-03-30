#!/usr/bin/env bash
# Check which mobile update is deployed on the server.
# Usage: pnpm check:mobile-update

set -euo pipefail

URL="${PUBLIC_URL:-https://dofek.asherlc.com}/api/updates/manifest"
RUNTIME_VERSION="${1:-1.0}"
PLATFORM="${2:-ios}"

response=$(curl -sf \
  -H "expo-protocol-version: 1" \
  -H "expo-platform: $PLATFORM" \
  -H "expo-runtime-version: $RUNTIME_VERSION" \
  -w "\n%{http_code}" \
  "$URL") || { echo "Failed to reach $URL"; exit 1; }

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "204" ]; then
  echo "No update deployed for platform=$PLATFORM runtimeVersion=$RUNTIME_VERSION"
  exit 0
fi

# Extract the JSON manifest from the multipart response
echo "$body" | sed -n '/^{/,/^}/p' | head -1 | \
  node -e "
    const json = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
    console.log('id:             ', json.id);
    console.log('createdAt:      ', json.createdAt);
    console.log('runtimeVersion: ', json.runtimeVersion);
    console.log('launchAsset:    ', json.launchAsset?.key);
    console.log('assets:         ', json.assets?.length ?? 0);
  "
