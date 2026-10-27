# Read-Only Supplements Design

## Goal

Make the supplements experience read-only on web and mobile. Users can inspect
their supplement stack, safety context, and recent dose history, but cannot add,
edit, remove, reorder, or manually record supplement data. Remove the matching
manual-write API surface rather than leaving disabled or deprecated mutation
paths.

## Scope

### Web

- Keep the `/nutrition/supplements` route and its three sections: supplement
  stack, safety context, and recent doses.
- Render the supplement stack without add, edit, delete, or reorder controls.
- Render recent dose counts, current status, provenance, and event history
  without `Taken` or `Skip` controls.
- Replace copy that instructs users to define a schedule or record a dose with
  copy that describes synced, read-only data.

### Mobile

- Keep the supplements screen, pull-to-refresh behavior, safety context, source
  links, stack display, and recent dose history.
- Remove the add form, add/cancel controls, delete controls, reorder controls,
  save state, mutation error handling, and reorder announcements.
- Remove `Taken` and `Skip` controls from recent dose rows.
- Use the same read-only framing as the web route.

### Server

- Keep `supplements.list` and `supplements.occurrences` as protected read
  procedures.
- Remove the `supplements.save` and `supplements.recordDose` mutation
  procedures.
- Remove repository code, validation schemas, conflict translation, cache
  invalidation, and telemetry that exist only to serve those mutations.
- Preserve the supplement tables, historical records, read queries, nutrition
  analytics, and the provider-owned `auto-supplements` sync path.
- Do not migrate or delete existing user-entered records; they remain visible as
  historical read-only data.

## Component Boundaries and Data Flow

`SupplementStackPanel` remains responsible for querying and rendering the
canonical stack, including loading, error, empty, and cached-refresh states. It
has no mutation dependency or local editing state.

`SupplementDoseEventsPanel` remains responsible for querying and rendering the
seven-day occurrence projection. It displays counts and event history without
creating successor events.

Both clients continue to consume the server-authored projections. The server
router exposes only the two read procedures, which delegate to the repository's
`list()` and `occurrences()` methods. Provider ingestion and scheduled
occurrence generation remain outside this UI/API path.

## Error Handling

Existing read-query behavior remains unchanged: initial failures show the
server error, and background refresh failures preserve cached data while
showing the error. Removing mutations also removes mutation-specific local
telemetry and client error messages because those operations no longer exist.

## Testing and Validation

- Keep and update positive tests for stack rendering, safety context, dose
  counts, statuses, provenance, loading, errors, and cached-refresh behavior on
  web and mobile.
- Delete mutation-specific tests and fixtures that cover adding, editing,
  deleting, reordering, saving, or recording a dose.
- Do not add tests whose only purpose is to assert that removed controls or API
  procedures are absent; production deletion, TypeScript API inference, and
  existing positive rendering tests provide the appropriate coverage.
- Run focused web, mobile, server-router, and repository tests, then repository
  typecheck and lint.

## Non-Goals

- Removing the supplements route or hiding supplement data.
- Changing provider ingestion or automatic occurrence generation.
- Changing supplement storage, nutrition calculations, or historical data.
- Adding a replacement manual-entry mechanism or a compatibility endpoint.
