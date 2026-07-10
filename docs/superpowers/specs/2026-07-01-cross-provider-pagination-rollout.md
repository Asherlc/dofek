# Cross-Provider Pagination Rollout Strategy

## Purpose

The WHOOP incident exposed a provider-neutral class of failure: an upstream API
can return a syntactically valid response that makes pagination unsafe to keep
following. This document describes how to migrate the other providers after the
shared sync-degradation and guarded-pagination foundation exists.

This is based on the local provider implementations, not on external API
documentation. The goal is to preserve each provider's domain-specific stop
rules while moving shared pagination safety rules into one implementation.

## Migration Principles

- Migrate providers by pagination shape, not alphabetically.
- Keep provider-specific business stops near provider code, such as stopping
  when an activity falls before the sync window.
- Keep provider-neutral safety stops in the shared pagination helper, such as
  repeated cursors, repeated page keys, empty pages that still claim more data,
  and maximum page limits.
- Treat pagination anomalies as degraded sync outcomes when already-fetched
  data can still be safely persisted.
- Do not reconcile deletions after a degraded or incomplete list fetch. Absence
  is only meaningful after a complete list fetch.
- Do not leave two competing pagination helpers in the provider tree once a
  provider has migrated.

## Provider Inventory

### Cursor and Link Providers

These should move first after WHOOP because repeated cursors are the failure
mode we just observed.

| Provider | Current shape | Local source | Migration target |
| --- | --- | --- | --- |
| WHOOP | `nextToken` in checkpoint continuation steps | `src/providers/whoop/sync-orchestrator.ts` | Stop on repeated token, record `pagination_stalled`, advance to persistence steps. |
| Oura | `next_token` via local `fetchAllPages` helper | `src/providers/oura/pagination.ts` and `src/providers/oura/sync-steps.ts` | Replace local helper with shared guarded pagination. |
| Decathlon | `links.next` absolute URL | `src/providers/decathlon.ts` | Use URL string as the cursor key, fingerprint URL in logs. |
| Wger | `next` absolute URL for workout sessions and weight entries | `src/providers/wger.ts` | Use URL string as the cursor key for both list loops. |
| Amazfit/Zepp | numeric `next` track cursor with local seen-cursor guard | `src/providers/amazfit-zepp.ts` | Replace local throw with shared degraded pagination handling. |

### Offset and Page Providers

These should move after the cursor/link providers. They are less likely to
repeat an opaque token, but they can still loop forever when the provider
returns unchanged pagination metadata or an empty page while claiming more
data.

| Provider | Current shape | Local source | Migration target |
| --- | --- | --- | --- |
| Fitbit | offset plus `pagination.next` and `pagination.limit` | `src/providers/fitbit/provider.ts` | Key each page by offset; degrade if `limit <= 0`, offset does not advance, or an empty page claims a next page. |
| Peloton | zero-based page plus `show_next` | `src/providers/peloton.ts` | Key by page number; preserve sync-window stop when an old workout appears. |
| MapMyFitness | offset plus `_links.next` | `src/providers/mapmyfitness.ts` | Key by offset and optionally next-link fingerprint; stop degraded if next link exists with no workouts. |
| Withings | offset plus `more` and returned `offset` | `src/providers/withings.ts` | Key by offset; degrade if `more` remains true while returned offset repeats. |
| Garmin Connect | checkpointed `activities_list` offset | `src/providers/garmin/sync-orchestrator.ts` | Keep checkpoint model, but derive follow-up list steps through guarded offset advancement. |
| Wahoo | one-based page plus `total`/`per_page` derived `hasMore` | `src/providers/wahoo/provider.ts` and `src/providers/wahoo/parsers.ts` | Key by page; degrade if page response is empty while totals still imply more. |
| Strava | one-based page plus full-page heuristic | `src/providers/strava.ts` | Keep rate-limit stop behavior; key by page and add max-page protection. |
| Zwift | offset plus fixed page size | `src/providers/zwift.ts` | Key by offset; preserve stop when an activity falls before the sync window. |
| Komoot | page plus `totalPages` | `src/providers/komoot.ts` | Key by page; degrade if `totalPages` increases without bound past max pages. |
| Concept2 | page plus `total_pages` | `src/providers/concept2.ts` | Key by page; preserve existing `page <= totalPages` boundary tests. |
| BodySpec | page plus `pagination.has_more` | `src/providers/bodyspec.ts` | Key by page; degrade if `has_more` is true on an empty results page. |
| Cycling Analytics | page plus page-size/empty-page stop | `src/providers/cycling-analytics.ts` | Key by page; add max-page protection and empty-page semantics. |
| Xert | page plus `data.length >= pageSize` | `src/providers/xert.ts` | Key by page; add max-page protection. |

