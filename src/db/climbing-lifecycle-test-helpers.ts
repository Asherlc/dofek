import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./index.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "./schema/climbing.ts";

export async function seedOwnedClimbingGraph(db: Database, userId: string, providerId: string) {
  await db.execute(
    sql`INSERT INTO fitness.provider(id,name) VALUES(${providerId},${providerId}) ON CONFLICT DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId}::uuid,'Climbing lifecycle user') ON CONFLICT DO NOTHING`,
  );
  const ids = {
    area: randomUUID(),
    climb: randomUUID(),
    pitch: randomUUID(),
    log: randomUUID(),
    whole: randomUUID(),
    child: randomUUID(),
  };
  await db.insert(area).values({
    id: ids.area,
    userId,
    providerId,
    name: "Recorded area",
    coordinates: { x: 0, y: 0 },
  });
  await db.insert(climb).values({
    id: ids.climb,
    userId,
    providerId,
    externalId: randomUUID(),
    name: "Recorded route",
    kind: "route",
    areaId: ids.area,
    coordinates: { x: -122.25, y: 37.5 },
  });
  await db.insert(pitch).values({
    id: ids.pitch,
    climbId: ids.climb,
    externalId: randomUUID(),
    number: 1,
    name: "Recorded pitch",
  });
  await db
    .insert(climbGrade)
    .values({ climbId: ids.climb, value: "5.10a", system: "yds", position: 0 });
  await db
    .insert(pitchGrade)
    .values({ pitchId: ids.pitch, value: "A2", system: "aid", position: 0 });
  await db.insert(climbingLogEntry).values({
    id: ids.log,
    userId,
    providerId,
    climbId: ids.climb,
    externalId: randomUUID(),
    climbedOn: null,
    notes: "Retained source note",
    raw: { marker: "Retained raw payload" },
    providerAbsentAt: new Date("2026-10-02T10:00:00Z"),
  });
  await db
    .insert(climbingLogEntryGrade)
    .values({ climbingLogEntryId: ids.log, value: "5.10b", system: "yds", position: 0 });
  await db.insert(climbingAttempt).values({
    id: ids.whole,
    climbingLogEntryId: ids.log,
    scope: "climb",
    outcome: "completed",
    usedAid: true,
  });
  await db.insert(climbingAttempt).values({
    id: ids.child,
    climbingLogEntryId: ids.log,
    scope: "pitch",
    pitchId: ids.pitch,
    parentAttemptId: ids.whole,
    outcome: "completed",
    ropeMethod: "lead",
    solo: true,
  });
  return ids;
}
