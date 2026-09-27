# Unattached Mountain Project Ticks and Activity Matching

## Problem

Mountain Project exports climbing ticks as date-only records. The current sync
groups ticks by date and location and creates synthetic activity rows to hold
them. A tick is a climb data point, not a climbing session, so those synthetic
activities distort the activity list and make it difficult to associate a tick
with a workout recorded by another provider. The observed export contract and
its date-only field are documented in the
[Mountain Project provider guide](../../mountain-project.md).

## Goals

- Store each Mountain Project tick as one canonical `fitness.climbing_entry`
  row, without creating a synthetic activity for it.
- Allow a tick to exist before it is associated with a workout.
- On a climbing activity detail page, suggest only unattached Mountain Project
  ticks whose exported date is the same as the activity's displayed calendar
  day.
- Let the user attach each tick individually to the selected activity.
- Preserve tick identity, ownership, and any user-selected association across
  later Mountain Project syncs.
- Keep unattached ticks in climb and grade progression summaries without
  treating them as activities or sessions.
- Provide the same behavior on web and mobile through the shared server API.

## Non-goals

- Automatically selecting or attaching a tick to a same-day activity.
- An unmatched-ticks inbox, dismissal state, or suggestion-ranking system.
- Linking ticks to non-climbing activities or to activities on another day.
- Creating a second table that copies climbing-entry data or stores a separate
  suggestion/link record.
- Deleting raw ticks when Mountain Project stops returning them.

## Considered approaches

### Keep one synthetic activity per date and location

This is the current approach. It retains a parent for every entry, but continues
to present a date/location bucket as though it were a workout. Keeping it hidden
while adding a separate association would leave the same synthetic activity
model in the data path. This is not selected.

### Make the existing climbing entry optionally associated

Use `fitness.climbing_entry` as the single tick record. A tick without an
activity has its own owner, provider identity, and an `unattached_date`. On
attachment, clear `unattached_date` and set its activity association; from then
on, the activity supplies the tick's displayed day. A database constraint
ensures the entry is either unattached with a date or attached to an activity,
never both. This is selected because it models a tick as a standalone data point
until a workout is known and avoids duplicate normalized date values or copied
tick rows. PostgreSQL supports enforcing row invariants with [check and foreign
key constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).

### Add a separate tick-to-activity association table

This would preserve the current required activity foreign key and represent
matching in a separate relation. It would still need an owner and date for
unattached ticks, plus extra joins and two representations of association
state. It is not selected.

## Product flow

1. Mountain Project sync creates or refreshes one climbing-entry row per
   supported tick. It creates no activity row.
2. When the user opens a climbing activity, the server looks up unattached
   Mountain Project ticks for that activity's exact displayed day.
3. Web and mobile show the matching ticks in the activity detail page. Each
   tick has its own explicit attach action.
4. After a user attaches a tick, it appears with the selected activity's
   climbing entries and is no longer eligible for suggestions on any activity.

If multiple climbing activities occur on one displayed day, each can show the
same unattached ticks. The user chooses the correct activity one tick at a time;
date equality alone never attaches a tick.

## Data model

Extend the existing `fitness.climbing_entry` table; do not add a tick or
suggestion table.

- Add a required `user_id` so an unattached entry has an owner without needing
  to traverse an activity.
- Add a provider reference so source identity remains provider-agnostic when an
  entry is unattached. Keep the provider's external tick ID as the idempotent
  identity within that user and provider.
- Make `activity_id` nullable. When set, it references an activity owned by the
  same user.
- Add nullable `unattached_date`, containing Mountain Project's exported day
  only while `activity_id` is null.
- Enforce that exactly one of `activity_id` and `unattached_date` is present.
  Existing linked climbing entries keep their date from their parent activity;
  they do not receive a second normalized date.
- Preserve the original export row in the existing raw payload for source
  provenance. Application date filters use `unattached_date` only for detached
  ticks and the parent activity's date for attached entries.
