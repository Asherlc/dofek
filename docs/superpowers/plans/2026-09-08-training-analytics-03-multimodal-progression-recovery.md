# Multimodal Progression, Recovery, and Comparison Implementation Plan

> Execution continues the approved longitudinal training-analysis design and
> the repository's test-first workflow. Each task ends in a separately pushed
> commit so existing MCP tools remain usable throughout.

**Goal:** Add provenance-rich climbing, finger-loading, strength, body,
nutrition, recovery, and comparable-performance analytics without replacing
the current high-level tools or collapsing distinct biological loads.

**Architecture:** Query canonical `fitness.v_activity` membership for activity
deduplication, retain nullable source observations as unknown, calculate
aggregates server-side, and expose complete date spines with explicit coverage
and quality states. Extend existing normalized repositories where they already
model the domain; introduce no stored calculated metrics or parallel sources of
truth.

**Stack:** TypeScript, Drizzle/Postgres, ClickHouse read models, Zod, MCP SDK,
Vitest, existing `@dofek/training` grade and strength primitives.

## Task 6: Climbing progression and missing-attempt correctness

**Files:**

- Modify: `packages/server/src/repositories/climbing-repository.ts`
- Modify: `packages/server/src/repositories/climbing-repository.test.ts`
- Create: `packages/server/src/repositories/climbing-progression-repository.ts`
- Create: `packages/server/src/repositories/climbing-progression-repository.test.ts`
- Create: `packages/server/src/repositories/climbing-progression-repository.integration.test.ts`
- Create: `packages/server/src/mcp/climbing-progression-tool.ts`
- Create: `packages/server/src/mcp/climbing-progression-tool.test.ts`
- Modify: `packages/server/src/mcp/climbing-sessions-tool.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing tests proving that a climb with null `attempt_count` and null
   `sent` remains unknown, never becomes zero attempts or a failed attempt.
2. Query exact date ranges over canonical activity membership and preserve
   provider, member activity, local-time, grade-system, discipline, ascent,
   location, wall-angle, route, and detailed-attempt provenance.
3. Calculate daily and grade trends: hardest observed send/flash/onsight,
   observed send rate, attempts per send only when attempts are known,
   submaximal volume, frequency/rest/consecutive days, and rolling 7/28-day
   exposure. Mark partial aggregates when only some entries have attempt data.
4. Register `get_climbing_progression` with date, provider, discipline,
   location, and grade-system filters plus pagination. Preserve
   `get_climbing_sessions`, correcting only its handling of nullable facts.
5. Prove overlapping provider activities do not double sessions and ambiguous
   entry overlap is surfaced rather than silently merged. Commit and push.

## Task 7: Finger-loading progression

**Files:**

- Modify: `packages/server/src/repositories/climbing-training-log-repository.ts`
- Modify: `packages/server/src/repositories/climbing-training-log-repository.test.ts`
- Create: `packages/server/src/repositories/finger-loading-progression-repository.ts`
- Create: `packages/server/src/repositories/finger-loading-progression-repository.test.ts`
- Create: `packages/server/src/repositories/finger-loading-progression-repository.integration.test.ts`
- Create: `packages/server/src/mcp/finger-loading-progression-tool.ts`
- Create: `packages/server/src/mcp/finger-loading-progression-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing tests for protocol, grip, edge, signed added/assistance load,
   body weight, effective load, work/rest, repetitions/sets, laterality, RPE,
   notes, and source evidence.
2. Produce exact-range daily effective-load, load-to-bodyweight, and
   kg-seconds exposure series. Keep finger load separate from climbing and
   generic strength.
3. Define high-intensity days only from caller-supplied effective-load,
   load-ratio, or RPE thresholds; otherwise return null with an explicit
   reason. Return consecutive exposure-day counts without diagnosing injury.
4. Register `get_finger_loading_progression`, verify canonical activity
   deduplication and missing optional fields, then commit and push.

## Task 8: Strength progression and source-quality flags

**Files:**

- Modify: `src/db/schema/activity.ts`
- Add one migration only if provider inspection confirms upstream per-set raw
  values cannot be reconstructed from the canonical activity payload
- Modify relevant strength provider writers and their tests if the migration is
  required
