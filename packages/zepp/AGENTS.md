# Zepp Agent Guide

Read [README.md](./README.md) first.

## Agent-Specific Information

- **ZeppOS runtime**: Code in `page/`, `app-side/`, `app-service/`, and `setting/` runs in the ZeppOS restricted JS runtime. No Node.js APIs, no Zod, no npm packages beyond `@zeppos/*`.
- **Testable code**: Only `src/` modules (imu-collector, imu-format, session-file, types) can be unit tested with Vitest. Page/service code depends on ZeppOS globals.
- **Binary format**: `src/imu-format.ts` writes the binary session format. `src/providers/zos-app/decode.ts` (in the root package) decodes it. Both must stay in sync.
- **pnpm**: This package uses pnpm (same as the monorepo root). The `package-lock.json` is managed by pnpm via the root lockfile.
- **Stryker exclusions**: `page/`, `app-side/`, `app-service/`, `setting/` are excluded from mutation testing — they run in ZeppOS runtime and cannot be tested with Vitest.
