# Intervals.icu provider implementation plan

> Use the approved design and work through the tasks in order. Record a failing regression test before each behavior change and review the diff after the corresponding test passes.

**Goal** — Sync completed workouts, wellness, and scheduled workouts through one read-only OAuth connection on web and iOS.

**Architecture** — An Intervals.icu pull provider calls three date-bounded feeds and uses Dofek’s provider OAuth, queue, activity, and wellness paths. The Activities screen reads upcoming workouts from a single provider-neutral PostgreSQL model. Use TypeScript, Zod, Drizzle, tRPC, and the existing React and Expo components.

**Spec** — [Approved design](../specs/2026-11-21-intervals-icu-provider-design.md).

## Global constraints

- Provider ID `intervals.icu`. Per-user OAuth only with `ACTIVITY:READ`, `WELLNESS:READ`, and `CALENDAR:READ`, comma-separated with S256 PKCE. Register and enable the provider once the three feeds are implemented. Reuse shared connectivity and status UI.
- Preserve source provenance and local dates. Reconcile a list only within its complete source window. Preserve imported data on disconnect. Attach storage to existing provider data deletion and account erasure. Keep read-model overlap resolution on the server.
- OAuth approval and live tests gate rollout. Validate behavior with MSW and real database tests before credentials are available. Avoid printing OAuth credentials, personal records, or raw auth response bodies in logs.

## Review focus

- Incomplete grant during reconnect preserves the prior authorization in Task 1.
- Switching athlete after disconnect stays blocked during source data deletion in Task 1.
- Restricted stub stays out of activity ingestion and does not imply source absence in Task 2.
- Null wellness fields clear source observations and omitted fields preserve them in Task 3.
- A reschedule across days keeps its event identity. An invalid calendar response preserves the previous snapshot in Task 4.

## Task 1 — OAuth and retained athlete

**Files** — Create `src/providers/intervals-icu/oauth.ts` and its colocated MSW tests. Add the retained binding in `src/db/provider-data-deletion.ts`, `src/db/schema/events.ts`, and their integration tests. Update `.env.example` and add setup notes in `docs/intervals-icu.md`. The provider registration is wired in Task 4 after feed coverage is in place.

**Interface** — `createIntervalsIcuAuthSetup(options?: { host?: string }): ProviderAuthSetup | undefined`, `validateIntervalsIcuConfig(): string | null`, and `bindIntervalsIcuAthlete(db: SyncDatabase, userId: string, athleteId: string): Promise<void>` within the database layer. The provider calls the binding both at connect and before a sync writes source rows.

- [ ] Write and run tests for the authorized URL, POST form and S256 verifier, a token response with an athlete ID and all three grants, partial grants, malformed responses, and bearer `DELETE /api/v1/disconnect-app`. Assert private response content stays out of errors. Run `rtk proxy pnpm exec vitest run --project unit src/providers/intervals-icu/oauth.test.ts` and confirm the missing behavior fails.
- [ ] Implement OAuth using the documented form contract and existing redirect resolver. Use `INTERVALS_ICU_CLIENT_ID` and `INTERVALS_ICU_CLIENT_SECRET`. Follow the repository precedent for grants without documented expiry or refresh credentials. Set `reconnectStrategy: "replace"` and use the existing explicit disconnect and account-erasure revoke hooks. Accept only established terminal outcomes from revocation and preserve unexpected errors for retry.
- [ ] Write and run PostgreSQL tests for accepting the same athlete, reserving a binding across disconnect, rejecting an alternate athlete while data is retained or deletion is pending, and accepting it after completed deletion. Cover generation replay: a stale completion must preserve a binding moved to a newer generation by a succeeding connection or sync.
- [ ] Persist a keyed athlete digest with the existing user/provider generation row. Derive it using repository credential identifier conventions. Check and set it under the existing transaction and operation fences. Couple its removal to the matching completed deletion generation, preserving any binding touched for a newer generation. The generation row’s existing user cascade covers account erasure. Keep provider data deletion discoverable when the binding is the only retained metadata. Verify the exact reconnect and teardown behavior in the callback and deletion callers.
- [ ] Rerun focused OAuth and real PostgreSQL test files, validate migration metadata, then review and commit the chunk. After adding the migration, run `rtk proxy pnpm migrate` in the isolated workspace.

## Task 2 — Completed workout ingestion

**Files** — Create `src/providers/intervals-icu/client.ts`, `src/providers/intervals-icu/activities.ts`, `src/providers/intervals-icu/provider.ts`, and matching tests. Reuse `src/db/provider-activity-sync.ts` and `src/db/metric-stream-writer.ts`.

**Interface** — `IntervalsIcuProvider implements SyncProvider` with ID `intervals.icu`. The client supplies a rate-limit-aware authenticated GET with Zod validation, `AbortSignal`, and explicit errors. Feed modules receive the client and the existing `SyncRun`.

