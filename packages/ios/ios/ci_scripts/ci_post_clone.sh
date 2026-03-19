#!/bin/sh
set -e

# Navigate to monorepo root
cd "$CI_PRIMARY_REPOSITORY_PATH"

# Install Node.js via Homebrew (Xcode Cloud has Homebrew pre-installed)
brew install node@22
export PATH="/usr/local/opt/node@22/bin:$PATH"

# Install pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Install all workspace dependencies
pnpm install --frozen-lockfile
