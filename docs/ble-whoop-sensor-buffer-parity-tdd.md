# TDD — BLE / WHOOP sensor-buffer parity hardening

**Status:** Implemented in this PR
**Target:** follow-up to #1401
**Scope:** `packages/mobile/modules/ble-heart-rate`, `packages/mobile/modules/whoop-ble`,
`packages/mobile/lib/*`, `packages/server/src/repositories/*`
**Not in scope:** the App-Review BLE feature itself (shipping in #1401). The `timestamp`
boundary-validation fix (cubic #10) already landed on #1401.

---

## 1. Motivation

Cubic's three remaining blockers on #1401 all describe patterns that are **identical to the
already-shipping WHOOP module**, which is why they were originally deferred:

| # | Issue | BLE file | Mirrored in WHOOP |
|---|-------|----------|-------------------|
| 13 | Overflow eviction can violate the peek→confirm contract, deleting un-uploaded samples | `BleHeartRateSampleBuffer.swift` | `WhoopBleSampleBuffer.swift` (imu + realtime) |
| 17 | Buffered samples carry no device id; upload attributes them to whatever monitor is connected now | `BleHeartRateSampleBuffer` / module / RN service | `WhoopBleSampleBuffer` / `background-whoop-ble-sync.ts` |
| 14 | Provider row is owned by the first user to sync (`ON CONFLICT (id) DO NOTHING`) | `ble-heart-rate-sync-repository.ts` | `whoop-ble-sync-repository.ts` |

Fixing only BLE would diverge two sibling modules. The implementation in this PR fixes the
**shared** patterns in both so they stay consistent (per the "consistency over duplicate tools"
guideline).

Each fix was **test-first**: land the failing test, then the implementation.

---

## 2. Fix #13 — overflow-safe peek→confirm (both native buffers)

### Problem
`peekSamples(maxCount)` returns a prefix **without** removing it; JS uploads, then calls
`confirmDrain(count)` which does `removeFirst(min(count, samples.count))`. Concurrently, the
BLE/stream thread's `append(...)` evicts from the **front** when the buffer exceeds capacity
(`removeFirst(overflow)`). If eviction happens between peek and confirm, the front shifts, and
`confirmDrain(count)` deletes `count` samples that now include newer, **never-uploaded** ones.

Trigger: buffer at capacity (86 400 realtime / 500 000 imu ≈ 24 h / 83 min continuous) with an
in-flight drain. Rare, but real data loss.

### Design — head-sequence cursor
Add a monotonically increasing counter of samples removed from the head (for **any** reason:
overflow eviction, confirmed drain, legacy drain). Confirm removes only the still-present slice
of the peeked batch.

Per stream, under the existing `NSLock`:
- `private var headSequence: UInt64 = 0` — absolute index of `samples[0]`.
- `private var lastPeekBaseSequence: UInt64 = 0` — `headSequence` captured at the last `peek`.
- `peekSamples`: record `lastPeekBaseSequence = headSequence` before returning the prefix.
- overflow eviction in `append`: `headSequence += overflow`.
- `confirmDrain(count)`:
  ```
  let evictedSincePeek = headSequence - lastPeekBaseSequence   // ≥ 0
  let removeCount = max(0, min(Int(count) - Int(evictedSincePeek), samples.count))
  samples.removeFirst(removeCount)
  headSequence += UInt64(removeCount)
  ```
  Legacy `drainX` (peek+immediate remove) also bumps `headSequence`.

Single-consumer contract (JS drains one page at a time, sequentially) makes one
`lastPeekBaseSequence` sufficient. Document this precondition in the buffer header comment.

**Invariant:** `confirmDrain` can never remove a sample with sequence ≥ the newest peeked
sequence, so un-peeked (newer) samples are never dropped by a confirm.

### Tests added first (XCTest, both buffers)
1. `peek N → simulate overflow of k → confirmDrain(N)` removes only `N − k`, and the buffer's
   surviving head equals the first sample appended **after** the peeked batch.
2. `peek N → overflow of k ≥ N → confirmDrain(N)` removes 0; newest samples intact.
3. No-overflow `peek N → confirmDrain(N)` still removes exactly N (regression).
4. `confirmDrain(count > buffer size)` clamps and never traps.

Files: `Tests/BleHeartRateSampleBufferTests.swift`, `Tests/WhoopBleSampleBufferTests.swift`.

---

## 3. Fix #17 — device-scoped buffered samples (both modules)

### Problem
Samples are appended with only measurement + timestamp. `deviceId` is supplied at **upload**
time (`pushSamples({ deviceId, samples })`). If the strap disconnects and a *different* device
connects before the drain, buffered samples from device A upload under device B's id (or are
skipped when nothing is connected).

### Design — tag at capture, group at upload
**Native (both):**
- Add `deviceId: String` to the sample struct (`BleHeartRateSample`, `WhoopImuSample`,
  `WhoopRealtimeDataSample`).
- The connection manager already knows the connected peripheral
  (`connectedPeripheral?.identifier.uuidString`); tag each sample at capture time.
- `serialize(...)` emits `"deviceId"` in each bridge dict.

**RN service (both):** group the peeked page by `deviceId` and issue one `pushSamples` call per
device id, draining the same page count once all groups succeed (keep the existing
peek→upload→confirm retry semantics; a failed group leaves the whole page buffered).
- BLE: `heart-rate-recording-service.ts`
- WHOOP: `background-whoop-ble-sync.ts`

**Server:** no schema change — `pushSamples` still takes a top-level `deviceId`; the RN layer
calls it per group. `externalId` already includes `deviceId`, so per-device rows stay distinct.

### Tests added first
- Native (XCTest): append while "connected" to A, then to B; serialized dicts carry the correct
  per-sample `deviceId`.
- RN (Vitest): a peeked page with two device ids issues two `pushSamples` calls with the right
  subsets; a rejected second group leaves the page unconfirmed (no data loss). Files:
  `heart-rate-recording-service.test.ts`, `background-whoop-ble-sync.test.ts`.

---

## 4. Fix #14 — provider ownership (both repositories)

### Investigation (already done)
`fitness.provider` is a **global catalog**: `id` is the PK, `user_id` is `NOT NULL` but is
**never read to determine a user's provider connection**. Per-user connection status is derived
in `sync.ts` from `metric_stream` activity (`pushLastReceived`, keyed by `userId`) plus tokens —
not from `provider.user_id`. So "row owned by first user" is cosmetic and causes **no** per-user
data leak; each user's samples are correctly attributed via `metric_stream.userId`.

### Design — make catalog semantics explicit; no migration
Do **not** introduce per-user provider rows (that PK is shared across `metric_stream`,
dedup, and priority — a per-user id would ripple everywhere). Instead:
1. Extract one shared `ensurePushProvider(db, providerId, userId)` helper (removes the duplicated
   raw `INSERT ... ON CONFLICT (id) DO NOTHING` in the WHOOP and BLE repos → single canonical
   path, satisfying "one canonical path").
2. Add regression coverage proving cross-user correctness: user A syncs (creates the catalog
   row), user B syncs; assert the catalog helper does not rewrite ownership and the existing
   sync-router tests continue to attribute rows through `metric_stream.userId`.
3. Document in the repository/README that push-provider rows are a global catalog and per-user
   attribution lives on `metric_stream`.

> Open question for reviewer: if we'd rather model this "properly" (split `provider` catalog
> from a `user_provider` connection table), that's a cross-cutting migration touching every
> provider and belongs in its own dedicated PR — flag it as modeling debt rather than fold it in.

### Tests added first
Unit coverage for the shared catalog helper plus existing sync-router coverage for per-user
`metric_stream` attribution.

---

## 5. Rollout / risk

- Touches the **production WHOOP IMU pipeline** — highest risk is the buffer cursor math and the
  per-sample struct change. Native XCTest + `pnpm test:mobile` gate both.
- No DB migration. No bridge API removal (only additive `deviceId` field + internal cursor).
- Pre-push: `pnpm lint`, `pnpm test:unit`, `pnpm test:mobile`, all-package `tsc --noEmit`,
  SwiftLint `--strict`, Swift tests. Stryker will re-check the TS service branch logic; Swift
  buffer cursor math is covered by XCTest.

## 6. Commit plan (test-first, small commits)
1. `test(whoop,ble): failing buffer overflow/confirm race tests` → `fix: head-sequence cursor`.
2. `test: failing device-scoping tests (native + RN)` → `feat: tag samples with deviceId`.
3. `test: cross-user provider attribution` → `refactor: shared ensurePushProvider helper + docs`.
