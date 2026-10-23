# Parallel WHOOP BLE Uploads Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this scoped task. Keep test and final-review checkpoints explicit.

**Goal:** Let realtime heart-rate uploads progress while motion uploads are in flight.

**Architecture:** Run the existing motion and realtime buffer drains concurrently, with sequential batches inside each stream and one shared active worker per stream. Wait for both drains to settle before returning to the caller; preserve unexpected failures for telemetry. Use individual HTTP requests for the upload mutations so response completion is independent.

**Tech Stack:** TypeScript, React Native, Vitest; existing native buffers and tRPC endpoints.

**Spec:** The user explicitly requested parallel WHOOP BLE uploads, with one request per stream and existing foreground/confirmation safeguards. The [incident evidence](../../production-incident-baseline.md#2026-10-22--whoop-bluetooth-uploads-absent-from-a-climbing-activity) records the starvation reproduction. Existing behavior is defined by the [uploader](../../../packages/mobile/lib/background-whoop-ble-sync.ts).

## Global Constraints

- Keep the existing 500-sample limits, device grouping, erasure cutoff, foreground guards, and peek/confirm contract.
- Add no dependencies, environment variables, retries, or native bridge changes.
- This is the iOS-native ingestion path; server and web rendering contracts remain shared and unchanged.

## Review Focus

- A stalled upload must not block the other stream.
- Concurrent mutations must use separate HTTP requests, verified through the real tRPC client.
- Each stream must retain at most one in-flight batch upload.
- Overlapping foreground/background callers must share each active stream drain.
- Periodic ticks must upload new realtime samples while a motion drain is still busy.
- An unexpected failure must not release the sync guard while the other stream is running.
- Missing realtime clients must preserve motion-only use.
- Backgrounding and upload failures must retain unconfirmed samples.

## Task 1: Independent bounded upload streams

**Files:**
- Modify: `packages/mobile/lib/background-whoop-ble-sync.ts`
- Test: `packages/mobile/lib/background-whoop-ble-sync.test.ts`
- Modify: `packages/mobile/app/_layout.tsx`, `packages/mobile/app-tests/_layout.cleanup.test.tsx`
- Add: `packages/mobile/lib/trpc-links.ts`, `packages/mobile/lib/trpc-links.test.ts`
- Document: `docs/whoop-ble-protocol.md`, `docs/production-incident-baseline.md`

**Interfaces:** Keep the public initialization, background-sync, and native dependency interfaces unchanged. Extract private motion/realtime drain functions from the existing loops.

- [x] Replace the prepared scheduling regression with concurrent-upload tests that stall either stream and verify the other can upload/confirm multiple batches; verify one request per stream.
- [x] Add a regression where one native peek rejects while the other upload is pending; verify the caller waits for the surviving stream. Cover two simultaneous unexpected failures.
- [x] Cover overlapping background/foreground callers and share each stream's in-flight promise so they cannot independently confirm the same native samples.
- [x] Track each stream's in-flight promise separately and let periodic ticks start a free stream while reusing the busy one.
- [x] Run the focused tests against the sequential implementation and confirm the expected failures.
- [x] Launch the two private drain functions together and await all settled results before propagating unexpected errors, retaining both causes if both fail.
- [x] Run the full sync suite and existing background/confirmation/device/erasure regressions.
- [x] Reproduce HTTP batching coupling with the real client, then route upload mutations independently while preserving other transport behavior.
- [x] Update the protocol guide and incident record with actual validation and rollout limits.
- [x] Run unit/mobile tests, relevant TypeScript and lint checks, and independent review; address material findings.
- Commit and push the complete change on the existing branch after those checks pass.

## Working Notes

- User approval is for parallel streams; the earlier alternating-batch proposal is superseded by that explicit choice.
- Existing source ownership and UI behavior do not require platform-specific web changes.
- Review checkpoint: red tests before implementation; fresh diff review after validation.
- Independent review identified HTTP batching as an important remaining coupling; its regression failed with one fetch for two mutations before the transport fix, then passed with realtime settling while motion remained pending.
- Final validation: 82 focused tests passed; full unit/mobile suite passed 20,309 tests (19 skipped) across 1,316 passing files (2 skipped). Mobile TypeScript, `lint:sandbox`, canonical spellcheck, and `git diff --check` passed. No native or database behavior changed.
- Physical-device rollout and historical recovery remain unverified. The current scheduling defect is reproduced; the earlier workout's capture/retention gap remains unresolved.
