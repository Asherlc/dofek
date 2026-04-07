import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  type Database,
  HEALTHKIT_STAGE_MAP,
  MAX_SLEEP_SESSION_GAP_MS,
  PROVIDER_ID,
  type SleepSample,
} from "./health-kit-sync-schemas.ts";

function parseIsoTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return milliseconds;
}

export function isSleepStageValue(value: string): boolean {
  return (
    value === "asleep" ||
    value === "asleepUnspecified" ||
    value === "asleepCore" ||
    value === "asleepDeep" ||
    value === "asleepREM"
  );
}

export function deriveSleepSessionsFromStages(samples: SleepSample[]): SleepSample[] {
  const sessions: SleepSample[] = [];
  const bySource = new Map<string, SleepSample[]>();

  for (const sample of samples) {
    if (!isSleepStageValue(sample.value) && sample.value !== "awake") continue;
    const sourceSamples = bySource.get(sample.sourceName) ?? [];
    sourceSamples.push(sample);
    bySource.set(sample.sourceName, sourceSamples);
  }

  for (const [sourceName, sourceSamples] of bySource) {
    const sorted = sourceSamples
      .map((sample) => ({
        sample,
        startMs: parseIsoTimestamp(sample.startDate),
        endMs: parseIsoTimestamp(sample.endDate),
      }))
      .filter((entry): entry is { sample: SleepSample; startMs: number; endMs: number } => {
        if (entry.startMs === null || entry.endMs === null) return false;
        return entry.endMs > entry.startMs;
      })
      .sort((a, b) => a.startMs - b.startMs);

    if (sorted.length === 0) continue;

    const firstEntry = sorted[0];
    if (!firstEntry) continue;

    let currentStart = firstEntry.startMs;
    let currentEnd = firstEntry.endMs;
    let currentUuid = firstEntry.sample.uuid;
    let currentHasSleepStage = isSleepStageValue(firstEntry.sample.value);

    for (let index = 1; index < sorted.length; index++) {
      const entry = sorted[index];
      if (!entry) continue;

      if (entry.startMs <= currentEnd + MAX_SLEEP_SESSION_GAP_MS) {
        if (entry.endMs > currentEnd) {
          currentEnd = entry.endMs;
        }
        if (isSleepStageValue(entry.sample.value)) {
          currentHasSleepStage = true;
        }
        continue;
      }

      if (currentHasSleepStage) {
        sessions.push({
          uuid: currentUuid,
          startDate: new Date(currentStart).toISOString(),
          endDate: new Date(currentEnd).toISOString(),
          value: "inBed",
          sourceName,
        });
      }

      currentStart = entry.startMs;
      currentEnd = entry.endMs;
      currentUuid = entry.sample.uuid;
      currentHasSleepStage = isSleepStageValue(entry.sample.value);
    }

    if (currentHasSleepStage) {
      sessions.push({
        uuid: currentUuid,
        startDate: new Date(currentStart).toISOString(),
        endDate: new Date(currentEnd).toISOString(),
        value: "inBed",
        sourceName,
      });
    }
  }

  return sessions;
}

function mapHealthKitStage(value: string): string | null {
  return HEALTHKIT_STAGE_MAP[value] ?? null;
}

