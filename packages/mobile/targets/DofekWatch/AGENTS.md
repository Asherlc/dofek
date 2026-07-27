# Dofek watch app agent guide

Read [README.md](README.md) before changing this target.

## Ownership

- `DofekWatchApp.swift` and `ContentView.swift`: lifecycle and watch UI.
- `AccelerometerRecorder.swift`, `GyroscopeRecorder.swift`, and
  `AltimeterRecorder.swift`: sensor capture and buffering.
- `TransferManager.swift` and `WatchSessionDelegate.swift`: compressed file
  transfer and iPhone coordination.
- `AccelerometerTransferCursor.swift` and `GyroscopeSampleBuffer.swift`:
  portable logic compiled by `Package.swift`.
- `expo-target.config.js`, `Info.plist`, and `pods.rb`: generated-target
  integration.

## Change rules

- Keep sensor behavior aligned with Apple's
  [Core Motion documentation](https://developer.apple.com/documentation/coremotion).
- Preserve the asynchronous delivery contract documented by
  [Watch Connectivity](https://developer.apple.com/documentation/watchconnectivity);
  phone reachability is not a durability guarantee.
- Report unexpected failures to Sentry and show actionable transfer status in
  the UI.
- Keep heavy sample processing and compression off the main thread.
- Do not add sensor-derived analytics to the watch client. Transfer raw samples;
  server-side read models own metric computation.
- Do not edit generated Xcode project files. Change the source target or
  `expo-target.config.js`, then regenerate through the mobile prebuild workflow.

## Validate

Run the portable suite:

```bash
cd packages/mobile/targets/DofekWatch
swift test
```

For recorder, lifecycle, and transfer changes, also build the generated watchOS
target and test the relevant sensors plus iPhone delivery on physical hardware.
