import {
  USER_ID,
  addMinutes,
  daysBefore,
  timestampAt,
  type SeedRandom,
  type Sql,
} from "./helpers.ts";

export async function seedRecovery(sql: Sql, random: SeedRandom): Promise<void> {
  const today = new Date();
  await seedDailyMetrics(sql, random, today);
  await seedSleep(sql, random, today);
  console.log("Seeded: 180 days of recovery metrics and 120 sleep sessions");
}

async function seedDailyMetrics(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  for (let daysAgo = 0; daysAgo < 180; daysAgo++) {
    if (daysAgo > 0 && daysAgo % 43 === 0) continue;

    const date = daysBefore(today, daysAgo);
    const hardBlock = daysAgo >= 24 && daysAgo <= 38;
    const badSleepWeek = daysAgo >= 9 && daysAgo <= 15;
    const highStressDay = daysAgo === 12;
    const restingHr = 50 + Math.round(daysAgo / 60) + (badSleepWeek ? 7 : 0) + random.int(-2, 2);
    const heartRateVariability = 72 - Math.round(daysAgo / 18) - (badSleepWeek ? 16 : 0);
    const steps = hardBlock ? random.int(11_000, 16_000) : random.int(6_000, 12_500);

    await sql`
      INSERT INTO fitness.daily_metrics (
        date, provider_id, user_id, resting_hr, hrv, vo2max, spo2_avg,
        respiratory_rate_avg, skin_temp_c, stress_high_minutes, recovery_high_minutes,
        steps, active_energy_kcal, basal_energy_kcal, distance_km, cycling_distance_km,
        flights_climbed, exercise_minutes, walking_speed, walking_step_length,
        walking_double_support_pct, walking_asymmetry_pct, walking_steadiness,
        stand_hours, resilience_level, source_name
      ) VALUES (
        ${date}, 'whoop', ${USER_ID}, ${restingHr}, ${Math.max(28, heartRateVariability + random.int(-4, 4))},
        ${random.float(47, 55, 1)}, ${random.float(95.4, 99.1, 1)},
        ${random.float(13.2, 16.8, 1)}, ${random.float(35.8, 36.9, 1)},
        ${highStressDay ? 180 : random.int(20, 85)}, ${highStressDay ? 20 : random.int(70, 180)},
        ${steps}, ${hardBlock ? random.int(780, 1_150) : random.int(360, 760)}, 1810,
        ${random.float(4.2, 11.5, 1)}, ${hardBlock ? random.float(18, 55, 1) : random.float(0, 18, 1)},
        ${random.int(3, 24)}, ${hardBlock ? random.int(55, 125) : random.int(22, 70)},
        ${random.float(1.15, 1.55, 2)}, ${random.float(68, 86, 1)},
        ${random.float(18, 27, 1)}, ${random.float(0, 2.5, 1)},
        ${random.float(0.72, 0.98, 2)}, ${random.int(9, 14)},
        ${highStressDay ? "limited" : hardBlock ? "solid" : "strong"}, 'WHOOP Review Seed'
      ) ON CONFLICT DO NOTHING
    `;

    await sql`
      INSERT INTO fitness.daily_metrics (
        date, provider_id, user_id, steps, active_energy_kcal, basal_energy_kcal,
        distance_km, flights_climbed, exercise_minutes, stand_hours, source_name
      ) VALUES (
        ${date}, 'apple_health', ${USER_ID}, ${steps + random.int(-600, 900)},
        ${random.int(330, 820)}, 1790, ${random.float(3.8, 12.2, 1)},
        ${random.int(2, 28)}, ${random.int(20, 95)}, ${random.int(8, 15)}, 'iPhone + Apple Watch'
      ) ON CONFLICT DO NOTHING
    `;
  }
}

