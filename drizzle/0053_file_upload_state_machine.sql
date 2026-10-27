CREATE TABLE fitness.file_upload (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  import_type text NOT NULL,
  object_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  content_type text NOT NULL,
  expected_size_bytes bigint NOT NULL,
  expected_sha256 text NOT NULL,
  verified_sha256 text,
  r2_multipart_upload_id text,
  state text NOT NULL DEFAULT 'initiated',
  version bigint NOT NULL DEFAULT 0,
  part_size_bytes bigint NOT NULL,
  completion_parts jsonb,
  import_job_id text UNIQUE,
  import_since timestamptz NOT NULL,
  weight_unit text,
  progress_percent bigint NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  object_deleted_at timestamptz,
  CONSTRAINT file_upload_import_type_valid CHECK (
    import_type IN (
      'apple-health', 'strong-csv', 'cronometer-csv', 'kaya-export',
      'zos-app', 'garmin-dump', 'fit-file'
    )
  ),
  CONSTRAINT file_upload_state_valid CHECK (
    state IN (
      'initiated', 'uploading', 'uploaded', 'queued', 'processing',
      'completed', 'failed', 'aborted', 'expired'
    )
  ),
  CONSTRAINT file_upload_expected_size_positive CHECK (expected_size_bytes > 0),
  CONSTRAINT file_upload_expected_sha256_valid CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_upload_verified_sha256_valid CHECK (
    verified_sha256 IS NULL OR verified_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT file_upload_part_size_valid CHECK (part_size_bytes >= 5242880),
  CONSTRAINT file_upload_progress_valid CHECK (progress_percent BETWEEN 0 AND 100),
  CONSTRAINT file_upload_weight_unit_valid CHECK (weight_unit IS NULL OR weight_unit IN ('kg', 'lbs'))
);
--> statement-breakpoint

CREATE INDEX file_upload_owner_updated_idx
ON fitness.file_upload (user_id, updated_at DESC);
--> statement-breakpoint

CREATE INDEX file_upload_reconcile_idx
ON fitness.file_upload (state, expires_at, updated_at);
--> statement-breakpoint

CREATE TABLE fitness.file_upload_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL UNIQUE REFERENCES fitness.file_upload (id) ON DELETE CASCADE,
  import_job_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  failed_at timestamptz,
  CONSTRAINT file_upload_outbox_status_valid
  CHECK (status IN ('pending', 'dispatched', 'completed', 'failed'))
);
--> statement-breakpoint

CREATE INDEX file_upload_outbox_dispatch_idx
ON fitness.file_upload_outbox (status, created_at);
