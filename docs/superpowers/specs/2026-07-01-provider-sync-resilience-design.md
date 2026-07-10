# Provider Sync Resilience Design

## Problem

Provider APIs can return responses that are syntactically successful but unsafe
to follow blindly: repeated pagination cursors, empty pages with a cursor,
schema drift, optional endpoint failures, or malformed individual records. The
current sync framework mostly represents outcomes as either success or `errors`,
which makes recoverable anomalies easy to hide and hard to observe. The July 1,
2026 WHOOP investigation found this exact gap: WHOOP activity rows were stale
because developer-workout pagination repeated the same `next_token`, and the
continuation planner kept inserting another `developer_workouts` step before
`persist_workouts`.

## Goals

- Add a shared, provider-neutral vocabulary for degraded sync progress.
- Add a guarded pagination helper that prevents infinite or non-progressing
  provider pagination.
- Emit structured logs, degradation metrics, and database sync-log rows for
  recoverable anomalies.
- Migrate WHOOP developer-workout pagination first, using production evidence as
  the regression target.
- Keep provider syncs useful under partial upstream API failure: persist already
  fetched data whenever it is safer than failing the whole provider run.

## Non-Goals

- Do not rewrite every provider in the first PR.
- Do not make recoverable provider anomalies hard-fail user syncs by default.
- Do not add new provider-specific workaround paths when a shared helper can
  express the behavior.
- Do not log raw provider cursor tokens; cursor values may be opaque upstream
  state and should be fingerprinted before logging.

## Current State

`SyncResult` has `recordsSynced`, `errors`, `duration`, and `continued`, but no
structured way to say "the sync completed with degraded provider behavior."
WHOOP has custom continuation state in
`src/providers/whoop/sync-orchestrator.ts`. Oura has a small pagination helper
in `src/providers/oura/pagination.ts` that follows `next_token` until it is
absent. These patterns are provider-local and do not enforce non-progress
guards.

Sentry supports warning-level message capture through `captureMessage`; the
JavaScript SDK accepts a severity level such as `"warning"` as the second
argument, and messages appear as Sentry issues. See the Sentry JavaScript API
docs:
https://docs.sentry.io/platforms/javascript/configuration/apis/#capturemessage

## Design

### 1. Provider Degradation Model

Add `src/providers/sync-degradation.ts` with provider-neutral degradation types:

```ts
export type SyncDegradationKind =
  | "pagination_stalled"
  | "pagination_empty_page_with_cursor"
  | "pagination_max_pages_exceeded"
  | "schema_mismatch"
  | "record_rejected"
  | "optional_endpoint_unavailable";

export interface SyncDegradation {
  kind: SyncDegradationKind;
  providerId: string;
  stepName: string;
  message: string;
  externalId?: string;
  context?: Record<string, string | number | boolean | null>;
}
```

Extend `SyncResult` with `degradations?: SyncDegradation[]`. Existing providers
do not need to return it immediately; absence means no structured degradation was
reported.

### 2. Sync Log Support

Extend sync logging to support `status = "degraded"` and optional
`degradation_kind`. Prefer a schema migration over overloading
`error_message`, because degraded steps should be queryable without parsing text.

The first implementation should keep the existing `sync_log` table and add:

- `degradation_kind text null`

`withSyncLog` should accept an optional degradation payload and write:

- `status = "success"` when no degradation exists
- `status = "degraded"` when the step produced usable data but observed a
  recoverable anomaly
- `status = "error"` for existing failing behavior

### 3. Metric and Logger Reporting

Add a small reporting helper in `src/providers/sync-degradation-reporting.ts`.
It should:

- log `logger.warn("[provider-sync] Degraded provider sync step", details)`
- increment `sync.degradations.total`
- set metric attributes for `provider`, `step_name`, and `degradation_kind`
- never include raw cursor tokens

The helper should be used by shared framework code, not copied into each
provider.

### 4. Safe Cursor Fingerprints

Add a helper in `src/lib/stable-fingerprint.ts` or
`src/providers/pagination/fingerprint.ts`:

```ts
export function fingerprintOpaqueValue(value: string | null | undefined): string | null;
```

Use SHA-256 and keep a short prefix, for example 12 hex characters. This gives
operators enough evidence to correlate repeated cursors without exposing raw
cursor payloads.

### 5. Shared Guarded Pagination

Add `src/providers/pagination.ts`:

