# Manual cycling FTP implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation tasks and explicit task review.

**Goal:** Replace ongoing estimated FTP with dated user-entered FTP, an activity settings link, and explicitly invoked estimation options beside the input.
**Architecture:** Existing Postgres sport-settings snapshots supply FTP; existing ClickHouse observations supply normalized power. One server path combines them using each activity's source-local date.
**Tech Stack:** TypeScript, PostgreSQL/Drizzle, ClickHouse/dbt, tRPC, React and React Native.
**Spec:** `docs/superpowers/specs/2026-11-15-manual-cycling-ftp-design.md` (approved).

## Global Constraints

- Stay on the current branch; prefix shell commands with `rtk`; use pnpm and noninteractive tests.
- Manual FTP is the sole applied threshold. Do not auto-populate, decay, or use provider/profile fallbacks. User-invoked settings suggestions require explicit choice and Save.
- Settings rows remain full dated snapshots. Preserve omitted fields, copy the preceding snapshot for a new date, and preserve explicit null clearing.
- Select FTP using the canonical source-local activity date, falling back to user timezone. Bulk lookup only.
- Preserve independent power observations, normalized power, work, Critical Power, source invalidation and account-erasure fencing.
- Observe regression tests fail before implementation and pass afterward. Update obsolete tests according to the removal policy.
- Workers must not recursively delegate, switch branches, commit or push. The lead reviews, validates, commits and pushes each coherent chunk.
- No production deployment. Local migrations must actually run. Required lint, workspace typechecks, affected unit/mobile and real-engine integration tests must pass before readiness.

## Review Focus

Check snapshot edits and clear semantics; source-local dates; consistent unavailable states and load totals; no ongoing eFTP consumers; cache invalidation; NP lifecycle; bounded explicitly invoked suggestions with no write side effects; mobile/web parity and accessible settings navigation.

### Task 1: Restore dated FTP settings

Files: `src/db/schema/activity.ts`, new forward Drizzle migration and metadata, server sport-settings repository/router, cache invalidation, focused repository/router integration tests.

- Add nullable positive whole-watt `ftp` to existing sport settings, without backfilling.
- First add integration regressions for same-date partial save, preceding snapshot inheritance, lower FTP, explicit clear, deletion, future exclusion and user isolation; observe failure.
- Implement optional nullable FTP inputs and snapshot-preserving upsert. Current reads exclude future settings. Preserve unrelated fields and existing APIs.
- Invalidate affected settings, cycling, activity, calendar, comparison, load, PMC and MCP cache consumers using existing domains.
- Run migration and focused real Postgres tests; review spec and maintainability. Record exact commands and reports.

### Task 2: Retain normalized-power projection independently

Files: cycling-power projector/policy, `src/db/cycling-power-schema.ts`, forward ClickHouse migration, dbt models/sources, analytics build and erasure registrations, affected tests.

- First add a regression proving NP becomes available without threshold history, and retains source refresh, completion, null coverage and erasure behavior; observe failure.
- Remove automatic history replay and publication, keeping bounded NP projection. Retain the reference bank/candidate policy for explicitly invoked suggestions; no decaying ongoing estimate.
- Serve NP plus activity metadata without eFTP dependence. Replace serving view before dropping old history views/storage through a forward migration.
- Preserve public numerical package APIs unless proven application-only; preserve separate CP.
- Run focused projection and real ClickHouse migration/query tests. Review before proceeding.

### Task 3: Replace every server threshold consumer

Files: server cycling threshold/contracts, power/cycling/activity/calendar/load/PMC/comparison repositories and routers, MCP tools/contracts, shared types and cache versions, affected tests.

- First add tests of manual FTP formulas and dated bulk resolution including source-local near-midnight behavior; observe failure.
- Resolve manual FTP from Task 1 snapshots in bulk and compute IF=NP/FTP and TSS=(NP/FTP)^2*elapsed_seconds/36 in one path.
- Update every consumer of the old metrics/history contracts, preserving null/unavailable semantics and raw power availability including zero samples.
- Remove ongoing eFTP estimate/trend endpoints and MCP registrations; expose configured-value provenance where relevant. Replace the old estimator wrapper with a read-only bounded settings suggestion query over power-duration observations: retained reference family and 95% of best 20-minute power, evidence metadata and limitations. Default selected range is 90 days through the chosen effective date; allow explicit date bounds. No setting writes or out-of-range evidence.
- Bump response/cache versions; validate saves apply without analytics rebuild. Run affected tests and real-engine consumer tests.

### Task 4: Complete web and mobile behavior

Files: both settings pages/routes, cycling/activity views, FTP components/stories, persisted caches and affected client tests.

- First add behavior regressions for power/no FTP link and date-target navigation, no power, zero power, incomplete coverage, loading/errors, save/lower/clear and entered states; observe failure.
- Add Cycling FTP in Models & Units with positive whole watts, effective date, save and clear, using server settings API.
- Link activity power-zone missing state directly to FTP input with its local activity date.
- Add an Estimate action beside the input on both platforms. Only clicking it runs the bounded suggestion query. Show method results/unavailability, evidence dates and limitations. Choosing a suggestion fills the editable input; only Save applies it. Test no automatic request on mount, no setting write on run/choice, editable date bounds, missing evidence and error states.
- Remove eFTP values/provenance/trends on both platforms while keeping unrelated charts and CP. Update cache persistence and stories.
- Run focused web/mobile tests and review accessible visual states using the existing Firefox session only; no local E2E unless E2E files change.

### Task 5: Validate and review the whole change

- Run `pnpm migrate`, forward ClickHouse migration and focused real-engine integrations.
- Run `pnpm lint`, `pnpm --recursive --include-workspace-root --if-present typecheck`, affected noninteractive unit/mobile tests.
- Document coordinated server/web/worker/mobile release boundary and preserved NP data; no production deploy.
- Review the whole diff independently, resolve material findings, then commit and push coherent chunks. Record checks and a concise retrospective.
