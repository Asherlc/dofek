# Sync checkpoint retries

## Goal

Provider sync jobs should survive transient infrastructure failures without starting the full sync over. A retry should keep the same job visible as running and resume from the last durable provider checkpoint.

## Design

- Provider sync jobs carry a stable `sinceIso` timestamp in BullMQ job data. Retries reuse that timestamp instead of recomputing the window from `sinceDays`.
- Provider sync jobs also carry the target refresh window as `targetRefreshWindow`, either `{ type: "full" }` or `{ type: "days", days: number }`. This preserves the requested window label while `sinceIso` preserves the exact retry boundary.
- Provider sync jobs may carry provider-owned checkpoint data in BullMQ job data. This keeps retry state in Redis with the job and avoids a second retry ledger.
- `SyncOptions` exposes a checkpoint store with `load`, `save`, and `clear`.
- Providers save a checkpoint only after a durable chunk has been written to the database.
- Providers clear the checkpoint only after the whole provider sync finishes.
- Infrastructure failures are rethrown from the job processor so BullMQ keeps the same job and retries it. User-facing status remains running while BullMQ reports `waiting`, `delayed`, or `active`.

## Garmin checkpoint shape

Garmin resumes at provider phases:

- `activities`
- `sleep`
- `daily_metrics`
- `stress`
- `heart_rate`
- `complete`

For day-based phases, the checkpoint stores the next date to sync. If a failure happens while syncing a date, the checkpoint still points at that date, so the retry reprocesses that day. Garmin writes are idempotent, so retrying the current day is safer than skipping data.

## Infra failure scope

Retryable infrastructure failures include local database and Redis availability failures, especially Postgres recovery mode, terminated connections, refused connections, and timeouts. Provider API failures remain normal sync errors unless they are surfaced as one of these local infrastructure failures.
