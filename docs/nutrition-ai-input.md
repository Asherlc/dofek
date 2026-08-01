# Nutrition AI Input

Natural-language meal logging is available on both web and iOS Nutrition screens.

## What it does

- Accepts one free-text meal description (for example: `two eggs, toast with butter, and coffee with milk`).
- Parses the text into multiple itemized food entries.
- Logs each parsed item as a normal confirmed food entry for the selected date.

## End-to-end flow

```text
User enters meal text (web/iOS)
  -> food.analyzeItemsWithAi({ description })
  -> server analyzeNutritionItems()
  -> parsed items[]
  -> client loops items and calls food.create(...)
  -> confirmed food_entry + food_entry_nutrient rows
  -> Nutrition totals/analytics update from existing queries
```

## API flow

- Clients call `food.analyzeItemsWithAi` with `{ description }`.
- The server uses `analyzeNutritionItems()` to produce parsed items with meal + macro/micronutrient estimates.
- Clients create one `food.create` call per parsed item.

## Where implemented

- Server router: `packages/server/src/routers/food.ts`
- Web screen: `packages/web/src/pages/NutritionPage.tsx`
- iOS screen: `packages/mobile/app/(tabs)/food.tsx`

## Data model behavior

- Entries are saved as standard `fitness.food_entry` + `fitness.food_entry_nutrient` rows via existing food create flow.
- Detailed micronutrients, caffeine, hydration, and macronutrients are all stored as nutrient rows, not wide columns.
- Raw provider totals remain derived through
  `fitness.v_nutrition_provider_daily`. Application totals use the resolved
  `fitness.v_nutrition_daily`/`fitness.v_nutrition_canonical_nutrient` views;
  the AI parser writes itemized raw entries and does not write separate daily
  nutrient rows. PostgreSQL documents views as query-defined virtual tables:
  <https://www.postgresql.org/docs/current/sql-createview.html>.
- No AI-specific columns are added to nutrition tables.
- Parsed items participate in existing nutrition totals/analytics automatically.

## Error behavior

- Server validation/API errors are returned to clients as normal error messages.
- Web and mobile capture unexpected errors to telemetry before showing the message.

## AI observability and privacy

- The server enables the AI SDK's OpenTelemetry-compatible telemetry for each nutrition operation, using stable function IDs for analysis and refinement. See the [AI SDK telemetry documentation](https://ai-sdk.dev/docs/ai-sdk-core/telemetry).
- When trace observability is enabled, server startup registers the AI SDK's provider-neutral OpenTelemetry integration so those telemetry options emit spans.
- Input and output recording are disabled, so this AI telemetry path does not export the user's meal description or the model's nutrition response.
- Production instrumentation forwards AI spans to PostHog's generic OpenTelemetry AI adapter. Nutrition/domain code supplies only standard `user.id` context; the provider-specific export stays in the instrumentation adapter. PostHog documents this [Vercel AI/OpenTelemetry integration](https://posthog.com/docs/ai-observability/installation/vercel-ai) and its [privacy mode](https://posthog.com/docs/ai-observability/privacy-mode).

## Troubleshooting

- `No items logged after submit`:
  - Check the `food.analyzeItemsWithAi` response payload for `items.length`.
  - If `items` is empty or missing, inspect server logs around AI parsing for provider/API failures.
- `Some items logged, others missing`:
  - The client performs one `food.create` call per parsed item.
  - A per-item create failure stops the loop; inspect the first failing `food.create` error message.
- `Validation error from food.create`:
  - Confirm each parsed item has required fields expected by `food.create` (valid `foodName`, valid numeric nutrients, valid meal value).
- `User sees generic failure`:
  - Confirm client is showing server `error.message`.
  - Check telemetry events for `nutrition-ai-meal-input` (web) or `food-ai-meal-input` (mobile).
