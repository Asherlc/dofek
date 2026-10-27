# HealthKit Agent Notes

Read [README.md](README.md) before changing this module.

Scope: this directory (`packages/mobile/modules/health-kit`) and its direct app integration points.

## Expectations

- Do not introduce or preserve "import-only" fallback behavior for HealthKit in mobile provider UI.
- HealthKit failures should be surfaced as actionable errors, not silently downgraded behavior.
- Keep TypeScript API (`index.ts`) aligned with Swift module exports in `ios/HealthKitModule.swift`.

## High-Value Files

- Native entrypoint: `ios/HealthKitModule.swift`
- Type registry (read/write sets): `ios/HealthKitTypes.swift`
- Query/date/unit helpers: `ios/HealthKitQueries.swift`
- JS bridge surface: `index.ts`
- Provider connect/sync screen: `packages/mobile/app/providers/index.tsx`
- Sync orchestration: `packages/mobile/lib/health-kit-sync.ts`
- Background observer wiring: `packages/mobile/lib/background-health-kit-sync.ts`

## Guardrails

- Keep HealthKit API names stable unless all call sites are updated.
- If adding new HealthKit read types, update:
  1. `ios/HealthKitTypes.swift`
  2. mapping/parsing logic in sync pipeline
  3. tests for new type behavior
- Do not swallow native errors that indicate build/config issues.
- Preserve `hasEverAuthorized` for UX/re-authorization prompting only. Do not use it to gate
  HealthKit sync execution or background sync initialization; it is a local authorization-flow
  marker and can be false for users who already granted read access before the marker existed.
- Treat `getRequestStatus() === "unnecessary"` as authoritative evidence that the current
  HealthKit request set has already completed authorization, and keep the local marker aligned
  with that state.

## Fast Validation

Run from repo root:

- `pnpm test:mobile -- packages/mobile/app/providers/index.test.tsx`
- `pnpm test:mobile -- packages/mobile/lib/health-kit-sync.test.ts`
- `pnpm test:mobile -- packages/mobile/lib/background-health-kit-sync.test.ts`
