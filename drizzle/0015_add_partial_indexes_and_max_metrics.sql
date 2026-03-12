-- No-op: indexes and materialized views will be created by a background
-- task at app startup to avoid OOM on memory-constrained servers.
SELECT 1;
