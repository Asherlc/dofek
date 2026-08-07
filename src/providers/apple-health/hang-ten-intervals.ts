import { eq, sql } from "drizzle-orm";
import type { SyncDatabase } from "../../db/index.ts";
import { activityInterval } from "../../db/schema.ts";
import type { HangTenActivitySegment, HealthWorkout } from "./workouts.ts";

export function hangTenIntervalLabel(segment: HangTenActivitySegment): string {
  if (segment.kind === "rest") return `Step ${segment.stepNumber}: Rest`;
  if (segment.sizeMillimeters !== undefined && segment.holdType) {
    return `Step ${segment.stepNumber}: ${segment.sizeMillimeters} mm ${segment.holdType}`;
  }
  if (segment.holdType) return `Step ${segment.stepNumber}: ${segment.holdType}`;
  return `Step ${segment.stepNumber}: Work`;
}

export function buildHangTenIntervals(
  activityId: string,
  workout: HealthWorkout,
): (typeof activityInterval.$inferInsert)[] {
  const segments = workout.hangTen?.activitySegments;
  if (!segments || segments.length === 0) return [];

  const rows: (typeof activityInterval.$inferInsert)[] = [];
  let cursor = workout.startDate;
  let offsetsAreUnambiguous = true;
  for (const [index, segment] of segments.entries()) {
    const startedAt = cursor;
    const endedAt: Date | undefined =
      offsetsAreUnambiguous && segment.durationSeconds !== undefined
        ? new Date(cursor.getTime() + segment.durationSeconds * 1000)
        : undefined;
    rows.push({
      activityId,
      intervalIndex: index,
      label: hangTenIntervalLabel(segment),
      intervalType: segment.kind,
      startedAt,
      endedAt,
    });
    if (endedAt) {
      cursor = endedAt;
    } else {
      offsetsAreUnambiguous = false;
    }
  }
  return rows;
}

export async function replaceHangTenIntervals(
  db: SyncDatabase,
  activityId: string,
  workout: HealthWorkout,
): Promise<void> {
  const intervals = buildHangTenIntervals(activityId, workout);
  if (intervals.length === 0) {
    await db.delete(activityInterval).where(eq(activityInterval.activityId, activityId));
    return;
  }

  const replacementValues = sql.join(
    intervals.map(
      (interval) => sql`(
        ${interval.activityId}::uuid,
        ${interval.intervalIndex},
        ${interval.label ?? null},
        ${interval.intervalType ?? null},
        ${interval.startedAt},
        ${interval.endedAt ?? null}
      )`,
    ),
    sql`, `,
  );

  await db.execute(sql`
    WITH deleted AS (
      DELETE FROM ${activityInterval}
      WHERE ${activityInterval.activityId} = ${activityId}
    )
    INSERT INTO ${activityInterval} (
      ${activityInterval.activityId},
      ${activityInterval.intervalIndex},
      ${activityInterval.label},
      ${activityInterval.intervalType},
      ${activityInterval.startedAt},
      ${activityInterval.endedAt}
    )
    VALUES ${replacementValues}
  `);
}
