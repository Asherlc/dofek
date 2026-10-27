# Handled Failure Reporting Implementation Plan

**Goal:** Count expected operational failures without generating error issues.

**Architecture:** Share a narrow classifier; retain existing telemetry pipelines.
Provider lifecycle diagnostics become counters and logs. Confirmed credential
failures carry an explicit tRPC marker to both clients.

**Tech Stack:** TypeScript, Vitest, existing OpenTelemetry and PostHog SDKs.

**Spec:** [Approved policy](../specs/2026-10-27-handled-failure-reporting-design.md).

## Constraints and review focus

- Unknown authorization, parse/schema, and storage failures remain reportable.
- Known failure messages nested in another failure must not hide a parse error.
- Cyclic causes must terminate; missing evidence remains unexpected.
- Metrics contain only bounded category/operation labels.
- User-facing failures still reject; no retry or timeout changes.

## Tasks

- [x] Add shared classifier regressions; run them RED, implement, run GREEN.
- [x] Add web/mobile destination and event-count regressions; run RED, implement,
  run GREEN. Keep existing background transport behavior and diagnostic logs.
- [x] Add provider counter and tRPC marker regressions; run RED, implement, run
  GREEN. Remove synthetic lifecycle exceptions, retaining unknown HTTP diagnostics.
- [ ] Review complete diff, run focused suites and affected type/lint checks,
  record incident follow-through, commit and push, then open the requested PR.

## Working notes

Approval: user selected the application policy, then requested metrics.
Review checkpoints: after classifier; after both client reporters; after server
diagnostics/serialization; final full-diff review. Execute inline.

Classifier checkpoint: 6 behavioral failures before implementation; 15/15 passed
afterward. Client/server checkpoint: expected count/marker assertions failed
before implementation; nine final focused suites passed 174 assertions before
the final review.

Final review: two important reporting-boundary findings. Wrapped parse/schema
regressions and real Kaya/Zepp error producers reproduced seven failures before
the correction; the four affected suites pass 75 assertions afterward.

Final review decision: vendor credential error classes remain reportable because
they include upstream and malformed-response failures. The credential marker is
limited to the server's own confirmed password-check rejection; the cost is
retaining vendor auth reports until affirmative rejection evidence exists.

Full-suite checkpoint: initial run passed 21,994 assertions but one router suite
failed setup because its OpenTelemetry mock replaced the complete API without
`metrics`. Preserving the real exports and overriding only tracing restores all
22 tests in that suite. No production-only testing branch was added.
