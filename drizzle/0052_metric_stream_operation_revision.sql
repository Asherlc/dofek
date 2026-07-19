CREATE SEQUENCE fitness.metric_ingest_operation_revision_seq
AS bigint
-- Existing ClickHouse tombstones use Unix-millisecond versions. Reserve a
-- higher namespace so the first revisioned event wins over every legacy row.
START WITH 1000000000000000;
