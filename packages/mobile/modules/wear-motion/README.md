# Wear Motion Module

Android Expo bridge for the Wear OS phone receiver. Received channels are
atomically persisted in a private Room-backed inbox before JavaScript can list,
read, or explicitly delete them. The public contract mirrors the safety
boundary of the iOS `watch-motion` module.

Wearable Data Layer channels are connection-oriented, so local receipt is the
durability boundary; see Android's [Data Layer client types](https://developer.android.com/training/wearables/data/client-types).

## Validation

```bash
pnpm exec vitest run packages/mobile/modules/wear-motion/index.test.ts --project mobile
```
