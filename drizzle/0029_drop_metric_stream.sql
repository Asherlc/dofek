-- Drop the retired Postgres metric stream hypertable. Historical rows have
-- been archived to R2 and the serving copy is Redpanda-fed ClickHouse; no
-- production reader or writer uses fitness.metric_stream anymore.
DROP TABLE IF EXISTS fitness.metric_stream CASCADE;
