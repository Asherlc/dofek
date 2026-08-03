ALTER TABLE fitness.life_events
ADD COLUMN personal_experiment_id uuid
REFERENCES fitness.personal_experiment (id) ON DELETE SET NULL;

CREATE INDEX life_events_personal_experiment_idx
ON fitness.life_events (personal_experiment_id)
WHERE personal_experiment_id IS NOT NULL;

CREATE TABLE fitness.personal_experiment_check_in (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  personal_experiment_id uuid NOT NULL
  REFERENCES fitness.personal_experiment (id) ON DELETE CASCADE,
  date date NOT NULL,
  adherence text NOT NULL,
  confounder text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_experiment_check_in_experiment_date_unique
  UNIQUE (personal_experiment_id, date),
  CONSTRAINT personal_experiment_check_in_adherence_valid
  CHECK (adherence IN ('adherent', 'partial', 'not_adherent', 'unknown')),
  CONSTRAINT personal_experiment_check_in_confounder_nonempty
  CHECK (confounder IS NULL OR btrim(confounder) <> ''),
  CONSTRAINT personal_experiment_check_in_note_nonempty
  CHECK (note IS NULL OR btrim(note) <> '')
);
