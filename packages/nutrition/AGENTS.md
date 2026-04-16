# Agent Guidelines for @dofek/nutrition

Read the [README.md](./README.md) first to understand the implementation details.

- **Nutrient Truth**: Never add a new micronutrient without first defining it in the `NUTRIENTS` catalog in `nutrients.ts`.
- **Prefer Canonical IDs**: Use the `id` field from the catalogs (e.g., `vitamin_a`, `resting_hr`) for all database and API logic. Use legacy field names only at the boundary of external provider integration.
- **Search Locales**: When using `OpenFoodFactsClient`, pass the user's device locale to ensure relevant food search results.
- **Validation**: Always use `parseQuickAddForm` or equivalent Zod schemas when processing user input for food entries.
