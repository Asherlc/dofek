# Running race-time forecast implementation plan

**Goal**

Import existing Runalyze running race finishes and serve 10K and half-marathon estimates with traceable source evidence.

**Architecture**

Use the existing personal-token provider registration and sync path. Keep race results in one account-owned PostgreSQL relation. Serve the forecast from those observations through the existing read-only MCP authorization and structured response patterns.

**Design**

[Running race-time forecast](../specs/2026-11-21-running-riegel-race-forecast-design.md), approved in Paseo Q3.

## Task 1. Import completed Runalyze race results

- [ ] Write failing tests first for personal-token access, race pagination, linked running sport, unavailable and malformed values, and authoritative sync in a real PostgreSQL integration test. Record the failing command and first assertion. Use MSW for Runalyze HTTP.
- [ ] Implement `RunalyzeProvider` in `src/providers/runalyze.ts` using the existing sync and provider HTTP wrappers. Register the provider in the worker and server registries and relevant provider metadata and queue configuration. Reuse the existing connection UI. The documented personal token header is `token`. Validate access with a bounded GET to `/api/v1/raceresult`, and follow the existing personal-token error semantics. The provider publishes no programmatic Personal API token revoke endpoint. Follow the existing account erasure prerequisite pattern for locally stored, user-revocable tokens and document how to revoke in Runalyze.
- [ ] Use `GET /api/v1/raceresult` with `Accept: application/json`, `page`, `itemsPerPage`, and documented activity-time ordering. Batch `GET /api/v1/activity?id=…` requests where needed to check the explicit linked `sport.name`, activity ID, and `is_virtual` without importing its workout metrics. For eligibility require completed status, a nonvirtual linked Running activity, an attributable date, nonnull positive finite `official_distance` in kilometers and `official_time` in seconds, and a positive source `activity_id`. Runalyze may return results for other sports and activities with unknown metadata. Send clearly malformed contract responses through the existing failed-sync path.
- [ ] Persist eligible finish facts in `fitness.running_race_result`, declared under `src/db/schema/`, keyed on owner, provider, and source activity ID. Include source date/time with its recorded offset when available, source name, distance in meters, and exact elapsed finish seconds. Keep result time and distance together. Do not add a workout or model forecast values in storage. Replace the provider's owner-scoped snapshot transactionally after successful full inventory and activity resolution. An empty full inventory clears the snapshot. Partial/failed reads preserve it. Repeated sync is idempotent. Reuse the normal per-user sync and erasure fences. Any data ownership uncertainty is a stop-and-report point for the worker.
- [ ] Generate the migration with repo tooling, run `pnpm migrate` against an identified workspace-local database, and rerun the focused noninteractive tests. Verify owner isolation, repeated sync, changed data, deletion, partial failure, and account erasure coverage. Add concise documentation under the provider README and schema guide.

## Task 2. Serve the race forecast

- [ ] Write a failing server test for precise estimates, unavailable data, authorization, and source evidence. Use 25:00 at 5 km to pin 3149.150… seconds for 10K and 7000.362… seconds for half-marathon. Use real PostgreSQL for the scoped query. Verify another user's record is invisible.
- [ ] Register `get_running_race_forecast` under `activity:read` in the existing MCP tool registry. Accept `start_date`, `end_date`, and target `10k` or `half_marathon`. Use the established date schema and time zone range pattern. Consider only exact documented source distances shorter than target. Select longest eligible distance, newest race for ties, and stable provider/source identity for any remaining tie. Preserve full arithmetic precision and display rounded seconds only at presentation. Return target and estimate, method/source citation, and the source race name, date, input distance and finish seconds, and provider identity. Return an unavailable result when no eligible finish exists. Expose no new entry UI.
- [ ] Run focused unit and real PostgreSQL tests, `pnpm lint`, and `pnpm --recursive --include-workspace-root --if-present typecheck`. Check the complete diff, migration, source attribution and public contract. An authenticated live Runalyze check requires an authorized account token. Report its status explicitly and keep credentials and private results out of tool output.

## Review focus

- Explicit Runalyze completion and sport evidence are required. A tag, a workout title, a virtual effort, and a tracked duration cannot stand in for a race finish.
- Unrecognized sport names stay ineligible. No account-specific sport mapping is inferred from race names.
- Runalyze may revise results. Full successful sync replaces the account snapshot, while a failed page or linked lookup leaves the previous snapshot intact.
- A future date or same-distance result cannot seed a shorter-race forecast within the requested range.
- The existing provider and MCP account boundaries apply to token storage, snapshots, structured outputs, and erasure.
