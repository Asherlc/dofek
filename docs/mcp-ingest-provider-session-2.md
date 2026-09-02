# MCP ingest and provider audit — session 2

Audit date: 2026-09-01. Production investigation was read-only. No historical
backfill, provider reconnection, import, migration, or deployment was performed.

## Executive status

| Item | Result |
| --- | --- |
| Timezone corruption | Forward fix and bounded backfill tooling shipped; production backfill is blocked until the user has a persisted home timezone and the change is deployed. |
| Outdoor power | No extractor defect: the sampled Wahoo payloads and all 2022 Wahoo payloads lack power upstream. |
| Climbing and strength | Both are present and now exposed. Hangboard protocols are absent. |
| WHOOP typing | Sport extraction already works when upstream supplies a sport; containment merging of an untyped child into a typed activity was repaired. |
| Nutrition | FatSecret sync succeeds but currently returns no records. The canonical resolver is working; no truthful ingest-time `partial_log` signal exists. |
| Streams | `get_activity_streams` shipped with deduped ClickHouse data, default downsampling, and a hard response cap. |
| Provider health | Exact sync health and staleness shipped. Amazfit's token expired; the three never-synced sources are import-only by design. |
| Wearable history | History and recovery options were mapped. No backfill can run without an authorized provider request or valid Apple archive. |
| Ingest validation | The specified stored values and the full audit contain no invalid numeric sentinels; the observed zeros are introduced at read time. |
| Activity search | Full production repository search with and without `query` succeeds. A regression test and safe Sentry exception context shipped; the original exception was not retained in logs. |
| Map payload | Search map previews are opt-in; activity details retain them. |
| Supplements | `get_supplements` shipped. |
| Subjective data | One-tap all-clear check-ins and free-text, body-region-tagged injury notes shipped on web and mobile. |
| Unconnected providers | BodySpec is already implemented and is the highest-value connection, but connecting it requires user authorization and actual scan data. |

## 1. Timezone investigation and correction

The sign convention was not the defect. In the IANA database, `Etc/GMT+4`
means UTC-4 because these fixed-zone identifiers follow POSIX signs. The
Peloton inconsistency came from treating provider-supplied fixed zones as
reliable location zones.

Forward ingest now resolves local time in this order: geographic provider
timezone, provider offset, then persisted user home timezone. A fixed
`Etc/GMT` zone can express an offset but cannot establish location, so it is
replaced by the persisted home zone when available. Disagreements greater than
60 minutes are logged, and `local_time_source` records the source actually
used. Scheduled and file-import jobs both install the same provider-agnostic
ingest context.

Assuming the account home zone is `America/Los_Angeles`, the production audit
found these offsets more than 60 minutes from home:

| Provider | Year | Disagreeing | Total |
| --- | ---: | ---: | ---: |
| Apple Health | 2026 | 0 | 138 |
| Kaya | 2026 | 8 | 20 |
| Peloton | 2026 | 3 | 13 |
| WHOOP | 2026 | 0 | 187 |

The migration and backfill command are documented in
[`record-local-time.md`](record-local-time.md). They deliberately do nothing
without a valid persisted home timezone. Production currently has no home
timezone setting, so the acceptance backfill count remains pending.

Read-path handoff: activity weekly grouping uses the requested/user timezone.
Daily HRV uses provider dates. Sleep and resting-HR alignment use a fixed UTC-6
heuristic and should be corrected by the read-path owner. The dbt
`deduped_activities` model also appears to omit `user_home_timezone` from one
`argMin` predicate even though the older TypeScript projection includes it.

## 2. Cycling power provenance and coverage

Raw Wahoo records `2a7c6fa3` and `761483e6` contain no power field, and their
stored stream channels contain no power samples. The parser already consumes
`raw.power` when present. All 124 rides in 2022 lack power in their raw
payloads; this is not a units parser or provider-migration regression. Wahoo
raw records with positive power occur only in eight 2020 sessions. There is no
recoverable power backfill.

Power-bearing activities / total activities by year and modality:

