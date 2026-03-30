CREATE TABLE IF NOT EXISTS fitness.training_export_watermark (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  last_exported_at timestamptz NOT NULL,
  row_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (table_name)
);
