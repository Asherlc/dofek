CREATE TABLE fitness.effort_equivalence_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  display_name text NOT NULL,
  effort_kind text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT effort_equivalence_group_effort_kind
    CHECK (effort_kind = 'user_defined_benchmark')
);
--> statement-breakpoint
CREATE UNIQUE INDEX effort_equivalence_group_user_id_idx
  ON fitness.effort_equivalence_group (user_id, id);
--> statement-breakpoint
CREATE TABLE fitness.effort_equivalence_group_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id),
  canonical_activity_id uuid NOT NULL,
  inclusion_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT effort_equivalence_group_member_user_group_fk
    FOREIGN KEY (user_id, group_id)
    REFERENCES fitness.effort_equivalence_group (user_id, id),
  CONSTRAINT effort_equivalence_group_member_user_activity_fk
    FOREIGN KEY (user_id, canonical_activity_id)
    REFERENCES fitness.activity_group (user_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX effort_equivalence_group_member_user_group_activity_idx
  ON fitness.effort_equivalence_group_member (user_id, group_id, canonical_activity_id);
--> statement-breakpoint
CREATE INDEX effort_equivalence_group_member_user_activity_idx
  ON fitness.effort_equivalence_group_member (user_id, canonical_activity_id);
