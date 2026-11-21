# Provider goals and training calendar imports

## Scope

Dofek users can see upcoming races, planned workouts, and recurring goals
they have already set in connected apps. Web and iOS show the same imported
records with their source. Each provider contributes the fields it exposes.
Roll out providers as their data access is verified.

Users continue to manage imported plans and goals at their source. This scope
covers ingestion and display. Plan authoring, progress calculations, automated
workout matching, recommendations, and provider writeback are separate work.

## Approach

Provider imports share a small set of domain records and use Dofek's existing
connection, sync, upload, and account lifecycle. A single release across all
providers would tie available integrations to partner access and undocumented
export contents. Provider-specific dashboards would duplicate display logic
and make it harder to see training plans across apps. The approved direction
is to use a shared experience and release each provider when verified.

## Data and display

- Calendar entries belong to an account and carry provider identity, a stable
  external identifier, a name, and the scheduled date or time. A race can also
  carry sport, priority, and explicit race goals. A planned workout can carry
  sport and its planned duration or distance when supplied.
- Recurring targets have an explicit metric, value, unit, and time period.
  Keep the source's sport and date range when provided. A weekly training-time
  target and a race finish-time target retain their distinct meanings. Race
  goals can include unitless placing or a boolean personal-record target.
  Apple Health goals are dated daily values, and the Move target can be
  energy or time depending on the source mode.
- Keep day-only dates as local calendar dates. Preserve an authoritative
  timestamp and time zone when supplied. Show absent fields as unavailable
  and preserve zero when it is a valid upstream target.
- Extend the existing Activities experience to expose upcoming calendar
  entries on both clients. Present recurring targets alongside the period
  they apply to. The API provides the normalized records and source labels.
  Completed-activity analytics continue to consume recorded activity data.
- Use Postgres for these low-volume source records. Idempotent upserts update
  the same provider record on repeat sync or reschedule. Preserve source
  attribution and leave cross-provider records individually identifiable.
- Remove an entry from the active calendar on explicit source removal or
  absence from a verified complete source snapshot. Fetch a window that can
  include upcoming entries. Preserve prior state for windows with partial
  results, failed syncs, or ambiguous permissions. Incremental and one-time
  import paths add or update only the records they receive.
- Keep records private to the importing user. Apply existing provider
  disconnect, data export, provider-data deletion, and account-erasure rules.
  Retained plans from disconnected providers and one-time imports can still
  appear with their source and last confirmed import date. Mark these records
  as snapshots so the user can tell that edits at the source won't sync. Use
  minimum read scopes and validate provider and upload payloads at ingestion.

## Provider evidence

| Provider | Expected import | Evidence needed before release |
| --- | --- | --- |
| TrainerRoad | Calendar races and planned workouts. Surface priority and targets when returned. | Verify each claimed record type in a populated authorized payload. Check the [documented iCalendar feed](https://support.trainerroad.com/hc/trainerroad-support/articles/360022469251-calendar-export) for field coverage alongside the [calendar mapped in repository research](../../trainerroad.md). The [existing client](../../../packages/trainerroad-client/src/client.ts) syncs completed activities. A calendar read and parser would extend that connection if its contract can be verified. |
| Intervals.icu | A/B/C races, planned workouts, and weekly time, distance, and training-load targets. | Verify a calendar response under read-only access and document event-field units and timezone behavior. Production OAuth requires app approval. The [OpenAPI definition](https://intervals.icu/api-docs.html) enumerates race and target categories, and the [OAuth guide](https://forum.intervals.icu/t/intervals-icu-oauth-support/2759) documents calendar reads. |
| Apple Health | Daily Move, Exercise, and Stand goals available to the authorized user. | Verify native activity summaries and the corresponding XML goal fields. Extend the existing HealthKit sync and XML upload paths where the fields are present. Read the target fields only and preserve Dofek's prohibition on provider-estimated expenditure. The [existing XML fixture](../../../src/providers/apple-health/sync.integration.test.ts) includes goal attributes and the [HealthKit activity summary](https://developer.apple.com/documentation/healthkit/hkactivitysummary) documents the native targets. [Apple's read-authorization guidance](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data) explains why an empty read cannot establish removal. |
| TrainingPeaks | Race details and goal values for time, distance, place, and personal record, plus available planned workouts. | Verify official partner access, granted scopes, and usable event discovery before promising an entire upcoming calendar. The official docs show [next-event reads](https://github.com/TrainingPeaks/PartnersAPI/wiki/Event-Get-Next), [by-date reads](https://github.com/TrainingPeaks/PartnersAPI/wiki/Event-Get-By-Date), and [planned workout reads](https://github.com/TrainingPeaks/PartnersAPI/wiki/Planned-Workouts-Get). |
| Garmin Connect | Evaluate race and recurring-goal availability. | Confirm an entitled read or inspect an authorized [account export](https://support.garmin.com/en-IE/?faq=q22kMdCbU23NUT2Wmspz16) for actual goal records. The [developer program](https://developerportal.garmin.com/developer-programs/connect-developer-api) advertises Training as publishing content. Extend the existing Garmin ZIP importer if a stable export format is verified. |
| Strava | Evaluate recurring distance, time, activity-count, and elevation goals. | Check the [public API reference](https://developers.strava.com/docs/reference/) and an authorized [account archive](https://support.strava.com/hc/en-us/articles/216918437-Exporting-your-Data-and-Bulk-Export). Use a one-time import if the archive provides usable goal records. [Strava's app goal guide](https://support.strava.com/en-us/articles/15401694-goals-on-the-strava-app) documents the recurring goal types. |

Start with the Apple Health XML path, which already has a local test fixture.
Verify native HealthKit access and the calendar sources independently. Dofek
supports connecting TrainerRoad, but the account checked during design had
no TrainerRoad authorization. Confirm TrainingPeaks eligibility and investigate
Garmin and Strava access early. Advance verified slices while other providers
await access. A provider can ship individual verified record types. A
TrainerRoad feed with just workouts can ship as a planned-workout source,
and a TrainingPeaks next-race read can ship with that coverage stated.

## Release checks

- Each enabled source has a representative, authorized read or export showing
  the claimed fields, with personal values removed from test fixtures.
- Verify a race with and without a finish-time target, and a planned workout,
  where the source supports them. Verify weekly training targets and dated
  activity goals against source values and units.
- Check web and iOS against identical server results. Cover upcoming dates,
  unavailable optional fields, source attribution, loading, empty, and error
  states. Include day-only timestamps across time zones and daylight saving.
- Use the real database to verify account isolation, repeat imports, edits,
  cancellations, partial sync results, and deletion. Run the required
  repository checks for the complete change.
