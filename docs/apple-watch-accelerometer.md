# Apple Watch Accelerometer

## Architecture

```
[Apple Watch]
  CMSensorRecorder (50 Hz, 12h sessions, 3-day retention)
    → WCSession.transferFile() (gzip JSON, triggered on foreground)

[iPhone]
  WatchMotionModule (Expo native module)
    → receives transferred files, stores in pending directory
    → WatchCoreMotionAdapter (implements CoreMotionAdapter)
      → syncAccelerometerToServer() (existing pipeline, unchanged)
        → tRPC pushAccelerometerSamples
          → TimescaleDB (device_type="apple_watch")
```

## Data Flow

1. **Watch records continuously**: `CMSensorRecorder.recordAccelerometer(forDuration: 43200)` runs 12-hour sessions. Called on every foreground + background transition.

2. **Watch transfers on foreground**: When the Watch app becomes active, it queries new samples since the last transfer, serializes as JSON, gzip-compresses, and calls `WCSession.transferFile()`.

3. **iPhone receives files**: `WatchMotionModule.swift` receives files via `session(_:didReceive:)`, moves them to `Application Support/watch-motion-pending/`, emits `onWatchFileReceived` event.

4. **iPhone syncs on foreground**: `background-watch-accelerometer-sync.ts` triggers sync when the iPhone app comes to foreground. The `WatchCoreMotionAdapter` reads pending files, the existing `syncAccelerometerToServer()` batches and uploads.

5. **Files acknowledged**: After successful server upload, `acknowledgeWatchSamples()` deletes the processed files.

## File Transfer Format

- **Container**: Gzip-compressed JSON file (`.json.gz`)
- **Content**: JSON array of sample objects:
  ```json
  [
    {"timestamp": "2026-03-25T10:00:00.000Z", "x": 0.01, "y": -0.98, "z": 0.04},
    {"timestamp": "2026-03-25T10:00:00.020Z", "x": 0.02, "y": -0.97, "z": 0.05}
  ]
  ```
- **Typical size**: 12h at 50 Hz = ~2.16M samples = ~150 MB raw JSON → ~15 MB gzip
- **Transfer limit**: `WCSession.transferFile()` handles up to ~30 MB

## WCSession Protocol

**iPhone → Watch** (request sync):
```json
{"action": "sync_accelerometer"}
```

**Watch → iPhone** (file transfer metadata):
```json
{
  "type": "accelerometer_samples",
  "sampleCount": 2160000,
  "transferredAt": "2026-03-25T22:00:00Z"
}
```

## Adding the Watch Target to Xcode

The WatchKit app source lives in `packages/mobile/ios/DofekWatch/`. To add it to the Xcode project:

1. Open `packages/mobile/ios/Dofek.xcworkspace` in Xcode
2. File → New → Target → watchOS → App
3. Product Name: `DofekWatch`
4. Bundle Identifier: `com.dofek.app.watchkit`
5. Language: Swift, Interface: SwiftUI
6. Set deployment target: watchOS 10.0
7. Delete the auto-generated files and point to `DofekWatch/` directory
8. Link frameworks: CoreMotion, WatchConnectivity

**Note**: `expo prebuild --clean` may remove the Watch target. Consider creating an Expo config plugin to re-add it automatically.

## Supported Devices

- **CMSensorRecorder**: Available on all Apple Watch models (Series 1+)
- **watchOS 10+**: Required for standalone app lifecycle (`@main App`)
- **50 Hz sampling**: Same rate as iPhone CMSensorRecorder
- **3-day retention**: Same as iPhone

## Testing

### Unit tests (no device needed)
- `watch-accelerometer-adapter.test.ts` — mocks watch-motion module
- `background-watch-accelerometer-sync.test.ts` — mocks adapter

### On-device testing
1. Build and install DofekWatch on a paired Apple Watch
2. Grant motion permission when prompted
3. Verify "Recording: Active" in Watch app
4. Wait a few minutes, then tap "Sync Now" on Watch
5. Open iPhone app → Accelerometer screen → verify Watch data appears
6. Check server: `SELECT count(*) FROM fitness.accelerometer_sample WHERE device_type = 'apple_watch'`
