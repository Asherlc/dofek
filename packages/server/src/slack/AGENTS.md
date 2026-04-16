# Slack Bot Agent Notes

Read `README.md` in this directory before making any changes.

## Quick Rules
- Do not mask missing IDs or missing preconditions; fail fast with actionable errors.
- Keep confirmation flow reliable: `confirm_food.value` must contain real entry UUIDs.
- If you touch message text/blocks in web behavior, verify mobile/web user expectations still hold.
- Preserve idempotent confirm behavior: repeated confirm clicks on already-confirmed entries should remain safe.
- Slack intake architecture rule: keep all parsed/unconfirmed food entries in Redis only. Persist to Postgres only after explicit user confirmation. Postgres is the source of truth for confirmed/final values, not pending drafts.

## Where to Start Debugging
1. `slack-handlers.ts` for event/action flow.
2. `food-entry-repository.ts` for DB writes/reads.
3. `bot-unit.test.ts` for behavior contracts and edge cases.

## Operational Tips
- Always inspect logs before guessing root cause.
- If you see `These entries were already saved.`, verify whether action `value` had valid IDs and whether rows still exist.
- Keep errors user-visible and specific.
