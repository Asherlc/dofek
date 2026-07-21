# Sanitize Slack Error Replies TDD Plan

**Goal:** Keep unexpected server exception details out of Slack while preserving actionable user guidance and full operator telemetry.

**Behavior:** Slack error replies explain what operation failed, whether anything was saved, and what the user can do next; raw exception text is reported only to Sentry and structured logs.

**Scope:** Fix refinement, AI-analysis, top-level message, and confirmation-save replies in `slack-handlers.ts`. Do not hide safe domain validation messages intentionally produced for users.

**Docs:** [`docs/nutrition-ai-input.md`](../../nutrition-ai-input.md), [`docs/sentry.md`](../../sentry.md)

---

## Current Evidence

- Four Slack handler branches interpolate `error.message` or `String(error)` directly into messages sent to users.
- These catches can receive database, Redis, Slack API, and AI-provider exceptions, not only curated domain errors.
- Several of the same branches only log and do not report the original error to Sentry.

Primary sources: the current [`slack-handlers.ts`](../../../packages/server/src/slack/slack-handlers.ts)
and its handler coverage in [`bot-unit.test.ts`](../../../packages/server/src/slack/bot-unit.test.ts),
plus Sentry's official [`captureException` guidance](https://docs.sentry.io/platforms/javascript/guides/node/usage/#capturing-errors).

## Test Strategy

- Unit: for refinement, analysis, outer handling, and confirmation-save failures, reject with sentinel exception text containing internal identifiers and assert the reply names the failed operation, states whether data was saved, gives a recovery action, omits the sentinel, and passes the original error to `Sentry.captureException()`.
- Integration: exercise refinement, analysis, outer handler, and confirmation-save failures through the registered Slack handlers.
- UI/mobile/web parity: not applicable; this is the Slack client surface.

## File Structure

- Modify: `packages/server/src/slack/slack-handlers.ts` - separate operator diagnostics from user-safe actionable replies.
- Modify: `packages/server/src/slack/bot-unit.test.ts` - cover each affected failure branch and telemetry.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add failures containing sentinel database/provider details for refinement, analysis, outer handling, and save confirmation.
- [ ] Assert current Slack replies leak the sentinel and missing branches do not report to Sentry.
- [ ] Run `rtk pnpm vitest run --project unit packages/server/src/slack/bot-unit.test.ts`.

### Task 2: Implement the Minimal Fix

- [ ] Report each original unexpected exception to Sentry with an allowlisted context containing only the operation name, event type, team ID, channel ID, and thread timestamp when needed. Prohibit raw event payloads, message text, credentials/tokens, and unrelated user or resource identifiers.
- [ ] Replace raw exception interpolation with operation-specific recovery text that states whether data was saved and suggests retry/support steps.
- [ ] Preserve intentionally safe domain validation feedback.
- [ ] Run the focused tests.

### Task 3: Final Verification

- [ ] Run the full Slack handler test file, server typecheck, and lint.
- [ ] Search Slack reply construction for any remaining interpolation of caught exception text.
- [ ] Confirm logs/Sentry retain the diagnostic detail that replies no longer expose.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete documentation or skill improvement.
