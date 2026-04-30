WITH power_samples AS (
  SELECT ds.scalar AS power
  FROM fitness.deduped_sensor ds
  WHERE ds.activity_id = {{activityId}}
    AND ds.user_id = {{userId}}
    AND ds.channel = 'power'
    AND EXISTS (
      SELECT 1
      FROM fitness.v_activity a
      WHERE a.id = {{activityId}}
        AND a.user_id = {{userId}}
        {{accessPredicate}}
    )
)
SELECT
  z.zone,
  COUNT(ps.power)::int AS seconds
FROM (VALUES (1), (2), (3), (4), (5), (6), (7)) AS z(zone)
LEFT JOIN power_samples ps ON
  CASE z.zone
    WHEN 1 THEN ps.power < {{ftp}} * 0.55
    WHEN 2 THEN ps.power >= {{ftp}} * 0.55 AND ps.power < {{ftp}} * 0.75
    WHEN 3 THEN ps.power >= {{ftp}} * 0.75 AND ps.power < {{ftp}} * 0.9
    WHEN 4 THEN ps.power >= {{ftp}} * 0.9 AND ps.power < {{ftp}} * 1.05
    WHEN 5 THEN ps.power >= {{ftp}} * 1.05 AND ps.power < {{ftp}} * 1.2
    WHEN 6 THEN ps.power >= {{ftp}} * 1.2 AND ps.power < {{ftp}} * 1.5
    WHEN 7 THEN ps.power >= {{ftp}} * 1.5
  END
GROUP BY z.zone
ORDER BY z.zone
