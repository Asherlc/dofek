# Native delivery and HealthKit CPU correction implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; no recursive delegation. Track RED/GREEN and review checkpoints in the working ledger.

**Goal:** Fix repeated HealthKit formatter CPU exhaustion and deliver live native WHOOP batches without relying only on OS-discretionary transfers.

**Architecture:** Create one invocation-local HealthKit formatter. Each existing durable WHOOP reservation uses stock ordinary URLSession delivery plus an OS-managed file-upload fallback, with the same replay identity and one completion owner. Reconfiguration/explicit flush can accelerate restored background-only reservations. Preserve SQLite, account generations, credential rejection and native background acknowledgment without React.

**Tech Stack:** Existing Swift/Foundation/URLSession/XCTest and Expo bridge runner; no new dependencies.

**Spec:** User selected both fixes from the investigation; [evidence](../../evidence/ble-collection-20261114/README.md) and [durability contract](../specs/2026-10-28-whoop-durable-upload-design.md). The recovered Kafka backlog is not a defect and gets no runtime change.

## Global constraints

- Existing branch/workspace only; no administrator prompts, raw sensor/credential inspection, production mutations, HTTP development servers or new background loops.
- One canonical outbox/reservation identity; no token persistence. Both network paths share the request and body. Concurrent replay is possible and existing deterministic server identities must remain valid.
- First completion owns handling; cancel its counterpart after durable handling. Ignore retired callbacks, preserve response bounds/origin checks, and keep per-stream progress independent.
- Keep the URLSession adapter excluded from standalone SwiftPM; validate it in the real iOS bridge host.

## Review focus

- A restored OS task can complete without React/token; successful acknowledgment removes only its exact generation.
- Live and fallback task IDs can collide across sessions; response data must remain isolated.
- Token/account rotation and delayed cancellation cannot cancel a replacement generation or accept stale callbacks.
- Invalid acknowledgment, HTTP rejection and network errors retain rows and follow existing explicit failure policy.
- Racing completions cause one acknowledgment and no premature counterpart cancellation before store handling.

### Task 1: HealthKit formatter

Files: HealthKitQuantitySeriesTransport.swift and its existing XCTest suite.
- [ ] Add a synthetic large-series regression with a generous host formatting budget; preserve existing exact fractional timestamp/source/identity tests.
- [ ] Observe failure on the old per-timestamp formatter implementation.
- [ ] Configure one formatter after the async read and reuse it for both timestamps throughout the invocation.
- [ ] Run the complete HealthKit Swift suite, review behavior/scope, commit and push.

### Task 2: Immediate native transport

Files: WhoopURLSessionTransport.swift, WhoopBleBackgroundUploader.swift, existing uploader tests/helpers, and iOS BridgeTests.
- [ ] Add failing tests for immediate delivery while fallback is pending, restored-task acceleration, one logical completion and cross-session response isolation.
- [ ] Serialize transport state on one queue; retain/adopt fallback tasks, add one ordinary task, and retire counterparts only after the uploader handles the completion.
- [ ] Explicit configuration/flush may refresh an active reservation; ordinary capture preserves coalescing and one active logical batch per stream.
- [ ] Test generation/token replacement, stale/duplicate callbacks, malformed/oversized acknowledgments, native background-only restoration and independent streams.
- [ ] Run standalone WHOOP tests and the real iOS bridge suite; review actual diff and commit/push.

### Task 3: Whole change validation and handoff

- [ ] Update module README and incident baseline with final behavior and Apple primary-source links.
- [ ] Run required lint, recursive typechecks, relevant unit/mobile and native checks. Keep failures explicit and fix their proven causes.
- [ ] Separate whole-change self-review; use automatic included PR review when available. No paid/repeated reviewer requests.
- [ ] Open/update PR and monitor required checks. Do not claim real-device CPU/background recovery from host or Simulator tests; record physical acceptance requirements.
