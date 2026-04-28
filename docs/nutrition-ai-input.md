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
- No AI-specific columns are added to nutrition tables.
- Parsed items participate in existing nutrition totals/analytics automatically.

## Error behavior

- Server validation/API errors are returned to clients as normal error messages.
- Web and mobile capture unexpected errors to telemetry before showing the message.

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
