# Agent Guidelines for @dofek/nutrition

Read the [README.md](./README.md) first to understand the implementation details.

- **Nutrient Truth**: Never add a new micronutrient without first defining it in the `NUTRIENTS` catalog in `nutrients.ts`.
- **Prefer Canonical IDs**: Use the `id` field from [the nutrient catalog](src/nutrients.ts) (e.g., `vitamin_a`) for database and API logic. Use legacy field names only at the boundary of external provider integration.
