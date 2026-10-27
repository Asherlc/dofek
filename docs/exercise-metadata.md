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

## Strong export audit (2026-09-07)

The supplied Strong export uses the header `Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,RPE`. Its September 3 rows record Seated Leg Curl as 140 lb for 11, 8, and 7 reps, and Leg Extension as 140 lb for 8, 9, and 9 reps. The current importer resolves the `Weight` and `Reps` columns by normalized header name, converts only weight when the selected unit is pounds, and persists reps unchanged. The regression in [`strong-csv.test.ts`](../src/providers/strong-csv.test.ts) pins 140 lb as 63.503 kg with reps 11, 8, 7, and 8.

That regression passed before any importer production change. The current group hydrator also projects stored `weight_kg` and `reps` independently, as covered by [`strength-repository.integration.test.ts`](../packages/server/src/repositories/strength-repository.integration.test.ts). The narrowest supported corruption boundary is therefore persisted historical data or a writer that predates the current importer; the supplied export and current read path do not identify which historical writer transposed those fields.

### Verified aliases from the supplied export

These names were alias mismatches: the uploaded Strong name identifies one existing bundled-catalogue exercise, so the local override copies that exercise's muscle mapping.

| Strong name | Bundled Free Exercise DB exercise |
|---|---|
| Ab Wheel | Ab Roller |
| Bent Over Row (Dumbbell) | Bent Over Two-Dumbbell Row |
| Bicep Curl (Dumbbell) | Dumbbell Bicep Curl |
| Bicycle Crunch | Air Bike |
| Calf Press on Leg Press | Calf Press On The Leg Press Machine |
| Chest Dip / Chest Dip (Assisted) | Dips - Chest Version |
| Chest Fly (Dumbbell) | Dumbbell Flyes |
| Crunch | Crunches |
| Flat Leg Raise | Flat Bench Lying Leg Raise |
| Leg Extension (Machine) | Leg Extensions |
| Prone Leg Curl | Lying Leg Curls |
| Standing Calf Raise (Dumbbell) | Standing Dumbbell Calf Raise |
| Strict Military Press (Barbell) | Standing Military Press |
| Triceps Dip | Dips - Triceps Version |
| Wide Pull Up | Wide-Grip Rear Pull-Up |

### Unresolved names

Unresolved names remain `null`; the lookup does not invent anatomy when the catalogue cannot identify a single exercise.

| Strong name | Reason |
|---|---|
| Skullcrusher (Dumbbell) | Absent catalogue entry for the uploaded equipment. The only skullcrusher entry is EZ-Bar Skullcrusher. |
| Triceps Extension | Ambiguous alias: the export supplies no equipment and the catalogue contains distinct cable, dumbbell, barbell, machine, and other variants. |
| V Up | Absent catalogue entry. Similar abdominal movements are not treated as aliases without exact evidence. |
