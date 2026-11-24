# Sleep widget Expo module agent guide

Read [README.md](README.md) before changing this module.

## Ownership

- `ios/SleepWidgetSnapshotWriter.swift` replaces and removes the App Group cache.
- `ios/SleepWidgetModule.swift` and `index.ts` provide the typed `replaceSnapshot` bridge.
- Keep publishing and authentication logic in the host integration.

## Validate

```bash
swift test --package-path packages/mobile/modules/sleep-widget --scratch-path .context/sleep-widget-lib
```
