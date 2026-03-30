#!/bin/bash
# Build and run ble-probe as a macOS app bundle (required for Bluetooth TCC permissions)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Build
swift build 2>&1 | grep -v "^$"

# Create minimal app bundle
APP_DIR=".build/BleProbe.app/Contents"
mkdir -p "$APP_DIR/MacOS"

# Copy binary
cp .build/debug/ble-probe "$APP_DIR/MacOS/ble-probe"

# Create Info.plist with Bluetooth usage description
cat > "$APP_DIR/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.dofek.ble-probe</string>
	<key>CFBundleName</key>
	<string>BleProbe</string>
	<key>CFBundleExecutable</key>
	<string>ble-probe</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>NSBluetoothAlwaysUsageDescription</key>
	<string>BLE Probe connects to Bluetooth devices for reverse engineering and protocol analysis.</string>
</dict>
</plist>
PLIST

# Ad-hoc sign
codesign --force --sign - "$APP_DIR/../" 2>/dev/null || true

# Run as interactive terminal app (not via open, which detaches)
exec "$APP_DIR/MacOS/ble-probe"
