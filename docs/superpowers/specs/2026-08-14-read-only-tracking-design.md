# Read-Only Tracking Design

## Goal

Make Dofek's journal, life-event, and subjective body-state tracking surfaces read-only. Remove the user-facing controls and tRPC procedures that create, update, or delete those records while preserving existing records, provider ingestion, queries, trends, timelines, and analysis.

## Scope

The change covers all web and mobile callers of the manual-write APIs, not only the web `/tracking` route. It removes experiment annotations backed by life events and the subjective body check-in controls shown on mobile Recovery.

The following tRPC mutations will be removed:

- `journal.create`
- `journal.update`
- `journal.delete`
- `journal.createQuestion`
- `lifeEvents.create`
- `lifeEvents.update`
- `lifeEvents.delete`
- `subjective.saveCheckIn`
- `subjective.createInjury`
- `subjective.updateInjury`
- `subjective.deleteInjury`

The following behavior remains in scope and unchanged:

- Provider-driven journal ingestion, including WHOOP journal data.
- Existing database rows and schema.
- Journal questions, entries, trends, time-range selection, and provider attribution.
- Life-event listing and impact analysis.
- Subjective body regions, check-ins, injuries, and timeline queries.
- Loading, empty, cached-data, retry, and server-error states for retained queries.

## Web Experience

The web `/tracking` route remains available as a read-only review surface.

### Journal

Keep the existing history and trends views, time-range controls, exact values, missing-day representation, and provider attribution. Remove the add-entry modal, add-entry trigger, entry deletion controls, and their mutation state and telemetry.

### Life Events

Keep the event list, selection, and impact analysis for existing records. Remove the add-event form, delete controls, mutation state, and mutation telemetry.

### Body State

Keep the current day's recorded check-in status and symptoms plus the injury and niggle history. Remove region, kind, score, date, and description inputs and all save, all-clear, and create actions. The resulting component only queries and renders stored data.

### Experiments

Remove life-event annotation creation from personal-experiment pages because it depends on `lifeEvents.create`. Existing linked annotations remain visible wherever the current read model exposes them.

## Mobile Experience

The mobile `/tracking` route remains its existing read-only Journal Trends screen. No new mobile tracking views are introduced.

Remove the subjective body check-in and injury-entry panel from Recovery. Remove life-event annotation creation from the mobile personal-experiments screen. Other recovery and experiment analysis remains unchanged.

## Server and Repository Boundaries

The journal, life-events, and subjective routers retain their query procedures and remove the manual mutation procedures listed above. Provider ingestion continues through its existing provider-specific paths and does not depend on these user-facing tRPC mutations.

After removing the procedures and clients, remove repository write methods, schemas, cache-invalidation imports, error types, and other implementation that have no remaining production consumer. Retain every repository method required by queries, analysis, or ingestion. Do not introduce disabled endpoints, compatibility aliases, feature flags, or fallback mutation paths.

## Data and Migration Policy

No database migration, backfill, or deletion is part of this work. Existing manual records remain readable so historical charts, timelines, and analyses do not lose context. The change removes future user-authored writes through the application and API; it does not erase history.

## Error Handling

Retained read surfaces continue to distinguish initial loading, refresh errors with cached data, terminal errors, and empty results. They continue to display server-provided error messages and retry controls where those exist today. Mutation-only error reporting is removed with the mutation code.

## Testing and Validation

Follow the repository's removal-testing policy: delete or rewrite tests that exercise removed mutation behavior, but do not add tests whose only purpose is to assert that a procedure or control no longer exists.

Retain and update tests for active read behavior, including journal history and trends, life-event analysis, and subjective history. Preserve provider-ingestion coverage. Update affected stories and test helpers so they model the read-only steady state.

Validation must include:

- Targeted web component and page tests.
- Targeted mobile screen and component tests.
- Targeted server router, repository, and integration tests.
- Type checking and linting for affected packages.
- Repository dead-code checks to confirm mutation-only components and methods are not stranded.

## Completion Criteria

The work is complete when:

- Web `/tracking` exposes no create, edit, save, all-clear, or delete action.
- Mobile exposes no subjective check-in or injury-entry panel and no experiment annotation creation.
- Web exposes no experiment annotation creation.
- None of the listed tRPC mutations remains in the application router type.
- No production client calls or repository write methods remain solely for those mutations.
- Existing records and provider-derived data remain readable through the retained queries.
- Targeted tests, type checking, linting, and dead-code checks pass.
