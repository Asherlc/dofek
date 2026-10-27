# Retry Required Post-Sync Maintenance

## Context

User post-sync jobs currently catch personalized-parameter refit and user-cache invalidation
failures, report them to Sentry, and then return successfully. BullMQ therefore marks the job
complete while personalized or cached state may remain stale. The post-sync enqueue paths also
omit retry options, so a processor rejection alone would not trigger another attempt.

BullMQ retries processor failures only when the processor throws and the job's `attempts` option
allows another attempt. Fixed delays are configured through the job's `backoff` option.
[BullMQ retry documentation](https://docs.bullmq.io/guide/retrying-failing-jobs)

## Design

Treat body-measurement refresh, personalized-parameter refitting, and user-cache invalidation as
required ordered maintenance:

1. Run body-measurement refresh.
2. Refit personalized parameters.
3. Invalidate the user's query-cache prefix.
4. Report 100% completion only after every step succeeds.

When any required step rejects, report step-specific failure progress, capture the original error
in Sentry with the existing `postSyncStep` tag, and rethrow the same error. Fail fast so cache
invalidation never runs after a failed refit.

Apply the existing `SYNC_JOB_RETRY_OPTIONS` policy to both global-maintenance and user-refit
post-sync enqueue paths while preserving their delay, deduplication, and completion-removal
behavior. This gives BullMQ the configured attempts and fixed backoff needed to retry transient
processor failures.

## Idempotency

Retries replay the full ordered processor:

- Body-measurement refresh is already retried on rejection by the current processor contract.
- Personalized parameters are saved through an `INSERT ... ON CONFLICT DO UPDATE`, so a repeated
  successful refit replaces the same canonical settings row.
- Cache invalidation deletes matching keys and is safe when matching keys were already removed.

No checkpoint or partial-success state is required.

## Error and Progress Behavior

- Preserve the original thrown error so BullMQ and its failure records retain the actionable
  cause.
- Preserve the existing Sentry step tags for body refresh, refit, and cache invalidation.
- Add failure progress messages that name the failed maintenance step and state that retry is
  required.
- Continue treating progress-reporting failures as non-fatal because progress reporting is
  observability, not maintenance state.
- Remove the obsolete “completed with errors” terminal state.

## Tests

Use test-driven development in `process-post-sync-job.test.ts`:

- Replace the test that expects a refit failure to complete normally with one that expects the
  original error to be rejected.
- Replace the cache-invalidation partial-completion test with one that expects the original error
  to be rejected.
- Assert step-specific Sentry tags and failure progress.
- Assert cache invalidation does not run after refit failure.
- Keep existing success, ordering, body-refresh failure, and non-fatal progress-update coverage.

Update the existing queue-enqueue expectations to include the established retry options. Verify
the focused processor and queue tests, then run the repository's changed-test and static-check
tiers appropriate to the touched TypeScript files.

## Scope

This change does not alter individual personalization fitter behavior inside `refitAllParams`,
introduce new retry policies, add checkpoints, or change post-sync concurrency or deduplication.
