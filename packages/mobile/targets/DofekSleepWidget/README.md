# Dofek Sleep widget

Native WidgetKit extension for the read-only Sleep Home Screen (`systemSmall`) and
Lock Screen (`accessoryRectangular`) layouts. The host Expo module writes a
version-one JSON snapshot into the App Group cache. The extension reads it,
builds the timeline, and supplies tap URLs. WidgetKit shows a generic placeholder
while the device is locked. [Apple widget privacy guidance](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension)

## Wire contract

| State | Snapshot |
| --- | --- |
| Sleep | `{"version":1,"kind":"sleep","date":"YYYY-MM-DD","durationMinutes":N,"expiresAt":epochMs}` |
| Empty | `{"version":1,"kind":"empty","expiresAt":epochMs}` |
| Signed out | `{"version":1,"kind":"signedOut"}` |

Missing, invalid, and expired snapshots render the Overview update state.

## Identifiers

| Item | Value |
| --- | --- |
| Product | `<host bundle id>.sleep-widget` |
| App Group | `group.<host bundle id>.sleep-widget` |
| Snapshot path | `Library/Caches/DofekSleepWidget.json` |
| Widget kind | `DofekSleepWidget` |

## Validate

```bash
cd packages/mobile/targets/DofekSleepWidget
swift test --scratch-path ../../../../.context/dofek-sleep-widget-core
```

Keep SwiftPM output outside this synchronized folder. Regenerate the iOS project
with a clean Expo prebuild before checking embed and entitlements.