- [ ] Write MSW fixtures and a provider integration test for date-bounded lists, a full activity with sensor streams, duplicate sync, an empty authoritative list, a restricted stub with the same ID as a previously imported record, malformed list data, and a failed stream fetch. Assert `activity` identity and stream payloads via the normal writer. Run the failing suites before adding ingestion.
- [ ] Use `/api/v1/athlete/0/activities` with `oldest` and `newest`, and `/api/v1/activity/{id}/streams` for supported series. Request the smallest verified response shape that preserves activity ID, actual start and end evidence, sport, device attribution, and all accepted sample streams. Normalize sport via existing helpers and map event offsets to instants using the actual start time. Apply the `SyncWindow` bounds to activity rows and both sides of reconciliation. Preserve unsupported/restricted rows as upstream presence only. Keep zero readings, nullable samples, and incomplete streams semantically distinct.
- [ ] Use shared activity list upserts and reconciliation, and the metric-stream writer’s replacement API for independently complete channels. Preserve a stored channel on fetch failure or omission. Honor `Retry-After` through `createProviderRateLimitFetch`, scoped to the OAuth app budget, and use bounded concurrency. Ensure errors or a throttle in one feed do not discard successful work from other feeds and their status remains actionable.
- [ ] Load the encrypted per-user token through `loadTokens`, bind its athlete before writes, and report counts and per-feed diagnostics through the shared sync entry point. Rerun focused tests, review, and commit.

## Task 3 — Daily wellness and sleep totals

**Files** — Create `src/providers/intervals-icu/wellness.ts` and colocated unit and integration tests. Use existing health and body storage. For date-only observations without an existing read path, extend the typed daily metric catalog and its server projections. Update matching existing health or sleep summary destinations in `packages/web` and `packages/mobile` with test and Storybook coverage for changed components.

- [ ] Fixture `/api/v1/athlete/0/wellness` with `oldest`/`newest`, overlapping days, explicit null, omitted fields, zero, and temporary weight or resting heart rate. Tests prove the canonical local date, source provenance, replay behavior, and clearing of source facts. Assert the sleep total is displayed as provider-reported duration without an inferred episode or stages. Run these tests before implementation.
- [ ] Parse authoritative recorded weight, resting heart rate, HRV, steps, and `sleepSecs`. Map other raw wellness fields only where existing canonical units and meanings match. Reuse the existing date-ledger storage for date-only fields. If a raw date-only weight or resting heart rate needs a new projection, keep its calendar date authoritative and avoid fabricating a timestamp or placing it into an unrelated time-series analysis. Explicit null clears that source fact and an omitted field preserves it. Keep date-only sleep duration out of episode or stage derivation.
- [ ] Read the values through shared server-resolved source precedence and use matching labels on both clients. Carry source attribution. Validate the proposed Garmin disclosure for source-unknown wellness before production rollout. Include real-engine coverage for any changed daily or body queries. Rerun tests, review, and commit.

## Task 4 — Planned workouts and provider registration

**Files** — Create a planned workout model in `src/db/schema/planned-workout.ts`, its sync repository and tests under `src/db`, and the API adapter `src/providers/intervals-icu/calendar.ts`. Extend the existing calendar tRPC router and the Activities pages `packages/web/src/pages/ActivitiesPage.tsx` and `packages/mobile/app/(tabs)/activities.tsx`. Register the provider in `src/jobs/provider-registration.ts`, `src/jobs/provider-queue-config.ts`, `packages/server/src/routers/sync-helpers.ts`, root exports, and `src/processing/dataset-contracts.ts` as appropriate. Update provider data deletion and export inventories for the new records.

- [ ] Write and run PostgreSQL tests for upserting `(user_id, provider_id, external_id)`, moving the same event across days, clearing missing events only in a valid response window, malformed lists keeping their snapshot, and source/user erasure. Include an athlete-local date at a UTC day boundary and at daylight saving changes. Add calendar API and web/iOS UI tests for an upcoming dated session with a repeat group and percentage or absolute target beside existing completed totals.
- [ ] Sync the `WORKOUT` calendar category in bounded requests. A normal sync covers the requested past window through 90 athlete-local days ahead. Keep explicit historical backfills bounded to their requested range. Persist original structured data with source-local dates, upsert and reconcile the exact successful window in one transaction, and keep the previous snapshot after malformed or partial responses. Retain title, notes, sport, source and authored target units.
- [ ] Add a user-scoped upcoming calendar response capped to the 90-day horizon. Project structured steps and repeats on the server to a provider-neutral shape. Respect source filtering and the existing data-access policy. Add the upcoming schedule section on web and iOS with local date grouping, details, and stale data during refetch. Keep completed counts based on recorded activity. Invalidate the upcoming query when sync or source deletion changes the schedule.
- [ ] Register both server and worker using the existing presentation catalog entry and shared sync flow. Confirm scheduled and manual sync discover the integration only when its app credentials are configured. Document the verified API, rate limits, source restrictions, registration, connection, and sync behavior in `docs/intervals-icu.md`.
- [ ] Apply the migration with `rtk proxy pnpm migrate`, review schema diagrams, verify erasure/export coverage, and rerun real database, web and mobile suites. Review and commit.

## Task 5 — Verification and rollout

- [ ] Run `rtk proxy pnpm lint`, `rtk proxy pnpm --recursive --include-workspace-root --if-present typecheck`, non-interactive unit and mobile suites for all affected behavior, and `rtk proxy pnpm test:integration --` for the changed database tests. Review the whole diff independently and resolve actionable findings. Push each verified commit to the current branch.
- [ ] Verify approved OAuth client registration, redirect URIs, and named Infisical credentials in each applicable environment. Keep initial rollout gated on a consenting account exercising connect, all three feeds, same-account reconnect, and disconnect. Confirm wellness attribution, stream/restriction behavior, calendar removals, and idempotent revocation outcomes. Record what was observed and which production credentials or approvals are still pending.
