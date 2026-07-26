# Background Jobs

This directory contains background job processing logic using BullMQ and Redis.

## Job Types

- **Sync**: Periodic data synchronization with provider APIs (e.g., Strava, Fitbit).
- **Import**: Processing uploaded files (Apple Health XML, Strong CSV, Cronometer CSV).
- **Export**: Generating user data ZIP exports.
- **Scheduled Sync**: High-level orchestrator for triggering periodic syncs based on tiers.
- **Post-Sync**: Downstream tasks (e.g., recomputing metrics, cache invalidation) triggered after a successful sync.
- **Activity Delete Analytics**: Rebuilds ClickHouse activity read models after user-initiated deletes.

## Architecture

- **BullMQ**: Job queue management with Redis.
- **Per-Provider Workers**: Each sync provider has its own dedicated BullMQ worker to independently manage concurrency and rate limits.
- **Queues**: Defined in `queues.ts` with typed job data interfaces.
- **Workers**: Implemented in `worker.ts` with support for graceful shutdown and idle spin-down.
- **Processor Functions**: Each job type has a dedicated processor (e.g., `process-sync-job.ts`).

## Configuration

- **Provider Tiers**: Sync frequency and priority are defined in `provider-queue-config.ts`.
- **Concurrency**: Per-queue concurrency limits for rate-limiting API calls.
- **Retry Logic**: Sync and post-sync jobs use a fixed five-minute backoff;
  provider-deletion and activity-analytics jobs use a fixed 30-second backoff.
  Other queues declare retry options at their enqueue sites. BullMQ documents
  fixed backoff and attempt handling in
  [retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs).