### Date Iteration and Non-Pagination Loops

These should not be migrated just because they contain a `while` loop. They are
bounded date-window iterations or stream chunking, not provider pagination:

- `src/providers/auto-supplements.ts`
- `src/providers/fatsecret/provider.ts`
- `src/providers/ultrahuman.ts`
- `src/providers/whoop/sync-streams.ts`
- date utilities such as `src/providers/garmin/date-utils.ts`

## Rollout Order

### Phase 1: Foundation and WHOOP

Ship the shared degradation model, sync-log degraded status, metric and logger
reporting, cursor fingerprinting, and guarded pagination helper. Migrate WHOOP
developer-workout pagination first because production evidence already proves
the repeated-token failure mode.

Validation:

- WHOOP repeated-token unit test advances to `persist_workouts`.
- WHOOP sync-log records a degraded `developer_workouts` step.
- `sync.degradations.total` increments and the structured warn log records the
  degraded step.
- Production WHOOP activity ingestion reaches current activity data or records
  a clear degraded stop before persistence.

### Phase 2: Token and Link Providers

Migrate Oura, Decathlon, Wger, and Amazfit/Zepp. This phase removes the highest
risk class of repeated opaque cursors and next links.

Provider-specific tests:

- Oura: repeated `next_token` stops with `pagination_stalled` and returns data
  fetched before the repeated token.
- Decathlon: repeated `links.next` stops degraded and does not re-fetch the same
  URL.
- Wger: workout-session and weight-entry loops both stop degraded on repeated
  `next`.
- Amazfit/Zepp: repeated numeric `next` no longer throws a raw provider error;
  it returns fetched summaries with a degradation.

### Phase 3: Activity Offset and Page Providers

Migrate providers whose pagination affects `fitness.activity` freshness:
Fitbit, Peloton, MapMyFitness, Garmin Connect, Wahoo, Strava, Zwift, Komoot,
Concept2, Cycling Analytics, Xert, and BodySpec.

Prioritize providers that reconcile activity lists or fetch streams after
activity pages, because incomplete pagination can otherwise lead to stale
activity state or unsafe deletion assumptions.

Provider-specific tests:

- Empty page with a next marker records
  `pagination_empty_page_with_cursor`.
- Non-advancing offset records `pagination_stalled`.
- Max-page exhaustion records `pagination_max_pages_exceeded`.
- Degraded list fetch skips activity reconciliation.
- Already-fetched activities are still persisted.

### Phase 4: Non-Activity and Optional Endpoints

After activity ingestion is covered, migrate remaining metric/body/sleep list
loops that use pagination or next links. Keep optional endpoint failures
separate from pagination degradation; optional missing scopes should become
`optional_endpoint_unavailable`, while repeated cursors remain
`pagination_stalled`.

## Shared Helper Requirements for Other Providers

The helper should support both cursor and page-key pagination:

- `currentKey`: the key used to fetch the current page, such as token, URL,
  offset, or page number.
