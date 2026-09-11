ALTER TABLE fitness.activity_interval
ADD COLUMN source_kind text,
ADD COLUMN source_provider text,
ADD COLUMN source_activity_id uuid,
ADD COLUMN segment_type text,
ADD COLUMN target_intensity real,
ADD COLUMN target_zone bigint,
ADD COLUMN target_cadence_rpm real,
ADD COLUMN target_power_watts real,
ADD COLUMN target_resistance real,
ADD COLUMN work_recovery_kind text,
ADD COLUMN raw jsonb;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_source_provider_provider_id_fk
FOREIGN KEY (source_provider) REFERENCES fitness.provider (id) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_source_activity_id_activity_id_fk
FOREIGN KEY (source_activity_id) REFERENCES fitness.activity (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_source_kind
CHECK (source_kind IS NULL OR source_kind IN ('provider_recorded', 'inferred')) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_inferred_targets
CHECK (
  source_kind IS DISTINCT FROM 'inferred' OR (
    target_intensity IS NULL
    AND target_zone IS NULL
    AND target_cadence_rpm IS NULL
    AND target_power_watts IS NULL
    AND target_resistance IS NULL
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_work_recovery_kind
CHECK (work_recovery_kind IS NULL OR work_recovery_kind IN ('work', 'recovery')) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_source_provider_provider_id_fk;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_source_activity_id_activity_id_fk;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_source_kind;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_inferred_targets;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_work_recovery_kind;
