# Slack Bot (Nutrition Logging)

This directory contains the Slack bot runtime for logging food entries into Dofek.

## What It Does
- Listens to Slack messages (DMs and app mentions).
- Uses AI parsing to convert free-text meal descriptions into nutrition items.
- Saves parsed items as **unconfirmed** rows in `fitness.food_entry`.
- Shows a confirmation message with `Confirm` / `Cancel` buttons.
- On confirm, marks rows `confirmed = true`, updates message, and invalidates cached food/nutrition queries.
- Supports thread-based refinement: users can reply in thread to modify parsed items before confirming.

## Core Files
- `bot.ts`: Bot creation/startup in HTTP or Socket mode.
- `slack-handlers.ts`: Event/action handlers and Slack interaction flow.
- `food-entry-repository.ts`: Database operations for Slack workflow.
- `formatting.ts`: Slack Block Kit message composition.
- `slack-diagnostics.ts`: Config verification helpers.

## End-to-End Flow
1. User sends a message.
2. `handleParsedMessage()` resolves the app user via Slack profile email + `auth_account` mapping.
3. AI parser returns one or more items.
4. `saveUnconfirmed()` inserts `nutrition_data` + `food_entry` (`confirmed = false`) and returns entry IDs.
5. Bot posts/updates a confirmation block where `confirm_food.value` is comma-separated entry IDs.
6. On `confirm_food`, bot updates matching entries to `confirmed = true`, loads saved summary, updates Slack message, and invalidates cache.

## Known Failure Mode (and Fix)
Observed symptom: first entry succeeds, later confirms show `These entries were already saved.`

Root issue: if a food-entry insert unexpectedly returned no `id`, code previously logged a warning and continued. That could leave the confirm button with empty IDs, which later looked like an "already saved" confirm.

Fix implemented:
- `saveUnconfirmed()` now fails fast and throws an explicit error when `INSERT ... RETURNING id` yields no row.
- User now gets an actionable Slack error message instead of a broken confirm flow.

## Debugging Checklist
- Confirm Slack scopes include: `chat:write`, `im:history`, `im:read`, `im:write`, `users:read`, `users:read.email`.
- Verify Slack user can be resolved to Dofek user in `fitness.auth_account` / `fitness.user_profile`.
- Check logs around:
  - message receipt (`Message handler invoked`)
  - save path (`Saved X unconfirmed entries`)
  - confirm path (`confirm_food action` + `updated N rows`)
- If confirm says already saved, inspect the clicked action payload `value` and ensure it contains entry UUIDs.

## Testing Notes
- Unit tests are in `bot-unit.test.ts`.
- Important coverage includes:
  - idempotent confirm behavior
  - empty/malformed confirm values
  - thread refinement path
  - insert-returning-no-id behavior (should now surface explicit error)