/** Process sleep samples, grouping by inBed boundaries */
export async function processSleepSamples(
  db: Database,
  userId: string,
  samples: SleepSample[],
): Promise<number> {
  const explicitInBedSamples = samples.filter((s) => s.value === "inBed");
  const inBedSamples =
    explicitInBedSamples.length > 0 ? explicitInBedSamples : deriveSleepSessionsFromStages(samples);
  const stageSamples = samples.filter((s) => s.value !== "inBed");

  if (inBedSamples.length === 0) return 0;

  let inserted = 0;
  for (const session of inBedSamples) {
    const sessionStart = new Date(session.startDate).getTime();
    const sessionEnd = new Date(session.endDate).getTime();

    // Filter stages that overlap this session
    const overlapping = stageSamples.filter((stage) => {
      const stageStart = new Date(stage.startDate).getTime();
      const stageEnd = new Date(stage.endDate).getTime();
      return stageStart >= sessionStart && stageEnd <= sessionEnd;
    });

    // Group stages by source so each source gets its own row.
    // The v_sleep materialized view handles deduplication via device/provider priority.
    const stagesBySource = new Map<string, SleepSample[]>();
    for (const stage of overlapping) {
      const existing = stagesBySource.get(stage.sourceName) ?? [];
      existing.push(stage);
      stagesBySource.set(stage.sourceName, existing);
    }

    const durationMinutes = Math.round((sessionEnd - sessionStart) / (1000 * 60));

    // Clean up legacy single-source row (old format without source suffix)
    const legacyExternalId = `hk:sleep:${session.uuid}`;
    await db.execute(
      sql`DELETE FROM fitness.sleep_session
          WHERE user_id = ${userId} AND provider_id = ${PROVIDER_ID} AND external_id = ${legacyExternalId}`,
    );

    // Determine sources to insert: one row per source, or one row with session source if no stages
    const sources: Array<[string, SleepSample[]]> =
      stagesBySource.size > 0 ? [...stagesBySource.entries()] : [[session.sourceName, []]];

    for (const [sourceName, stages] of sources) {
      let deepMinutes = 0;
      let remMinutes = 0;
      let lightMinutes = 0;
      let awakeMinutes = 0;

      for (const stage of stages) {
        const stageStart = new Date(stage.startDate).getTime();
        const stageEnd = new Date(stage.endDate).getTime();
        const stageDuration = Math.round((stageEnd - stageStart) / (1000 * 60));
        switch (stage.value) {
          case "asleep":
          case "asleepUnspecified":
            lightMinutes += stageDuration;
            break;
          case "asleepDeep":
            deepMinutes += stageDuration;
            break;
          case "asleepREM":
            remMinutes += stageDuration;
            break;
          case "asleepCore":
            lightMinutes += stageDuration;
            break;
          case "awake":
            awakeMinutes += stageDuration;
            break;
        }
      }

      const externalId = `hk:sleep:${session.uuid}:${sourceName}`;
      const sessionResult = await executeWithSchema(
        db,
        z.object({ id: z.string().uuid() }),
        sql`INSERT INTO fitness.sleep_session (user_id, provider_id, external_id, started_at, ended_at, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, sleep_type, source_name)
            VALUES (
              ${userId},
              ${PROVIDER_ID},
              ${externalId},
              ${session.startDate}::timestamptz,
              ${session.endDate}::timestamptz,
              ${durationMinutes},
              ${deepMinutes},
              ${remMinutes},
              ${lightMinutes},
              ${awakeMinutes},
              ${null},
              ${sourceName}
            )
            ON CONFLICT (user_id, provider_id, external_id) DO UPDATE SET
              started_at = ${session.startDate}::timestamptz,
              ended_at = ${session.endDate}::timestamptz,
              duration_minutes = ${durationMinutes},
              deep_minutes = ${deepMinutes},
              rem_minutes = ${remMinutes},
              light_minutes = ${lightMinutes},
              awake_minutes = ${awakeMinutes},
              sleep_type = ${null},
              source_name = ${sourceName}
            RETURNING id`,
      );

      // Insert individual sleep stage intervals
      const sessionId = sessionResult[0]?.id;
      if (sessionId && stages.length > 0) {
        await db.execute(
          sql`DELETE FROM fitness.sleep_stage WHERE session_id = ${sessionId}::uuid`,
        );

        const stageValues = stages
          .map((stage) => {
            const mapped = mapHealthKitStage(stage.value);
            if (!mapped) return null;
            return sql`(${sessionId}::uuid, ${mapped}, ${stage.startDate}::timestamptz, ${stage.endDate}::timestamptz, ${stage.sourceName})`;
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);

        if (stageValues.length > 0) {
          await db.execute(
            sql`INSERT INTO fitness.sleep_stage (session_id, stage, started_at, ended_at, source_name)
                VALUES ${sql.join(stageValues, sql`, `)}`,
          );
        }
      }

      inserted++;
    }
  }

  return inserted;
}
