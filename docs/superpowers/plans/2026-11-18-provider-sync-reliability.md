# Provider sync reliability implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution and verify each changed behavior with a failing regression test first.

**Goal** Apply scheduling, upstream deferral, and failure reporting consistently across provider infrastructure.

**Architecture** Reuse provider queue configuration, BullMQ schedulers, the existing provider HTTP wrapper and cooldown store, and shared sync outcomes and telemetry.

**Spec** [Approved design](../specs/2026-11-18-provider-sync-reliability-design.md).

## Global constraints

Use existing runtime dependencies and persisted provider records. Preserve manual sync behavior, queue identities and origin, ownership checks, and cursor semantics. Support older queued jobs and Redis records. Validate changed worker, server, web, and iOS behavior without watch mode.

## Tasks

- [x] **Scheduling and freshness.** In `scheduled-sync.test.ts`, assert stable regular and daily scheduler keys, default and overridden intervals, and repeat registration. In `process-scheduled-sync-job.test.ts`, assert that regular and legacy jobs select realtime and frequent providers and that the daily schedule selects daily providers. Include an on-demand provider. Update the scheduler and dispatcher to share cadence from `provider-queue-config.ts`. Use the same interval in the server provider list and MCP health. Test daily freshness and eligibility in the existing server suites.
- [x] **Shared retry guidance.** In `rate-limit.test.ts`, test delay and date forms and malformed headers. In `provider-rate-limit-cooldown.test.ts` and `sync-provider-failure.test.ts`, verify that an explicit 503 delay uses the existing queue deferral and retains an availability reason. Keep existing 429 scoping and delay behavior. Verify older cooldown records and overlapping cooldowns.
- [x] **Logbook access.** On theCrag client, token-auth, and provider status test paths, cover ambiguous denial versus explicit credential rejection. Use a shared access-denied error and a trusted provider action link through existing status contracts. Verify web and iOS render actionable access guidance and MCP reports it. Keep cursors unchanged on denial.
- [x] **Telemetry.** In the scheduled sync log tests, assert stable provider and failure grouping. In sync execution and failure tests, assert the existing counter records a bounded failure category for returned and thrown outcomes. Preserve existing escalation and credential notification rules.
- [x] **Validation.** Review each diff against its requirements. Run full lint, recursive typecheck, targeted unit/mobile suites, and real-engine tests for changed persistence behavior. Review the whole branch before committing and pushing to the existing branch.

## Review follow-up

The independent review identified a Redis write race, a deployment queue overlap, delayed request collisions within an account, mixed cooldown responses, and generic manual deferral messages. The revised implementation uses the shared Redis compare-and-set, a separate daily queue, request-specific retry identities, the longest applicable cooldown, and an outage-specific deferral message. The Redis and BullMQ integration suites cover concurrent writes and queue isolation.
