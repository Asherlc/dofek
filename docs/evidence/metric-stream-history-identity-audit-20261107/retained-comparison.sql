-- Frozen read-only comparison executed once on 2026-11-08 UTC.
-- Query ID: history-unread-identity-comparison-20261107-once
-- This evidence file is not permission to rerun.
-- PRECONDITION: complete source coverage and exactly one distinct immutable
-- tuple per incoming ID were independently verified locally.
-- Under that precondition, a retained tuple outside the incoming tuple set
-- is exactly an identity conflict for that ID. No incoming-wide GROUP BY needed.
SELECT
    count() AS retained_versions,
    countIf(NOT matches_incoming_identity) AS conflicting_retained_versions,
    uniqExactIf(id, NOT matches_incoming_identity) AS conflicting_ids
FROM
(
    SELECT
        id,
        (id, user_id, provider_id, recorded_at) IN
        (
            SELECT id, user_id, provider_id, recorded_at
            FROM incoming_identity
        ) AS matches_incoming_identity
    FROM ingest.metric_stream
    WHERE id IN (SELECT id FROM incoming_identity)
)
SETTINGS
    max_threads = 1,
    max_memory_usage = 1073741824,
    max_execution_time = 120,
    max_rows_to_read = 210000000,
    max_bytes_to_read = 12884901888,
    read_overflow_mode = 'throw',
    timeout_overflow_mode = 'throw'
FORMAT JSONEachRow;
