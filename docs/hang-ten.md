# Hang Ten Apple Health Import

Hang Ten is integrated through Apple Health exports rather than a direct cloud
API. The Hang Ten app writes completed workouts to HealthKit as functional
strength training and adds workout metadata with `HKMetadataKeyWorkoutBrandName`
plus `HangTen.*` keys for the plan, session, board, and serialized activity
segments. The implementation source is
[`HealthKitService.swift`](https://github.com/Asherlc/hang-ten/blob/30ec9e8188b33048c948c745449ad67918206b88/HangTen/Models/HealthKitService.swift);
Apple documents the HealthKit workout type and brand metadata key as
[`HKWorkoutActivityType.functionalStrengthTraining`](https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/functionalstrengthtraining)
and
[`HKMetadataKeyWorkoutBrandName`](https://developer.apple.com/documentation/healthkit/hkmetadatakeyworkoutbrandname).

Dofek keeps `provider_id = apple_health` for these rows. It recognizes Hang Ten
only when an Apple Health workout export has the functional strength workout
type, a Hang Ten workout brand, and a non-empty `HangTen.PlanName`. Recognized
workouts are stored as canonical `hangboard` activities with the Hang Ten
metadata retained in `activity.raw.hangTen`.

The current metadata keys consumed by Dofek are:

- `HKMetadataKeyWorkoutBrandName`
- `HangTen.PlanName`
- `HangTen.SessionID`
- `HangTen.BoardID`
- `HangTen.BoardName`
- `HangTen.ActivitySegments`

`HangTen.ActivitySegments` is JSON shaped like `{ "version": 1, "segments": [...] }`.
The segment schema comes from Hang Ten's `WorkoutActivityMetadata` and
`RecordedActivitySegment` types in
[`WorkoutActivityRecording.swift`](https://github.com/Asherlc/hang-ten/blob/30ec9e8188b33048c948c745449ad67918206b88/HangTen/Models/WorkoutActivityRecording.swift).
Malformed segment JSON is reported as a non-fatal import error while the
workout row is still imported for provenance.
