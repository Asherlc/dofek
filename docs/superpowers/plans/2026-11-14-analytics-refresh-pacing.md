# Analytics refresh pacing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, with one independent final review. Preserve the running PeerDB recovery release.

**Goal:** Give ingestion useful processing windows between analytics builds and qualify sustained net backlog drain with ongoing arrivals.

**Architecture:** Keep the existing publication lock and BullMQ queue. Use its stock global worker rate limiter to cap actual build starts at the existing configured interval. Periodic jobs perform the actual refresh rather than spending a rate-limit slot forwarding another job. Preserve immediate startup, event-request deduplication, one pending follow-up, and truthful completion waits. Apply the existing first-cycle health budget to the cycle's admission time once it starts.

**Tech Stack:** Existing TypeScript, BullMQ/Redis, Vitest, existing Compose fixtures and canonical release. No dependency update or new service.

**Spec and authorization:** The user approved pursuing refresh pacing and then said “i approve whatever, but always check git to make sure we're not retreading ground.” They opted out of further routine approach questions. Keep lock ownership, data predicates, query limits and pending-operation correctness intact. A measured improvement is required; a theoretical rate or synthetic test does not establish catch-up.

## History and evidence checked first

- [PR #2999](https://github.com/Asherlc/dofek/pull/2999), commit `449fd64a6`, already introduced the periodic schedule, concurrency one and deduplication. Releasing the active deduplication key deliberately lets arrivals during a build request one subsequent snapshot. Do not reimplement basic deduplication or attach new arrivals to an older completed snapshot.
- [PR #3305](https://github.com/Asherlc/dofek/pull/3305) already halves canonical query work/time; production still consumed 79,861 live records against 93,779 arrivals over the observed 41-minute window.
- Read-only production lock evidence at 02:46 UTC showed analytics owning the publication resource for 7m13s while both sinks waited on that owner's advisory lock. Existing timestamps show mostly consecutive builds and a larger committed advance during the longer free window. This confirms exclusion during builds; post-release sustained capacity still needs measurement.
- `git log --all -G 'rateLimit|limiter|minimum.*interval|cooldown'` found no existing limiter in this queue/worker. Health history traces to `d9a1e6857`: first-success health uses process startup, whereas later running cycles use cycle start.
- [BullMQ rate limits](https://docs.bullmq.io/guide/rate-limiting) apply across workers. Its manual TTL requires a configured maximum; do not add a manual cooldown that its backend ignores. [Job schedulers](https://docs.bullmq.io/guide/job-schedulers/) already supply periodic scheduling.

## Global Constraints

- Before proposing or changing behavior, check Git history, the current implementation and deployed revision. Record prior fixes and why this change is distinct.
- Existing branch only; no switching, rebasing, new local branch or force push. Automatically push every new commit. Main was integrated through merge `1c0a2891c`; its diff against main was empty before this plan.
- No new queue, custom scheduler, limiter counter, persistent state, environment input, dependency or secret. Reuse `intervalMilliseconds` and existing retention/concurrency semantics.
- No manual production changes to replicas, owners, offsets or configuration. No larger timeout, retry budget, skipped gate or failure suppression.
- PeerDB PR #3339 is merged as `3cdb5f70`; its main CI/recovery must finish before merging this pacing PR, avoiding another main head superseding that release.
- Local native Redis uses an owned workspace suffix; stop owned containers afterward and preserve all volumes. Never inspect or print actual environments.
- Original backlog heartbeat expired and was deleted. Do not recreate or extend it; foreground rollout verification remains required.

## Review Focus

- Periodic forwarding must not waste rate-limit slots or make ingestion updates wait indefinitely.
- Requests arriving during an active or rate-limited build must remain pending until a matching later build finishes.
- Multiple consumers and a replacement worker must obey the same durable queue rate limit and concurrency one.
- A legitimately delayed first admission must receive the existing active-cycle watchdog, while stalled startup, overdue cycles and first failures remain unhealthy.
- Production qualification must distinguish processing restoration, actual sink capacity and sustained catch-up; no ETA from a burst alone.

### Task 1: Qualify and implement stock queue pacing

**Files:** `src/analytics-refresh-queue.ts`, its colocated unit/integration tests, `src/analytics-worker.ts`, its colocated unit tests, and existing relevant README/incident documentation.

**Interfaces:** Preserve `runAnalyticsRefreshJobs` and `enqueueAnalyticsRefreshAndWait` signatures. Keep `intervalMilliseconds` as the configured refresh cadence. Preserve pending requests and abort/drain behavior.

- [ ] Read current source/tests and relevant guidance. Check history before each substantive correction; retain the distinction from #2999.
- [ ] Add a real Redis regression proving two actual builds cannot start within the configured interval, including competing consumers, a periodic request and an arrival during the first build. The later wait must remain unfinished until its later build completes. Run before implementation: expected RED on early second admission.
- [ ] Add first-cycle health regression with admission delayed until near startup budget: active first cycle remains starting/HTTP200 within its own unchanged budget, then becomes unhealthy after that budget; stalled startup and first-failure cases still pass. Run before implementation: expected RED on process-start attribution.
- [ ] Configure Worker limiter `{ max: 1, duration: intervalMilliseconds }`. Periodic jobs perform `processRefresh`; retain the existing dedup-key release for actual requests. Schedule the first periodic tick after one interval while retaining explicit immediate startup enqueue. No custom sleeps or counters.
- [ ] Use actual current-cycle start for first-cycle health once admitted, with existing interval/retry budget. Preserve the startup deadline before admission and immediate failure handling.
- [ ] Adapt existing native fixtures to short real interval inputs, preserving assertions for coalescing, actual completion, failure propagation and draining. Add durable restart/competing-consumer and rate-limited shutdown coverage with real Redis; no module mocks in integration tests.
- [ ] Run focused unit/native suites, root TypeScript, changed-file Biome, added-prose spelling and diff checks. Expected GREEN with unchanged safety assertions; record exact commands/results, stop owned Redis and preserve its volume.
- [ ] Update current docs with stock limiter behavior, freshness tradeoff and primary citations. Commit/push. Obtain the single final independent source/spec and quality review; fix material findings with RED/GREEN coverage.

### Task 2: Ship and measure actual capacity

**Interfaces:** Task1 supplies reviewed pacing with native correctness proof. Require full exact-head CI and completed PeerDB recovery before normal merge, then matching main qualification and serialized canonical release.

- [ ] Open an independent PR; preserve all full CI and actionable-feedback gates. No merge until PeerDB restoration has passed its own canonical CDC/service checks.
- [ ] Merge normally after exact-head CI; track matching main CI and canonical release without overlap or manual mutations.
- [ ] Verify actual revision/digest, healthy services, successful analytics cycles, preserved pending-operation semantics and fresh live/history commits.
- [ ] Measure start spacing, publication-lock hold/free windows and sink progress across whole cycles with arrivals. Require sustained net drain for catch-up acceptance; report remaining limits and only a conditional ETA supported by those measurements.
- [ ] Update incident baseline, dashboard and retrospective. Preserve original analytics memory tradeoff as an explicit separate acceptance item.
