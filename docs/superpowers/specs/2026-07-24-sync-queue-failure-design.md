# Sync Queue Failure Handling Design

## Problem

The `sync.syncStatus` and `sync.activeSyncs` procedures currently translate
BullMQ/Redis lookup failures into successful empty results. That makes a queue
outage indistinguishable from a successful lookup with no matching user-owned
job. Web and mobile consumers consequently stop polling, clear active sync
state, or start a duplicate automatic sync.

GitHub issue: [#1736](https://github.com/Asherlc/dofek/issues/1736)

## Goals

- Preserve `null` and `[]` for successful lookups with no matching user-owned
  job.
- Report queue dependency failures as actionable, retryable tRPC errors.
- Capture the underlying queue error in Sentry with procedure and job context.
- Preserve the last known sync state on web and mobile while polling retries.
- Display the server-provided `error.message`.
- Prevent automatic sync from treating an `activeSyncs` error as an idle queue.

## Server Design

Both procedures will keep their existing successful lookup and user-ownership
logic. Their queue-operation `catch` blocks will instead:

1. Capture the original error with Sentry.
2. Include the procedure name in the Sentry context.
3. Include the requested job ID for `syncStatus`.
4. Throw `TRPCError` with code `BAD_GATEWAY` and a procedure-specific message
   that tells the user the sync service is temporarily unavailable and to retry.

`BAD_GATEWAY` maps to HTTP 502 in tRPC, matching a server that cannot currently
read its upstream queue dependency. See the
[tRPC error-code mapping](https://github.com/trpc/trpc/blob/main/www/docs/further/rpc.md).

Successful queue reads remain unchanged:

- Missing jobs return `null`.
- Jobs owned by another user return `null`.
- Malformed job data returns `null`.
- No active user-owned jobs return `[]`.

## Client Design

### Web

The existing `pollSyncJob` helper will distinguish two outcomes:

- A successful `null` lookup remains terminal and reports lost job status.
- A rejected lookup is transient. It keeps each affected provider in its
  existing syncing state, updates the visible message to `error.message`, waits
  for the normal polling interval, and retries.

The Data Sources screen will render `activeSyncs.error.message`. Cached
`activeSyncs` data remains usable during refetch failures, so an already known
job continues to drive the existing UI. TanStack Query explicitly distinguishes
a refetch error with existing data from an initial loading error; see
[`isRefetchError`](https://github.com/TanStack/query/blob/main/packages/query-core/src/queryObserver.ts).

The dashboard auto-sync hook will not trigger a new sync while `activeSyncs` is
in an error state.

### Mobile

The provider-list and provider-detail polling loops will match the web
semantics:

- Keep the job and providers marked as syncing.
- Preserve the last percentage.
- Set the visible progress message to `error.message`.
- Wait for the normal interval and retry.
- Resume ordinary progress updates after recovery.

The Providers screen will render `activeSyncs.error.message`, including while
cached active-job data continues to render. Automatic sync will not treat an
`activeSyncs` error as an empty result. Its imperative `syncStatus` polling will
also retry transient failures instead of terminating the sync state.

## Testing

Implementation will use red-green TDD.

Server tests will first replace the current Redis-empty-state expectations and
prove that both procedures:

- reject with `BAD_GATEWAY`,
- expose the actionable message, and
- capture the original error with procedure/job context.

Existing tests for missing, cross-user, malformed, and empty successful results
will remain as regression coverage.

Client tests will prove:

- web polling retains syncing state, displays `error.message`, and recovers on
  the next successful poll;
- web auto-sync does not trigger after an `activeSyncs` error;
- mobile provider polling retains syncing state and progress, displays
  `error.message`, and recovers;
- mobile auto-sync does not trigger from an errored `activeSyncs` lookup; and
- both provider screens render the `activeSyncs` error message.

## Scope

The change will stay within the two sync router procedures and their existing
web/mobile consumers. It will not add global tRPC retry middleware, change
unrelated query defaults, or introduce a new cross-platform polling
abstraction.
