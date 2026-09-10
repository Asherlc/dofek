CREATE TABLE fitness.activity_integrity_repair_journal (
  run_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  artifact_path text NOT NULL,
  artifact_checksum text NOT NULL,
  acceptance_owner text NOT NULL,
  acceptance_deadline timestamptz NOT NULL,
  phase text NOT NULL,
  accepted_by text,
  retirement_disposition text,
  retired_at timestamptz,
  retirement_receipt_path text,
  retirement_receipt_checksum text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT activity_integrity_repair_journal_artifact_path_key UNIQUE (artifact_path),
  CONSTRAINT activity_integrity_repair_journal_checksum_valid
  CHECK (artifact_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT activity_integrity_repair_journal_phase_valid
  CHECK (phase IN (
    'postgres_committed',
    'rebuild_failed',
    'executed',
    'rollback_committed',
    'rolled_back',
    'retired'
  )),
  CONSTRAINT activity_integrity_repair_journal_disposition_valid
  CHECK (retirement_disposition IS NULL OR retirement_disposition IN ('accepted', 'superseded')),
  CONSTRAINT activity_integrity_repair_journal_receipt_checksum_valid
  CHECK (retirement_receipt_checksum IS NULL OR retirement_receipt_checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT activity_integrity_repair_journal_retirement_complete
  CHECK (
    (phase = 'retired') = (
      accepted_by IS NOT NULL
      AND retirement_disposition IS NOT NULL
      AND retired_at IS NOT NULL
      AND retirement_receipt_path IS NOT NULL
      AND retirement_receipt_checksum IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX activity_integrity_repair_journal_single_eligible_idx
ON fitness.activity_integrity_repair_journal ((TRUE))
WHERE phase IN ('postgres_committed', 'rebuild_failed', 'executed', 'rollback_committed');
