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

-- The analytics CDC mirror uses a dedicated publication with a row filter
-- that drops imu channel events at the source. IMU samples (~100Hz × 6
-- axes per device) make up >90% of metric_stream write volume and are not
-- consumed by analytics. Routing them through PeerDB to MinIO staging to
-- ClickHouse fills disk and gets the slot stuck (2026-05-10 incident).
-- The publication itself is bootstrapped on the source postgres by
-- ensureMetricStreamNoImuPublication in clickhouse-cdc.ts since that
-- file owns all publication DDL (publications live on postgres, not
-- on PeerDB). Avoid apostrophes and semicolons in this comment — the
-- naive splitter in clickhouse-cdc.ts does not strip line comments.
CREATE MIRROR IF NOT EXISTS dofek_metric_stream_analytics
FROM dofek_postgres TO dofek_clickhouse_postgres_fitness
WITH TABLE MAPPING
(
  {
    from: fitness.metric_stream,
    to: metric_stream,
    exclude: [device_id, source_type, vector, point, metadata]
  }
)
WITH (
  do_initial_copy = false,
  max_batch_size = 100000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_no_imu',
  soft_delete = true
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
    from: fitness.provider_priority,
    to: provider_priority
  },
  {
    from: fitness.device_priority,
    to: device_priority
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
  publication_name = 'peerdb_metric_stream_publication',
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
  }
)
WITH (
  do_initial_copy = {{PROVIDER_INVENTORY_RAW_ANALYTICS_DO_INITIAL_COPY}},
  max_batch_size = 100000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_publication',
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
  publication_name = 'peerdb_metric_stream_publication',
  snapshot_num_rows_per_partition = 100000,
  snapshot_max_parallel_workers = 1,
  snapshot_num_tables_in_parallel = 1,
  soft_delete = true
);
