# Hangboarding Import and Training UI Design

## Goal

Surface Hang Ten workouts imported through Apple Health as first-class
Hangboarding activities, with their plan/board metadata and ordered work/rest
segments visible on activity details and aggregate metrics visible on the
climbing training page.

## Existing implementation to reuse

The finalized Apple Health importer already exists on the local
`codex/hang-ten-apple-health-import` ref. Its implementation:

- recognizes functional-strength workouts branded `Hang Ten` with a plan name;
- preserves Hang Ten metadata and parsed activity segments in `activity.raw`;
- classifies recognized workouts as the canonical `hangboard` activity type;
- stores ordered segments as `activity_interval` rows and replaces them
  idempotently on reimport; and
- keeps malformed segment JSON non-fatal while retaining the workout row.

The current branch does not contain those changes. The implementation will
port the finalized importer changes and reconcile them with the current
migration journal instead of blindly reusing the historical migration number.

Hang Ten's Apple Health contract is based on functional-strength workouts,
the workout brand metadata key, and serialized app metadata. The relevant
HealthKit definitions are documented by Apple for
[`HKWorkoutActivityType.functionalStrengthTraining`](https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/functionalstrengthtraining)
and [`HKMetadataKeyWorkoutBrandName`](https://developer.apple.com/documentation/healthkit/hkmetadatakeyworkoutbrandname).

## Data flow

```text
Apple Health export.xml
  -> streaming Workout + MetadataEntry parser
  -> typed Hang Ten metadata and segments
  -> activity(canonical_type = hangboard, name = plan name)
  -> activity_interval rows for work/rest segments
  -> server activity detail and climbing summary queries
  -> web + mobile rendering
```

The importer remains Apple Health-backed (`provider_id = apple_health`). No
direct Hang Ten provider or duplicate Hang Ten tables are added. Raw metadata
remains the provenance source; intervals are the serving representation for
ordered work/rest timing.

## Activity detail behavior

Hang Ten activities display the user-facing type label **Hangboarding** while
retaining the internal canonical value `hangboard`. The activity name uses the
Hang Ten plan name when present. Existing activity header metrics continue to
show duration, heart-rate metrics, and source information when available.

The detail page adds a Hangboarding section when intervals or Hang Ten raw
metadata are present. It shows:

- plan name;
- board name and board identifier when available;
- session identifier when available;
- ordered work/rest intervals;
- interval labels such as `Step 1: 19 mm edge` or `Step 1: Rest`;
- work/rest duration and timestamps when the imported segment durations make
  them unambiguous; and
- an actionable server error when interval data cannot load.

Web and mobile use the existing activity-detail and interval APIs. No client
calculates interval timestamps, durations, or aggregate values.

## Climbing page behavior

Add a Hangboarding section to the web climbing page and the mobile climbing
section. The server computes the selected date-range summary from canonical
`hangboard` activities and their imported intervals. The response contains:

- session count;
- total hangboarding duration;
- average session duration;
- total work duration and total rest duration when interval durations are
  available;
- work-interval count;
- average recorded heart rate and highest recorded heart rate when present;
- most recent plan and board metadata; and
- a daily trend of session count, total duration, work duration, and rest
  duration.

Missing interval or heart-rate data remains explicitly nullable and does not
become zero. Calories, estimated expenditure, and inferred hang loads are not
ingested or displayed.

The web page renders summary metric cards and a compact trend visualization.
The mobile page renders the same server-provided metrics in the existing
Climbing card with an empty state when no Hangboarding data exists. Both
surfaces link each listed session to its activity detail page.

## Server contracts and boundaries

- Add repository methods for Hangboarding detail and date-range summaries;
  routers remain thin and validate every response with Zod.
- Reuse `activity_interval` for imported segments rather than adding a
  Hangboarding-specific interval table.
- Keep all aggregation and timestamp derivation on the server.
- Use the selected training range and the user's timezone for date grouping.
- Preserve cached data during background refetches and show server error
  messages through the existing query-state patterns.
- Register `hangboard` in shared activity labels/icons and in the database
  canonical activity enum through a forward-only migration using the current
  journal's next available migration number.

## Testing

Test-first coverage will include:

- existing importer behavior from the finalized historical implementation,
  ported to the current branch;
- real-database interval replacement and Hang Ten activity insertion;
- repository summary calculations with missing interval and heart-rate values;
- router response validation and actionable errors;
- web activity-detail Hangboarding metadata and interval rendering;
- web climbing-page Hangboarding summary and trend rendering; and
- mobile activity-detail and climbing-section parity, including empty/error
  states.

Database-dependent behavior will use executable integration tests against the
real database. Unit tests will cover pure parsing, formatting, and rendering
behavior without external services.

## Scope boundaries

This change does not add a direct Hang Ten API, infer individual hangs from
heart-rate data, store duplicate Hang Ten-specific columns, or change generic
strength workouts that lack the required Hang Ten metadata. Historical Apple
Health workouts become enriched when reimported through the existing import
flow; no request-time backfill is added.
