## Task 6: Make sensor, GPS, and elevation hydration a group union

**Files:**

- Modify: `analytics/models/read_models/activity_sensor_sample.sql`
- Modify: `analytics/models/read_models/activity_sensor_summary_rows.sql`
- Modify: `analytics/models/read_models/activity_location_sample.sql`
- Modify: `analytics/models/read_models/activity_location_summary_rows.sql`
- Modify: `analytics/models/read_models/activity_summary_rows.sql`
- Modify: relevant colocated SQL tests
- Create or modify: executable ClickHouse integration tests for activity summary hydration

**Produces:** One stable group summary populated from every member's deduplicated samples and location evidence.

**Task 5 handoff:** `activity_sensor_sample` already starts from stable `deduped_activities`, but `activity_sensor_summary_rows.current_activity` still reads raw PostgreSQL member IDs and therefore tombstones/misses stable group summaries. Audit every downstream model and the legacy `src/db/clickhouse-read-models.ts` / bootstrap builders for the same member-ID assumption. Task 5 also added nullable winning-sample `source_activity_id` to `sensor_scalar_sample` and `deduped_sensor`; preserve that schema for representative richness and current-membership attribution. Group hydration includes an unlinked sample as ambient data, or a linked sample when its `source_activity_id` belongs to any current group member—never only the representative. Historical deployment requires rebuilding sensor staging/deduped rows before downstream summaries.

- [ ] Add a fixture with disjoint payloads: metadata-only Peloton cardio, WHOOP cycling/commuting plus heart rate, and a third member with GPS/elevation.
- [ ] Assert the route-rich baseline has `canonical_type=cycling`, and across actual ranking-winner changes the independent commute refinement, heart rate, GPS, and elevation survive while display classification follows the representative.
- [ ] Add a property/permutation test that compares the set of populated output fields across representative permutations.
- [ ] Run the executable ClickHouse test and confirm failure on current summary/member compatibility behavior.
- [ ] Key all sample and summary joins on persisted group membership. Continue reading `analytics.deduped_sensor`; never read raw `ingest.metric_stream` for served metrics.
- [ ] Replace summary lifecycle `current_activity` and dirty-key comparisons that still use raw PostgreSQL `activity.id` with stable `deduped_activities.activity_id`; member IDs are lookup/invalidation inputs, not published summary keys.
- [ ] Bring canonical manual/bootstrap read-model builders into schema and identity parity with the dbt models changed here; do not leave a second dynamic/min-member grouping implementation.
- [ ] Preserve existing source-priority/location deduplication so overlapping providers do not double-count distance.
- [ ] Ensure incremental dirty keys invalidate both old aliases/member IDs and the stable group key.
- [ ] Run focused ClickHouse tests.
- [ ] Commit and push: `Union activity sensor payloads across group members`.
