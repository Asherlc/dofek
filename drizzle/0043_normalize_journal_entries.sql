-- Normalize journal entries: add journal_question reference table, migrate journal_entry

-- Step 1: Create journal_question reference table
CREATE TABLE IF NOT EXISTS fitness.journal_question (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  data_type TEXT NOT NULL,
  unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 2: Seed known questions
INSERT INTO fitness.journal_question (slug, display_name, category, data_type, sort_order) VALUES
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

-- Step 3: Auto-insert any existing question strings not yet in the reference table
INSERT INTO fitness.journal_question (slug, display_name, category, data_type)
  SELECT DISTINCT
    question,
    INITCAP(REPLACE(question, '_', ' ')),
    'custom',
    'numeric'
  FROM fitness.journal_entry
  WHERE question NOT IN (SELECT slug FROM fitness.journal_question)
ON CONFLICT (slug) DO NOTHING;

-- Step 4: Add question_slug column (nullable initially)
ALTER TABLE fitness.journal_entry ADD COLUMN question_slug TEXT;

-- Step 5: Backfill question_slug from existing question column
UPDATE fitness.journal_entry SET question_slug = question;

-- Step 6: Make question_slug NOT NULL and add FK
ALTER TABLE fitness.journal_entry ALTER COLUMN question_slug SET NOT NULL;
ALTER TABLE fitness.journal_entry
  ADD CONSTRAINT journal_entry_question_slug_fk
  FOREIGN KEY (question_slug) REFERENCES fitness.journal_question(slug);

-- Step 7: Drop old unique index and question column
DROP INDEX IF EXISTS fitness.journal_entry_provider_date_question_idx;
ALTER TABLE fitness.journal_entry DROP COLUMN question;

-- Step 8: Create new indexes
CREATE UNIQUE INDEX journal_entry_user_date_question_provider_idx
  ON fitness.journal_entry (user_id, date, question_slug, provider_id);
CREATE INDEX journal_entry_question_slug_idx
  ON fitness.journal_entry (question_slug);
