CREATE PEER IF NOT EXISTS dofek_postgres FROM POSTGRES WITH
(
  host = {{POSTGRES_HOST}},
  port = {{POSTGRES_PORT}},
  user = {{POSTGRES_USER}},
  password = {{POSTGRES_CREDENTIAL}},
  database = {{POSTGRES_DATABASE}}
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

CREATE MIRROR IF NOT EXISTS dofek_fitness_raw_analytics
FROM dofek_postgres TO dofek_clickhouse_postgres_fitness
WITH TABLE MAPPING
(
{{FITNESS_RAW_ANALYTICS_TABLE_MAPPINGS}}
)
WITH (
  do_initial_copy = {{FITNESS_RAW_ANALYTICS_DO_INITIAL_COPY}},
  max_batch_size = 100000,
  sync_interval = 60,
  publication_name = 'peerdb_raw_analytics_publication',
  snapshot_num_rows_per_partition = 100000,
  snapshot_max_parallel_workers = 1,
  snapshot_num_tables_in_parallel = 1,
  soft_delete = true
);

CREATE MIRROR IF NOT EXISTS dofek_provider_inventory_raw_analytics
FROM dofek_postgres TO dofek_clickhouse_postgres_fitness
WITH TABLE MAPPING
(
{{PROVIDER_INVENTORY_RAW_ANALYTICS_TABLE_MAPPINGS}}
)
WITH (
  do_initial_copy = {{PROVIDER_INVENTORY_RAW_ANALYTICS_DO_INITIAL_COPY}},
  max_batch_size = 100000,
  sync_interval = 60,
  publication_name = 'peerdb_raw_analytics_publication',
  snapshot_num_rows_per_partition = 100000,
  snapshot_max_parallel_workers = 1,
  snapshot_num_tables_in_parallel = 1,
  soft_delete = true
);

CREATE MIRROR IF NOT EXISTS dofek_sensor_priority_raw_analytics
FROM dofek_postgres TO dofek_clickhouse_postgres_fitness
WITH TABLE MAPPING
(
{{SENSOR_PRIORITY_RAW_ANALYTICS_TABLE_MAPPINGS}}
)
WITH (
  do_initial_copy = {{SENSOR_PRIORITY_RAW_ANALYTICS_DO_INITIAL_COPY}},
  max_batch_size = 100000,
  sync_interval = 60,
  publication_name = 'peerdb_raw_analytics_publication',
  snapshot_num_rows_per_partition = 100000,
  snapshot_max_parallel_workers = 1,
  snapshot_num_tables_in_parallel = 1,
  soft_delete = true
);
