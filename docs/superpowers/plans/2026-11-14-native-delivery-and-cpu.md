# Native delivery and HealthKit CPU correction implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; no recursive delegation. Track RED/GREEN and review checkpoints in the working ledger.

**Goal:** Fix repeated HealthKit formatter CPU exhaustion and deliver live native WHOOP batches without relying only on OS-discretionary transfers.

**Architecture:** Create one invocation-local HealthKit formatter. Each existing durable WHOOP reservation uses stock ordinary URLSession delivery plus an OS-managed file-upload fallback, with the same replay identity and one completion owner. Reconfiguration/explicit flush can accelerate restored background-only reservations. Preserve SQLite, account generations, credential rejection and native background acknowledgment without React.

**Tech Stack:** Existing Swift/Foundation/URLSession/XCTest and Expo bridge runner; no new dependencies.

**Spec:** User selected both fixes from the investigation; [evidence](../../evidence/ble-collection-20261114/README.md) and [durability contract](../specs/2026-10-28-whoop-durable-upload-design.md). The recovered Kafka backlog is not a defect and gets no runtime change.

## Global constraints

- Existing branch/workspace only; no administrator prompts, raw sensor/credential inspection, production mutations, HTTP development servers or new background loops.
- One canonical outbox/reservation identity; no token persistence. Both network paths share the request and body. Concurrent replay is possible and existing deterministic server identities must remain valid.
- First terminal response owns handling; a network error on one path is reported immediately while its counterpart remains available. Cancel counterparts after durable handling. Ignore retired callbacks, preserve response bounds/origin checks, and keep per-stream progress independent.
- Keep the URLSession adapter excluded from standalone SwiftPM; validate it in the real iOS bridge host.

## Review focus

- A restored OS task can complete without React/token; successful acknowledgment removes only its exact generation.
- Live and fallback task IDs can collide across sessions; response data must remain isolated.
- Token/account rotation and delayed cancellation cannot cancel a replacement generation or accept stale callbacks.
- Invalid acknowledgment, HTTP rejection and network errors retain rows and follow existing explicit failure policy.
- Racing completions cause one acknowledgment and no premature counterpart cancellation before store handling.

### Task 1: HealthKit formatter

Files: HealthKitQuantitySeriesTransport.swift and its existing XCTest suite.
- [x] Add a synthetic large-series regression with a generous host formatting budget; preserve existing exact fractional timestamp/source/identity tests.
- [x] Observe failure on the old per-timestamp formatter implementation.
- [x] Configure one formatter after the async read and reuse it for both timestamps throughout the invocation.
- [x] Run the complete HealthKit Swift suite, review behavior/scope, commit and push (`b18c879c1`, 122 tests).

### Task 2: Immediate native transport

Files: WhoopURLSessionTransport.swift, WhoopBleBackgroundUploader.swift, existing uploader tests/helpers, and iOS BridgeTests.
- [x] Add failing tests for immediate delivery while fallback is pending, restored-task acceleration, one logical completion and cross-session response isolation.
- [x] Serialize transport state on one queue; retain/adopt fallback tasks, add one ordinary task, and retire counterparts only after the uploader handles the completion.
- [x] Explicit configuration/flush may refresh an active reservation; ordinary capture preserves coalescing and one active logical batch per stream. Network attempt errors preserve the other path and the existing backoff.
- [x] Test generation/token replacement, stale/duplicate callbacks, malformed/oversized acknowledgments, native background-only restoration and independent streams. Delayed cancellation retires an adopted old task while protecting a replacement.
- [x] Run standalone WHOOP tests and the real iOS bridge suite; review actual diff and commit/push. Included review additionally reproduced queued old credential results; each in-memory submission now fences its callbacks, including unchanged-credential refreshes.

### Task 3: Whole change validation and handoff

- [x] Update module README and incident baseline with final behavior and Apple primary-source links.
- [x] Run required lint, recursive typechecks, relevant unit/mobile and native checks. Keep failures explicit and fix their proven causes. Additional local real-engine replay validation could not start because Docker VM asynchronous I/O capacity was exhausted; preserve the limitation and use required CI integration evidence.
- [x] Separate whole-change self-review; use automatic included PR review when available. Included CodeRabbit review confirmed the callback race and its concrete regression. No paid/repeated reviewer requests.
- [ ] Open/update PR and monitor required checks. Do not claim real-device CPU/background recovery from host or Simulator tests; record physical acceptance requirements.
