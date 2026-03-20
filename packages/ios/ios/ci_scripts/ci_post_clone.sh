#!/bin/bash
set -euo pipefail

# Xcode Cloud post-clone script
# Runs after Xcode Cloud clones the repo, before the build starts.
# Installs Node.js, pnpm, JS dependencies, and CocoaPods.

echo "--- Installing Node.js 22 ---"
brew install node@22
export PATH="/usr/local/opt/node@22/bin:$PATH"
node --version

echo "--- Enabling corepack and activating pnpm ---"
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version

echo "--- Installing JS dependencies ---"
cd "$CI_PRIMARY_REPOSITORY_PATH"
pnpm install --frozen-lockfile

echo "--- Installing CocoaPods ---"
cd "$CI_PRIMARY_REPOSITORY_PATH/packages/ios/ios"
pod install
