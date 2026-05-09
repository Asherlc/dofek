ALTER TABLE fitness.metric_stream ADD COLUMN IF NOT EXISTS external_id text;

WITH body_values AS (
    SELECT
        b.id,
        b.user_id,
        b.provider_id,
        b.recorded_at,
        b.source_name,
        mapped.channel,
        mapped.scalar,
        COALESCE(b.external_id, 'legacy-body:' || b.id::text) AS external_id
    FROM fitness.body_measurement AS b
    CROSS JOIN
        LATERAL (
            VALUES
            ('body_weight', b.weight_kg::real),
            ('body_fat_percentage', b.body_fat_pct::real),
            ('muscle_mass', b.muscle_mass_kg::real),
            ('bone_mass', b.bone_mass_kg::real),
            ('body_water_percentage', b.water_pct::real),
            ('body_mass_index', b.bmi::real),
            ('height', b.height_cm::real),
            ('waist_circumference', b.waist_circumference_cm::real),
            ('systolic_blood_pressure', b.systolic_bp::real),
            ('diastolic_blood_pressure', b.diastolic_bp::real),
            ('heart_pulse', b.heart_pulse::real),
            ('body_temperature', b.temperature_c::real)
        ) AS mapped (channel, scalar)
    WHERE mapped.scalar IS NOT NULL
)

UPDATE fitness.metric_stream ms
SET external_id = body_values.external_id
FROM body_values
WHERE
    ms.external_id IS NULL
    AND ms.user_id = body_values.user_id
    AND ms.provider_id = body_values.provider_id
    AND ms.recorded_at = body_values.recorded_at
    AND ms.device_id IS NOT DISTINCT FROM body_values.source_name
    AND ms.channel = body_values.channel;

WITH duplicate_body_stream_rows AS (
    SELECT
        id,
        recorded_at,
        ROW_NUMBER() OVER (
            PARTITION BY user_id, provider_id, external_id, channel, recorded_at
            ORDER BY id
        ) AS row_number
    FROM fitness.metric_stream
    WHERE
        external_id IS NOT NULL
        AND channel IN (
            'body_weight',
            'body_fat_percentage',
            'muscle_mass',
            'bone_mass',
            'body_water_percentage',
            'body_mass_index',
            'height',
            'waist_circumference',
            'systolic_blood_pressure',
            'diastolic_blood_pressure',
            'heart_pulse',
            'body_temperature'
        )
)

DELETE FROM fitness.metric_stream ms
USING duplicate_body_stream_rows duplicate_rows
WHERE
    ms.id = duplicate_rows.id
    AND ms.recorded_at = duplicate_rows.recorded_at
    AND duplicate_rows.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS
metric_stream_provider_external_channel_time_idx
ON fitness.metric_stream (
    user_id, provider_id, external_id, channel, recorded_at
);

INSERT INTO fitness.metric_stream (
    recorded_at,
    user_id,
    provider_id,
    external_id,
    device_id,
    source_type,
    channel,
    scalar
)
SELECT
    b.recorded_at,
    b.user_id,
    b.provider_id,
    COALESCE(b.external_id, 'legacy-body:' || b.id::text) AS external_id,
    b.source_name,
    'api' AS source_type,
    mapped.channel,
    mapped.scalar
FROM fitness.body_measurement AS b
CROSS JOIN
    LATERAL (
        VALUES
        ('body_weight', b.weight_kg::real),
        ('body_fat_percentage', b.body_fat_pct::real),
        ('muscle_mass', b.muscle_mass_kg::real),
        ('bone_mass', b.bone_mass_kg::real),
        ('body_water_percentage', b.water_pct::real),
        ('body_mass_index', b.bmi::real),
        ('height', b.height_cm::real),
        ('waist_circumference', b.waist_circumference_cm::real),
        ('systolic_blood_pressure', b.systolic_bp::real),
        ('diastolic_blood_pressure', b.diastolic_bp::real),
        ('heart_pulse', b.heart_pulse::real),
        ('body_temperature', b.temperature_c::real)
    ) AS mapped (channel, scalar)
WHERE mapped.scalar IS NOT NULL
ON CONFLICT (user_id, provider_id, external_id, channel, recorded_at) DO UPDATE
    SET
        scalar = excluded.scalar,
        device_id = excluded.device_id,
        source_type = excluded.source_type;

