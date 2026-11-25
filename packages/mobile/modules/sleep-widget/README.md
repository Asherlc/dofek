# Sleep widget Expo module

The iOS bridge atomically replaces or removes
`Library/Caches/DofekSleepWidget.json` in the Sleep widget App Group, applies
complete file protection, skips unchanged bytes, and reloads the
`DofekSleepWidget` timeline. [Apple App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups) · [Foundation file protection](https://developer.apple.com/documentation/foundation/nsdata/writingoptions/completefileprotection)

```ts
import { replaceSnapshot } from "../modules/sleep-widget";

replaceSnapshot('{"version":1,"kind":"signedOut"}');
replaceSnapshot(null);
```

Errors are reported without snapshot payload contents. Host Overview publishing
lives outside this module.
