# Task 1 Implementation Report

## Implementation summary

Implemented provider-neutral reusable effort identity primitives and pure route
matching evidence for later repositories, read models, and MCP schemas.

- Added the complete `EffortIdentityKind` and `EquivalenceStrength` vocabularies.
- Added source-level `EffortIdentityEvidence`, reusable `RepeatedEffortKey`,
  normalized route geometry, and `RouteMatchEvidence` types.
- Added whitespace/case normalization, lossless identity key construction,
  provenance-only provider activity-instance keys, strength ranking, and a
  locale-independent deterministic key comparator.
- Added bounded route geometry evaluation with forward/reverse/unknown
  direction, overlap, endpoint tolerance, relative distance difference,
  optional elevation similarity, confidence, and rejection tracking.
- Incomplete geometry and routes that fail any required threshold return `null`.
  Accepted evidence carries an empty `rejection_reasons` list.

The route acceptance thresholds are exact: overlap `>= 0.9`, endpoint tolerance
`<= 250` meters, relative distance difference `<= 0.1`, and elevation
similarity `>= 0.85` when both profiles are available.

## Files changed

- `packages/server/src/repositories/repeated-effort-types.ts`
- `packages/server/src/repositories/repeated-effort-identity.ts`
- `packages/server/src/repositories/repeated-effort-identity.test.ts`
- `packages/server/src/repositories/route-equivalence.ts`
- `packages/server/src/repositories/route-equivalence.test.ts`

## TDD evidence

### RED

Command:

```bash
rtk pnpm exec vitest run packages/server/src/repositories/repeated-effort-identity.test.ts packages/server/src/repositories/route-equivalence.test.ts --project unit
```

Result: expected failure before production modules existed. Both suites failed
to import `./repeated-effort-identity.ts` and `./route-equivalence.ts`; Vitest
reported `Test Files 2 failed` and `Tests no tests`.

### GREEN

Command:

```bash
rtk pnpm exec vitest run packages/server/src/repositories/repeated-effort-identity.test.ts packages/server/src/repositories/route-equivalence.test.ts --project unit
```

Result:

```text
Test Files  2 passed (2)
Tests       11 passed (11)
```

## Tests and validation

- Focused identity and route tests: passed, 11/11.
- Full unit/mobile tier: passed, 1,252 files; 18,219 tests; 2 skipped files
  and 20 skipped tests.
- `rtk pnpm typecheck`: passed, `TypeScript: No errors found`.
- Biome check over all five changed source/test files: passed.
- `rtk pnpm lint:sandbox`: passed, including exact-version, formatting,
  suppression, workflow-download, migration-policy, provider-derived-metric,
  mobile telemetry, web story, review scenario, and mobile route checks.
- `rtk git diff --check`: passed.

## Self-review

- Provider activity instance keys use the distinct
  `provider_activity_instance` namespace and cannot equal reusable workout
  identity keys for the same external ID.
- No provider-specific fields, database writes, client calculations, or
  ingestion behavior were added.
- Route matching is pure and bounded to supplied normalized points; it does not
  perform network, database, or caller-assertion work.
- Direction is selected from the lower endpoint-distance orientation, with
  ties reported as `unknown`; reverse elevation profiles are aligned before
  comparison.
- Comparator ordering uses explicit string comparisons rather than locale-aware
  collation, preserving deterministic behavior across runtimes.

## Concerns

No blocking concerns identified for Task 1. The fixed 100-meter point-to-route
coverage tolerance is an internal geometry-sampling tolerance; later route
materialization should keep its normalized point contract compatible with it.
