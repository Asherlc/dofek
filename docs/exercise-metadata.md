# Exercise Metadata

The exercise metadata lookup is used when imported strength data does not provide muscle metadata.

The baseline data comes from Free Exercise DB:

- Source: https://github.com/yuhonas/free-exercise-db
- License: Unlicense / public domain
- Fields used: `name`, `primaryMuscles`, `secondaryMuscles`

`src/free-exercise-db.json` is a minified copy of the upstream Free Exercise DB `dist/exercises.json` file.

## Updating Free Exercise DB

Refresh the upstream copy with:

```bash
curl -fsSL https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json \
  | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(input)) + "\n"));' \
  > src/free-exercise-db.json
```

Keep the file minified. The PR size check counts added lines, and the upstream pretty-printed JSON is large enough to fail that check.

After updating, review the `src/free-exercise-db.json` diff, run the exercise metadata tests, and commit the refreshed upstream copy.

## Local Overrides

`src/exercise-metadata.ts` normalizes exercise names to lowercase keys and maps upstream muscle names into Dofek muscle group tokens such as `CHEST`, `QUADRICEPS`, `LATS`, `UPPER_BACK`, and `LOWER_BACK`.

`src/exercise-metadata-overrides.json` stores local corrections, provider aliases, and missing common names. Keep overrides in normalized lowercase-key format so all providers can use the same lookup path.

Use overrides when:

- a provider uses a common name that Free Exercise DB does not include, such as `pull up`;
- the upstream exercise exists but should map to Dofek's more specific muscle groups;
- an imported exercise name needs to stay stable across providers.

Run this focused check after changing the upstream copy, overrides, or lookup code:

```bash
pnpm vitest run src/exercise-metadata.test.ts src/providers/strong-csv.test.ts
```
