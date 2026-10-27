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

- [ ] Add shared classifier regressions; run them RED, implement, run GREEN.
- [ ] Add web/mobile destination and event-count regressions; run RED, implement,
  run GREEN. Keep existing background transport behavior and diagnostic logs.
- [ ] Add provider counter and tRPC marker regressions; run RED, implement, run
  GREEN. Remove synthetic lifecycle exceptions, retaining unknown HTTP diagnostics.
- [ ] Review complete diff, run focused suites and affected type/lint checks,
  record incident follow-through, commit and push, then open the requested PR.

## Working notes

Approval: user selected the application policy, then requested metrics.
Review checkpoints: after classifier; after both client reporters; after server
diagnostics/serialization; final full-diff review. Execute inline.
