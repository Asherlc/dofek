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
  {
    from: fitness.activity,
    to: activity
  },
  {
    from: fitness.sleep_session,
    to: sleep_session
  },
  {
    from: fitness.sleep_stage,
    to: sleep_stage
  },
  {
    from: fitness.daily_metrics,
    to: daily_metrics
  },
  {
    from: fitness.provider,
    to: provider
  },
  {
    from: fitness.provider_connection,
    to: provider_connection
  },
  {
    from: fitness.provider_priority,
    to: provider_priority
  },
  {
    from: fitness.device_priority,
    to: device_priority
  },
  {
    from: fitness.processing_flow_marker,
    to: processing_flow_marker
  },
  {
    from: fitness.user_profile,
    to: user_profile
  }
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
  {
    from: fitness.food_entry,
    to: food_entry
  },
  {
    from: fitness.health_event,
    to: health_event
  },
  {
    from: fitness.lab_panel,
    to: lab_panel
  },
  {
    from: fitness.lab_result,
    to: lab_result
  },
  {
    from: fitness.journal_entry,
    to: journal_entry
  },
  {
    from: fitness.processing_flow_marker,
    to: processing_flow_marker_provider_inventory
  }
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
  {
    from: fitness.sensor_provider_priority,
    to: sensor_provider_priority
  },
  {
    from: fitness.sensor_device_priority,
    to: sensor_device_priority
  }
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
