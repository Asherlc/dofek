CREATE TYPE fitness.finger_loading_exercise AS ENUM (
  'max_hang',
  'repeater',
  'min_edge',
  'one_arm',
  'campus',
  'no_hang'
);
--> statement-breakpoint

CREATE TYPE fitness.finger_loading_grip_position AS ENUM (
  'half_crimp',
  'full_crimp',
  'open_hand',
  'three_finger_drag',
  'two_finger_pocket'
);
--> statement-breakpoint

CREATE TYPE fitness.finger_loading_laterality AS ENUM ('both', 'left', 'right');
--> statement-breakpoint

CREATE TYPE fitness.climbing_hold_type AS ENUM ('crimp', 'sloper', 'pinch', 'pocket', 'jug');
--> statement-breakpoint

CREATE TYPE fitness.climbing_attempt_outcome AS ENUM ('sent', 'failed');
--> statement-breakpoint

CREATE TYPE fitness.climbing_failure_reason AS ENUM (
  'fell',
  'pumped',
  'skin',
  'technique',
  'fear'
);
--> statement-breakpoint

CREATE TABLE fitness.finger_loading_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES fitness.activity (id) ON DELETE CASCADE,
  exercise fitness.finger_loading_exercise NOT NULL,
  edge_size_mm real,
  grip_position fitness.finger_loading_grip_position,
  external_load_kg real NOT NULL,
  bodyweight_kg real NOT NULL,
  laterality fitness.finger_loading_laterality NOT NULL,
  -- The router caps a session at 100 sets, so this cannot approach the 32-bit limit.
  -- squawk-ignore prefer-bigint-over-int
  set_count integer NOT NULL,
  hold_duration_seconds real NOT NULL,
  -- The router caps rest intervals at one hour, so this cannot approach the 32-bit limit.
  -- squawk-ignore prefer-bigint-over-int
  rest_interval_seconds integer NOT NULL,
  rpe real,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finger_loading_entry_edge_size_positive CHECK (
    edge_size_mm IS NULL OR edge_size_mm > 0
  ),
  CONSTRAINT finger_loading_entry_bodyweight_positive CHECK (bodyweight_kg > 0),
  CONSTRAINT finger_loading_entry_effective_load_positive CHECK (
    bodyweight_kg + external_load_kg > 0
  ),
  CONSTRAINT finger_loading_entry_set_count_positive CHECK (set_count > 0),
  CONSTRAINT finger_loading_entry_hold_duration_positive CHECK (hold_duration_seconds > 0),
  CONSTRAINT finger_loading_entry_rest_interval_nonnegative CHECK (rest_interval_seconds >= 0),
  CONSTRAINT finger_loading_entry_rpe_range CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10))
);
--> statement-breakpoint

CREATE INDEX finger_loading_entry_activity_idx -- noqa: PG01
ON fitness.finger_loading_entry (activity_id);
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
-- Structured manual logs store outcomes in climbing_attempt; imported aggregate rows retain values.
-- squawk-ignore ban-drop-not-null
ALTER COLUMN sent DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
-- Structured manual logs store counts in climbing_attempt; imported aggregate rows retain values.
-- squawk-ignore ban-drop-not-null
ALTER COLUMN attempt_count DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
ADD COLUMN wall_angle_degrees real;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
ADD COLUMN hold_type fitness.climbing_hold_type;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_aggregate_pair CHECK (
  (sent IS NULL) = (attempt_count IS NULL)
) NOT VALID;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_aggregate_pair;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
ADD CONSTRAINT climbing_entry_wall_angle_range CHECK (
  wall_angle_degrees IS NULL OR (
    wall_angle_degrees >= -90
    AND wall_angle_degrees <= 90
  )
) NOT VALID;
--> statement-breakpoint

ALTER TABLE fitness.climbing_entry
VALIDATE CONSTRAINT climbing_entry_wall_angle_range;
--> statement-breakpoint

CREATE TABLE fitness.climbing_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  climbing_entry_id uuid NOT NULL REFERENCES fitness.climbing_entry (id) ON DELETE CASCADE,
  -- The router caps a climb at 100 attempts, so this cannot approach the 32-bit limit.
  -- squawk-ignore prefer-bigint-over-int
  attempt_index integer NOT NULL,
  outcome fitness.climbing_attempt_outcome NOT NULL,
  failure_reason fitness.climbing_failure_reason,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT climbing_attempt_index_positive CHECK (attempt_index > 0),
  CONSTRAINT climbing_attempt_failure_reason CHECK (
    (outcome = 'sent' AND failure_reason IS NULL)
    OR (outcome = 'failed' AND failure_reason IS NOT NULL)
  ),
  CONSTRAINT climbing_attempt_notes_nonempty CHECK (
    notes IS NULL OR btrim(notes) <> ''
  )
);
--> statement-breakpoint

CREATE INDEX climbing_attempt_entry_idx -- noqa: PG01
ON fitness.climbing_attempt (climbing_entry_id);
--> statement-breakpoint

CREATE UNIQUE INDEX climbing_attempt_entry_index_idx
ON fitness.climbing_attempt (climbing_entry_id, attempt_index);
