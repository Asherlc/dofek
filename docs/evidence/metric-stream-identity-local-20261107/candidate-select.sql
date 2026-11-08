-- Frozen local qualification SELECT body for one user/activity scope.
-- Assumes immutable (user_id, provider_id, recorded_at) per ID.
-- Not deployed; excludes publication, scope-ledger and acknowledgement sequencing.
SELECT
        id,
        latest_row.1 AS activity_id,
        latest_row.2 AS user_id,
        latest_row.3 AS recorded_at,
        latest_row.4 AS channel,
        latest_row.5 AS provider_id,
        latest_row.6 AS external_id,
        latest_row.7 AS device_id,
        latest_row.8 AS source_type,
        latest_row.9 AS scalar,
        latest_row.10 AS vector,
        latest_row.11 AS point,
        latest_row.12 AS metadata,
        now64(9) AS ingested_at,
        1 AS is_deleted,
        {replacement_version:UInt64} AS version,
        latest_row.13 AS generation
      FROM (
        SELECT metric_stream_row.id AS id,
          argMax(
            tuple(
              metric_stream_row.activity_id,
              metric_stream_row.user_id,
              metric_stream_row.recorded_at,
              metric_stream_row.channel,
              metric_stream_row.provider_id,
              metric_stream_row.external_id,
              metric_stream_row.device_id,
              metric_stream_row.source_type,
              metric_stream_row.scalar,
              metric_stream_row.vector,
              metric_stream_row.point,
              metric_stream_row.metadata,
              metric_stream_row.generation,
              metric_stream_row.is_deleted,
              metric_stream_row.version
            ),
            tuple(metric_stream_row.version, metric_stream_row.ingested_at)
          ) AS latest_row
        FROM ingest.metric_stream AS metric_stream_row
        WHERE ((metric_stream_row.user_id = {user_id:UUID}))
          AND (metric_stream_row.id, metric_stream_row.user_id, metric_stream_row.provider_id, metric_stream_row.recorded_at) IN (
            SELECT id, user_id, provider_id, recorded_at FROM (
          SELECT candidate_row.id AS id, candidate_row.user_id AS user_id, candidate_row.provider_id AS provider_id, candidate_row.recorded_at AS recorded_at
          FROM ingest.metric_stream AS candidate_row
          WHERE candidate_row.user_id = {user_id:UUID} AND candidate_row.activity_id = {activity_id:UUID}
          GROUP BY candidate_row.id, candidate_row.user_id, candidate_row.provider_id, candidate_row.recorded_at
            )
          )
        GROUP BY metric_stream_row.id
      )
      WHERE ((latest_row.2 = {user_id:UUID} AND latest_row.1 = {activity_id:UUID}))
        AND latest_row.14 = 0
        AND lower(hex(SHA256(toString(latest_row.2)))) NOT IN (
          SELECT user_hash
          FROM ingest.account_erasure_fence FINAL
        );
