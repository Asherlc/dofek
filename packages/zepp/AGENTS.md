# Zepp Agent Guide

Read [README.md](./README.md) first.

## Agent-Specific Information

- **Watch-side runtime** (`page/`, `app-service/`): Runs in the restricted ZeppOS JS sandbox on the watch. No network access, no npm packages beyond `@zos/*` and `@zeppos/*` (which are runtime-provided, not bundled). `app-service/` additionally has no `setTimeout`, no UI, and no high-power sensors (Accelerometer, Gyroscope). ([App Service guide](https://docs.zepp.com/docs/guides/framework/device/app-service/))
- **Phone-side runtime** (`app-side/`, `setting/`): Runs in the Zepp App on the phone — a different, more capable environment. Has the **Fetch API** (full internet access), Settings Storage API, and Messaging API. npm packages beyond `@zeppos/*` can be used as long as they don't require Node.js or DOM globals (`window`, `document`, `navigator`) — esbuild bundles them into the output. ([Side Service intro](https://docs.zepp.com/docs/guides/framework/side-service/intro/))
- **Testable code**: Keep runtime-independent logic in `src/` modules and cover it with colocated Vitest tests. Entry-point behavior that depends on ZeppOS globals may use explicit module/global mocks or an end-to-end runtime harness; prefer extracting reusable logic into `src/`. ([Vitest mocking guide](https://vitest.dev/guide/mocking), [Zepp OS app architecture](https://docs.zepp.com/docs/guides/framework/quick-start/))
- **Binary format**: `src/imu-format.ts` writes the binary session format. `src/providers/zos-app/decode.ts` (in the root package) decodes it. Both must stay in sync.
- **pnpm**: This package uses pnpm (same as the monorepo root). The `package-lock.json` is managed by pnpm via the root lockfile.
- **Stryker exclusions**: `page/`, `app-side/`, `app-service/`, `setting/` are excluded from mutation testing — they run in ZeppOS runtime and cannot be tested with Vitest.