| Year | Modality coverage |
| ---: | --- |
| 2009 | road 0/24 |
| 2010 | road 0/1 |
| 2011 | road 0/1 |
| 2012 | road 0/1 |
| 2013 | road 0/25; unspecified 0/18 |
| 2014 | road 0/4; unspecified 0/3 |
| 2015 | road 0/7; unspecified 0/4 |
| 2016 | road 0/6; unspecified 0/2 |
| 2017 | unspecified 0/2 |
| 2018 | road 0/3; unspecified 0/13 |
| 2019 | mountain 0/1; unspecified 15/42 |
| 2020 | indoor 1/1; mountain 0/5; unspecified 60/134; virtual 0/1 |
| 2021 | mountain 0/80; unspecified 3/24 |
| 2022 | unspecified 0/124 |
| 2023 | indoor 66/66; unspecified 0/81 |
| 2024 | indoor 29/29; unspecified 0/112 |
| 2025 | indoor 25/31; unspecified 0/51 |
| 2026 | empty 0/3; indoor 54/57; mountain 0/7; road 0/1; unspecified 0/20 |

The defensible coverage boundary is per-year/per-modality availability, not an
inferred power-meter ownership date.

## 3. Climbing, finger loading, and strength

Production contains 123 `climbing_entry` rows from 2026-07-06 through
2026-08-27. Grade, discipline, attempts, sends, location, and source are
populated on all 123; route name is populated on three; wall angle on none.
There are no orphaned rows. Kaya contributes 20 canonical activities; Mountain
Project contributes no canonical activity.

Production contains 1,189 strength sets from 2016-01-06 through 2026-07-14,
linked to 103 activities; 1,170 sets have enough data for volume load.
`strong-csv` accounts for 99 activities. The new strength tool exposes session
and muscle-group volume load.

Classification:

- Climbing grades and sends: present and exposed.
- Strength sets: present and exposed.
- Hangboard protocols: absent (`finger_loading_entry` has zero rows).

`get_finger_loading` defines effective load as bodyweight kilograms plus
external load kilograms. With no finger-loading rows, there is currently no
hangboard source to expose.

## 4–7. WHOOP, nutrition, streams, and provider sync

Sampled untyped WHOOP payloads contain no sport identifier. The existing sport
ID extraction and canonical mapping work when WHOOP supplies one. The merge
defect was a containment rule that required identical types; an untyped
contained session can now inherit its typed container while two differing known
types remain separate. Of 164 raw WHOOP `other` activities, 13 are recoverable
by containment; the 11 near-identical recoveries are a subset of those 13.
That leaves an expected raw residual of 151 after refresh.

FatSecret's last 30 scheduled jobs completed successfully in roughly 1–1.5
seconds and wrote zero rows. Full history contains 142 `dofek` entries
(2026-04-24 through 2026-08-25) and three FatSecret entries, all on 2026-03-10.
FatSecret last returned data on 2026-04-22. `dofek` is the app/manual source.
The resolver correctly sees only that available source for current dates;
observed statuses are `available` and `source_conflict`.

No provider supplies an authoritative “day complete” marker. Marking an intake
day partial solely because calories fall below a threshold would misclassify
fasting and would store a derived guess as raw truth. A `partial_log` indicator,
if desired, belongs in the read/quality layer unless a provider supplies a raw
completion signal.

`get_activity_streams` reads the deduplicated ClickHouse activity stream and
supports power, heart rate, cadence, altitude, speed, and position. It defaults
to 500 points and caps output at 2,000.

Provider health now includes exact `last_success`, `last_attempt`, `last_error`,
`consecutive_failures`, expected interval, and derived staleness. Scheduled
providers run every 30 minutes and become stale after 90 minutes. Sync metrics
already flow through OpenTelemetry; the second consecutive scheduled failure
is captured in Sentry, so a stopped provider surfaces at the next interval.
Amazfit stopped because its access token expired. `fit-file`,
`cronometer-csv`, and `zos-app` are user-triggered importers and are dormant by
design, not broken scheduled providers.

## 8. Wearable-history recovery

| Metric | First canonical date | Current sources | Earlier recovery |
| --- | --- | --- | --- |
| HRV | 2026-03-11 | WHOOP, Apple Health | WHOOP can be manually paged through account history; Apple requires an on-device full sync or valid archive. |
| Resting HR | 2026-03-11 | Derived from sleep-window heart-rate streams | Earlier activity HR exists, but the current read model intentionally requires sleep-window samples. |
| Sleep | 2026-03-11 | WHOOP, Apple Health, Amazfit | WHOOP/account history and a valid Apple full sync are recoverable; Polar exposes only recent/new data. |

