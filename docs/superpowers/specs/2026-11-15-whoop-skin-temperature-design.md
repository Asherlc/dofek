# Skin temperature on activities and Recovery

## Approved scope

The user requested skin temperature alongside heart rate on activities, and
reported it missing from Recovery. They approved using existing source
selection, chart components, units, and gap handling on web and mobile, with
the additional requirement to investigate missing data before changing empty
states. Stay on the existing `whoop-skin-temp-data-check` branch.

## Investigation

Read-only production checks on November 15 confirmed cloud temperatures through
that day, decoded BLE temperature samples through that day, and non-null
temperature values in the live `dailyMetrics.list` cache. The existing Firefox
session showed the Body temperature chart after its query completed. The web
[Recovery route](../../../packages/web/src/routes/training/recovery.tsx) does
not request or render temperature; the mobile
[Recovery screen](../../../packages/mobile/app/(tabs)/recovery.tsx) already has
a temperature card. Missing ingestion is not established. Detailed evidence
stays in local working notes rather than publishing private readings.

## Approach

Extend the existing activity metric contract, source discovery, and stream
query with a distinct `skinTemperature` metric backed by already-decoded
`skin_temperature` samples in `analytics.daily_health_sensor`. Use source
measurement time, preserve device identities, resolve duplicates at read time,
and bound reads to the authenticated activity window. Add a web activity-chart
series and mobile activity chart with their existing source controls. Cloud
daily recovery values must never be fabricated into activity observations.

Add a skin-temperature chart to web Recovery using the existing daily-metrics
API, date-range context, chart components, and unit conversion. Preserve the
existing mobile Recovery card and verify it with data and without data; do not
invent an ingestion fix or replace absent values with zero.

## Alternatives and constraints

A dedicated temperature endpoint would duplicate existing activity ownership,
source selection, and downsampling. Decoding raw WHOOP packets per activity
would duplicate the existing dbt decoder. Reuse the existing stream and decoded
model instead. No dependencies, schema migrations, new read models, native BLE
changes, deployment changes, or production mutations are needed.

## Acceptance

- Web and mobile activities display skin temperature when timestamped readings
  overlap the owned activity, including temperature-only points.
- Source selection distinguishes devices and preserves existing metric choices.
- Sample time, units, missing readings, sparse markers, and gaps remain truthful;
  generic ambient `temperature` is not relabeled as skin temperature.
- Web Recovery plots the existing daily values over its selected range with
  explicit loading, empty, and error states; mobile retains equivalent access.
- Real ClickHouse integration tests prove window/user isolation, source
  selection, duplicate handling, and downsampling of the new channel.
- Regression tests fail before implementation and pass after; relevant unit and
  mobile tests, lint, and all-package typechecks pass before push.
