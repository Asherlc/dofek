# Background Jobs

This directory contains background job processing logic using BullMQ and Redis.

## Job Types

- **Sync**: Periodic data synchronization with provider APIs (e.g., Strava, Fitbit).
- **Import**: Processing uploaded files (Apple Health XML, Strong CSV, Cronometer CSV).
- **Export**: Generating user data ZIP exports.
- **Scheduled Sync**: High-level orchestrator for triggering periodic syncs based on tiers.
- **Post-Sync**: Downstream tasks (e.g., recomputing metrics, cache invalidation) triggered after a successful sync.
- **Training Export**: Incremental data export for machine learning models.

## Architecture

- **BullMQ**: Job queue management with Redis.
- **Per-Provider Workers**: Each sync provider has its own dedicated BullMQ worker to independently manage concurrency and rate limits.
- **Queues**: Defined in `queues.ts` with typed job data interfaces.
- **Workers**: Implemented in `worker.ts` with support for graceful shutdown and idle spin-down.
- **Processor Functions**: Each job type has a dedicated processor (e.g., `process-sync-job.ts`).

## Configuration

- **Provider Tiers**: Sync frequency and priority are defined in `provider-queue-config.ts`.
- **Concurrency**: Per-queue concurrency limits for rate-limiting API calls.
- **Retry Logic**: BullMQ handles retries with exponential backoff.
