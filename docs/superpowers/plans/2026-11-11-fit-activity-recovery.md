# FIT Activity Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the tasks in order, with explicit review checkpoints.

**Goal:** Recover complete messages from damaged activity FIT files while preserving originals and showing that the activity is incomplete.

**Architecture:** Keep Garmin's C++ decoder, the existing bounded two-pass protocol, FIT importer, and activity detail screens. Return a nullable `recoveryError` from native metadata; store that structural ingestion outcome once in the nullable `activity.fit_recovery_error` column. Ordinary provider payload replacements leave it intact. The server exposes whether any active member of a merged activity was recovered. Both clients render a plain warning on activity details.

**Tech Stack:** Existing Garmin FIT SDK, C++17/CMake/vcpkg, TypeScript/Zod/Drizzle, React and React Native.

**Approved design:** The user approved explicit partial recovery on November 11 after diagnosis established that Wahoo workout 184071258 has 8,675 complete record messages, a checksum failure, and a malformed final message. Full-file rejection and requiring a replacement were considered; the user selected recovery. This follows Garmin's [documented activity recovery practice](https://developer.garmin.com/fit/articles/cookbook/isfit_checkintegrity_read.html). Preserve existing safeguards; recovery does not establish data completeness or checksum validity.

The user separately approved a nullable recovery-status column and additive migration, so ordinary provider-payload updates preserve the warning. Clear it only after a clean FIT import finishes saving.

## Global Constraints

- Preserve original bytes and content-addressed retention before decoding. Never repair or replace the archived file.
- Recover only single-segment declared activity files with at least one complete timestamped record. Damaged chained inputs, invalid headers, unsupported files, weight files, zero usable records, protocol errors, acknowledgement failures, I/O failures, and resource-limit failures remain fatal. Intact chained files keep normal SDK decoding.
- Catch only Garmin decoding failures. Do not swallow listener/persistence errors. Both passes must observe the same decode outcome and complete record count.
- Keep 250-message batches, 512 KiB protocol messages, 4,096 metadata keys, acknowledgement backpressure, and idle timeout unchanged.
- Use synthetic fixtures in committed tests. The private incident original stays in ignored `.context/`.
- No new dependencies, environment variables, recovery framework, or provider-specific exception. Add one nullable activity metadata column through the existing Drizzle migration workflow; no backfill or new table is needed.
- Report recovered decode failures to Sentry as handled warnings; they remain visible without turning successful recovery into another fatal sync result.
- Show the warning on both detail screens. Do not add explanatory text to activity list cards.
- No branch switching, merge, production deployment, or replay by workers. No recursive delegation. Lead performs checks, commits, pushes, and production coordination.

## Review Focus

- Complete records only: the footer must never be consumed as the tail of a recovered record.
- Strict files: malformed weight, non-activity, and empty files remain rejected.
- Infrastructure failures: failed acknowledgements and metadata/batch bounds never become recovery warnings.
- Canonical groups: a recovered secondary member still produces a detail warning, with owner/deletion filters preserved.
- Reimport: a valid later import clears the warning; incomplete reimport cannot be called complete.

### Task 1: Native recovery and adapter contract

**Files:** `native/fit-decoder/src/fit-decoder.cpp`, native fixture/protocol tests and CMake registration, `src/fit/stream-decoder.ts`, `src/fit/stream-decoder.test.ts`, `native/fit-decoder/README.md`.

**Interfaces:** Native metadata always includes `recoveryError: string | null`; `FitStreamMetadata` exposes the same required field. Normal files use null. Recovery must be decided during metadata pass and reproduced during streaming. No CLI flags.

