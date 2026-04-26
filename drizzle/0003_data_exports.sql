CREATE TABLE IF NOT EXISTS fitness.data_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile(id) ON DELETE CASCADE,
  status text NOT NULL,
  object_key text,
  filename text NOT NULL,
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  error_message text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS data_export_user_created_idx
  ON fitness.data_export (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS data_export_user_status_idx
  ON fitness.data_export (user_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS data_export_expires_idx
  ON fitness.data_export (expires_at);
