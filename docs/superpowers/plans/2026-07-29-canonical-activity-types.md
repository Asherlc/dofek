# Canonical Activity Types TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development before
> implementation. If executing this plan task-by-task, use the repository
> `write-tests`, `ship-pr`, `address-pr-comments`, and `gh-fix-ci` skills as
> applicable. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a provider-neutral activity concept, the verbatim provider type,
and the currently consumed modality qualifiers as separate fields.

**Behavior:** Synonymous provider activity labels aggregate and filter as one
canonical concept without losing the upstream label or the road, mountain,
indoor, trail, and other qualifiers that current consumers use.

**Scope:** Replace `fitness.activity.activity_type` with
`canonical_type`, `provider_type`, and nullable `modality`; migrate every writer
and reader across Postgres, PeerDB/ClickHouse dbt models, tRPC/MCP/export
contracts, web, and mobile; remove the old storage and application contract.
No surface, equipment, or other hypothetical classification dimensions are
added. Distinct sports remain distinct canonical concepts.

**Docs:** [Issue #2245](https://github.com/Asherlc/dofek/issues/2245),
[`docs/schema.md`](../../schema.md), and
[`docs/clickhouse-activity-dedup-runbook.md`](../../clickhouse-activity-dedup-runbook.md).

---

## Current Evidence

- `fitness.activity_type` contains 126 provider and qualifier values, including
  synonym pairs such as `climbing` / `rock_climbing`, `strength` /
  `strength_training`, and `hockey` / `ice_hockey`.
- `fitness.activity` stores only `activity_type`, so the actual upstream value
  has already been discarded for historical rows.
- `fitness.v_activity`, the MCP `search_activities` tool, tRPC repositories, and
  ClickHouse/dbt models group and filter on the mixed `activity_type` field.
- Existing consumers require modality:
  `activity_summary_rows.sql` suppresses indoor/virtual cycling speed and
  distance; cycling read models select cycling variants; web and mobile vertical
  ascent charts distinguish road/mountain/gravel; recording and running flows
  distinguish trail and mountain activities.
- WHOOP defines `football` separately from `soccer`, while Garmin's
  `american_football` currently maps to legacy `football`. Therefore legacy
  `football` migrates to `american_football`; new WHOOP Gaelic football records
  use the distinct `gaelic_football` canonical concept.
- Historical `provider_type` must be backfilled from the legacy enum text
  because the original provider vocabulary cannot be reconstructed. Every new
  writer must persist its actual upstream value, stringifying numeric codes.

## Canonical Decision Table

The table is exhaustive for all 126 values in the legacy Postgres enum. A blank
modality is stored as `NULL`.

| Legacy value | Canonical type | Modality |
| --- | --- | --- |
| `cycling` | `cycling` | |
| `road_cycling` | `cycling` | `road` |
| `mountain_biking` | `cycling` | `mountain` |
| `gravel_cycling` | `cycling` | `gravel` |
| `indoor_cycling` | `cycling` | `indoor` |
| `virtual_cycling` | `cycling` | `virtual` |
| `e_bike_cycling` | `cycling` | `electric` |
| `cyclocross` | `cycling` | `cyclocross` |
| `track_cycling` | `cycling` | `track` |
| `bmx` | `cycling` | `bmx` |
| `running` | `running` | |
| `trail_running` | `running` | `trail` |
| `swimming` | `swimming` | |
| `open_water_swimming` | `swimming` | `open_water` |
| `walking` | `walking` | |
| `hiking` | `hiking` | |
| `strength` | `strength` | |
| `strength_training` | `strength` | |
| `functional_strength` | `strength` | `functional` |
| `gym` | `strength` | |
| `yoga` | `yoga` | |
| `pilates` | `pilates` | |
| `tai_chi` | `tai_chi` | |
| `mind_and_body` | `mind_and_body` | |
| `meditation` | `meditation` | |
| `breathwork` | `breathwork` | |
| `stretching` | `stretching` | |
| `flexibility` | `stretching` | |
| `barre` | `barre` | |
| `elliptical` | `elliptical` | |
| `rowing` | `rowing` | |
| `cardio` | `cardio` | |
| `hiit` | `hiit` | |
| `mixed_cardio` | `cardio` | `mixed` |
| `mixed_metabolic_cardio` | `cardio` | `mixed_metabolic` |
| `stair_climbing` | `stair_climbing` | |
| `stairmaster` | `stair_climbing` | |
| `stairs` | `stair_climbing` | |
| `step_training` | `step_training` | |
| `jump_rope` | `jump_rope` | |
| `fitness_gaming` | `fitness_gaming` | |
| `cross_training` | `cross_training` | |
| `bootcamp` | `bootcamp` | |
| `circuit_training` | `circuit_training` | |
| `functional_fitness` | `strength` | `functional` |
| `core` | `core` | |
| `core_training` | `core` | |
| `boxing` | `boxing` | |
| `kickboxing` | `kickboxing` | |
| `martial_arts` | `martial_arts` | |
| `group_exercise` | `group_exercise` | |
| `skiing` | `skiing` | |
| `cross_country_skiing` | `skiing` | `cross_country` |
| `downhill_skiing` | `skiing` | `downhill` |
| `snowboarding` | `snowboarding` | |
| `snow_sports` | `snow_sports` | |
| `snowshoeing` | `snowshoeing` | |
| `skating` | `skating` | |
| `surfing` | `surfing` | |
| `kayaking` | `kayaking` | |
| `sailing` | `sailing` | |
| `paddle_sports` | `paddling` | |
| `paddleboarding` | `paddling` | `paddleboard` |
| `paddling` | `paddling` | |
| `water_fitness` | `water_fitness` | |
| `water_polo` | `water_polo` | |
| `water_sports` | `water_sports` | |
| `aqua_fitness` | `water_fitness` | |
| `underwater_diving` | `diving` | |
| `diving` | `diving` | |
| `snorkeling` | `snorkeling` | |
| `tennis` | `tennis` | |
| `table_tennis` | `table_tennis` | |
| `squash` | `squash` | |
| `racquetball` | `racquetball` | |
| `badminton` | `badminton` | |
| `pickleball` | `pickleball` | |
| `padel` | `padel` | |
| `paddle_racquet` | `pickleball` | |
| `basketball` | `basketball` | |
| `soccer` | `soccer` | |
| `football` | `american_football` | |
| `american_football` | `american_football` | |
| `australian_football` | `australian_football` | |
| `rugby` | `rugby` | |
| `hockey` | `hockey` | |
| `ice_hockey` | `hockey` | `ice` |
| `lacrosse` | `lacrosse` | |
| `baseball` | `baseball` | |
| `softball` | `softball` | |
| `volleyball` | `volleyball` | |
| `cricket` | `cricket` | |
| `handball` | `handball` | |
| `golf` | `golf` | |
| `disc_golf` | `disc_golf` | |
| `climbing` | `climbing` | |
| `rock_climbing` | `climbing` | |
| `dance` | `dance` | |
| `dancing` | `dance` | |
| `cardio_dance` | `dance` | `cardio` |
| `social_dance` | `dance` | `social` |
| `triathlon` | `triathlon` | |
| `multisport` | `multisport` | |
| `hand_cycling` | `cycling` | `hand_cycle` |
| `wheelchair_walk` | `walking` | `wheelchair` |
| `wheelchair_run` | `running` | `wheelchair` |
| `disc_sports` | `disc_sports` | |
| `equestrian` | `equestrian` | |
| `fencing` | `fencing` | |
| `fishing` | `fishing` | |
| `hunting` | `hunting` | |
| `gymnastics` | `gymnastics` | |
| `archery` | `archery` | |
| `bowling` | `bowling` | |
| `curling` | `curling` | |
| `wrestling` | `wrestling` | |
| `track_and_field` | `track_and_field` | |
| `play` | `play` | |
| `navigation` | `navigation` | |
| `geocaching` | `geocaching` | |
| `skydiving` | `skydiving` | |
| `paragliding` | `paragliding` | |
| `preparation_and_recovery` | `preparation_and_recovery` | |
| `cooldown` | `preparation_and_recovery` | `cooldown` |
| `transition` | `transition` | |
| `other` | `other` | |

New provider mappings may additionally emit `gaelic_football` when the upstream
contract says exactly that. It is not part of the legacy backfill table because
the old enum did not contain it.

## Test Strategy

- Unit: prove the 126-row legacy map is exhaustive and every result belongs to
  the canonical type and modality enums; prove provider resolvers retain the
  verbatim raw string and distinguish canonical type from modality.
- PostgreSQL integration: run the real migration/schema and insert synonym
  records; prove `climbing` and `rock_climbing` become canonical `climbing`,
  retain distinct provider strings, and aggregate/filter through
  `fitness.v_activity` without the old column.
- ClickHouse/dbt integration: build the real affected models with a minimal
  fixture and prove synonyms aggregate on `canonical_type`, while modality
  preserves indoor speed suppression and road/mountain/gravel grouping.
- API/MCP/export: update schemas and response assertions so canonical type,
  provider type, and modality cross every server boundary.
- Web/mobile parity: update rendering, filters, recording inputs, stories, and
  tests together. User-facing displays use canonical type plus modality when a
  qualifier is material.

## File Structure

- Create `packages/training/src/activity-types.ts` for the single canonical
  vocabulary, modality vocabulary, exhaustive legacy map, and provider
  classification helpers.
- Modify `packages/training/src/training.ts`,
  `endurance-types.ts`, `derived-cardio.ts`, and `activity-icons.ts` to consume
  canonical type plus modality without reconstructing old compound strings.
- Modify `src/db/schema/enums.ts`, `src/db/schema/activity.ts`,
  `drizzle/_views/01_v_activity.sql`, and add forward migration
  `drizzle/0064_canonical_activity_types.sql`.
- Modify all root/package provider parsers and persistence paths so the actual
  upstream type reaches `provider_type`.
- Modify affected ClickHouse bootstrap schemas and dbt models under
  `analytics/models/read_models/`.
- Modify server models, repositories, routers, MCP tools, export/ML contracts,
  and their tests.
- Modify web and mobile activity components/pages, recording flows, stories,
  and tests.
- Regenerate `docs/schema.dbml` and `docs/schema.puml`; update current human
  documentation where the contract is described.

## Tasks

### Task 1: Add Failing Classification Tests

**Files:**
- Create: `packages/training/src/activity-types.test.ts`
- Modify: provider parser tests that currently assert compound legacy values

- [ ] Assert the exhaustive legacy table has exactly the 126 input values above.
- [ ] Assert every result belongs to the canonical and optional modality enums.
- [ ] Assert representative synonym, qualifier, unknown, numeric-provider, and
  Gaelic-football behavior, including verbatim `providerType`.
- [ ] Run `rtk pnpm test:unit -- packages/training/src/activity-types.test.ts`.
- [ ] Confirm failures are caused by the missing canonical classifier.

### Task 2: Implement the Canonical Classifier

**Files:**
- Create: `packages/training/src/activity-types.ts`
- Modify: `packages/training/src/training.ts`
- Modify: all provider parser/mapping modules reached by the failing tests

- [ ] Implement the canonical and modality constants and types.
- [ ] Implement the exhaustive legacy classifier and provider-resolution helper.
- [ ] Update provider mappings to return canonical type, modality, and raw
  provider type without cross-provider dependencies.
- [ ] Run `rtk pnpm test:unit -- packages/training/src/activity-types.test.ts`.
- [ ] Confirm the classification tests pass.

### Task 3: Add Failing PostgreSQL Migration and Writer Tests

**Files:**
- Modify: `src/db/migrate.integration.test.ts`
- Modify: `src/db/provider-activity-sync.integration.test.ts`
- Modify: focused provider integration tests
- Modify: `packages/server/src/repositories/activity-repository.integration.test.ts`

- [ ] Add a real-database fixture containing synonym and qualified legacy rows.
- [ ] Assert the migrated rows expose canonical, provider, and modality values.
- [ ] Assert `fitness.v_activity` groups/filters canonical values and has no old
  storage column.
- [ ] Assert representative new writes retain exact string and numeric provider
  values.
- [ ] Run `rtk pnpm test:integration -- src/db/migrate.integration.test.ts src/db/provider-activity-sync.integration.test.ts packages/server/src/repositories/activity-repository.integration.test.ts`.
- [ ] Confirm failures are caused by the missing schema and writer migration.

### Task 4: Implement the PostgreSQL Migration and Every Writer

**Files:**
- Modify: `src/db/schema/enums.ts`
- Modify: `src/db/schema/activity.ts`
- Modify: `drizzle/_views/01_v_activity.sql`
- Create: `drizzle/0064_canonical_activity_types.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: all activity insert/upsert paths found by `rg`

- [ ] Add canonical type and modality enums and the provider type text column.
- [ ] Backfill historical provider type from legacy enum text and classify every
  legacy row with the exhaustive table.
- [ ] Replace dependent views atomically, remove the old column/type, and leave
  no dual-write or compatibility path.
- [ ] Update every writer to require all three fields and fail at compile time
  when provider provenance is missing.
- [ ] Run `rtk pnpm migrate`.
- [ ] Run the Task 3 integration command and confirm it passes.

### Task 5: Add Failing Analytics and Serving Contract Tests

**Files:**
- Modify: ClickHouse/dbt integration tests near the affected read models
- Modify: MCP, tRPC repository/router, export, and ML contract tests

- [ ] Assert source, deduped, summary, endurance, cycling, hiking, and reporting
  models use `canonical_type` for grouping/filtering.
- [ ] Assert `provider_type` remains provenance only.
- [ ] Assert modality drives existing indoor/virtual, trail, and
  road/mountain/gravel behavior.
- [ ] Assert MCP/API/export response and input schemas expose the new fields.
- [ ] Run focused unit tests with
  `rtk pnpm test:unit -- <changed unit test files>`.
- [ ] Run focused database tests with
  `rtk pnpm test:integration -- <changed integration test files>`.
- [ ] Confirm failures are caused by old reader contracts.

### Task 6: Implement Analytics and Serving Migration

**Files:**
- Modify: `analytics/models/read_models/*.sql` reached by code search
- Modify: ClickHouse bootstrap/read-model schemas reached by code search
- Modify: server models, repositories, routers, MCP, export, and ML boundaries

- [ ] Rename read-model columns and propagate canonical/provider/modality fields.
- [ ] Group/filter only on canonical type; use modality only for demonstrated
  qualifier behavior.
- [ ] Remove rock-climbing and cycling subtype special merges made obsolete by
  canonical classification.
- [ ] Run `rtk pnpm analytics:build`.
- [ ] Run `rtk pnpm lint:analytics-sql`.
- [ ] Run `rtk pnpm lint:analytics-policy`.
- [ ] Run Task 5 tests and confirm they pass.

### Task 7: Add Failing Web and Mobile Parity Tests

**Files:**
- Modify: activity web/mobile component, page, route, recording, and story tests

- [ ] Assert canonical labels/icons/filters are rendered from canonical type.
- [ ] Assert material modality labels remain visible and selectable where the
  current product distinguishes them.
- [ ] Assert the recording API sends canonical type plus modality and uses its
  chosen value as the Dofek provider type.
- [ ] Run `rtk pnpm test:unit -- <changed web test files>`.
- [ ] Run `rtk pnpm test:mobile -- <changed mobile test files>`.
- [ ] Confirm failures are caused by old client contracts.

### Task 8: Implement Web and Mobile Parity

**Files:**
- Modify: all web and mobile activity consumers reached by code search
- Modify: colocated stories for every changed visual component

- [ ] Update web and mobile together without client-side metric computation.
- [ ] Use shared activity-type formatting/classification helpers.
- [ ] Remove legacy compound-type reconstruction.
- [ ] Run Task 7 tests and confirm they pass.

### Task 9: Final Verification and Documentation

- [ ] Run `rtk pnpm tsx scripts/generate-schema-diagram.ts`.
- [ ] Run `rtk pnpm lint:migrations`.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Run `rtk pnpm test:changed:all`.
- [ ] Review `rtk git diff origin/main...HEAD` for any old runtime
  `activity_type` / `activityType` contract outside historical migrations and
  dated documentation.
- [ ] Commit and push each meaningful passing chunk.
- [ ] Open a PR with `Fixes #2245`, backlink the issue, move it to `In review`,
  monitor every required check/review, address all actionable feedback, and
  merge only after CI succeeds.
