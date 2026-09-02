CREATE TABLE IF NOT EXISTS fitness.personal_experiment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  hypothesis text NOT NULL,
  intervention text NOT NULL,
  outcome_metric_id text NOT NULL,
  lag_days bigint NOT NULL DEFAULT 0,
  baseline_days bigint NOT NULL,
  intervention_days bigint NOT NULL,
  start_date date NOT NULL,
  status text NOT NULL DEFAULT 'active',
  stopped_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_experiment_hypothesis_nonempty CHECK (btrim(hypothesis) <> ''),
  CONSTRAINT personal_experiment_intervention_nonempty CHECK (btrim(intervention) <> ''),
  CONSTRAINT personal_experiment_outcome_metric_nonempty CHECK (btrim(outcome_metric_id) <> ''),
  CONSTRAINT personal_experiment_lag_days_range CHECK (lag_days BETWEEN 0 AND 7),
  CONSTRAINT personal_experiment_baseline_days_positive CHECK (baseline_days > 0),
  CONSTRAINT personal_experiment_intervention_days_positive CHECK (intervention_days > 0),
  CONSTRAINT personal_experiment_status_valid CHECK (status IN ('active', 'stopped')),
  CONSTRAINT personal_experiment_stopped_at_consistent CHECK (
    (status = 'active' AND stopped_at IS NULL)
    OR (status = 'stopped' AND stopped_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS personal_experiment_user_created_idx -- noqa: PG01
ON fitness.personal_experiment (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS personal_experiment_user_status_idx -- noqa: PG01
ON fitness.personal_experiment (user_id, status);