- Create: `packages/server/src/repositories/strength-progression-repository.ts`
- Create: `packages/server/src/repositories/strength-progression-repository.test.ts`
- Create: `packages/server/src/repositories/strength-progression-repository.integration.test.ts`
- Create: `packages/server/src/mcp/strength-progression-tool.ts`
- Create: `packages/server/src/mcp/strength-progression-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Inspect Strong and WHOOP source payloads before choosing the single
   canonical original-value representation. Do not mirror normalized data.
2. Write failing tests for normalized exercise identity, set type, warm-up
   versus working sets, load, reps, RPE, unavailable RIR, named estimated-1RM
   formula, trends, frequency, and PR evidence.
3. Flag implausible and potentially reversed/import-corrupted fields while
   returning original and normalized values. Exclude flagged sets from volume,
   e1RM, and PR aggregates without silently correcting them.
4. Register `get_strength_progression`, prove a 140 reps by 11 lb-style record
   cannot contaminate aggregates, then commit and push.

## Task 9: Body-weight context and nutrition completeness

**Files:**

- Modify: `packages/server/src/repositories/body-repository.ts`
- Modify: `packages/server/src/repositories/body-repository.test.ts`
- Modify: `packages/server/src/repositories/nearby-weight-repository.ts`
- Modify: `packages/server/src/repositories/nearby-weight-repository.test.ts`
- Modify: `packages/server/src/repositories/nutrition-repository.ts`
- Modify: `packages/server/src/repositories/nutrition-repository.test.ts`
- Add a migration and provider writes only if an upstream source contains an
  explicit daily logging-completeness observation
- Modify corresponding MCP tools, schemas, transport tests, and README docs

1. Add rolling body-weight statistics and reuse one nearby-weight selection
   policy for W/kg evidence. Label direct, nearest, and interpolated weights.
2. Label consumer scale body-fat and lean-mass values as provider estimates,
   not direct body-composition measurements.
3. Return a complete nutrition date spine. Use `complete` or `partial` only
   from explicit source/user evidence; otherwise distinguish
   `unknown_completeness` from `no_logging`.
4. Permit nutrition and modality-specific load in one requested response while
   preserving source resolution. Commit and push.

## Task 10: Date-aligned recovery and training response series

**Files:**

- Create: `packages/server/src/repositories/recovery-training-series-repository.ts`
- Create: `packages/server/src/repositories/recovery-training-series-repository.test.ts`
- Create: `packages/server/src/repositories/recovery-training-series-repository.integration.test.ts`
- Create: `packages/server/src/mcp/recovery-training-series-tool.ts`
- Create: `packages/server/src/mcp/recovery-training-series-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing tests for one compact exact-range date spine containing
   selected HRV, resting HR, sleep duration/efficiency/stages, respiratory
   rate, body weight, steps, load channels, subjective fatigue/soreness,
   symptoms/injuries, and relevant activity exposure.
2. Reuse canonical repositories and ClickHouse resting-HR read models. Include
   per-value evidence, completeness, missingness, and timezone quality without
   silently shifting ambiguous dates.
3. Support stream selection and optional nutrition columns so token cost scales
   with the analyst's question. Return observations and alignments only; never
   state causal conclusions.
4. Verify next-day alignment at DST and ambiguous-timezone boundaries, then
   register `get_recovery_training_series`, commit, and push.

## Task 11: Equivalent-performance comparison

**Files:**

- Create: `packages/server/src/repositories/performance-comparison-repository.ts`
- Create: `packages/server/src/repositories/performance-comparison-repository.test.ts`
- Create: `packages/server/src/repositories/performance-comparison-repository.integration.test.ts`
- Create: `packages/server/src/mcp/performance-comparison-tool.ts`
- Create: `packages/server/src/mcp/performance-comparison-tool.test.ts`
- Modify: `packages/server/src/mcp/tool-output.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/README.md`

1. Write failing fixtures for repeated provider workout IDs, named/routes with
   explicit equivalence evidence, the same climb/problem, normalized strength
   exercise, and standardized tests.
2. Require a reference performance or explicit equivalence key. Return the
   equivalence method and confidence; do not compare unrelated activities.
3. Return cycling power, HR, cadence, duration, route, device/provider,
   temperature/elevation, and data-quality differences where available, plus
   modality-appropriate fields for climbing and strength.
4. Register `compare_performances` with date/provider/modality filters and
   pagination, prove canonical duplicate handling, then commit and push.

## Review Checkpoint

After Task 11, run lint, typecheck, Knip, changed unit tests, and serial focused
Postgres/ClickHouse integration suites. Audit every new strict MCP output,
formula definition, missing-data reason, source contribution, timezone label,
and pagination boundary. If the deployed connector and required read-model
refreshes are available, answer acceptance questions 8–12 from the authorized
dataset; otherwise report the exact deployment/data prerequisite and do not
guess.
