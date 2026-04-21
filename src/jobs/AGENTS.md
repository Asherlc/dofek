# Jobs Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Job Data Types**: Ensure `SyncJobData`, `ImportJobData`, etc., in `queues.ts` are strictly typed.
- **telemetry integration**: All workers must be initialized with telemetry to capture background exceptions.
- **Idle Spin-down**: In production, workers spin down after 5 minutes of inactivity (`IDLE_TIMEOUT_MS`).
- **Graceful Shutdown**: Always handle `SIGTERM` and `SIGINT` to allow in-progress jobs to complete or be moved to the delayed queue.

### Testing Strategy
- **Unit Tests**: `process-sync-job.test.ts` for logic verification with mocked database/providers.
- **Integration Tests**: `bullmq-stall.integration.test.ts` verifies queue behavior and Redis connectivity.
- **Queue Tests**: `queues.test.ts` ensures queue names and connection factories work as expected.

### Adding a New Job Type
1. Define a new data interface in `queues.ts`.
2. Create a new `process-xxx-job.ts` file with the implementation.
3. Add a worker instance in `worker.ts`.
4. Define a corresponding queue factory in `queues.ts`.
5. Add unit and integration tests for the new processor.
