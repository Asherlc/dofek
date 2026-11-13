# HealthKit running measurement ingestion

The running chart investigation found no cadence or optional running dynamics in
five current production summaries. The user authorized fixing the proposed
HealthKit ingestion gap. This spec covers the independently useful raw running
measurement path; the user subsequently chose raw step intervals, specified in
[the cadence extension](2026-10-28-running-step-cadence.md).

## Required behavior

Native sync and Apple Health XML import must ingest running speed, running power,
running stride length, running ground-contact time, and running vertical
oscillation into the existing metric stream. Canonical units/channels are:

| HealthKit suffix | Channel | Unit |
| --- | --- | --- |
| RunningSpeed | speed | m/s |
| RunningPower | power | W |
| RunningStrideLength | stride_length | m |
| RunningGroundContactTime | ground_contact_time | ms |
| RunningVerticalOscillation | vertical_oscillation | mm |

Apple defines these [running quantity identifiers](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier).
Normalize reported units at server ingestion for both sources, accepting the
usual compatible length/time/speed/power units and rejecting incompatible units
with an actionable error. Preserve recording-source attribution and existing
stream generation, replacement, deletion, and erasure behavior. Do not add a
second canonical storage location or synthetic cadence samples.

Native read authorization, observers, initial/full sync, anchored updates, and
parent UUID deletions must cover the added quantities. For condensed running
samples, query individual quantities with original timestamps and the parent
UUID rather than averaging series averages. Apple documents [condensed workout
samples](https://developer.apple.com/documentation/healthkit/accessing-condensed-workout-samples)
and the [quantity property's aggregation](https://developer.apple.com/documentation/healthkit/hkquantitysample/quantity).
Keep fractional timestamps so series points do not overwrite each other. Errors
must propagate through the existing Sentry reporting boundary; no partial anchor
acknowledgment after extraction or upload failure.

## Constraints

- Keep raw data in the existing Redpanda/R2/ClickHouse path; no derived Postgres fields.
- Compute metrics on the server; native code only reads/converts/transports observations.
- No new dependencies, environment variables, branches, or production mutations.
- Test behavior before implementation; use real database tests for database semantics.
- Preserve web/mobile parity through the shared serving API; do not change chart APIs in this ingestion stage.
- Do not consume calorie expenditure estimates.

## Validation and release boundary

Prove API/XML routing and unit conversion, parent UUID deletion, native quantity
series extraction and error propagation, and TS sync inclusion with focused
regressions. Run package typechecks and the unit/mobile suite plus the affected
native suite. A native release, HealthKit authorization, and historical sync are
required to retrieve measurements previously omitted; code-only checks cannot
prove measurements exist on the user's watch.
