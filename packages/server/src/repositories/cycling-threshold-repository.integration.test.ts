import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

describe("CyclingThresholdRepository database semantics", () => {
  const analyticsDatabase = `manual_ftp_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const providerId = `manual-ftp-${randomUUID()}`;
  const canonicalId = randomUUID();
  const groupedMemberId = randomUUID();
  const fallbackId = randomUUID();
  const noNpId = randomUUID();
  const clearedId = randomUUID();
  const absentId = randomUUID();
  const withdrawnId = randomUUID();
  const beforeInstantStartId = randomUUID();
  const atInstantStartId = randomUUID();
  const insideAfterMidnightId = randomUUID();
  const atInstantEndId = randomUUID();
  let postgres: TestContext;
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(schema: TSchema, query: string, params = {}) {
      const result = await clickhouse.query({
        query: query.replaceAll("analytics.", `${analyticsDatabase}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    postgres = await setupTestDatabase();
    await postgres.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Manual FTP integration')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id) VALUES (${providerId}, 'Manual FTP fixture', ${userId}::uuid)
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.sport_settings (user_id, sport, ftp, effective_from) VALUES
        (${userId}::uuid, 'cycling', 200, '2026-06-14'),
        (${userId}::uuid, 'cycling', 250, '2026-06-15'),
        (${userId}::uuid, 'cycling', 220, '2026-06-16'),
        (${userId}::uuid, 'cycling', NULL, '2026-06-17')
    `);
    await postgres.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, raw, local_time_source, start_utc_offset_minutes,
        provider_absent_at, deleted_at
      ) VALUES
        (${canonicalId}::uuid, ${canonicalId}::uuid, ${providerId}, ${userId}::uuid, 'canonical', 'cycling', 'cycling',
          '2026-06-15T00:30:00Z', '2026-06-15T01:30:00Z', '{}'::jsonb, 'provider_offset', 120, NULL, NULL),
        (${groupedMemberId}::uuid, ${canonicalId}::uuid, ${providerId}, ${userId}::uuid, 'grouped-member', 'cycling', 'cycling',
          '2026-06-15T00:30:00Z', '2026-06-15T01:30:00Z', '{}'::jsonb, 'provider_offset', 120, NULL, NULL),
        (${fallbackId}::uuid, ${fallbackId}::uuid, ${providerId}, ${userId}::uuid, 'fallback', 'cycling', 'cycling',
          '2026-06-15T00:30:00Z', '2026-06-15T01:30:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL),
        (${noNpId}::uuid, ${noNpId}::uuid, ${providerId}, ${userId}::uuid, 'no-np', 'cycling', 'cycling',
          '2026-06-15T12:00:00Z', '2026-06-15T13:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL),
        (${clearedId}::uuid, ${clearedId}::uuid, ${providerId}, ${userId}::uuid, 'clear', 'cycling', 'cycling',
          '2026-06-17T12:00:00Z', '2026-06-17T13:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL),
        (${absentId}::uuid, ${absentId}::uuid, ${providerId}, ${userId}::uuid, 'provider-absent', 'cycling', 'cycling',
          '2026-06-15T12:00:00Z', '2026-06-15T13:00:00Z', '{}'::jsonb, 'unknown', NULL, now(), NULL),
        (${withdrawnId}::uuid, ${withdrawnId}::uuid, ${providerId}, ${userId}::uuid, 'withdrawn', 'cycling', 'cycling',
          '2026-06-15T12:00:00Z', '2026-06-15T13:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, now()),
        (${beforeInstantStartId}::uuid, ${beforeInstantStartId}::uuid, ${providerId}, ${userId}::uuid, 'before-instant-start', 'cycling', 'cycling',
          '2026-06-15T01:00:00Z', '2026-06-15T02:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL),
        (${atInstantStartId}::uuid, ${atInstantStartId}::uuid, ${providerId}, ${userId}::uuid, 'at-instant-start', 'cycling', 'cycling',
          '2026-06-15T06:00:00Z', '2026-06-15T07:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL),
        (${insideAfterMidnightId}::uuid, ${insideAfterMidnightId}::uuid, ${providerId}, ${userId}::uuid, 'inside-after-midnight', 'cycling', 'cycling',
          '2026-06-16T01:00:00Z', '2026-06-16T02:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL),
        (${atInstantEndId}::uuid, ${atInstantEndId}::uuid, ${providerId}, ${userId}::uuid, 'at-instant-end', 'cycling', 'cycling',
          '2026-06-16T06:00:00Z', '2026-06-16T07:00:00Z', '{}'::jsonb, 'unknown', NULL, NULL, NULL)
    `);
    await clickhouse.command({ query: `CREATE DATABASE ${analyticsDatabase}` });
    await clickhouse.command({
      query: `CREATE TABLE ${analyticsDatabase}.cycling_activity_power_metrics (
        user_id UUID, activity_id UUID, normalized_power Nullable(Float64), power_sample_count UInt64
      ) ENGINE = Memory`,
    });
    await clickhouse.command({
      query: `INSERT INTO ${analyticsDatabase}.cycling_activity_power_metrics VALUES
        ('${userId}', '${canonicalId}', 250, 3600),
        ('${userId}', '${fallbackId}', 250, 3600),
        ('${userId}', '${clearedId}', 250, 3600)`,
    });
  }, 60_000);

  afterAll(async () => {
    await postgres?.cleanup();
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${analyticsDatabase} SYNC` });
    await clickhouse.close?.();
  });

  it("uses source-local FTP dates for canonical groups and user-zone fallback when context is missing", async () => {
    const repository = new CyclingThresholdRepository(
      postgres.db,
      store,
      userId,
      "America/Los_Angeles",
    );
    const metrics = await repository.getForActivities([canonicalId, groupedMemberId, fallbackId]);
    expect(metrics.get(canonicalId)).toMatchObject({
      activity_id: canonicalId,
      activity_date: "2026-06-15",
      normalized_power: 250,
      power_tss: 100,
      ftp: 250,
    });
    expect(metrics.get(groupedMemberId)).toMatchObject({
      activity_id: canonicalId,
      activity_date: "2026-06-15",
      ftp: 250,
      power_tss: 100,
    });
    expect(metrics.get(fallbackId)).toMatchObject({
      activity_date: "2026-06-14",
      ftp: 200,
      power_tss: 156.25,
    });
  });

  it("keeps configured FTP without an NP row, applies dated clears, and excludes deleted activities", async () => {
    const repository = new CyclingThresholdRepository(
      postgres.db,
      store,
      userId,
      "America/Los_Angeles",
    );
    const metrics = await repository.getForActivities([noNpId, clearedId, absentId, withdrawnId]);
    expect(metrics.get(noNpId)).toMatchObject({
      ftp: 250,
      normalized_power: null,
      power_tss: null,
    });
    expect(metrics.get(clearedId)).toMatchObject({
      ftp: null,
      intensity_factor: null,
      power_tss: null,
    });
    expect(metrics.get(absentId)).toMatchObject({ activity_id: absentId, ftp: 250 });
    expect(metrics.has(withdrawnId)).toBe(false);
  });

  it("preserves context-zone entitlement boundaries while using source-local FTP date", async () => {
    const repository = new CyclingThresholdRepository(
      postgres.db,
      store,
      userId,
      "America/Los_Angeles",
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-06-14",
        endDateExclusive: "2026-06-15",
      },
    );
    const metrics = await repository.getForActivities([canonicalId]);
    expect(metrics.get(canonicalId)).toMatchObject({ activity_date: "2026-06-15", ftp: 250 });
  });

  it("preserves explicit timestamp access bounds and both half-open edges", async () => {
    const repository = new CyclingThresholdRepository(postgres.db, store, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-06-15T06:00:00Z",
      endDateExclusive: "2026-06-16T06:00:00Z",
    });
    const metrics = await repository.getForActivities([
      beforeInstantStartId,
      atInstantStartId,
      insideAfterMidnightId,
      atInstantEndId,
    ]);
    expect(metrics.has(beforeInstantStartId)).toBe(false);
    expect(metrics.has(atInstantStartId)).toBe(true);
    expect(metrics.has(insideAfterMidnightId)).toBe(true);
    expect(metrics.has(atInstantEndId)).toBe(false);
  });
});
