# Human-readable device names implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track review checkpoints in working notes.

**Goal:** Display recognizable device names consistently across web and mobile.

**Architecture:** A shared string resolver uses a bundled AppleDB catalog and
readable Garmin product names. The server resolves numeric FIT products with
the existing SDK and builds hardware labels without changing raw identities.

**Tech stack:** TypeScript, existing Garmin FIT SDK, Vitest, React/React Native.

**Spec:** [Approved design](../specs/2026-10-25-device-names-design.md).

## Global constraints

- Keep raw source IDs, attribution, ordering, and defaults unchanged.
- Preserve raw hardware/product identifiers in source records; omit these codes from displayed Details (user's final direction).
- Cover web and mobile with one shared name resolver; add no runtime catalog fetch.
- Preserve reported names and avoid inventing unsupported model variants.
- Reuse the existing Garmin SDK; add no duplicate device-decoding dependency.

## Review focus

- Apple hardware identifiers may be in either model or hardwareVersion.
- FIT manufacturer and product values may be numeric, numeric strings, or symbols.
- Manufacturer namespaces must prevent resolving another vendor's product as Garmin.
- Personal device names and unfamiliar identifiers must retain honest provenance.
- Display normalization must not alter chart source identity or match unrelated sources.

### Task 1: Shared name resolver and catalog

**Files:** `packages/providers-meta/src/device-names.ts`, colocated tests,
`apple-device-catalog.ts`, package exports, providers/source helpers and tests.

**Interfaces:** Produce `deviceDisplayName(name: string): string` and
`appleDeviceModel(identifier: string): string | null` for server and client use.

- [x] Write and observe failing tests for Watch6,9, other Apple families,
  Garmin fr955/edge530/fenix8, preserved custom names, unknown codes, and shared
  provider/source labels.
- [x] Bundle public AppleDB model identifiers with revision and MIT attribution.
- [x] Implement the resolver, wire shared source-label helpers, and run focused tests.
- [x] Review shared changes against the design before server integration.

### Task 2: Hardware normalization and chart-source matching

**Files:** `packages/server/src/models/activity-hardware.ts`, its tests,
`activity-source-tree.ts` and tests, metric-source repository and tests.

**Interfaces:** Consume Task 1 exports. Keep the existing ActivityHardware API shape.

- [x] Observe failing tests for HealthKit model/hardwareVersion resolution,
  preserved custom names, numeric and symbolic Garmin/Favero products,
  and other manufacturers.
- [x] Resolve display names at read time while retaining original raw source records.
- [x] Verify source-name normalization preserves source IDs, attribution, and defaults.
- [x] Run focused model/repository tests and review the integrated diff.

### Task 3: Client parity and final verification

**Files:** Both ActivityHardwarePanel tests/stories and package README documentation.

**Interfaces:** Both clients render server-normalized ActivityHardware values.

- [x] Exercise readable Apple/Garmin names and useful device-detail disclosure on web/mobile.
- [x] Add representative stories and document catalog provenance/refresh guidance.
- [x] Run affected unit/mobile tests, typechecks, lint, and browser visual verification.
- [x] Obtain independent review; resolve material findings and rerun affected checks.
- [x] Commit and push the finished change on the existing branch.
