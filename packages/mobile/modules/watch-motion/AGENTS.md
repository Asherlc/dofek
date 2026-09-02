# Watch Motion Agent Guide

Read [README.md](./README.md) first.

## Ownership

- Keep the TypeScript bridge in `index.ts` limited to runtime validation,
  filename safety, and the typed public API.
- Keep WatchConnectivity lifecycle, durable receipt, and parsing in Swift.
- `WatchFileInbox` must persist transfers before module attachment; do not move
  receipt ownership back to a weak module instance.
- Preserve the peek/read then explicit-delete contract. Never delete a pending
  file before its upload is acknowledged.
- Accelerometer files use `watch-accel-`; altitude files use
  `watch-altitude-`. Keep Swift naming and TypeScript filtering aligned.
- Unexpected native receipt/persistence errors must remain visible to Sentry.

## Tests

- TypeScript API and unsafe filename behavior:
  `packages/mobile/modules/watch-motion/index.test.ts`.
- Swift file parsing and durable receipt:
  `Tests/SampleFileParserTests.swift` and
  `Tests/WatchFileReceiverTests.swift`.
- Run `pnpm exec vitest run
  packages/mobile/modules/watch-motion/index.test.ts --project mobile` and
  `swift test --package-path packages/mobile/modules/watch-motion`.

WatchConnectivity delivery and real motion sensors require paired hardware;
unit tests and Simulator runs do not prove those behaviors
([WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity)).
