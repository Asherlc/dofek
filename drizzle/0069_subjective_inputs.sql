ALTER TABLE fitness.activity
ADD CONSTRAINT activity_perceived_exertion_range
CHECK (perceived_exertion IS NULL OR perceived_exertion BETWEEN 0 AND 10)
NOT VALID;

ALTER TABLE fitness.activity
VALIDATE CONSTRAINT activity_perceived_exertion_range;

CREATE TABLE fitness.body_region (
  id text PRIMARY KEY,
  parent_id text REFERENCES fitness.body_region (id) ON DELETE RESTRICT,
  label text NOT NULL,
  kind text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT body_region_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT body_region_label_nonempty CHECK (btrim(label) <> ''),
  CONSTRAINT body_region_kind_valid CHECK (kind IN ('body', 'limb', 'hand', 'digit', 'pulley'))
);

CREATE INDEX body_region_parent_sort_idx
ON fitness.body_region (parent_id, sort_order, id);

INSERT INTO fitness.body_region (id, parent_id, label, kind, sort_order)
VALUES
('body', NULL, 'Body', 'body', 0),
('left_upper_limb', 'body', 'Left arm', 'limb', 10),
('right_upper_limb', 'body', 'Right arm', 'limb', 20),
('left_hand', 'left_upper_limb', 'Left hand', 'hand', 10),
('right_hand', 'right_upper_limb', 'Right hand', 'hand', 10),
('left_hand_thumb', 'left_hand', 'Left thumb', 'digit', 10),
('right_hand_thumb', 'right_hand', 'Right thumb', 'digit', 10),
('left_hand_index', 'left_hand', 'Left index finger', 'digit', 20),
('left_hand_middle', 'left_hand', 'Left middle finger', 'digit', 30),
('left_hand_ring', 'left_hand', 'Left ring finger', 'digit', 40),
('left_hand_little', 'left_hand', 'Left little finger', 'digit', 50),
('right_hand_index', 'right_hand', 'Right index finger', 'digit', 20),
('right_hand_middle', 'right_hand', 'Right middle finger', 'digit', 30),
('right_hand_ring', 'right_hand', 'Right ring finger', 'digit', 40),
('right_hand_little', 'right_hand', 'Right little finger', 'digit', 50),
('left_hand_index_a1_pulley', 'left_hand_index', 'Left index A1 pulley', 'pulley', 1),
('left_hand_index_a2_pulley', 'left_hand_index', 'Left index A2 pulley', 'pulley', 2),
('left_hand_index_a3_pulley', 'left_hand_index', 'Left index A3 pulley', 'pulley', 3),
('left_hand_index_a4_pulley', 'left_hand_index', 'Left index A4 pulley', 'pulley', 4),
('left_hand_index_a5_pulley', 'left_hand_index', 'Left index A5 pulley', 'pulley', 5),
('left_hand_middle_a1_pulley', 'left_hand_middle', 'Left middle A1 pulley', 'pulley', 1),
('left_hand_middle_a2_pulley', 'left_hand_middle', 'Left middle A2 pulley', 'pulley', 2),
('left_hand_middle_a3_pulley', 'left_hand_middle', 'Left middle A3 pulley', 'pulley', 3),
('left_hand_middle_a4_pulley', 'left_hand_middle', 'Left middle A4 pulley', 'pulley', 4),
('left_hand_middle_a5_pulley', 'left_hand_middle', 'Left middle A5 pulley', 'pulley', 5),
('left_hand_ring_a1_pulley', 'left_hand_ring', 'Left ring A1 pulley', 'pulley', 1),
('left_hand_ring_a2_pulley', 'left_hand_ring', 'Left ring A2 pulley', 'pulley', 2),
('left_hand_ring_a3_pulley', 'left_hand_ring', 'Left ring A3 pulley', 'pulley', 3),
('left_hand_ring_a4_pulley', 'left_hand_ring', 'Left ring A4 pulley', 'pulley', 4),
('left_hand_ring_a5_pulley', 'left_hand_ring', 'Left ring A5 pulley', 'pulley', 5),
('left_hand_little_a1_pulley', 'left_hand_little', 'Left little A1 pulley', 'pulley', 1),
('left_hand_little_a2_pulley', 'left_hand_little', 'Left little A2 pulley', 'pulley', 2),
('left_hand_little_a3_pulley', 'left_hand_little', 'Left little A3 pulley', 'pulley', 3),
('left_hand_little_a4_pulley', 'left_hand_little', 'Left little A4 pulley', 'pulley', 4),
('left_hand_little_a5_pulley', 'left_hand_little', 'Left little A5 pulley', 'pulley', 5),
('right_hand_index_a1_pulley', 'right_hand_index', 'Right index A1 pulley', 'pulley', 1),
('right_hand_index_a2_pulley', 'right_hand_index', 'Right index A2 pulley', 'pulley', 2),
('right_hand_index_a3_pulley', 'right_hand_index', 'Right index A3 pulley', 'pulley', 3),
('right_hand_index_a4_pulley', 'right_hand_index', 'Right index A4 pulley', 'pulley', 4),
('right_hand_index_a5_pulley', 'right_hand_index', 'Right index A5 pulley', 'pulley', 5),
('right_hand_middle_a1_pulley', 'right_hand_middle', 'Right middle A1 pulley', 'pulley', 1),
('right_hand_middle_a2_pulley', 'right_hand_middle', 'Right middle A2 pulley', 'pulley', 2),
('right_hand_middle_a3_pulley', 'right_hand_middle', 'Right middle A3 pulley', 'pulley', 3),
('right_hand_middle_a4_pulley', 'right_hand_middle', 'Right middle A4 pulley', 'pulley', 4),
('right_hand_middle_a5_pulley', 'right_hand_middle', 'Right middle A5 pulley', 'pulley', 5),
('right_hand_ring_a1_pulley', 'right_hand_ring', 'Right ring A1 pulley', 'pulley', 1),
('right_hand_ring_a2_pulley', 'right_hand_ring', 'Right ring A2 pulley', 'pulley', 2),
('right_hand_ring_a3_pulley', 'right_hand_ring', 'Right ring A3 pulley', 'pulley', 3),
('right_hand_ring_a4_pulley', 'right_hand_ring', 'Right ring A4 pulley', 'pulley', 4),
('right_hand_ring_a5_pulley', 'right_hand_ring', 'Right ring A5 pulley', 'pulley', 5),
('right_hand_little_a1_pulley', 'right_hand_little', 'Right little A1 pulley', 'pulley', 1),
('right_hand_little_a2_pulley', 'right_hand_little', 'Right little A2 pulley', 'pulley', 2),
('right_hand_little_a3_pulley', 'right_hand_little', 'Right little A3 pulley', 'pulley', 3),
('right_hand_little_a4_pulley', 'right_hand_little', 'Right little A4 pulley', 'pulley', 4),
('right_hand_little_a5_pulley', 'right_hand_little', 'Right little A5 pulley', 'pulley', 5)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE fitness.subjective_check_in (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subjective_check_in_user_date_key UNIQUE (user_id, date)
);

