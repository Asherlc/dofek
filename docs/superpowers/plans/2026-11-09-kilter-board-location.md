# Kilter board location implementation plan

> **Execution:** The user approved direct implementation after the configured workers were unavailable. Use superpowers:executing-plans, with TDD and an independent final review.

**Goal:** Resolve each Kilter log's physical board and gym and show its location on web and iOS.

**Architecture:** Use the official PowerSync Node client for a disposable read-only directory mirror. Preserve native identities, store gym Areas through a log-level reference, and reuse the existing detail and map presentation.

**Tech Stack:** TypeScript, Zod, PowerSync Node SDK, Drizzle/PostgreSQL, React, React Native, Vitest/MSW.

**Spec:** [Approved design](../specs/2026-11-09-kilter-board-location-design.md), approved by the user with “y”.

## Global constraints

- Stay on `kilter-board-used-location`; do not switch branches or create worktrees.
- Use the SDK, not a custom PowerSync protocol, service or permanent SQLite store.
- Use the latest stable registry release and exact dependency versions; retain only necessary custom code.
- Preserve distinct log occurrences and shared climb identities; a shared problem must not acquire one gym's location.
- Unknown directory records remain unknown; failed/malformed directory reads prevent authoritative reconciliation.
- Reuse existing encrypted renewable account credentials, never print secrets, and do not resync or deploy production.
- Implement both clients. Unit/mobile tests are Docker-free; executable PostgreSQL tests cover persistence and view behavior.
- Write tests first, observe intended failures, then implement. No recursive worker delegation.
- Commit only after validation and push every new commit automatically.

## Review focus

- One problem logged at two gyms must retain two distinct log locations.
- Missing or mismatched wall/gym identities must not produce invented associations.
- Directory auth, cancellation, connection failure and cleanup must not hang or report a successful empty sync.
- Clearing or replacing a log location must not delete an Area still referenced by another log.
- Existing providers and installed-client response parsing must remain usable.

### Task 1: Read the Kilter directory with the standard SDK

**Files:** `src/lib/kilter-board-directory.ts`, its colocated tests, `package.json`, `pnpm-lock.yaml`, existing dependency/build configuration only if required.

**Interfaces:** Export `KilterBoardDirectory` with `fetch(credentials: (signal: AbortSignal) => Promise<{ token: string; expiresAt: Date }>, signal?: AbortSignal)` returning validated `{ walls, gyms }`. Wall fields: `wall_uuid`, `name`, `gym_uuid`; gym fields: `gym_uuid`, `name`, `latitude`, `longitude`. Unknown optional facts are nullable; identities required. Subscribe only to the server-advertised `global_gyms` stream with defaults disabled and await that subscription's first sync. Cancellation must cover pending SDK startup and credentials as well as first-sync waiting, with resource cleanup. Retain raw directory records for provenance if the mapping needs them.

- [x] Verify authenticated directory access with the connected account; record sanitized evidence and actual field shapes before freezing schemas.
- [x] Test SDK-backed sync completion, validation, abort and failure cleanup. Unit tests may mock external SDK boundaries; meaningful integration verification uses actual SDK and network fixtures or live read-only evidence, not a fake SDK.
- [x] Add latest stable SDK, using its existing support for SQLite and standard authenticated streaming. Bound first-sync lifetime and propagate errors instead of waiting forever on SDK reconnects. Always close and remove the disposable mirror.
- [x] Run focused tests, root typecheck, review diff against the approved design; report RED/GREEN evidence and dependency/runtime constraints. Lead reviews before Task 2.

### Task 2: Persist and resolve location for each log

**Files:** `src/lib/kilter-board-client.ts` and tests; `src/db/schema/climbing.ts`, `src/db/climbing-log-sync.ts` and integration tests; shared log schema as required; a new forward-only migration and journal/snapshot; existing view/serving queries as required.

**Interfaces:** Add nullable `climbing_log_entry.area_id` with owner/provider-safe FK to Area. Source log entries accept optional `areas` with existing `SourceAreaDefinition` semantics: omitted preserves, `[]` clears. Resolve and clean up through existing writer functions. Kilter mapping consumes Task 1's directory and maps physical board name plus log-specific gym Area and coordinates. Use source log `gymUuid` when present and verified; wall directory's gym association can resolve otherwise. Contradictory source associations must not silently select a gym.

The view's `area_path` is the effective log location; preserve actual shared Climb geometry and its separate `climb_area_path`. Append `log_area_id` for private serving-query precedence. Log detail responses add optional top-level `areaPath` under response version 4; older versions omit the new field. Both clients request version 4 and choose the log path, falling back to the Climb path only when the field is omitted by an older supported response. This uses the existing version-negotiation pattern rather than changing strict installed-client payloads.

- [x] Write executable PostgreSQL regressions for one shared problem at two gyms, omitted/cleared/replaced location, referenced-Area cleanup, owner isolation and log location precedence over climb location.
- [x] Write Kilter client regressions for mapped board/gym, missing IDs/records, contradictory IDs, one directory fetch per sync, auth renewal and directory failure before reconciliation. Preserve exact raw source evidence and existing native IDs.
- [x] Implement the minimal nullable log Area reference and migration; expose recorded location through the existing server projection. Do not change a Climb's recorded geometry to stand in for a log's gym.
- [x] Run focused unit and database tests, schema generation, migration lint and typechecks; review and record results before Task 3.

### Task 3: Present and verify both clients

**Files:** Existing web/mobile climbing detail/context components and tests/stories; shared/server location selection as needed; `docs/climbing-providers.md`.

**Interfaces:** Existing responses carry enriched board name and correct gym Area path/mapLocation. Keep list text concise. Existing map behavior should work without a second map framework.

- [x] Write failing web/mobile rendering regressions for named board, gym and absent location, and server location-selection tests when needed.
- [x] Implement parity in existing views and use existing map location outputs. Verify visually using browser tooling; every development HTTP server must have `/Users/asherlc/bin/paseo-quick-tunnel <port>` running and only its emitted trycloudflare URL may be reported.
- [x] Update provider docs with source links and actual authenticated verification limitations.
- [x] Run applicable lint, typecheck, unit/mobile and integration checks. Review actual full diff and evidence; fix material findings with TDD, commit and push on the existing branch.

## Review checkpoints

After each task, lead compares actual diff and test evidence to its requirements before starting the dependent task. A fresh Architect reviewer checks the whole result before completion. Record progress and rulings under `.superpowers/sdd/2026-11-09-kilter-board-location/`.
