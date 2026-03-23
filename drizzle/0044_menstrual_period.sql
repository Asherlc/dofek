-- Menstrual cycle tracking table
CREATE TABLE IF NOT EXISTS fitness.menstrual_period (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES fitness.user_profile(id),
  start_date DATE NOT NULL,
  end_date DATE,
  cycle_length INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS menstrual_period_user_start_idx
  ON fitness.menstrual_period (user_id, start_date);

CREATE INDEX IF NOT EXISTS menstrual_period_user_idx
  ON fitness.menstrual_period (user_id);
