# Notification Completion Log Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the implementation and review checkpoints below.

**Goal:** Record completed native notification checks so DOFEK-MOBILE-21 can be verified on the installed runtime.

**Architecture:** Add one call to the existing mobile logger after the native promise resolves and the current attempt passes the existing lifetime/attempt guard. Existing telemetry supplies build, runtime, and account context. Preserve authorization, alerts, exception reporting, and native behavior.

**Tech Stack:** TypeScript, React hooks, existing mobile telemetry, Vitest.

**Spec:** The user explicitly approved “the completion log and focused test” on November 11, 2026. The [incident record](../../production-incident-baseline.md#2026-11-11--native-notification-compatibility-revalidation) records the missing device proof. This is the approved small design; no additional runtime framework or native interface is needed.

## Global Constraints

- Modify the existing hook and its colocated tests; no new dependency, wrapper, native API, fallback, retry, or timeout.
- Use `logger.info("collection-notifications", "Native collection notification check completed", { event: "collection_notifications_enable_completed", requestPermission, granted })` after the existing active/current-attempt guard.
- Log granted and denied resolved results; denied permission is a completed check, not enabled alerts. Never log completion on rejection, retired lifetime, or superseded attempt.
- Do not duplicate user/build/runtime metadata supplied by telemetry. Do not log credentials or notification content.
- Keep this branch; no merge, production publication, or Sentry resolution. Push every new commit automatically after required checks.

## Review Focus

Check result accuracy, promise settlement timing, stale-result/account attribution, unchanged failure reporting, and the distinction between local tests and actual device proof.

### Task 1: Log current native completion

**Files:** `packages/mobile/lib/useCollectionNotifications.ts`, `packages/mobile/lib/useCollectionNotifications.test.ts`.

**Interface:** Keep `useCollectionNotifications(enabled: boolean | undefined): void`; consume the existing `logger.info` export.

- [x] Add focused tests that a pending native promise produces no completion, resolved granted/denied checks record the literal event and booleans, and rejection/retired/superseded results do not claim completion. Extend existing lifecycle/error tests where possible.
- [x] Run `pnpm exec vitest run --project mobile packages/mobile/lib/useCollectionNotifications.test.ts` and record the expected missing-log failures before implementation.
- [x] Add the single guarded log call and existing logger import; run the same test command and confirm all cases pass.
- [x] Lead reviews the actual diff; obtain an independent review of implementation and evidence. Update the existing mobile reference and incident record with the event and remaining device gate.
- [x] Run required lint, relevant tests, and root/server/web/mobile typechecks. Commit and push on `sentry/ios-native-ota`, open a draft PR, and coordinate release validation without merging or publishing.

Implementation and local review are complete in [draft PR 3270](https://github.com/Asherlc/dofek/pull/3270). The full single-worker suite passed 24,373 tests with 19 skips across 1,468 passing files and two skips. The final focused rerun passed 18/18 after a test-only assertion enhancement; production source was unchanged, and a temporary argument/result-substitution mutation failed that assertion. Shared Expo alignment in [PR 3268](https://github.com/Asherlc/dofek/pull/3268), subsequent CI, coordinated release clearance, and actual device invocation remain pending. This plan does not establish incident closure.

The [Expo runtime contract](https://docs.expo.dev/eas-update/runtime-versions/) and [release runbook](../../mobile-ota-recovery.md) remain the authority for the subsequent coordinated release and physical-device validation.
