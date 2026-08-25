CREATE TABLE fitness.breathwork_session (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL CONSTRAINT breathwork_session_user_id_fkey
  REFERENCES fitness.user_profile (id),
  technique_id text NOT NULL,
  -- Preserve the historical type required for a data-only restore of retained records.
  -- squawk-ignore prefer-bigint-over-int
  rounds integer NOT NULL,
  -- Preserve the historical type required for a data-only restore of retained records.
  -- squawk-ignore prefer-bigint-over-int
  duration_seconds integer NOT NULL,
  started_at timestamptz NOT NULL,
  notes text,
  stress_before bigint,
  stress_after bigint,
  dizziness_after boolean,
  perceived_effect text,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT breathwork_session_stress_before_range
  CHECK (stress_before IS NULL OR stress_before BETWEEN 0 AND 10),
  CONSTRAINT breathwork_session_stress_after_range
  CHECK (stress_after IS NULL OR stress_after BETWEEN 0 AND 10),
  CONSTRAINT breathwork_session_perceived_effect_valid
  CHECK (perceived_effect IS NULL OR perceived_effect IN ('better', 'same', 'worse'))
);

CREATE INDEX breathwork_session_user_idx
ON fitness.breathwork_session (user_id);

CREATE INDEX breathwork_session_started_at_idx
ON fitness.breathwork_session (started_at DESC);

CREATE TABLE fitness.menstrual_period (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL CONSTRAINT menstrual_period_user_id_fkey
  REFERENCES fitness.user_profile (id),
  start_date date NOT NULL,
  end_date date,
  notes text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX menstrual_period_user_idx
ON fitness.menstrual_period (user_id);

CREATE UNIQUE INDEX menstrual_period_user_start_idx
ON fitness.menstrual_period (user_id, start_date);
