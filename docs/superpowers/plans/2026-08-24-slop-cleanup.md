# Slop Cleanup Implementation Plan

**Goal:** Remove confirmed dead, developer-only, duplicated, and misleading product surfaces while retaining active health-data behavior.

**Architecture:** Delete unreferenced AI and debug UI modules rather than hiding them. Keep explicit server-authored user errors visible, while rewriting client-owned technical copy. Centralize activity-detail classification in `@dofek/training`.

**Spec:** User-approved 2026-08-24 audit cleanup design in the conversation.

## Completed work

- [x] Confirmed the AI nutrition module had no production consumers, then removed it and its dedicated tests.
- [x] Removed the mobile BLE probe, IMU, heart-rate visualization routes, their tests, their native module, and the Settings developer-tools section.
- [x] Removed the unused web MCP token-management panel and its Settings section.
- [x] Removed the unused TypeScript-expect-error fixer and the empty provider-auth compatibility branch.
- [x] Renamed the misleading shared CLI sync queue from “legacy” and removed its warning.
- [x] Centralized activity-detail classification and replaced the duplicate web/mobile predicates.
- [x] Replaced account-deletion recovery protocol details with outcome-focused user copy on web and mobile.
- [x] Made in-process test transport helpers fail on a fetch error instead of fabricating an application `500` response.

## Verification

- [x] Focused affected tests, including account erasure, settings, activity detail, auth, and webhook suites.
- [x] `pnpm typecheck`
- [x] `pnpm lint` with the generated workspace environment and healthy ClickHouse dependency.
- [x] `pnpm test:changed`
- [x] `EXPO_PUBLIC_SENTRY_DSN='https://public@example.ingest.sentry.io/1' pnpm knip --reporter compact`

## Completion

- [ ] Review the final diff, commit, and push.
