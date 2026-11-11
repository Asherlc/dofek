# Climbing Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Connect the verified climbing sources to Dofek on web and mobile and
record actionable access requirements for the remaining sources.

**Architecture:** Reuse the climbing graph, per-user credential repository,
provider HTTP boundary, and durable file imports. Share the Aurora protocol
client through composition; keep concrete providers independent. Preserve raw
completion booleans separately from textual result labels.

**Tech Stack:** Existing TypeScript, Zod, Drizzle/PostgreSQL, Vitest/MSW, React,
React Native, and yauzl; no new runtime dependencies are planned.

**Spec:** `docs/superpowers/specs/2026-10-31-climbing-providers.md`.

## Global Constraints

- No branch changes or per-user deployment environment variables.
- Raw data only; unknown values remain unknown; no fabricated timed sessions.
- Use `sourceCompleted` for upstream booleans and retain native textual results.
- Do not reconcile remote absence from deltas, partial fetches, or file uploads.
- Web and mobile expose equivalent provider connection/import controls.
- 27 Crags, Griptonite, and current MoonBoard sync need verified upstream access.
- Write failing behavioral tests first; database semantics require real-engine tests.
- Root owns registration, shared catalog, upload plumbing, and final commits/pushes.

## Review Focus

- Partial pages, nonadvancing cursors, and authentication failures must not retire logs.
- Counts must not copy a send result onto anonymous or distinct failed attempts.
- Reordered/repeated CSV uploads must retain occurrence identity and attachments.
- Malformed archives/CSV must fail with actionable messages and no destructive writes.
- Account erasure must not silently claim remote credentials were revoked.

### Task 1: Preserve raw boolean completion

**Files:** `packages/training/src/climbing-log.ts`, `src/db/source-attempt-facts.ts`,
`src/db/climbing-log-sync.ts`, `src/db/schema/climbing.ts`, forward migration and
colocated schema/writer/result tests.

**Interfaces:** Add nullable `sourceCompleted` only to the recorded attempt
schema and optional source writer input. Existing served attempt shape stays
unchanged. PostgreSQL chooses the explicit boolean before its existing label
projection. Extend native textual recognition for verified `f`, `os`, `rp`.

- [x] Write failing tests for true/false/null, stable refresh identity, conflicting
  evidence, omitted preservation, and anonymous count expansion.
- [x] Run targeted unit/database tests and record expected failures.
- [x] Implement the schema/writer/view migration without historical backfills.
- [x] Run targeted tests and schema/type checks; record results for review.

### Task 2: Account-connected board providers

**Files:** `src/providers/kilter.ts`, `src/providers/tension.ts`,
`src/providers/grasshopper.ts`, `src/providers/decoy.ts`, `src/providers/soill.ts`,
`src/providers/touchstone.ts`, `src/providers/aurora-board.ts`, shared upstream
client/sync modules under `src/lib/`, and matching tests.

**Interfaces:** Export `KilterProvider`, `TensionProvider`, `GrasshopperProvider`,
`DecoyProvider`, `SoillProvider`, `TouchstoneProvider`, `AuroraBoardProvider`.
IDs are `kilter`, `tension`, `grasshopper`, `decoy`, `soill`, `touchstone`,
`aurora-board`. Constructors accept optional Fetch injection. Implement
`SyncProvider` with `sync(run: SyncRun)` and per-user `authSetup()`.

- [x] Write failing protocol/parsing/auth tests for native IDs, grades, explicit
  completion, separate bids, tombstones, pagination, expired auth, and malformed
  payloads. Use real database/MSW tests for persistence and isolation.
- [x] Implement current Kilter API with token refresh and authoritative logs.
- [x] Implement the shared Aurora protocol with explicit pagination completion,
  no guessed grade/count conversion, and additive writes plus explicit tombstones.
- [x] Run targeted tests; document account smoke-test limitations and revocation
  requirements. Do not modify shared registration files.

### Task 3: Climbing file providers

**Files:** `src/providers/crimpd/provider.ts`, `src/providers/eight-a/provider.ts`,
`src/providers/moonboard/provider.ts`, parser helpers and colocated tests. Reuse/extract
the existing multiline-aware Kaya CSV decoder if useful.

**Interfaces:** `CrimpdProvider`, `EightAProvider`, `MoonBoardProvider` implement
`ImportProvider`, with IDs `crimpd`, `eight-a`, `moonboard`.
Export `importCrimpdExportFile(db, filePath, userId)`,
`importEightAExportFile(db, csvText, userId)`,
`importMoonBoardExportFile(db, csvText, userId)`, each returning `Promise<SyncResult>`.

- [x] Write failing parser/idempotency tests using cited wire/export contracts,
  including quoted newlines, empty/zero values, duplicate occurrences, source
  date semantics, and invalid headers/archives.
- [x] Implement Crimpd raw climbing sets and supported workout/strength facts;
  preserve booleans via Task 1 and omit vendor-computed rollups.
- [x] Implement 8a.nu/Vertical-Life CSV and historical MoonBoard BoardLib CSV.
  Preserve uncertain count and grade semantics; do not invent source identities.
- [x] Run unit and real-database importer tests; do not modify shared wiring files.

### Task 4: Expose providers and imports on both platforms

**Files:** Worker/server registration, root exports, provider catalog/onboarding,
queue configuration, processing contracts, file-upload types/schema/migration,
worker import dispatch, server format allowlist, web/mobile import configuration,
mobile share detection, account-erasure prerequisites, and behavioral tests.

**Interfaces:** Consume Tasks 1–3 exports. Upload types are `crimpd`, `eight-a`,
`moonboard`; source IDs match provider IDs. Crimpd accepts documented ZIP;
8a.nu and MoonBoard accept their distinct CSV headers.

- [x] Write failing upload dispatch, database CHECK, web/mobile action, share
  detection, and erasure-prerequisite tests.
- [x] Register all verified providers and wire existing upload/credential controls.
- [x] Add the forward upload-type constraint migration and processing coverage.
- [x] Run affected tests and typechecks for root/server/web/mobile/shared packages.

### Task 5: Review, document, and deliver

**Files:** `docs/climbing-providers.md`, provider guide/catalog docs, implementation
notes, and the task-specific review package.

- [x] Document verified access, native fields, missing fields, export instructions,
  account limitations, verification date, and the remaining blocked sources.
- [x] Perform independent task/final reviews; resolve important findings with tests.
- [x] Run lint, typechecks, relevant integration tests, and unit/mobile tiers.
- [x] Commit and automatically push the branch, reporting exact validation results
  and unresolved vendor-access requirements.
