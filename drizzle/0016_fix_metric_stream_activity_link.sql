-- Backfill activity_id on Peloton metric_stream rows by matching timestamps
-- to activities from the same provider.
UPDATE fitness.metric_stream ms
SET activity_id = a.id
FROM fitness.activity a
WHERE ms.provider_id = 'peloton'
  AND ms.activity_id IS NULL
  AND a.provider_id = 'peloton'
  AND ms.recorded_at >= a.started_at
  AND ms.recorded_at <= a.ended_at;
