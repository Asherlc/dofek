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
  do_initial_copy = true,
  max_batch_size = 1000000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_publication',
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
  do_initial_copy = true,
  max_batch_size = 1000000,
  sync_interval = 60,
  publication_name = 'peerdb_metric_stream_publication',
  soft_delete = true
);
