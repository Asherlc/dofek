# Dofek Sleep widget agent guide

Read [README.md](README.md) before changing this target.

## Ownership

- `SleepWidgetSnapshot.swift` and `SleepWidgetSnapshotStore.swift` define and read the App Group snapshot.
- `SleepWidgetTimeline.swift`, `DofekSleepWidget.swift`, and `DofekSleepWidgetViews.swift` build the timeline and UI.
- `expo-target.config.js` declares the product ID, App Group, and data protection.

## Change rules

- Keep stored data within the version-one snapshot contract.
- Preserve iOS 16.4 support and guard later WidgetKit APIs.
- Do not edit generated Xcode project files. Change sources or `expo-target.config.js`, then regenerate.

## Validate

```bash
cd packages/mobile/targets/DofekSleepWidget
swift test --scratch-path ../../../../.context/dofek-sleep-widget-core
```