Source ranges in canonical rows are WHOOP HRV 2026-03-11–09-01, Apple HRV
2026-04-19–09-01; WHOOP sleep 2026-03-11–09-01, Apple sleep
2026-04-23–09-01, and Amazfit sleep 2026-06-10–06-17. Historical heart-rate
streams do exist, including Garmin dump data from 2019-10-29 through
2022-05-17 and Wahoo data from 2020-05-21 onward.

Normal WHOOP sync looks back 30 days, while the provider's manual full-sync
path can request the full paginated collection. WHOOP documents pagination and
collection endpoints in its [developer API](https://developer.whoop.com/api/)
and [pagination guide](https://developer.whoop.com/docs/developing/pagination/).
The current Withings adapter can request historical measures but only ingests
the measures endpoint; it does not provide HRV or sleep. Polar says AccessLink
exposes new data rather than complete historical Flow data in its
[API overview](https://www.polar.com/accesslink-api/). Garmin's current adapter
uses Connect endpoints rather than the partner
[Garmin Health API](https://developer.garmin.com/gc-developer-program/health-api/).

The 55.9 MB Apple archive job created on 2026-08-04 did not import. Its queue
result was `No export.xml found in ZIP file`; the database row remained queued
because it used the legacy upload path. The object has passed the import-object
retention window. Apple's HealthKit sample API permits a local full-range query
through [`HKSampleQuery`](https://developer.apple.com/documentation/healthkit/hksamplequery),
and the mobile app already exposes that full-sync path. Recovery therefore
requires a user-triggered full sync or re-upload of an original archive that
contains `export.xml`.

## 9–14. Validation and remaining tools

The specified HRV source rows are positive or null; the specified sleep
efficiencies are null or 84.1. A read-only full audit found zero persisted
out-of-range rows for HRV, resting HR, sleep efficiency, weight, or body fat in
both canonical PostgreSQL data and the ClickHouse serving data. The sentinel
zeros are a read-path defect and must be fixed by the read-path owner.

`search_activities` was exercised inside the deployed web container against
the real PostgreSQL and ClickHouse clients. The same 2026 range returned 472
unfiltered activities and 89 `cycling` matches, with full hydration succeeding.
Deployed logs did not retain the original exception. The tool now has a query
regression test and reports future exceptions to Sentry without recording the
private query text.

Map previews are omitted from list search unless `include: ["mapPreview"]` is
requested; details remain unchanged. Supplements have a dedicated read tool.
Subjective logging now supports one-tap all-clear check-ins plus free-text
injury notes tagged with a body region on both clients.

BodySpec is already a registered PKCE/OIDC provider and stores DEXA scan and
regional measurements. Connecting it is an account authorization action, not
an ingest implementation task. The other listed providers likewise require
credentials, account access, and separate scope decisions before integration.

## Session-1 handoff

1. Do not final-validate local-day aggregation until the timezone migration is
   deployed, `America/Los_Angeles` is persisted as home timezone, and the
   announced backfill completes. Review the sleep/RHR UTC-6 heuristic and dbt
   `user_home_timezone` predicate.
2. Use the power coverage table above; outdoor Wahoo power is absent upstream.
3. Climbing grades/sends and strength sets are now exposed. Hangboard protocols
   are absent.
4. Expected post-refresh raw WHOOP `other` residual: 151.
5. `get_activity_streams` is available for power analytics.
6. Coverage starts: HRV, RHR, and sleep all 2026-03-11. Earlier WHOOP/Apple data
   requires a user-authorized full sync; Apple archive import failed.
7. Sentinel zeros are introduced at read time; the persisted out-of-range audit
   count is zero for every requested metric.

## Production actions still requiring authorization

1. Deploy the branch and migrations.
2. Persist the account home timezone as `America/Los_Angeles`.
3. Announce and run the single timezone dry-run/backfill pass, then report its
   exact updated-row count and re-audit >60-minute disagreements with travel
   records accounted for.
4. Refresh the activity read model to realize the WHOOP merge result.
5. Trigger authorized WHOOP history pagination and/or an Apple on-device full
   sync; announce any historical write immediately before it starts.
