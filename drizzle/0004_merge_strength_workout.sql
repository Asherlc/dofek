-- Add activity_id to strength_set (initially nullable)
ALTER TABLE fitness.strength_set ADD COLUMN activity_id uuid;

--> statement-breakpoint

-- Populate activity_id by joining strength_workout to activity on the canonical identity triplet.
UPDATE fitness.strength_set ss
SET activity_id = a.id
FROM fitness.strength_workout sw
JOIN fitness.activity a 
  ON a.user_id = sw.user_id 
  AND a.provider_id = sw.provider_id 
  AND a.external_id = sw.external_id
WHERE ss.workout_id = sw.id;

--> statement-breakpoint

-- Migrate specialized WHOOP strain metrics from strength_workout into activity.raw JSONB.
-- We merge them into the existing raw object, prioritizing the strength_workout values.
UPDATE fitness.activity a
SET raw = jsonb_strip_nulls(
  COALESCE(a.raw, '{}'::jsonb) || jsonb_build_object(
    'rawMskStrainScore', sw.raw_msk_strain_score,
    'scaledMskStrainScore', sw.scaled_msk_strain_score,
    'cardioStrainScore', sw.cardio_strain_score,
    'cardioStrainContributionPercent', sw.cardio_strain_contribution_percent,
    'mskStrainContributionPercent', sw.msk_strain_contribution_percent
  )
)
FROM fitness.strength_workout sw
WHERE a.user_id = sw.user_id 
  AND a.provider_id = sw.provider_id 
  AND a.external_id = sw.external_id
  AND (
    sw.raw_msk_strain_score IS NOT NULL OR 
    sw.scaled_msk_strain_score IS NOT NULL OR
    sw.cardio_strain_score IS NOT NULL
  );

--> statement-breakpoint

-- Delete orphaned sets that couldn't be linked to an activity (to satisfy NOT NULL requirement).
DELETE FROM fitness.strength_set WHERE activity_id IS NULL;

--> statement-breakpoint

-- Enforce NOT NULL and add foreign key to strength_set.activity_id.
ALTER TABLE fitness.strength_set
ADD CONSTRAINT strength_set_activity_id_not_null_chk CHECK (activity_id IS NOT NULL) NOT VALID;
ALTER TABLE fitness.strength_set ADD CONSTRAINT strength_set_activity_id_activity_id_fk FOREIGN KEY (activity_id) REFERENCES fitness.activity(id) ON DELETE CASCADE NOT VALID;

--> statement-breakpoint

-- Validate the foreign key in a separate transaction to avoid long-held locks.
ALTER TABLE fitness.strength_set VALIDATE CONSTRAINT strength_set_activity_id_not_null_chk;
ALTER TABLE fitness.strength_set VALIDATE CONSTRAINT strength_set_activity_id_activity_id_fk;

--> statement-breakpoint

-- Drop the old column and the redundant table.
ALTER TABLE fitness.strength_set DROP COLUMN workout_id;
DROP TABLE fitness.strength_workout;

--> statement-breakpoint

-- Update the activity_id index.
DROP INDEX IF EXISTS fitness.strength_set_workout_idx;
CREATE INDEX strength_set_activity_idx ON fitness.strength_set (activity_id);