- `nextKey`: the key to use for the next page, or `null` when complete.
- `items`: the records returned by the current page.
- `isComplete`: provider-specific completion flag when the provider uses totals
  or page counts instead of a next cursor.

The helper should expose enough metadata for providers to keep their own
business rules:

- `pagesFetched`
- `items`
- `degradations`
- `stoppedByProviderRule`
- `completed`

The helper should not know how to parse provider records, persist activities,
refresh OAuth tokens, or reconcile activity lists.

## Cleanup After Migration

After each provider migrates:

- Delete provider-local pagination helpers if no call sites remain. The first
  expected removal is `src/providers/oura/pagination.ts` after Oura moves to the
  shared helper.
- Remove provider-local repeated-cursor sets and raw pagination throws, such as
  the Amazfit/Zepp `seenCursors` throw, once the shared degradation path covers
  the same invariant.
- Replace duplicate max-page constants with the shared helper option where a
  provider does not need a provider-specific limit.
- Delete tests that only assert local helper mechanics after the shared helper
  tests cover those mechanics.
- Keep provider tests that assert provider-specific stop rules, reconciliation
  behavior, and persistence behavior.
- Remove duplicate Sentry/logging calls from provider code when the shared
  degradation reporter emits the warning centrally.
- Update docs and runbooks to describe `status = "degraded"` and
  `degradation_kind` as the operational signal for recoverable provider API
  anomalies.
- Add a production dashboard or saved query for degraded sync-log rows only
  after at least two providers emit real degraded events or synthetic staging
  events prove the query shape.
- Review `fitness.sync_log` growth after rollout. If degraded context starts
  carrying too much data for `sync_log`, create a separate step-detail table in
  a follow-up migration rather than expanding the initial implementation.
- Remove temporary migration notes from the provider files once the final
  provider-local pagination path is gone.

Final cleanup after all provider pagination loops migrate:

- Search for provider-local list loops with `while (hasMore)`, `while (url)`,
  `while (!done)`, and `do ... while (nextToken)` and confirm each remaining
  loop is either date iteration, stream chunking, auth redirect handling, or
  intentionally not provider pagination.
- Search for `next_token`, `links.next`, `pagination.next`, `has_more`,
  `show_next`, `totalPages`, and `offset +=` in provider code and confirm each
  remaining use flows through the shared helper or is not pagination.
- Ensure all providers that call `finishProviderActivityListSync` skip
  reconciliation when list pagination ends degraded.
- Remove obsolete docs that describe provider-local pagination behavior as the
  canonical implementation.

## PR Structure

Do not migrate every provider in one PR. The safer sequence is:

1. Foundation plus WHOOP regression fix.
2. Oura plus one link-based provider, preferably Wger because it has two
   similar next-link loops.
3. Fitbit plus one page-based activity provider, preferably Peloton.
4. Garmin Connect, Wahoo, Strava, Zwift, and MapMyFitness.
5. Remaining lower-risk page providers: Komoot, Concept2, BodySpec, Cycling
   Analytics, Xert.
6. Final cleanup PR once repository search proves no provider-local pagination
   helper remains.

Each migration PR should include:

- one repeated-key or non-advancing-page regression test,
- one test proving already-fetched records are retained,
- one test proving unsafe reconciliation is skipped on degraded list fetches
  when the provider reconciles activity lists,
- focused provider tests,
- shared helper tests only when adding a new helper capability.

## Operational Verification

For each migrated provider in production:

- Query `fitness.sync_log` for recent `status in ('success', 'degraded',
  'error')` grouped by provider and step.
- Confirm degraded rows contain `degradation_kind` and safe fingerprint context,
  not raw cursor tokens or URLs with credentials.
- Confirm activity providers have current `max(started_at)` when the upstream
  provider has recent activity data.
- Confirm Sentry has warning-level degraded-sync issues grouped by provider,
  step, and degradation kind.
- Confirm no provider run is repeatedly recording the same degraded fingerprint
  without follow-up operator visibility.
