# Manual cycling FTP cutover

The [approved design](superpowers/specs/2026-11-15-manual-cycling-ftp-design.md)
replaces ongoing estimated FTP with a user-entered, effective-dated setting.
Normalized power remains a server-owned observation. Manual FTP determines zones,
intensity factor and power training stress; Critical Power remains separate.

## Settings and estimation assistance

[Migration 0189](../drizzle/0189_restore_manual_cycling_ftp.sql) restores nullable,
positive whole-watt FTP on `fitness.sport_settings`, without populating it from
estimates or restoring profile FTP. Rows remain full snapshots: partial saves
preserve omitted fields; a new date inherits omitted values from its predecessor.
Clearing records null. Deleting a whole snapshot intentionally exposes its
predecessor. Editing an earlier snapshot does not rewrite later snapshots.

Settings can request estimates explicitly over selected date bounds, initially
90 days through the chosen effective date. The retained reference-family method
and 95% of best 20-minute power return evidence and limitations. The latter
follows [TrainingPeaks guidance](https://help.trainingpeaks.com/hc/en-us/articles/204071934-How-to-Calculate-Threshold-Values-for-Power-Heart-Rate-or-Pace).
Ordinary rides do not establish maximal effort; easy-only riding can underestimate
FTP. Reference-family results are not exact Intervals.icu outputs or individually
validated thresholds. The [historical research](cycling-power-algorithms-research.md)
records the method's provenance and limitations.

Running estimates changes no setting. Choosing an option fills the editable
input; only Save applies it. Activity links carry their local date into settings,
so applying a value to a historical ride is an explicit decision.

## Coordinated release boundary

Release matching server, worker, web and mobile contracts together using the
[existing maintenance procedure](../deploy/README.md#deployment). The forward
[ClickHouse migration 0114](../src/db/clickhouse-migrations/0114_normalized_power_projection.ts)
replaces the power serving view with existing normalized-power
observations and activity metadata, then removes obsolete estimated-threshold
history storage/views. Preserve raw sensor and activity data; this cutover needs
no full sensor backfill.

Old mobile clients expect computed-eFTP contracts. Ship the matching mobile
update and persisted-cache contract change before ending the coordinated cutover;
do not fabricate legacy estimates or maintain a second threshold source.
MCP clients must refresh their tool catalog and output schemas: ongoing estimate
and estimated-threshold-history tools are removed, and cycling metrics identify
the applicable configured FTP. The settings estimation action is a separate,
explicit request and does not restore the old maintained estimate contract.
Production deployment is separate from implementation and local validation.

## Calculation and validation

Select the snapshot using the canonical activity's source-resolved local date,
falling back to the user's timezone only when source context is absent. Chart
grouping timezone must not change FTP. Resolve settings in bulk.

Intensity factor is NP/FTP; power training stress is
`(NP/FTP)^2 * elapsed_seconds / 36`, following the
[TrainingPeaks definition](https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/).
Missing FTP or incomplete power coverage produces unavailable metrics, never
zero stress. Recorded zero watts remains valid. Unsupported rides must not
silently disappear from load totals.

Retain bounded normalized-power projection, source invalidation, completed-activity
eligibility and erasure insert fences. Remove per-user FTP-history reconstruction.
Deletion/recomputation still awaits the same serialized analytics writer.

Validate both database migrations, focused real-engine regressions, lint,
workspace typechecks and affected unit/mobile tests. Cover dated saves, lower
values, clears, deletion, future exclusion, concurrent partial updates,
near-midnight source dates, zero watts and incomplete coverage. Check activity,
calendar, cycling, comparisons, load and MCP consistency. Settings changes must
affect reads without rebuilding analytics. Estimate invocation/selection must not
save anything. Review missing, entered, loading and error states on both clients.