- Add provider-list absence state to the entry so a full tick export can retire
  records no longer present and restore records that reappear without deleting
  raw rows. An empty export retains the current safety behavior of not
  interpreting an ambiguous empty response as mass deletion.

On attachment, a transaction verifies that the entry and target belong to the
requesting user, the entry is an active unattached Mountain Project tick, the
target is an active climbing activity, and the entry's `unattached_date` equals
the target activity's displayed day. It then sets the activity association and
clears `unattached_date` atomically. The activity foreign key points to the
selected activity member; existing activity-group hydration includes entries
for all group members. The activity grouping contract is described in the
[stable activity groups design](2026-09-07-stable-activity-groups-design.md).

## Sync and migration

The Mountain Project importer parses and upserts ticks individually by their
stable source identity rather than grouping them by date and location. Conflict
updates may refresh provider-owned tick attributes and raw payload, but must
preserve an existing `activity_id` and keep `unattached_date` null so a later
sync cannot undo a user attachment or create a second normalized date. For
unattached entries, sync refreshes `unattached_date` from the exported date.
Full-list reconciliation operates on tick identities rather than synthetic
activity identities. Its empty-list behavior follows the current
[provider absence reconciler](../../../src/db/provider-activity-absence.ts).

The migration backfills `user_id`, provider identity, and the Mountain Project
date from each existing tick and its synthetic parent. It detaches those ticks
and retires the synthetic parent activities from normal activity visibility,
preserving group integrity and raw tick data. The importer must not recreate
those parent activities after migration.

## Date and reporting behavior

Suggestion matching uses calendar days as rendered by the activity detail page:
the server computes the target activity's displayed date using the user's
configured timezone, then compares it exactly to the Mountain Project export
date. A tick from the previous or next date is never included.

Climb and grade progression include active unattached ticks using
`unattached_date`. Once attached, those same summaries get the tick's day from
the associated activity. Unattached ticks do not count as a workout, activity,
or climbing session and do not contribute a duration. This preserves tick-level
climbing evidence while removing the synthetic session from activity counts.

## API and clients

The shared server API provides:

- A user-scoped query for active, unattached Mountain Project ticks matching a
  target climbing activity's displayed date.
- A per-entry attach mutation with server-side checks for ownership, source,
  active/unattached state, target type, and exact day equality.

The mutation updates one entry atomically. A tick attached concurrently by
another request is not attached twice; the caller receives an actionable
conflict result and can refresh. Unexpected errors are reported through the
existing server error-reporting path.

Both web and mobile activity detail screens render the same returned tick data,
show a separate attach action per tick, surface API error messages, and refresh
the suggestion and activity-entry queries after attachment. No date matching
or climb aggregation is computed in client code.

## Validation

- Database-backed tests prove the nullable association/date invariant, owner
  enforcement, same-day attach behavior, and exclusion of adjacent-day ticks.
- Provider tests prove one entry is written per tick, stable source identities
  update existing rows, accepted associations survive later syncs, and absent
  entries are retired/restored without deleting raw data.
- Climbing query tests prove unattached ticks remain in grade/progression
  summaries and are not counted as activities or sessions.
- Web and mobile activity-detail tests prove only same-day unattached ticks are
  shown, each tick can be attached individually, and the UI refreshes after
  success.
- Migration integration coverage proves existing Mountain Project tick data is
  retained, detached with its export day, and no synthetic parent remains
  visible.

## References

- [Mountain Project provider guide](../../mountain-project.md), which records
  the observed date-only export contract and its limitations.
- [Stable activity groups design](2026-09-07-stable-activity-groups-design.md),
  which defines canonical activity identity and member hydration.
- [Climbing repository](../../../packages/server/src/repositories/climbing-repository.ts),
  which currently hydrates climbing entries through canonical activity members.
- [Provider absence reconciler](../../../src/db/provider-activity-absence.ts),
  which currently avoids mass tombstoning when an authoritative list is empty.
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html),
  for enforcing association, ownership, and one-of date/link invariants.
