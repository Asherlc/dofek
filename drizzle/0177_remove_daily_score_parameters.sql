-- dofek: deployment-mode=maintenance
UPDATE fitness.user_settings
SET
  value = CASE
    WHEN jsonb_typeof(value -> 'successfulFitAt') = 'object'
      THEN
        (value - 'readinessWeights' - 'sleepTarget')
        #- '{successfulFitAt,readinessWeights}'
        #- '{successfulFitAt,sleepTarget}'
    ELSE value - 'readinessWeights' - 'sleepTarget'
  END
WHERE
  key = 'personalized_params'
  AND jsonb_typeof(value) = 'object'
  AND (
    value ?| ARRAY['readinessWeights', 'sleepTarget']
    OR (
      jsonb_typeof(value -> 'successfulFitAt') = 'object'
      AND (value -> 'successfulFitAt') ?| ARRAY['readinessWeights', 'sleepTarget']
    )
  );
