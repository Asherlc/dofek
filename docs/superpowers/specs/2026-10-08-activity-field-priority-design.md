# Activity Field Source Priority Design

## Goal

Choose source values for independently merged activity fields using priorities
specific to each field. For a climbing activity with Kaya and Peloton members,
Kaya's activity name should win while the canonical activity type, provider,
measurements, and source records keep their current selection rules. This
replaces the earlier proposal to remove `Cardio:` from displayed titles.

The observed activity has a Peloton name of `41 min 58 sec Cardio: Climbing`, a
Kaya name of `Kaya climbing at Touchstone Great Western Power Company`, and no
name on its WHOOP or Apple Health members. The canonical type is `climbing`.
The existing [Postgres activity view](../../../drizzle/_views/01_v_activity.sql)
chooses a non-null name by general source priority, independently of the
canonical member. The [ClickHouse activity view](../../../src/db/clickhouse-read-models.ts)
and [dbt activity models](../../../analytics/models/read_models/deduped_activities.sql)
also merge activity source fields.

## Scope

- Support field-specific source priority for merged activity scalar fields.
  Initially wire `activity.name`, `activity.notes`, and
  `activity.perceived_exertion` where those fields are present in a projection.
- Configure only Kaya's `activity.name` priority in this change. Kaya's current
  [import](../../../src/providers/kaya/import.ts) produces climbing activities.
- Preserve every provider's stored name and raw payload. Web, mobile, and MCP
  continue to receive the selected merged name from the server.
- Keep canonical type, canonical provider, time-context selection, sensor data,
  and raw JSON key merging on their existing domain rules. Sleep, daily metrics,
  and sensor priorities are outside this change.

## Priority data model

Add `fitness.provider_field_priority` with `provider_id`, `field_key`, and an
integer `priority`, keyed by `(provider_id, field_key)`. A smaller number wins.
Field keys are namespaced strings such as `activity.name`; adding a rule for
another wired activity field requires a row, not a new priority column or
schema migration. A newly introduced merged field must explicitly use its key
in each relevant projection. The table is global per provider, like the
existing [provider priority table](../../../src/db/schema/reference.ts).

For a candidate source and field, use the field priority when present;
otherwise use its current effective device priority, provider priority, or
default of 100, in that order. A field rule takes precedence over a generic
device rule because it describes the specific value being selected. Exclude
null field values before ranking and use source activity ID as the stable
tie-breaker. With no field rule, generic source ranking still applies; the
source ID resolves previously unspecified ties. Seed Kaya's `activity.name`
priority at 0 so its available climbing name precedes the current Peloton
priority of 20.

Extend `fitness.provider_priority_audit` and its trigger to record changes to
the new table, including the field key. This preserves the existing
[priority audit contract](../../../drizzle/0026_seed_provider_priorities.sql)
without introducing a second audit path.

## Read paths and rollout

1. Add the Postgres table and a forward migration that updates
   `fitness.v_activity` while preserving its public columns. Keep
   [`drizzle/_views/01_v_activity.sql`](../../../drizzle/_views/01_v_activity.sql)
   aligned with that migration. PostgreSQL runs a normal view's defining query
   when the view is read; `CREATE OR REPLACE VIEW` updates its calculation
   without storing duplicate activity names
   ([PostgreSQL `CREATE VIEW`](https://www.postgresql.org/docs/current/sql-createview.html)).
2. Add the table to the existing [PeerDB mirror contract](../../../src/db/peerdb/mirror-contracts.ts)
   and create its ClickHouse raw mirror table with a tracked ClickHouse
   migration. The existing mirror reconciler adds newly declared mappings;
   validate that the Kaya rule appears in the mirror before comparing results.
3. Apply the same field-priority fallback in the live ClickHouse activity view
   and the dbt activity merge. The dbt merge currently takes the canonical
   member's name, unlike the Postgres and live ClickHouse views; make its name
   selection follow the same field rule and generic fallback. This may correct
   other merged names that differ between those paths. Use a deterministic
   `(effective priority, source activity ID)` ordering for non-null values.
   ClickHouse's `argMin`
   returns the value associated with the smallest ranking expression, and its
   `-If` combinator restricts the candidate rows
   ([ClickHouse `argMin`](https://clickhouse.com/docs/reference/functions/aggregate-functions/argMin),
   [aggregate combinators](https://clickhouse.com/docs/reference/functions/aggregate-functions/combinators)).
4. After the rule reaches ClickHouse, run the existing analytics build. The
   [deduped activity model](../../../analytics/models/read_models/deduped_activities.sql)
   compares selected names with stored rows and writes changed rows; the
   [activity summary model](../../../analytics/models/read_models/activity_summary_rows.sql)
   consumes its refreshed timestamp. Verify both models updated the observed
   activity, then compare its name in Postgres, ClickHouse, and the user-facing
   API. dbt's [incremental model guide](https://docs.getdbt.com/docs/build/incremental-models)
   describes why changed model logic must be processed against existing rows.

The new table is the only stored source of field overrides. Each read path
projects the same rule over its existing activity source records. No source
activity or title is rewritten.

## Verification

- A Postgres integration fixture with WHOOP, Apple Health, Peloton, and Kaya
  members reproduces the observed ordering and selects Kaya's name while
  retaining the `climbing` canonical type and current provider selection.
- A field rule for `activity.notes` on a separate fixture demonstrates that
  the same mechanism works for another field. With no matching rule or no
  non-null Kaya name, selection falls back to the prior order. Non-climbing
  activities without overrides retain their names.
- ClickHouse integration fixtures exercise the live activity view and dbt
  merge against the real engine, including fallback and deterministic ties.
  SQL text assertions alone do not establish database behavior.
- Run migration validation, SQL lint, typecheck, and the relevant integration
  tests. A read-only post-rollout check compares the selected name for the
  observed activity across serving paths.

## Boundaries

No global title-prefix removal, provider-name editing, user-facing priority
settings, device-specific field override, raw JSON key priority, or change to
other data domains is included. Existing device priorities remain the fallback
when no field rule applies.