- [x] Write and run failing synthetic native tests for a truncated activity, corrupt CRC, a malformed final record, corrupt weight file, and activity with no complete timestamped records.
- [x] Implement the smallest SDK-based recovery satisfying Global Constraints. Preserve raw messages without inventing metadata. Acknowledge and flush the recovered final batch normally.
- [x] Add adapter tests verifying nullable warning propagation and rejection of malformed warning messages. Update existing metadata fixtures for the required field.
- [x] Build using canonical release CMake presets and run `ctest --preset release`; run the focused adapter unit suite. Record commands and results.
- [x] Lead review checkpoint: inspect actual diff, fatal paths, native bounds, and exact incident record count before proceeding.

### Task 2: Import provenance and server detail

**Files:** `src/db/schema/activity.ts`, the generated additive Drizzle migration/metadata/schema diagram; `src/jobs/process-fit-file-import-job.ts` and its tests; `packages/server/src/repositories/activity-repository.ts`, `activity-repository-schemas.ts`, their database tests; `packages/server/src/models/activity.ts` and its tests; directly affected fixture helpers.

**Interfaces:** Store metadata recovery outcome at `activity.fit_recovery_error` (Drizzle property `fitRecoveryError: string | null`), writing null on a later valid FIT import. Ordinary provider raw-payload updates must preserve it. Add required `ActivityDetail.fitRecoveryWarning: string | null`. Use the fixed text: `Some activity data could not be recovered from the original file. The available data was imported; this activity may be incomplete.` API computes this from any live member's non-null status column, not only the representative. This text does not expose native errors or local paths.

- [x] Write failing importer tests for retained original, complete staged records committed, warning stored and reported, later clean import clears marker, and unexpected persistence failure remains fatal.
- [x] Generate and apply the additive column migration locally using existing tooling; never apply it to production from this task. Store provenance in that column and report the handled source decode failure at warning severity without adding a fatal result error. Preserve status on ordinary provider raw updates and on the existing Garmin-summary shortcut; clear only on clean FIT reimport.
- [x] Write a real Postgres regression proving a recovered secondary member produces the warning, other users/deleted members do not, and clean groups return null.
- [x] Extend the existing detail projection/model and update directly affected typed fixtures. Do not modify analytics models or add storage beyond the approved column.
- [x] Run focused unit and real-engine tests under the workspace's canonical test setup.
- [x] Lead review checkpoint: inspect provenance, erasure/ownership predicates, valid reimport, and warning aggregation.

### Task 3: Web and mobile warning

**Files:** `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/mobile/components/activity/ActivityDetailHeader.tsx`, their existing tests/stories/fixtures. The mobile route already passes the full activity to its header, so it needs no new wiring.

**Interfaces:** Render `activity.fitRecoveryWarning` only when non-null, in the existing detail content near the activity heading/summary, using established warning styles and accessible semantics. Clients do no recovery calculations.

- [x] Add failing web and mobile tests that show the server warning for recovered activities and preserve normal clean activity rendering.
- [x] Render the warning on both platforms using existing primitives; avoid a new component solely for one paragraph.
- [x] Update existing visual fixtures/stories and run relevant tests.
- [x] Lead review checkpoint: verify equivalent copy/visibility and existing screen-reader conventions. Code review passed; browser and native screen-reader runtime checks remain unverified because browser automation was unavailable.

### Task 4: Qualification and shipping

- [x] Run the modified native decoder against the ignored exact incident original and require exactly 8,675 complete records plus a recovery warning, without source changes.
- [ ] Review the complete diff, then run required lint, relevant tests, and package typechecks. Use existing native and integration test tiers; do not weaken gates.
- [ ] Update FIT documentation and production incident baseline with evidence and remaining release/replay acceptance.
- [ ] Commit and push automatically, open/update the PR using the canonical workflow, and monitor CI. Do not automatically merge.
- [ ] Coordinate the production release/replay with the original conversation. Resolve SERVER-7Z and SERVER-80 only after the exact activity import and operator outcome are demonstrated.

## Working decisions

- The user's explicit approval covers implementing the stated partial recovery behavior; do not repeat that approval question.
- Use Cursor Auto for bounded edits according to configured Paseo profiles. The lead reviews each task and final architecture.
