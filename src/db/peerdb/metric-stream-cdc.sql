CREATE PEER IF NOT EXISTS dofek_postgres FROM POSTGRES WITH
(
  host = {{POSTGRES_HOST}},
  port = {{POSTGRES_PORT}},
  user = {{POSTGRES_USER}},
  password = {{POSTGRES_CREDENTIAL}},
  database = {{POSTGRES_DATABASE}}
);

CREATE PEER IF NOT EXISTS dofek_clickhouse FROM CLICKHOUSE WITH
(
  host = {{CLICKHOUSE_HOST}},
  port = {{CLICKHOUSE_PORT}},
  user = {{CLICKHOUSE_USER}},
  password = {{CLICKHOUSE_CREDENTIAL}},
  database = {{CLICKHOUSE_DATABASE}},
  disable_tls = true
);

CREATE PEER IF NOT EXISTS dofek_clickhouse_postgres_fitness FROM CLICKHOUSE WITH
(
  host = {{CLICKHOUSE_HOST}},
  port = {{CLICKHOUSE_PORT}},
  user = {{CLICKHOUSE_USER}},
  password = {{CLICKHOUSE_CREDENTIAL}},
  database = 'postgres_fitness',
  disable_tls = true
);

-- validation and analytics mirrors keep only scalar fields needed by ClickHouse models.
-- device_id, source_type, and vector are not queried by analytics transforms and
-- are excluded to reduce replicated payload size.
CREATE MIRROR IF NOT EXISTS dofek_metric_stream_cdc
FROM dofek_postgres TO dofek_clickhouse
WITH TABLE MAPPING
(
  {
    from: fitness.metric_stream,
    to: metric_stream,
    exclude: [device_id, source_type, vector]
  }
)
WITH (
  do_initial_copy = true,
  max_batch_size = 1000000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_publication',
  soft_delete = true
);

CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics
FROM dofek_postgres TO dofek_clickhouse_postgres_fitness
WITH TABLE MAPPING
(
  {
    from: fitness.metric_stream,
    to: metric_stream,
    exclude: [device_id, source_type, vector]
  }
)
WITH (
  do_initial_copy = false,
  max_batch_size = 1000000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_publication',
  soft_delete = true
);
