# Provider HTTP Agent Guide

Read [README.md](./README.md) first for the package contract and usage.

## Package boundary

- Keep provider-specific authentication, retry policy, persistence, and
  orchestration in consuming packages. This package supplies Fetch-compatible
  error handling and adaptive admission primitives.
- Preserve the public entry points declared in `package.json`: the package root
  and `./rate-limit` resolve to `src/rate-limit.ts`;
  `./adaptive-rate-limit` resolves to `src/adaptive-rate-limit.ts`.
- Define shared error and store contracts in `src/rate-limit-types.ts`; export
  them through an intentional public entry point instead of importing that
  internal file from consumers.
- Treat serialized adaptive state as untrusted input. Keep validation in
  `parseAdaptiveRateState` aligned with every field in
  `ProviderAdaptiveRateState`.

## Tests

- `src/rate-limit.test.ts` covers Fetch passthrough, status classification,
  typed errors, the two-minute deadline and caller-signal composition,
  adaptive-store callbacks, and wrapper idempotence.
- `src/adaptive-rate-limit.test.ts` covers pacing, quota learning, state
  transitions, storage keys, and serialization.
- Add the failing colocated unit test first, then implement the behavior. Run
  `pnpm --filter @dofek/provider-http test` and
  `pnpm --filter @dofek/provider-http typecheck`.
