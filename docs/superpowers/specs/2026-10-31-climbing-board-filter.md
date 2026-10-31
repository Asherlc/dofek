# Climbing board filter

The user chose a filter on the existing climbing charts instead of separate
progression views. The default remains combined. This extends PR #3181.

## Design

- Extend the [shared climbing filter](../../../packages/training/src/climbing-filters.ts)
  with optional `board`, accepting `recorded` and `not_recorded` as one-or-many
  choices, normalized to arrays. Omission or both choices includes all entries;
  an empty selection includes none.
- Render a **Board** group beside Type and Setting in both clients, before
  More filters. Its choices are **Board climbs** and **No board recorded**;
  the select-all control is **All**. A restricted selection appears once in
  the existing summary. Clearing filters restores the combined view.
- Filter recorded `board` metadata, independent of provider. SQL NULL means
  no board was recorded; it does not establish ordinary gym bouldering.
  No new discipline, activity type, stored classification, or inferred board
  identity is introduced. Board identity and angle remain unchanged.
- Apply selection in the [shared server projection](../../../packages/server/src/repositories/climbing-rock-observations.ts)
  before aggregation, alongside existing filters. No client computes metrics.
  [PostgreSQL NULL predicates](https://www.postgresql.org/docs/current/functions-comparison.html#FUNCTIONS-COMPARISON-PRED-TABLE)
  distinguish present from missing metadata.
- Existing query inputs/cache keys carry this optional filter; response shapes
  and database schema do not change.

## Alternatives and decision

Separate default progression views would change the default experience. The
user selected the filter approach. Provider-based filtering cannot identify
board records from mixed logbook imports, so recorded board metadata is used.

## Verification

Tests first for shared normalization/toggling/summary, executable PostgreSQL
filtering, and web/iOS selection/reset/accessibility. Exercise same-provider
board and missing-board rows, board rows from a mixed import provider,
combined/empty choices, setting intersections, and unchanged unfiltered totals.
Use paired stories and a browser check. Preserve unknown metadata and existing
statistics definitions.