CREATE INDEX subjective_check_in_user_date_idx
ON fitness.subjective_check_in (user_id, date DESC);

CREATE TABLE fitness.subjective_symptom (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_in_id uuid NOT NULL REFERENCES fitness.subjective_check_in (id) ON DELETE CASCADE,
  body_region_id text NOT NULL REFERENCES fitness.body_region (id) ON DELETE RESTRICT,
  kind text NOT NULL,
  score integer NOT NULL,
  CONSTRAINT subjective_symptom_kind_valid CHECK (kind IN ('soreness', 'stiffness', 'tenderness')),
  CONSTRAINT subjective_symptom_score_range CHECK (score BETWEEN 1 AND 10),
  CONSTRAINT subjective_symptom_unique_kind UNIQUE (check_in_id, body_region_id, kind)
);

CREATE INDEX subjective_symptom_region_idx
ON fitness.subjective_symptom (body_region_id);

CREATE TABLE fitness.injury_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  kind text NOT NULL,
  body_region_id text NOT NULL REFERENCES fitness.body_region (id) ON DELETE RESTRICT,
  onset_date date NOT NULL,
  resolved_date date,
  severity integer,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT injury_event_kind_valid CHECK (kind IN ('injury', 'niggle')),
  CONSTRAINT injury_event_severity_range CHECK (severity BETWEEN 0 AND 10),
  CONSTRAINT injury_event_description_nonempty CHECK (btrim(description) <> ''),
  CONSTRAINT injury_event_resolution_order CHECK (resolved_date IS NULL OR resolved_date >= onset_date)
);

CREATE INDEX injury_event_user_onset_idx
ON fitness.injury_event (user_id, onset_date DESC);
