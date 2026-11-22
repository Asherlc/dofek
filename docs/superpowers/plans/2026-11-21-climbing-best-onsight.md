# Best Recorded Onsight Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans as the Paseo Implementer. Follow the tasks in order, report architectural uncertainty to the lead, and do not delegate further.

**Goal** — Show the 12-month best recorded onsight by climbing type and setting on the existing web and iOS climbing training pages.

**Architecture** — Read the recorded-date subset of canonical rock-climbing observations in PostgreSQL. Rank eligible grades on the server and serve the five rows through a protected tRPC query. Each client renders the source grade and opens the existing provider record detail viewer with its record identity.

**Tech stack** — PostgreSQL, Drizzle SQL, Zod, tRPC, React, React Native, Vitest.

**Spec** — [Approved design](../specs/2026-11-21-climbing-best-onsight-design.md).

## Global constraints

- Work sequentially in `insights/climbing-best-onsight`. Preserve existing design feedback files and any user edits. Repo policies require failing regression tests before behavior edits, noninteractive commands, lint, all-package typechecking, and real PostgreSQL integration checks.
- Use existing imports, views, attempt classification, grade order, and detail viewers. The feature needs no new provider, saved data, migration, or external link format. The approved surface is the existing climbing pages.
- The date line and grades are the matrix's supporting copy. Every populated grade opens its source send. Empty cells have dashes and an accessible description. Keep the full matrix independent of the page's selected period and filters.
- Keep both platforms consistent. Add stories for new presentational components and update affected route stories and test fixtures.

## Review focus

- Use the calendar-month cutoff at a leap day and the subscriber's local date around UTC midnight.
- Match a qualifying onsight to its own rope method when the log has multiple methods.
- Preserve the settings of records that lack a persisted setting, including providers with an outdoor projection default.
- Preserve query scoping by user, source date, and analytics access window for attached and unattached logs.
- Verify the exact selected record in the real detail viewer on both clients. Preserve loaded results during refetch and refresh the query after mobile data sync and pull-to-refresh.

### Task 1 — Serve the matrix from PostgreSQL

**Files** — Create `packages/training/src/climbing-best-onsight.ts`, `packages/server/src/repositories/climbing-best-onsight-repository.ts`, and its colocated integration test. Register the procedure in `packages/server/src/routers/climbing.ts`. Reuse `climbing-rock-observations.ts` and the grade helpers.

**Interface** — `ClimbingBestOnsightRepository extends BaseRepository` with `getBestOnsight(now = new Date()): Promise<ClimbingBestOnsight>`. The shared Zod output `climbingBestOnsightSchema` validates `{ startDate, endDate, rows }`. Each row has `type` from the existing five choices and `gym` and `outdoor` cells. Each cell is null or `{ grade, gradeSystem, providerId, recordId }`, with a canonical UUID record ID. `climbing.bestOnsight` is a protected no-input tRPC read with this output and the standard climbing error wrapper.

- [ ] Write and run failing PostgreSQL integration regressions. At `2026-11-22T02:00:00Z` in `America/Los_Angeles`, the start and end must be `2025-11-22` and `2026-11-21`. Include the first and last dates and exclude the anniversary and future days. Confirm leap-day month arithmetic. For an attached log with a different session date, the winner follows `climbedOn`. Seed an unattached confirmed 8a.nu boulder with a compatible reported grade and expect it to rank in Outdoor. Seed an unlabeled completion, a flash, a known prior attempt, aid, a pitch, a higher retired log, another user's log, an inaccessible date, and an unknown setting or method. None may displace a confirmed winner. Seed mixed route attempts and expect only the onsight's method to receive the grade. Verify published precedence, fallback, compatible cross-scale ranking, the recent tie winner, and the complete empty matrix.
- [ ] Build the minimal read. Use the authenticated user's calendar day and PostgreSQL month arithmetic for the inclusive start and end. Limit by `climbed_on`, active owned logs, and `dateAccessPredicate` before applying the existing rock projection. Join the owned climb row for persisted setting. Use its per-attempt onsight evidence, the view's original grade components, `isGradeSystemForClimbKind`, and `gradeSortValue`. Choose the first rankable compatible published component in existing source order, then the first rankable reported component as fallback. Rank within type and setting only. Use Zod-validated SQL results. Do not change account source readers or existing climbing call semantics.
- [ ] Run `rtk pnpm test:integration -- packages/server/src/repositories/climbing-best-onsight-repository.integration.test.ts` and the server typecheck. Report exact red and green outputs and anything requiring a lead decision. Commit and push the verified server slice after lead review.

### Task 2 — Render the matrix and open the stored send

**Files** — Add `ClimbingBestOnsight.tsx`, its unit test, and story in the existing web and mobile components directories. Integrate with `packages/web/src/routes/training/climbing.tsx` and `packages/mobile/app/strain.tsx` and, for Grade Progression placement where practical, `packages/mobile/components/ClimbingTrainingCard.tsx`. Update relevant route stories, fixture or mock registries, and `packages/mobile/lib/invalidate-synced-health-data.ts` with its existing test.

**Interface** — Consume the query's `ClimbingBestOnsight` result. On selection use each platform's existing `ProviderRecordDetail` with `{ providerId, dataType: "climbingLogEntries", recordId }` and the existing close flow. No standalone send page or URL is required.

- [ ] Write and run failing web and React Native regressions for all five types and both settings, empty cells, and selecting a displayed grade by its accessible name. Assert the correct provider, type, and exact record ID are passed to the existing viewer, and assert closing preserves the matrix. Cover loading, error, and empty state. Exercise the annual query through the normal route independently of the selected filter and period. Update the mobile sync invalidation test for the new query path.
- [ ] Add the approved Grade Progression content to both surfaces. Render the fixed date range using existing date formatters. Use a web table and an accessible native equivalent. Expose the setting, type, and grade in the accessible link name. Use the standard query state UI, refresh hooks, and keep previously loaded data visible during background refresh. Leave other training sections in place.
- [ ] Run the relevant web/mobile Vitest files noninteractively. Run full `rtk pnpm lint` with workspace ClickHouse and `rtk pnpm --recursive --include-workspace-root --if-present typecheck`. Report red and green outputs and any required check still pending. Commit and push after lead review.

### Task 3 — Review and verify

- [ ] Review actual diffs against the spec, storage and test policies, and both client entry points. Verify the app displays a recorded grade and that the selected send goes to the existing viewer. Use the available web/mobile previews where practical. Update the climbing documentation with the fixed window and the primary study's scope.
- [ ] Run or confirm the relevant real-engine, unit/mobile, lint, and all-package typecheck evidence for the final code. Report the final commit and check outcomes.
