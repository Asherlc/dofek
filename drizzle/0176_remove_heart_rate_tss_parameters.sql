-- dofek: deployment-mode=maintenance
UPDATE fitness.user_settings
SET
  value = CASE
    WHEN jsonb_typeof(value -> 'successfulFitAt') = 'object'
      THEN (value - 'trainingImpulseConstants') #- '{successfulFitAt,trainingImpulseConstants}'
    ELSE value - 'trainingImpulseConstants'
  END
WHERE
  key = 'personalized_params'
  AND jsonb_typeof(value) = 'object'
  AND (
    value ? 'trainingImpulseConstants'
    OR (
      jsonb_typeof(value -> 'successfulFitAt') = 'object'
      AND (value -> 'successfulFitAt') ? 'trainingImpulseConstants'
    )
  );
