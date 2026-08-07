# Hang Ten Apple Health Import Enrichment Design

## Goal

Import Hang Ten completed hangboard sessions through Dofek's existing Apple
Health export flow without adding a separate direct Hang Ten sync provider.
Hang Ten already saves completed routines as Apple Health functional strength
workouts with app-specific metadata. Dofek should preserve that metadata,
surface the workout with a readable Hang Ten name, classify it as
`hangboarding`, and expose the ordered work/rest segments as activity
intervals.

## Current State

Dofek's Apple Health importer streams `Workout`, `WorkoutStatistics`, routes,
records, sleep, and category data from `export.xml`. Workout parsing currently
keeps the canonical activity type, source name, duration, distance, calories,
heart-rate summary, start date, end date, and route points. Nested workout
metadata entries are ignored.

Hang Ten saves completed sessions with:

- `HKMetadataKeyWorkoutBrandName = "Hang Ten"`
- `HangTen.PlanName`
- `HangTen.SessionID`
- `HangTen.BoardID`
- `HangTen.BoardName`
- `HangTen.ActivitySegments`

`HangTen.ActivitySegments` is a stable JSON string containing a version and an
ordered list of recorded work/rest segments. Each segment includes step ID,
step number, segment kind, resolved hold IDs, optional hold type, optional hold
size in millimeters, and optional duration.

## Approach

Extend the Apple Health import path rather than creating a new provider ID for
this first version. Imported rows keep `provider_id = apple_health`; Hang Ten is
represented as the activity source and preserved raw metadata. Add
`hangboarding` as a first-class canonical activity type in the shared training
package and the database enum so Hang Ten sessions are not flattened into
generic functional strength training.

The XML streaming parser will collect nested `MetadataEntry` elements while a
`Workout` is open. On workout close, it will attach the metadata map to the
`HealthWorkout` object before the workout batch is flushed.

Workout parsing will recognize Hang Ten when all of these are true:

- the Apple Health workout activity type maps to `functional_strength`;
- `HKMetadataKeyWorkoutBrandName` is `Hang Ten`;
- `HangTen.PlanName` is present after trimming whitespace.

Recognized Hang Ten workouts will use:

- `name = HangTen.PlanName`
- `sourceName = Hang Ten`
- `externalId = ah:workout:<HangTen.SessionID>` when a session ID exists,
  otherwise the existing start-date-based Apple Health external ID
- `activityType = hangboarding`

The raw activity payload will include the existing workout summary fields plus
the Hang Ten metadata: session ID, plan name, board ID, board name, and parsed
activity segments. If segment JSON cannot be parsed, the importer should keep
the raw metadata string in `activity.raw`, add a sync error for that workout,
and still import the workout row.

## Activity Intervals

For Hang Ten workouts with parsed segments, insert one `activity_interval` row
per segment. Existing intervals for the activity should be replaced on reimport
so the interval set remains idempotent.

Intervals use the segment order as `interval_index`. Labels should be
layman-readable:

- rest segments: `Step <stepNumber>: Rest`
- work segments with size and type: `Step <stepNumber>: <size> mm <hold type>`
- work segments with only hold type: `Step <stepNumber>: <hold type>`
- work segments without a descriptor: `Step <stepNumber>: Work`

When all preceding segments have durations, `started_at` and `ended_at` are
derived from the workout start time and cumulative duration. If a segment has
no duration, set `started_at` to the best known cumulative time and leave
`ended_at` null; later segments continue from the last known cumulative time
only when their offsets are unambiguous.

Use `interval_type = "work"` or `"rest"` from the segment kind.

## Error Handling

Malformed Hang Ten segment JSON is an import-quality issue for that workout,
not a reason to drop the workout entirely. The importer should report a
specific sync error that includes the workout external ID and continue. Missing
optional Hang Ten metadata should simply leave those raw fields absent.

The parser should continue to fail loudly for invalid Apple Health export XML
or database write failures, matching the existing import behavior.

## Testing

Add unit coverage for:

- parsing workout metadata entries inside a workout;
- detecting Hang Ten workouts from metadata;
- preserving raw Hang Ten metadata and parsed segments;
- handling malformed segment JSON without dropping the workout;
- deriving interval labels and times from ordered segments.

Add integration coverage using a minimal Apple Health export fixture containing
a functional strength workout with Hang Ten metadata. Verify that import
creates one activity row, stores raw Hang Ten details, and inserts the expected
activity intervals.

## Out Of Scope

This design does not add a direct Hang Ten API, cloud account sync, or a
separate Hang Ten file-import provider. It also does not add new database
columns for hangboard-specific fields; raw Hang Ten source data stays in the
existing JSON payload unless a later UI or analytics feature proves that a
first-class schema change is needed.
