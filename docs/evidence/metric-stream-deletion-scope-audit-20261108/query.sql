-- Executed once as the final successful comparison; not permission to rerun.
-- Parameters supplied privately from 248 validated scopes for one user.
-- Query caps are recorded in summary.json. No FINAL or outer ownership filter.
SELECT count() AS physical_versions,
    uniqExact(id) AS audited_ids,
    uniqExact(tuple(id, user_id, provider_id, recorded_at)) AS identity_tuples
FROM ingest.metric_stream
WHERE id IN (SELECT id FROM ingest.metric_stream
WHERE user_id = {scope_user:UUID} AND activity_id IN {scope_activities:Array(UUID)})
FORMAT JSONEachRow;
