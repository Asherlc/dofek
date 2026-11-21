# Strength Epley Trend Implementation Plan

**Goal** Preserve Strong’s explicit failure evidence and use it to limit estimated single-rep strength trends to comparable barbell lifts.

**Architecture** Keep the imported set and its provenance together in the existing strength table. Apply one server-side estimate rule to the existing chart, strength progression, and scoped performance comparisons.

**Technology** TypeScript, PostgreSQL, tRPC, MCP, Vitest.

## Approved scope

The user approved the explicit-failure approach shown in the Paseo design. LeSuer et al. evaluated sets taken to fatigue with ten or fewer repetitions on barbell bench press, squat, and deadlift. Dofek presents an estimate from logged sets. Exercise setup, form, and rest protocols cannot be established from these logs. [LeSuer et al.](https://doi.org/10.1519/00124278-199711000-00001)

Retain measured observations and raw provider values. Keep effort unknown for sets with no source marker. A single recorded rep remains a lift in the workout history, and an explicitly measured maximum keeps its measured status. Keep the feature in current workout history and estimate surfaces. The artboard illustrates evidence and empty states. There is no new data entry, separate screen, load prescription, schema migration, or backfill.

## Task 1 — Preserve Strong failure evidence

Files are `src/providers/strong-csv.ts` and its colocated unit tests.

- [ ] Test a Strong single-workout text share with a weighted `[Failure]` set, a bodyweight `[Failure]` set, and an untagged set. Assert that the shared import persists `raw.setTag: "Failure"` only on the explicitly tagged sets and `raw.reportedWeightUnit` on the weighted tagged set, normalized to `kg` or `lbs`. Include a mixed-unit fixture to prove that a tagged set’s recorded unit is preserved even when it differs from the workout-level effective unit. The existing imported numeric fields, order, and normalized working/rest classification keep their semantics.
- [ ] Observe the new expectation fail in the focused unit suite before changing production code.
- [ ] Capture the exact Strong tag and marker’s line-level unit during text parsing and retain both using the existing per-set raw JSON. Keep CSV behavior and unlabeled/unknown tag behavior stable. Strong defines Failure as an attempted additional rep that was unsuccessful. [Strong set tags](https://help.strongapp.io/article/166-set-tags)
- [ ] Verify the focused Strong unit suite passes and report the exact red and green commands and output.

## Task 2 — Share eligibility among existing estimate paths

Relevant files are the strength and strength progression repositories, performance comparison repository, result and modality metrics, the progression MCP output schema, existing chart terminology/evidence contract, and their colocated tests. Use the existing style of DB result validation. Include the stored weight/reps, original provider evidence and set IDs where the existing estimate contract exposes evidence.

- [ ] Add failing tests through the chart, progression, and performance comparison entry points using clean tagged barbell sets. Cover 1/2/10/11 reps, missing or invalid weight, unknown effort, RPE 10 without a tag, mismatched line and effective weight units, unknown equipment, other equipment and exercises, conflicting/duplicate records, and exact exercise scope. Include a tagged single and verify its actual load and reps survive with no estimate. Pin representative formula results at each surface’s existing rounding precision.
- [ ] Use one unrounded formula, `weight_kg × (1 + .0333 × completed_reps)`, as printed in LeSuer et al. Use canonical exercise name/equipment and original Strong exercise identity to validate the supported barbell variants. Supported base labels are Bench Press, Squat/Back Squat, and Deadlift. Keep variants and exercise identities distinct in observations. Derive fatigue only from the supported source evidence in Task 1, and exclude missing or conflicting identity, units, and values. Keep policy checks that already excluded suspect rows. Retain existing endpoint date/access bounds and chart minimum of three workouts. Without two comparable observations, suppress a progression change.
- [ ] Keep chart and progression aggregation server-side. Retain eligible set evidence for each plotted observation or PR using current contracts and chart interaction. Supply a clear existing chart empty state and method explanation. A workout comparison or effort trend can emit an estimate delta only under an exact strength exercise scope with comparable equipment. Estimate coverage is based on eligible estimates independently of volume. Preserve unrelated volume and history.
- [ ] Observe targeted unit and real Postgres integration suites pass after the changes. Document method, source limits and availability in the existing reference docs.

Implementation boundaries for the database and presentation paths:

- Implement one pure server helper, `estimateStrengthSet`, that takes an existing normalized strength-set row with `set_provider`, `exercise_name`, `equipment`, `set_type`, `weight_kg`, `reps`, and `raw`. Return the unrounded value or the reason for unavailability. Validate the exact Strong exercise label using the existing parenthesized equipment convention. For comparisons, select a valid source row among truly identical consolidated rows. A missing tag on a matching row supplies no fatigue evidence. Existing quality flags and conflicts still apply to the set as a whole.
- Extract the progression repository’s set consolidation and quality checks for reuse by the chart. Keep its existing fingerprint and behaviors for raw sets and volume. Fetch chart source rows through the current canonical-activity range and access predicates. Limit inputs to workouts containing a recorded failure candidate, and include their matching set rows so duplicate/conflict handling sees the whole group. Group chart observations by canonical exercise identity, use one eligible maximum per workout, and use a deterministic set tie-break. Add source set ID, provider, and recorded fatigue marker to the chart point contract and use the existing chart tooltip.
- Compute estimates for performance rows only when the resolved key is `strength_exercise_id` and the row matches that ID. Scope via the existing comparison query and return unavailable for estimate values under other keys. Mark coverage complete when eligible estimates exist and no otherwise eligible source candidate was excluded by a quality or identity conflict. Ordinary sets with unknown effort and valid volume do not make estimate coverage partial. Apply the existing partial/no-data gating to deltas and effort trends.
- Retain the first-to-latest timeline in the chart and existing date/PR evidence in progression. Supply the chart hint and eligibility explanation through its existing empty state and method disclosure. Mobile currently has no estimated-max chart and shares the server contracts. Keep current range and chart layout, with the approved mockup serving as an illustration of the data states.

Independent review added four regression criteria:

- Estimates in workout comparisons require a caller-supplied exact exercise key. A reference workout may still supply a volume comparison when its exercise identity is inferred.
- Rank estimates and determine PRs at full precision before rounding response values.
- Keep a malformed load’s source failure marker and current workout observation. Withhold estimate-eligible unit evidence when the load token is malformed.
- An explicitly tagged Strong duplicate that conflicts with another tagged record excludes that set. A duplicate without a tag leaves effort unknown. Comparison marks an otherwise supported estimate partial when conflicting tagged evidence excludes a qualifying set.

## Task 3 — Review and validate

- [ ] Review the actual diff against the approved scope, with special attention to missing effort, source-tag provenance, same-name equipment separation, race-safe imports, cache behavior, and output schemas.
- [ ] Run `rtk pnpm lint`, `rtk pnpm --recursive --include-workspace-root --if-present typecheck`, relevant noninteractive unit and mobile checks, and `rtk pnpm test:integration -- <changed database suites>`. Use the repository Compose wrapper and report any precise external blocker.
- [ ] Stage the reviewed implementation and its tests and docs. Leave existing unrelated design work and preview artifacts outside the application change. Commit and push this branch, then check CI.
