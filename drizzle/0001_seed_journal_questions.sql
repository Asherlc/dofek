INSERT INTO fitness.journal_question (slug, display_name, category, data_type, sort_order)
VALUES
  ('caffeine', 'Caffeine', 'substance', 'boolean', 1),
  ('alcohol', 'Alcohol', 'substance', 'boolean', 2),
  ('melatonin', 'Melatonin', 'substance', 'boolean', 3),
  ('sleep_aid', 'Sleep Aid', 'substance', 'boolean', 4),
  ('meditation', 'Meditation', 'activity', 'boolean', 10),
  ('morning_stretch', 'Morning Stretch', 'activity', 'boolean', 11),
  ('hydration', 'Hydration', 'wellness', 'numeric', 20),
  ('sleep_quality', 'Sleep Quality', 'wellness', 'numeric', 21),
  ('energy', 'Energy', 'wellness', 'numeric', 22),
  ('mood', 'Mood', 'wellness', 'numeric', 23),
  ('recovery', 'Recovery', 'wellness', 'numeric', 24)
ON CONFLICT (slug) DO NOTHING;
