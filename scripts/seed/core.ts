import {
  daysBefore,
  SEED_PROVIDER_IDS,
  SEED_PROVIDER_NAMES,
  type Sql,
  timestampAt,
  USER_ID,
} from "./helpers.ts";

export async function clearSeedData(sql: Sql): Promise<void> {
  await sql`DELETE FROM fitness.sleep_stage WHERE session_id IN (
    SELECT id FROM fitness.sleep_session WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.activity_interval WHERE activity_id IN (
    SELECT id FROM fitness.activity WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.metric_stream WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.strength_set WHERE activity_id IN (
    SELECT id FROM fitness.activity WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.exercise_alias WHERE provider_id IN ('whoop', 'apple_health', 'strava', 'bodyspec', 'manual_review')`;
  await sql`DELETE FROM fitness.food_entry_nutrient WHERE food_entry_id IN (
    SELECT id FROM fitness.food_entry WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.supplement_nutrient WHERE supplement_id IN (
    SELECT id FROM fitness.supplement WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.dexa_scan_region WHERE scan_id IN (
    SELECT id FROM fitness.dexa_scan WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.lab_result WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.lab_panel WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.medication_dose_event WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.medication WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.condition WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.allergy_intolerance WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.health_event WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.dexa_scan WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.journal_entry WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.life_events WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.breathwork_session WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.menstrual_period WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.nutrition_daily WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.food_entry WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.supplement WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.body_measurement_value WHERE body_measurement_id IN (
    SELECT id FROM fitness.body_measurement WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.body_measurement WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.daily_metric_value WHERE daily_metrics_id IN (
    SELECT id FROM fitness.daily_metrics WHERE user_id = ${USER_ID}
  )`;
  await sql`DELETE FROM fitness.daily_metrics WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.sleep_session WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.activity WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.sport_settings WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.user_settings WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.sync_log WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.oauth_token WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.session WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fitness.provider_priority WHERE provider_id IN ('whoop', 'apple_health', 'strava', 'bodyspec', 'manual_review')`;
  await sql`DELETE FROM fitness.provider WHERE user_id = ${USER_ID} AND id IN ('whoop', 'apple_health', 'strava', 'bodyspec', 'manual_review')`;
}

export async function seedCore(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO fitness.user_profile (
      id, name, email, birth_date, max_hr, resting_hr, ftp
    ) VALUES (
      ${USER_ID}, 'Review User', 'review@example.com', '1988-04-12', 190, 52, 285
    )
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          email = EXCLUDED.email,
          birth_date = EXCLUDED.birth_date,
          max_hr = EXCLUDED.max_hr,
          resting_hr = EXCLUDED.resting_hr,
          ftp = EXCLUDED.ftp,
          updated_at = NOW()
  `;

  for (const providerId of SEED_PROVIDER_IDS) {
    await sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES (${providerId}, ${SEED_PROVIDER_NAMES[providerId]}, ${USER_ID})
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            user_id = EXCLUDED.user_id
    `;
  }

  await sql`
    INSERT INTO fitness.provider_priority (
      provider_id, priority, sleep_priority, body_priority, recovery_priority, daily_activity_priority
    ) VALUES
      ('whoop', 1, 1, 3, 1, 2),
      ('apple_health', 2, 2, 2, 2, 1),
      ('strava', 3, NULL, NULL, NULL, 3),
      ('bodyspec', 4, NULL, 1, NULL, NULL),
      ('manual_review', 5, 5, 5, 5, 5)
    ON CONFLICT (provider_id) DO UPDATE
      SET priority = EXCLUDED.priority,
          sleep_priority = EXCLUDED.sleep_priority,
          body_priority = EXCLUDED.body_priority,
          recovery_priority = EXCLUDED.recovery_priority,
          daily_activity_priority = EXCLUDED.daily_activity_priority
  `;

  await sql`
    INSERT INTO fitness.session (id, user_id, expires_at)
    VALUES ('dev-session', ${USER_ID}, NOW() + INTERVAL '365 days')
    ON CONFLICT (id) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          expires_at = EXCLUDED.expires_at
  `;

  await seedUserSettings(sql);
  await seedSportSettings(sql);
  await seedSyncLogs(sql);
}

async function seedUserSettings(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
    VALUES
      (${USER_ID}, 'unitSystem', '"metric"'::jsonb, NOW()),
      (${USER_ID}, 'goalWeight', '78'::jsonb, NOW()),
      (${USER_ID}, 'calorieGoal', '2450'::jsonb, NOW())
    ON CONFLICT (user_id, key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW()
  `;
}

async function seedSportSettings(sql: Sql): Promise<void> {
  const effectiveFrom = daysBefore(new Date(), 180);
  await sql`
    INSERT INTO fitness.sport_settings (
      user_id, sport, ftp, threshold_hr, threshold_pace_per_km,
      power_zone_pcts, hr_zone_pcts, pace_zone_pcts, effective_from, notes
    ) VALUES
      (
        ${USER_ID}, 'cycling', 285, 172, NULL,
        '[0.55,0.75,0.9,1.05,1.2,1.5]'::jsonb,
        '[0.68,0.83,0.9,0.95,1]'::jsonb,
        NULL,
        ${effectiveFrom},
        'Review seed cycling zones'
      ),
      (
        ${USER_ID}, 'running', NULL, 176, 4.55,
        NULL,
        '[0.68,0.83,0.9,0.95,1]'::jsonb,
        '[1.25,1.12,1,0.92,0.85]'::jsonb,
        ${effectiveFrom},
        'Review seed running zones'
      )
    ON CONFLICT (user_id, sport, effective_from) DO UPDATE
      SET ftp = EXCLUDED.ftp,
          threshold_hr = EXCLUDED.threshold_hr,
          threshold_pace_per_km = EXCLUDED.threshold_pace_per_km,
          power_zone_pcts = EXCLUDED.power_zone_pcts,
          hr_zone_pcts = EXCLUDED.hr_zone_pcts,
          pace_zone_pcts = EXCLUDED.pace_zone_pcts,
          notes = EXCLUDED.notes,
          updated_at = NOW()
  `;
}

async function seedSyncLogs(sql: Sql): Promise<void> {
  const today = new Date();
  const rows = [
    ["whoop", "sleep", "success", 90, null, 820, 1],
    ["whoop", "recovery", "success", 180, null, 910, 1],
    ["whoop", "strength", "failed", 0, "Review seed credential expired", 390, 4],
    ["apple_health", "daily_metrics", "success", 180, null, 640, 1],
    ["apple_health", "nutrition", "success", 90, null, 580, 1],
    ["apple_health", "clinical", "success", 16, null, 440, 2],
    ["strava", "activities", "success", 96, null, 1_120, 1],
    ["strava", "streams", "success", 1_400, null, 1_560, 1],
    ["bodyspec", "body_composition", "success", 2, null, 330, 3],
    ["manual_review", "journal", "success", 60, null, 120, 1],
    ["manual_review", "breathwork", "success", 16, null, 140, 1],
    ["manual_review", "cycle", "success", 6, null, 170, 1],
  ] as const;

  for (const [
    providerId,
    dataType,
    status,
    recordCount,
    errorMessage,
    durationMs,
    daysAgo,
  ] of rows) {
    await sql`
      INSERT INTO fitness.sync_log (
        provider_id, user_id, data_type, status, record_count, error_message, duration_ms, synced_at
      ) VALUES (
        ${providerId}, ${USER_ID}, ${dataType}, ${status}, ${recordCount}, ${errorMessage},
        ${durationMs}, ${timestampAt(daysBefore(today, daysAgo), 8, 15)}
      )
    `;
  }
}