async function seedSleep(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  for (let daysAgo = 1; daysAgo <= 90; daysAgo++) {
    const nightDate = daysBefore(today, daysAgo);
    const wakeDate = daysBefore(today, daysAgo - 1);
    const badSleepWeek = daysAgo >= 9 && daysAgo <= 15;
    const bedHour = badSleepWeek ? 23 : 22;
    const bedMinute = random.int(0, 45);
    const wakeHour = badSleepWeek ? 5 : 6;
    const wakeMinute = random.int(0, 45);
    const startedAt = timestampAt(nightDate, bedHour, bedMinute);
    const endedAt = timestampAt(wakeDate, wakeHour, wakeMinute);
    const durationMinutes = Math.round(
      (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000,
    );
    const deepMinutes = badSleepWeek ? random.int(35, 55) : random.int(62, 95);
    const remMinutes = badSleepWeek ? random.int(48, 75) : random.int(88, 125);
    const awakeMinutes = badSleepWeek ? random.int(55, 90) : random.int(18, 42);
    const lightMinutes = Math.max(120, durationMinutes - deepMinutes - remMinutes - awakeMinutes);
    const [{ id: sessionId }] = await sql<{ id: string }[]>`
      INSERT INTO fitness.sleep_session (
        provider_id, user_id, external_id, started_at, ended_at, duration_minutes,
        deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct,
        sleep_type, sleep_need_baseline_minutes, sleep_need_from_debt_minutes,
        sleep_need_from_strain_minutes, sleep_need_from_nap_minutes, source_name
      ) VALUES (
        'whoop', ${USER_ID}, ${`seed-whoop-sleep-${daysAgo}`}, ${startedAt}, ${endedAt},
        ${durationMinutes}, ${deepMinutes}, ${remMinutes}, ${lightMinutes}, ${awakeMinutes},
        ${Math.round(((durationMinutes - awakeMinutes) / durationMinutes) * 1000) / 10},
        'sleep', 480, ${badSleepWeek ? 45 : 10}, ${daysAgo % 5 === 0 ? 35 : 12}, 0,
        'WHOOP Review Seed'
      ) RETURNING id
    `;

    await seedSleepStages(sql, sessionId, startedAt, deepMinutes, remMinutes, lightMinutes, awakeMinutes);

    if (daysAgo <= 30) {
      const appleStart = addMinutes(startedAt, 90);
      const appleEnd = addMinutes(endedAt, -65);
      const appleDuration = Math.round(
        (new Date(appleEnd).getTime() - new Date(appleStart).getTime()) / 60_000,
      );
      await sql`
        INSERT INTO fitness.sleep_session (
          provider_id, user_id, external_id, started_at, ended_at, duration_minutes,
          deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct,
          sleep_type, source_name
        ) VALUES (
          'apple_health', ${USER_ID}, ${`seed-apple-sleep-${daysAgo}`}, ${appleStart}, ${appleEnd},
          ${appleDuration}, ${Math.max(25, deepMinutes - 20)}, ${Math.max(40, remMinutes - 24)},
          ${Math.max(90, lightMinutes - 70)}, ${Math.max(15, awakeMinutes - 8)}, NULL,
          'sleep', 'Apple Watch Review Seed'
        )
      `;
    }
  }
}

async function seedSleepStages(
  sql: Sql,
  sessionId: string,
  startedAt: string,
  deepMinutes: number,
  remMinutes: number,
  lightMinutes: number,
  awakeMinutes: number,
): Promise<void> {
  const stages = [
    ["light", Math.floor(lightMinutes / 2)],
    ["deep", deepMinutes],
    ["light", Math.ceil(lightMinutes / 2)],
    ["rem", remMinutes],
    ["awake", awakeMinutes],
  ] as const;
  let cursor = startedAt;
  for (const [stage, minutes] of stages) {
    const endedAt = addMinutes(cursor, minutes);
    await sql`
      INSERT INTO fitness.sleep_stage (session_id, stage, started_at, ended_at, source_name)
      VALUES (${sessionId}, ${stage}, ${cursor}, ${endedAt}, 'WHOOP Review Seed')
    `;
    cursor = endedAt;
  }
}
