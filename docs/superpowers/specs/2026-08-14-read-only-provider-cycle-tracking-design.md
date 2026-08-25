# Read-Only Provider Cycle Tracking Design

## Goal

Restore cycle tracking as a provider-fed, read-only feature on web and iOS.
Remove every first-party period create, update, and delete control and its
corresponding tRPC/repository write path. Do not infer menstruation from
temperature, recovery, sleep, or other proxy signals.

## Current State

The pre-removal implementation stores user-authored period rows in
`fitness.menstrual_period` and exposes `currentPhase`, `history`, `logPeriod`,
`updatePeriod`, and `deletePeriod`. Its web and iOS screens contain period
creation, correction, and deletion controls.

[PR #2523](https://github.com/Asherlc/dofek/pull/2523) subsequently removed the
whole cycle feature and added a forward migration that drops
`fitness.menstrual_period`. The production deployment's
[migration step](https://github.com/Asherlc/dofek/actions/runs/31862135496) has
completed, so the new design must not depend on that table or assume its former
rows still exist.

Apple Health import already parses menstrual-flow category records into the
generic `fitness.health_event` store, but the native sync does not schedule
menstrual-flow reads and neither path preserves the cycle-start metadata needed
to distinguish the first sample of a period.

## Provider Evaluation

### Apple Health / HealthKit — selected first source

HealthKit exposes `menstrualFlow` category samples. Apple requires every sample
to include cycle-start metadata and supports both one interval for a whole
period and multiple flow samples whose first sample carries the start marker
([Apple documentation](https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier/menstrualflow)).
HealthKit is the best immediate source because Dofek already has a native iOS
module, background sync, Apple Health upload APIs, and Apple Health XML import.
It also acts as an on-device aggregator for any authorized app that writes
these records. Reads remain subject to fine-grained user authorization, and
HealthKit deliberately does not reveal whether read access was denied
([authorization behavior](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)).

Required work:

- request read access for menstrual-flow records without requesting write
  access;
- query them through the existing anchored/background synchronization model;
- preserve UUID, source name, source bundle, numeric flow value, and the
  required cycle-start metadata;
- extend Apple Health XML category parsing to retain equivalent metadata;
- store each raw sample once in `fitness.health_event` and process deletion
  tombstones through the existing HealthKit deletion path.

### Garmin Women's Health API — best cloud follow-up

Garmin's official Women's Health API explicitly provides menstrual-cycle
schedules and phase details through REST with push or ping/pull delivery
([Women's Health API](https://developer.garmin.com/gc-developer-program/womens-health-api/)).
It is the strongest cloud-to-cloud candidate, but it is part of Garmin's
business-only Connect Developer Program, requires application approval, uses
OAuth 2.0, and may apply licensing or device-order requirements to some metrics
([program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)).

Dofek's current Garmin provider uses undocumented private Garmin Connect
endpoints. It must not guess or scrape Women's Health endpoints. A Garmin cycle
integration should begin only after program approval and access to the exact
payload contract, then use the official API as a separately reviewed provider
extension.

### Android Health Connect — viable future mobile source

Health Connect exposes both interval `MenstruationPeriodRecord` and
instantaneous menstrual-flow records under the cycle-tracking data category
([record API](https://developer.android.com/reference/androidx/health/connect/client/records/MenstruationPeriodRecord),
[data types and permissions](https://developer.android.com/health-and-fitness/health-connect/data-types)).
It is a good Android equivalent to HealthKit, with source metadata and explicit
read permissions. Dofek has no Android client today, so no Health Connect code
belongs in the first implementation.

### Not suitable as menstrual-record providers

- WHOOP's public `cycle` API describes an awake-to-sleep physiological day,
  not a menstrual cycle
  ([WHOOP cycle definition](https://developer.whoop.com/docs/developing/user-data/cycle/)).
- Oura's public V2 API documents sleep, activity, readiness, heart rate,
  workouts, tags, sessions, SpO2, stress, resilience, and related endpoints,
  but no menstrual-period record or menstrual-cycle scope
  ([Oura V2 API](https://cloud.ouraring.com/v2/docs)). Temperature or readiness
  changes are not an acceptable substitute for an observed period record.
- The current published catalogs for
  [Fitbit](https://dev.fitbit.com/build/reference/web-api/explore/),
  [Polar AccessLink](https://www.polar.com/polar-api-v4/),
  [Withings](https://developer.withings.com/developer-guide/v3/data-api/all-available-health-data/),
  and the [Google Health API](https://developers.google.com/health/data-types)
  do not document menstrual-period records. They should not be implemented
  from private endpoints or proxy inference.
- Direct integrations with consumer cycle apps should be reconsidered only
  when a supported, consented developer API exposes user-owned records. Until
  then, HealthKit and Health Connect are the appropriate aggregation layers.

## Approaches Considered

### 1. HealthKit-first provider events — selected

Restore only the read-only client and query layers, source their data from raw
Apple Health events, and retain explicit provider/source attribution. This
fits the existing application, requires no new vendor contract, and removes
all first-party writing.

Trade-off: only users with qualifying Apple Health records receive new cycle
data initially. Garmin and Android coverage remain future work.

### 2. Garmin-first cloud integration

Use Garmin's official Women's Health API before restoring the UI. This offers
server-side background delivery without depending on an iPhone.

Trade-off: the API is inaccessible until business approval and its detailed
contract is not public. Making it the critical path would block the read-only
feature on external onboarding.

### 3. Multi-provider cycle framework before the first source

Create a generalized reproductive-health provider interface, schemas, source
resolver, and adapters for HealthKit, Garmin, and Health Connect together.

Trade-off: only HealthKit is implementable now, so the extra abstractions would
be speculative. Add a shared interface when the second concrete provider is
approved and its payload is known.

## Selected Architecture

### Canonical storage

`fitness.health_event` remains the single raw storage path. Do not recreate
`fitness.menstrual_period` and do not store derived period duration, cycle
length, phase, or predictions.

Add only the generic source fields needed to represent HealthKit records
faithfully when they are not already available: source bundle and structured
sample metadata. Store the raw menstrual-flow value and cycle-start marker
with the upstream event. Keep HealthKit UUID-based external IDs so retries are
idempotent and deletion delivery can remove the exact record.

The XML import path must use a deterministic external ID that includes enough
source and event identity to avoid collapsing distinct records that share a
timestamp. Existing raw rows are not copied to another table.

### Server queries

Restore the `menstrualCycle` router with only:

- `history`: reads provider-originated cycle-start events for the requested
  range and returns dates plus provider/source attribution;
- `currentPhase`: computes its evidence from those cycle-start events and
  returns the existing safety/uncertainty contract.

Remove the `logPeriod`, `updatePeriod`, and `deletePeriod` procedures, their
input schemas, invalidation code, repository methods, and mutation-only error
types. No compatibility aliases or disabled endpoints remain.

At query time, collapse exact duplicate start dates while retaining their
source attribution. If active provider sources disagree about the latest
cycle start, return an explicit conflicting-provider-data availability state
and no phase estimate. Never pick a source silently and never infer a period
start from biometric proxies.

The server continues to own phase and cycle-length computation. Clients render
the server's values, labels, provider attribution, and error/availability
states without recomputing metrics.

### Web and iOS

Restore `/cycle` on web and the equivalent iOS screen/navigation entry as
read-only surfaces containing:

- current phase or the exact server-authored unavailable/conflict reason;
- tracking limitation notice;
- provider-attributed period-start history;
- existing privacy links for reviewing, exporting, or deleting account data.

Delete the log form, date picker, notes input, edit form, delete controls,
confirmation state, mutations, retry state, and mutation telemetry. Replace
copy such as "Log a period start" or "Correct it" with instructions to review
or correct the record in its source provider and sync again.

Navigation, privacy links, and sync controls are not health-data input and
remain interactive.

## Data Flow

```text
Apple Health source app
  -> HealthKit menstrual-flow sample + cycle-start metadata
  -> Dofek iOS anchored/background sync or Apple Health XML import
  -> fitness.health_event (raw, source-attributed, idempotent)
  -> menstrualCycle.history/currentPhase read queries
  -> read-only web and iOS cycle views
```

Garmin Women's Health and Android Health Connect may feed the same read
contract later, after their separate integration gates are satisfied.

## Error and Privacy Handling

- A denied HealthKit read permission is indistinguishable from no readable
  samples; show a neutral no-provider-data state and a permission-management
  link, not a false claim that no cycle records exist.
- Native query, upload, parse, and server failures continue to report through
  Sentry and surface their specific server error message.
- Conflicting provider records suppress the phase estimate and name the
  conflicting dates/sources without exposing data from another user.
- Cycle data remains included in generic health-event export and account
  erasure. Do not restore a separate manual-period export.
- The safety notice remains visible: the estimate is for tracking, not birth
  control or diagnosis.

## Historical Manual Data

The production drop migration has already run. Restoring former manual rows is
not part of this code implementation and cannot be accomplished by recreating
the table. If preservation is desired, use the database recovery runbook to
restore the latest pre-migration backup into an isolated database, export only
the affected user-scoped rows, and import them once into the canonical raw
event model with explicit legacy-manual provenance. That operator action
requires separate approval and verification before touching production.

## Testing and Verification

Follow TDD and the repository's test-tier rules:

1. Add real Postgres integration fixtures for HealthKit menstrual-flow events,
   exact-date deduplication, conflicting sources, sparse history, and phase
   computation.
2. Add native Swift and TypeScript tests for menstrual-flow permission,
   anchored reads, cycle-start metadata, source identity, and deletions.
3. Add Apple Health XML parser/import integration coverage for both single-
   interval and multi-sample representations.
4. Update web and mobile tests to exercise provider-attributed read-only
   rendering, permission/no-data states, and server errors. Remove tests for
   deleted mutation behavior; do not add tests whose sole purpose is asserting
   that removed controls or procedures are absent.
5. Verify with targeted tests, real database integration tests, Swift tests,
   lint, root/server/web typechecks, `pnpm test:changed:all`, and production-like
   web/mobile rendering.
6. Search production code for the removed procedure names and manual cycle
   input copy as a static review check.

## Out of Scope

- Restoring historical manual rows from production backups.
- Writing cycle data back to HealthKit or any provider.
- Garmin implementation before Developer Program approval and schema access.
- Android/Health Connect implementation before an Android client exists.
- Fertility, contraception, pregnancy, diagnosis, or calibrated forecasting.
- Inferring cycle events from temperature, HRV, recovery, sleep, or wearable
  scores.
