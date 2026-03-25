#!/usr/bin/env bash
# Downloads Sentry.xcframework (prebuilt static binary) from GitHub releases.
# Run this before `pod install` — the local podspec at ios/LocalPods/Sentry
# wraps this XCFramework so CocoaPods doesn't build Sentry from source.
#
# Why: Sentry 9.7.0 uses @_implementationOnly Swift imports without library
# evolution, causing runtime crashes on Xcode 26+. The prebuilt XCFramework
# is compiled with correct settings, avoiding both the crash and the
# SwiftVerifyEmittedModuleInterface build failure.
set -euo pipefail

SENTRY_VERSION="${1:-9.7.0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$SCRIPT_DIR/../ios"
LOCAL_POD_DIR="$IOS_DIR/LocalPods/Sentry"
XCFRAMEWORK_DIR="$LOCAL_POD_DIR/Sentry.xcframework"

# Idempotent — skip if already present
if [ -f "$XCFRAMEWORK_DIR/Info.plist" ]; then
  echo "Sentry.xcframework already exists, skipping download"
  exit 0
fi

mkdir -p "$LOCAL_POD_DIR"

# Download XCFramework (static variant)
DOWNLOAD_URL="https://github.com/getsentry/sentry-cocoa/releases/download/${SENTRY_VERSION}/Sentry.xcframework.zip"
ZIP_PATH="$LOCAL_POD_DIR/Sentry.xcframework.zip"

echo "Downloading Sentry.xcframework ${SENTRY_VERSION}..."
curl -fSL "$DOWNLOAD_URL" -o "$ZIP_PATH"

echo "Extracting Sentry.xcframework..."
unzip -qo "$ZIP_PATH" -d "$LOCAL_POD_DIR"
rm -f "$ZIP_PATH"

# Download private header needed by RNSentry (ios/RNSentry+fetchNativeStack.m
# imports SentryFormatter.h via HEADER_SEARCH_PATHS pointing to Sources/Sentry/include).
PRIVATE_HEADER_DIR="$LOCAL_POD_DIR/Sources/Sentry/include"
mkdir -p "$PRIVATE_HEADER_DIR"
HEADER_URL="https://raw.githubusercontent.com/getsentry/sentry-cocoa/${SENTRY_VERSION}/Sources/Sentry/include/SentryFormatter.h"
echo "Downloading SentryFormatter.h..."
curl -fSL "$HEADER_URL" -o "$PRIVATE_HEADER_DIR/SentryFormatter.h"

echo "Sentry.xcframework ${SENTRY_VERSION} ready at $XCFRAMEWORK_DIR"