```ts
export interface ProviderPage<TItem, TCursor extends string = string> {
  items: TItem[];
  nextCursor: TCursor | null;
}

export interface FetchProviderPagesOptions<TItem, TCursor extends string = string> {
  providerId: string;
  stepName: string;
  initialCursor?: TCursor;
  maxPages?: number;
  fetchPage(cursor: TCursor | undefined): Promise<ProviderPage<TItem, TCursor>>;
  shouldStopAfterPage?(page: ProviderPage<TItem, TCursor>, allItems: readonly TItem[]): boolean;
}

export interface FetchProviderPagesResult<TItem> {
  items: TItem[];
  degradations: SyncDegradation[];
  pagesFetched: number;
  finalCursor: string | null;
}
```

The helper should enforce:

- if `nextCursor == null`, stop normally
- if `nextCursor` equals the cursor used for the current page, stop and emit
  `pagination_stalled`
- if `nextCursor` has already appeared in the current pagination run, stop and
  emit `pagination_stalled`
- if a page is empty and still returns a cursor, stop and emit
  `pagination_empty_page_with_cursor`
- if `pagesFetched >= maxPages`, stop and emit `pagination_max_pages_exceeded`
- if `shouldStopAfterPage` returns true, stop normally

The result must include already fetched items and any degradations. The helper
must not throw for these pagination anomalies.

### 6. WHOOP Migration

Refactor WHOOP developer-workout pagination so the active continuation step does
not directly insert duplicate `developer_workouts` steps. The first PR can keep
WHOOP's existing checkpoint layout, but the decision should be based on the
shared pagination guard:

- current page fetch returns `presentIds`, `nextToken`, and `reachedWindowStart`
- repeated or previously seen token creates a `pagination_stalled` degradation
- the degradation is logged, counted as a metric, added to the result, and written to
  sync-log for `developer_workouts`
- pagination stops and the checkpoint advances to `persist_workouts`
- `persist_workouts` and `weightlifting` still run

WHOOP-specific tests should prove:

- a repeated `nextToken` does not insert another `developer_workouts` step
- a repeated `nextToken` records a metric through the degradation helper
- the next continuation advances to `persist_workouts`
- already fetched present IDs are retained

### 7. Cross-Provider Migration Path

After WHOOP:

1. Replace Oura's `fetchAllPages` with the shared helper.
2. Migrate other providers with explicit `next_token`, cursor, offset, or page
   loops as they are touched.
3. Keep provider-specific stop rules near provider code, but keep cursor and
   page-safety invariants in the shared helper.

## Error Handling Policy

Provider sync failures should map to one of these categories:

| Category | Behavior |
| --- | --- |
| Auth failure | Stop provider sync and surface reconnect state. |
| Rate limit | Save checkpoint and schedule delayed retry. |
| Service unavailable | Retry or fail as retryable infrastructure/upstream failure. |
| Pagination stalled | Record degraded warning, stop pagination, continue with fetched data. |
| Empty page with cursor | Record degraded warning, stop pagination, continue with fetched data. |
| Record rejected | Record per-record degradation and continue. |
| Internal invariant violation | Fail loudly with exception. |

## Testing Strategy

- Unit-test the shared pagination helper with repeated cursor, historical
  repeated cursor, empty page with cursor, max pages, normal cursor exhaustion,
  and provider stop condition.
- Unit-test degradation reporting with mocked metric counter and `logger.warn`.
- Unit-test `withSyncLog` degraded status after the schema change.
- Add WHOOP orchestrator regression tests for repeated developer-workout token
  and degradation metric reporting.
- Run focused WHOOP tests and affected shared provider tests.

## Rollout

1. Ship shared degradation types, logging/reporting helper, and guarded
   pagination helper.
2. Migrate WHOOP developer workouts and validate in production with a fresh sync.
3. Confirm `fitness.sync_log` shows `developer_workouts` as degraded or success,
   followed by `workouts` and `strength`.
4. Migrate Oura pagination in a separate follow-up.

## Decisions

- Degraded sync state remains operational-only for the first implementation.
  User-facing provider status can be added later once there are multiple real
  degradation examples and clear copy for users.
- Degradation data lives on `fitness.sync_log` for the first implementation.
  A separate `fitness.sync_step_log` table is deferred until there is evidence
  that `sync_log` cannot carry the operational queries we need.
