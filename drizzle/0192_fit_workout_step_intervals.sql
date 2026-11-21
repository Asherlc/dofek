ALTER TABLE fitness.activity_interval
ADD COLUMN fit_source text,
ADD COLUMN planned_duration_seconds double precision,
ADD COLUMN recorded_timer_duration_seconds double precision,
ADD COLUMN target_power_min_watts real,
ADD COLUMN target_power_max_watts real;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_fit_source
CHECK (fit_source IS NULL OR fit_source = 'workout_step_lap') NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
ADD CONSTRAINT activity_interval_fit_plan
CHECK (
  (
    fit_source IS NULL
    AND planned_duration_seconds IS NULL
    AND recorded_timer_duration_seconds IS NULL
    AND target_power_min_watts IS NULL
    AND target_power_max_watts IS NULL
  ) OR (
    fit_source IS NOT NULL AND fit_source = 'workout_step_lap'
    AND source_kind IS NOT NULL AND source_kind = 'provider_recorded'
    AND ended_at IS NOT NULL AND ended_at > started_at
    AND planned_duration_seconds IS NOT NULL AND planned_duration_seconds > 0
    AND (recorded_timer_duration_seconds IS NULL OR recorded_timer_duration_seconds >= 0)
    AND ((target_power_min_watts IS NULL) = (target_power_max_watts IS NULL))
    AND (target_power_min_watts IS NULL OR (
      target_power_min_watts < target_power_max_watts
      AND target_power_watts IS NULL
    ))
    AND (target_power_min_watts IS NOT NULL OR target_power_watts IS NOT NULL)
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_fit_source;
--> statement-breakpoint
ALTER TABLE fitness.activity_interval
VALIDATE CONSTRAINT activity_interval_fit_plan;
