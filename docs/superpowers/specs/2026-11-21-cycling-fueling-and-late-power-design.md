# Cycling fueling and late-ride power

## Scope

Pair a rider's recorded carbohydrate intake before a late effort with mean
measured power during that effort across comparable rides. Keep logging optional
and use the existing Dofek MCP food workflow and cycling analytics. The user
selected an optional MCP consumption time for this design. The comparison and
the API details below are proposed for review.

## Evidence

Smith et al. compared placebo with glucose at 15, 30, and 60 g/h in 12 cyclists.
The cyclists rode at a prescribed workload for two hours and then completed the
same simulated 20 km time trial. Mean time-trial watts were higher with glucose.
The glucose was administered at scheduled intervals during the preload.
[Smith et al., 2010](https://journals.physiology.org/doi/epdf/10.1152/japplphysiol.91394.2008)

Iten et al. compared 15 g/h carbohydrate with placebo during 150 minutes of
cycling at 90% of power at the first ventilatory threshold in a randomized
crossover trial. The carbohydrate condition attenuated the loss of power at
that threshold. The comparison between carbohydrate and placebo showed no
detectable difference in critical power. The ventilatory threshold required a
separate test with respiratory gas measurements.
[Iten et al., 2026](https://onlinelibrary.wiley.com/doi/10.1111/sms.70407)

Dofek's proposed observational adaptation uses logged food and drink carbs and
compares recorded power during equivalent efforts. The result describes what
was recorded for that rider. Conditions such as prior diet, training, hydration,
temperature, pacing, and exertion may differ. Leave the trial doses and test
durations in the research context. The comparison supplies neither a personal
carbohydrate target nor an estimate of a physiological threshold.

## Approach

Extend the existing MCP food records with an optional, explicitly reported
consumption timestamp. This reuses itemized carbohydrate amounts, account
scoping, versioning, and idempotency. The existing import-only approach would
require a verified provider contract for both grams and actual consumption time.
Apple Health currently supplies sample bounds that Dofek stores as daily
aggregates. FatSecret and the imported Cronometer fields have diary dates.
Ziva preserves a nullable raw meal time whose consumption semantics and timezone
remain unverified. Adoption of any external source would require its own evidence.
[Apple Health importer](../../../src/providers/apple-health/db-insertion.ts) ·
[Cronometer importer](../../../src/providers/cronometer-csv.ts) ·
[FatSecret diary API](https://platform.fatsecret.com/docs/v2/food_entries.get) ·
[Ziva provider contract](../../ziva.md)

### MCP food records

- Add optional `consumed_at` to `create_food_entry` and to the existing update
  set and clear operations for Dofek-authored itemized food records. Accept an
  explicit timestamp with a UTC offset. An MCP client supplies it only when the
  user explicitly reports the time of intake. Date-only writes remain valid.
- Keep `date` as the existing diary date and retain the current diary previews
  and daily nutrition resolution. Store the optional timestamp once as a typed
  field decision in the existing food record ledger, including on create. Expose
  the effective value and its human change provenance as optional fields in
  the existing MCP record response. Clearing the decision returns the value to
  unknown. Preserve the same version, request replay, delete, and restore rules
  as the other fields.
- Keep missing timestamps unknown. Entry creation and history timestamps,
  the request time, meal labels, free-text descriptions, and generic provider
  sample bounds cannot supply `consumed_at`. Existing food records receive no
  inferred timestamp or automated backfill. The feature needs no new web or
  mobile controls.

[MCP food contract](../../mcp.md#food-record-lifecycle) ·
[Existing food write path](../../../packages/server/src/repositories/food-record-repository.ts) ·
[Field decision projection](../../../drizzle/0111_human_record_projections.sql)

### Cycling comparison

- Reuse the existing repeated-effort workflow to identify rides for the same
  rider. For the first slice, require the same repeatable cycling workout
  protocol in the same modality, a documented sustained preload, and the same
  explicitly bounded late work interval in its recorded execution. An exact
  workout identity identifies possible repeats. Require execution evidence
  that the preload followed the same duration and workload prescription, and
  report observed work where available. Use the documented protocol to
  establish duration, workload, and the late effort window.
- Before opening the comparison implementation, verify a sanitized fixture
  from a currently supported cycling import that establishes those bounds and
  comparable executions alongside measured watts. The interval schema and
  comparison outputs already represent recorded bounds, but this review
  confirmed a production interval writer only for imported Hang Ten sessions.
  Keep the comparison pending if a supported cycling source cannot supply the
  required evidence. The timestamp contract can ship independently if approved.
- Calculate recorded carbohydrate g/h as the sum of eligible effective grams
  consumed from preload start up to, but excluding, effort start, divided by
  elapsed hours in that window. Use elapsed time consistently, including known
  pauses within the documented preload. Exclude entries at effort start and
  later. Evaluate instants across timezones and midnight. Count each effective
  item once, respect corrections and deletion, and withhold attribution when
  overlapping rides or duplicate sources make it ambiguous. Use **recorded
  carbohydrate g/h** because incomplete logging is possible. An empty window
  stays unknown. An explicit zero applies to the recorded item only unless the
  source can establish zero intake for the entire window.
- Use the existing deduplicated activity sensor path and cycling power coverage
  rules. Compute mean measured watts over the recorded effort window. Preserve
  recorded zero watts, withhold watts when coverage or direct-power provenance
  is inadequate, and keep the ride and effort bounds with the result. The
  durability workspace may supply reusable effort bounds, source and coverage
  evidence, and prior mechanical work. Fueling uses equivalent observed efforts
  without the durability benchmark or a dependency on that feature shipping.
- Propose an opt-in result in the existing MCP performance comparison. Require
  both `activity:read` and `nutrition:read` before returning nutrition data.
  Existing activity-only queries keep their present behavior. Return bounded
  per-ride evidence with effort identity, preload and effort bounds, recorded
  grams and g/h, mean watts, provenance and coverage, and any reason the
  comparison is unavailable. Present the individual observations without dose
  bands, a fitted response, a causal claim, or a single-ride comparison.

[Repeated cycling analysis](../../mcp.md#repeated-cycling-analysis-workflow) ·
[Performance comparison tool](../../../packages/server/src/mcp/performance-comparison-tool.ts) ·
[Cycling effort metrics](../../../packages/server/src/repositories/cycling-effort-metrics.ts)

## Acceptance and verification

1. A legacy date-only request still succeeds and has unknown consumption time.
   A supplied offset-bearing time is readable after create and update. Clear
   returns it to unknown. History preserves the timestamp decisions. An unzoned
   or malformed value fails validation. Retrying the same create returns the
   existing entry. Reusing its request ID with a different timestamp is a
   conflict. Another account cannot access the entry. Deleting and restoring
   it removes and restores its effective contribution. Test the MCP contract
   and ledger against PostgreSQL, and verify the migration locally.
2. Verify and document the eligible cycling source fixture before implementing
   the comparison. With equivalent, same-rider recorded executions and adequate
   direct watts, two eligible rides return their source and timing evidence,
   recorded g/h, and subsequent mean watts. Test exact boundaries, offset and
   midnight alignment, corrected or deleted entries, untimed or duplicate
   intake, and overlapping ride attribution. One eligible ride yields no
   comparison. Use the real PostgreSQL and ClickHouse test tier.
3. Keep unknown measurements unknown. Test estimated watts, real zero watts,
   missing sample coverage, unknown or inferred effort bounds, non-equivalent
   preloads, and a missing nutrition scope. Verify that the output makes the
   observational interpretation clear and that legacy tool callers retain their
   shape and behavior. Run repository lint, workspace typechecks, relevant
   non-interactive tests, and the required CI checks before reporting readiness.
