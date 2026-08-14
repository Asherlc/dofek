# Remove Remaining Manual Health Inputs Design

## Goal

Remove all first-party, user-authored health-data inputs while retaining
provider ingestion and read-only health-data views.

## Scope

- Remove manual journal entry creation from the web dashboard.
- Remove all first-party nutrition logging on web and iOS: typed entry,
  Quick Add, barcode scanning, and AI meal text.
- Remove Slack food logging and the Slack integration that supports it,
  including its persisted credentials and related operational documentation.
- Remove the now-unused HealthKit nutrition write-back paths and supporting
  packages, tests, stories, screenshots, and documentation.
- Preserve provider-originated ingestion, existing raw food and journal data,
  and read-only food/journal displays.

## Architecture

The application becomes provider-ingestion-only for these data domains.
Client controls and routes that create health data are removed rather than
hidden. Server and mobile code that exists solely to service those controls is
deleted with its tests. Slack storage is removed through a forward migration so
the deployed database no longer retains integration-only tables.

The implementation reuses the canonical, already-merged upstream removals:
`dcf84aa86` (first-party food logging), `ca4674507` (Slack integration), and
`21b5d1745` (journal-entry UI). This preserves the repository's established
deletion and migration boundaries instead of recreating an alternate design.

## Data Flow

```text
Provider sync -> raw health tables -> read-only web and iOS views
```

No web, iOS, AI, barcode, Quick Add, journal, or Slack route may create,
update, or delete first-party health data after this change.

## Error Handling

Removed input paths no longer surface client-side errors because they no longer
exist. Existing provider sync failures continue to use the established
telemetry and user-visible error behavior.

## Verification

- Verify removed UI controls, routes, and dependencies are absent.
- Run the targeted regression suites affected by the removals.
- Run repository lint, changed tests, and root/server/web TypeScript checks
  before every push.
- Validate the Slack removal migration against the local database before
  considering the change complete.