DROP VIEW IF EXISTS clickhouse.v_body_measurement;
DROP VIEW IF EXISTS fitness.v_body_measurement;

CREATE OR REPLACE VIEW fitness.provider_stats AS
WITH providers AS (
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.oauth_token
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.activity
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.daily_metrics
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.sleep_session
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.food_entry
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.health_event
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.metric_stream
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.v_nutrition_daily
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.lab_panel
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.lab_result
    UNION
    SELECT DISTINCT
        user_id,
        provider_id
    FROM fitness.journal_entry
),

a AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.activity
    GROUP BY user_id, provider_id
),

dm AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.daily_metrics
    GROUP BY user_id, provider_id
),

ss AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.sleep_session
    GROUP BY user_id, provider_id
),

bm AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM (
        SELECT DISTINCT
            user_id,
            provider_id,
            recorded_at,
            device_id,
            COALESCE(external_id, id::text) AS sample_id
        FROM fitness.metric_stream
        WHERE channel IN (
            'body_weight',
            'body_fat_percentage',
            'muscle_mass',
            'bone_mass',
            'body_water_percentage',
            'body_mass_index',
            'height',
            'waist_circumference',
            'systolic_blood_pressure',
            'diastolic_blood_pressure',
            'heart_pulse',
            'body_temperature'
        )
    ) AS body_samples
    GROUP BY user_id, provider_id
),

fe AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.food_entry
    WHERE confirmed = TRUE
    GROUP BY user_id, provider_id
),

he AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.health_event
    GROUP BY user_id, provider_id
),

ms AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.metric_stream
    GROUP BY user_id, provider_id
),

nd AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.v_nutrition_daily
    GROUP BY user_id, provider_id
),

lp AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.lab_panel
    GROUP BY user_id, provider_id
),

lr AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.lab_result
    GROUP BY user_id, provider_id
),

je AS (
    SELECT
        user_id,
        provider_id,
        COUNT(*) AS cnt
    FROM fitness.journal_entry
    GROUP BY user_id, provider_id
)

SELECT
    p.user_id,
    p.provider_id,
    COALESCE(a.cnt, 0)::bigint AS activities,
    COALESCE(dm.cnt, 0)::bigint AS daily_metrics,
    COALESCE(ss.cnt, 0)::bigint AS sleep_sessions,
    COALESCE(bm.cnt, 0)::bigint AS body_measurements,
    COALESCE(fe.cnt, 0)::bigint AS food_entries,
    COALESCE(he.cnt, 0)::bigint AS health_events,
    COALESCE(ms.cnt, 0)::bigint AS metric_stream,
    COALESCE(nd.cnt, 0)::bigint AS nutrition_daily,
    COALESCE(lp.cnt, 0)::bigint AS lab_panels,
    COALESCE(lr.cnt, 0)::bigint AS lab_results,
    COALESCE(je.cnt, 0)::bigint AS journal_entries
FROM providers AS p
LEFT JOIN a ON p.user_id = a.user_id AND p.provider_id = a.provider_id
LEFT JOIN dm ON p.user_id = dm.user_id AND p.provider_id = dm.provider_id
LEFT JOIN ss ON p.user_id = ss.user_id AND p.provider_id = ss.provider_id
LEFT JOIN bm ON p.user_id = bm.user_id AND p.provider_id = bm.provider_id
LEFT JOIN fe ON p.user_id = fe.user_id AND p.provider_id = fe.provider_id
LEFT JOIN he ON p.user_id = he.user_id AND p.provider_id = he.provider_id
LEFT JOIN ms ON p.user_id = ms.user_id AND p.provider_id = ms.provider_id
LEFT JOIN nd ON p.user_id = nd.user_id AND p.provider_id = nd.provider_id
LEFT JOIN lp ON p.user_id = lp.user_id AND p.provider_id = lp.provider_id
LEFT JOIN lr ON p.user_id = lr.user_id AND p.provider_id = lr.provider_id
LEFT JOIN je ON p.user_id = je.user_id AND p.provider_id = je.provider_id;

DROP TABLE IF EXISTS fitness.body_measurement_value;
DROP TABLE IF EXISTS fitness.body_measurement;
DROP TABLE IF EXISTS fitness.measurement_type;
