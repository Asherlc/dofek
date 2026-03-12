CREATE TABLE fitness.user_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default calorie goal
INSERT INTO fitness.user_settings (key, value) VALUES ('calorieGoal', '2000');
