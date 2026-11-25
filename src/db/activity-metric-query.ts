/** Includes standalone recordings, but excludes recordings attached to unrelated activities. */
export const activityMetricSamplesSql = `SELECT *
  FROM analytics.sensor_scalar_sample FINAL
  WHERE user_id = {userId:UUID}
    AND {isPointOnly:Bool} = 0
    AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
    AND recorded_date >= toDate(parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC'))
    AND recorded_date <= toDate(parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC'))
    AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC')
    AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC')
    AND (activity_id IS NULL OR activity_id IN (
      SELECT arrayJoin(CAST({memberActivityIds:Array(String)}, 'Array(UUID)'))
    ))
    AND _peerdb_is_deleted = 0
    AND (channel != 'heart_rate' OR scalar > 0)`;

/** Keep device identities distinct, including multiple recordings delivered by Apple Health. */
export const activityMetricSourceIdSql = `if(coalesce(device_id, '') = '', provider_id, toJSONString(tuple(provider_id, device_id)))`;
