import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const groupId = "10000000-0000-4000-8000-000000000100";
const whoopId = "10000000-0000-4000-8000-000000000101";
const appleHealthId = "10000000-0000-4000-8000-000000000102";
const pelotonId = "10000000-0000-4000-8000-000000000103";
const kayaId = "10000000-0000-4000-8000-000000000104";
const pelotonName = "41 min 58 sec Cardio: Climbing";
const kayaName = "Kaya climbing at Touchstone Great Western Power Company";

const mergedRowSchema = z.object({
  name: z.string().nullable(),
  canonical_type: z.string(),
  provider_id: z.string(),
  member_activity_ids: z.array(z.string()),
});
const selectedFieldsSchema = z.object({
  name: z.string().nullable(),
  notes: z.string().nullable(),
  perceived_exertion: z.number().nullable(),
  canonical_type: z.string(),
  provider_id: z.string(),
});

describe("merged activity field priorities", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES
        ('whoop', 'WHOOP'),
        ('apple_health', 'Apple Health'),
        ('peloton', 'Peloton'),
        ('kaya', 'Kaya')
      ON CONFLICT (id) DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${groupId}, ${TEST_USER_ID})`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      id, group_id, provider_id, user_id, external_id, canonical_type,
      provider_type, started_at, ended_at, name, source_name
    ) VALUES
      (${whoopId}, ${groupId}, 'whoop', ${TEST_USER_ID}, 'whoop-climb',
       'climbing', 'Rock Climbing', '2026-09-01T18:00:00Z', '2026-09-01T18:42:00Z',
       NULL, 'WHOOP'),
      (${appleHealthId}, ${groupId}, 'apple_health', ${TEST_USER_ID}, 'apple-climb',
       'climbing', 'HKWorkoutActivityTypeClimbing', '2026-09-01T18:00:00Z',
       '2026-09-01T18:42:00Z', NULL, 'Apple Health'),
      (${pelotonId}, ${groupId}, 'peloton', ${TEST_USER_ID}, 'peloton-climb',
       'cardio', 'Cardio', '2026-09-01T18:00:00Z', '2026-09-01T18:42:00Z',
       ${pelotonName}, 'Peloton'),
      (${kayaId}, ${groupId}, 'kaya', ${TEST_USER_ID}, 'kaya-climb',
       'climbing', 'rock_climbing', '2026-09-01T18:00:00Z',
       '2026-09-01T18:42:00Z', ${kayaName}, 'Kaya')`);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("uses Kaya's name while retaining WHOOP canonical metadata and raw source names", async () => {
    const merged = await executeWithSchema(
      context.db,
      mergedRowSchema,
      sql`SELECT name, canonical_type, provider_id, member_activity_ids
        FROM fitness.v_activity WHERE id = ${groupId}`,
    );
    expect(merged).toEqual([
      {
        name: kayaName,
        canonical_type: "climbing",
        provider_id: "whoop",
        member_activity_ids: expect.arrayContaining([whoopId, appleHealthId, pelotonId, kayaId]),
      },
    ]);

    const raw = await executeWithSchema(
      context.db,
      z.object({ name: z.string().nullable() }),
      sql`SELECT name FROM fitness.activity WHERE id = ${pelotonId}`,
    );
    expect(raw).toEqual([{ name: pelotonName }]);
  });

  it("applies a notes rule independently of the name and canonical provider", async () => {
    await context.db.execute(sql`UPDATE fitness.activity SET notes = 'Peloton note'
      WHERE id = ${pelotonId}`);
    await context.db.execute(sql`UPDATE fitness.activity SET notes = 'Kaya route notes'
      WHERE id = ${kayaId}`);
    await context.db.execute(sql`INSERT INTO fitness.provider_field_priority
      (provider_id, field_key, priority) VALUES ('kaya', 'activity.notes', 0)
      ON CONFLICT (provider_id, field_key) DO UPDATE SET priority = excluded.priority`);

    const rows = await executeWithSchema(
      context.db,
      selectedFieldsSchema,
      sql`SELECT name, notes, perceived_exertion, canonical_type, provider_id
        FROM fitness.v_activity WHERE id = ${groupId}`,
    );
    expect(rows).toEqual([
      {
        name: kayaName,
        notes: "Kaya route notes",
        perceived_exertion: null,
        canonical_type: "climbing",
        provider_id: "whoop",
      },
    ]);
  });

  it("applies a perceived exertion rule independently of name selection", async () => {
    const effortGroupId = "10000000-0000-4000-8000-000000000110";
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${effortGroupId}, ${TEST_USER_ID}) ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, name, perceived_exertion
    ) VALUES
      (${effortGroupId}, 'whoop', ${TEST_USER_ID}, 'whoop-effort', 'climbing',
       'Rock Climbing', '2026-09-02T18:00:00Z', '2026-09-02T19:00:00Z', NULL, 8),
      (${effortGroupId}, 'peloton', ${TEST_USER_ID}, 'peloton-effort', 'cardio',
       'Cardio', '2026-09-02T18:00:00Z', '2026-09-02T19:00:00Z', 'Peloton workout', 4)
      ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.provider_field_priority
      (provider_id, field_key, priority)
      VALUES ('whoop', 'activity.perceived_exertion', 0)
      ON CONFLICT (provider_id, field_key) DO UPDATE SET priority = excluded.priority`);

    const rows = await executeWithSchema(
      context.db,
      selectedFieldsSchema,
      sql`SELECT name, notes, perceived_exertion, canonical_type, provider_id
        FROM fitness.v_activity WHERE id = ${effortGroupId}`,
    );
    expect(rows).toEqual([
      {
        name: "Peloton workout",
        notes: null,
        perceived_exertion: 8,
        canonical_type: "climbing",
        provider_id: "whoop",
      },
    ]);
  });

  it("skips a null preferred name and falls back to generic priority", async () => {
    const nullNameGroupId = "10000000-0000-4000-8000-000000000120";
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${nullNameGroupId}, ${TEST_USER_ID}) ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, name
    ) VALUES
      (${nullNameGroupId}, 'kaya', ${TEST_USER_ID}, 'kaya-unnamed', 'climbing',
       'rock_climbing', '2026-09-03T18:00:00Z', '2026-09-03T19:00:00Z', NULL),
      (${nullNameGroupId}, 'peloton', ${TEST_USER_ID}, 'peloton-named', 'cardio',
       'Cardio', '2026-09-03T18:00:00Z', '2026-09-03T19:00:00Z', 'Peloton fallback')
      ON CONFLICT DO NOTHING`);

    const rows = await executeWithSchema(
      context.db,
      z.object({ name: z.string().nullable(), canonical_type: z.string() }),
      sql`SELECT name, canonical_type FROM fitness.v_activity WHERE id = ${nullNameGroupId}`,
    );
    expect(rows).toEqual([{ name: "Peloton fallback", canonical_type: "climbing" }]);
  });

  it("uses generic device priority when no field rule exists", async () => {
    const deviceGroupId = "10000000-0000-4000-8000-000000000130";
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${deviceGroupId}, ${TEST_USER_ID}) ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, name, source_name
    ) VALUES
      (${deviceGroupId}, 'apple_health', ${TEST_USER_ID}, 'apple-device', 'cycling',
       'Cycling', '2026-09-04T18:00:00Z', '2026-09-04T19:00:00Z',
       'Device workout', 'Wahoo TICKR X'),
      (${deviceGroupId}, 'peloton', ${TEST_USER_ID}, 'peloton-device', 'cardio',
       'Cardio', '2026-09-04T18:00:00Z', '2026-09-04T19:00:00Z',
       'Peloton generic', 'Peloton') ON CONFLICT DO NOTHING`);

    const rows = await executeWithSchema(
      context.db,
      z.object({ name: z.string().nullable() }),
      sql`SELECT name FROM fitness.v_activity WHERE id = ${deviceGroupId}`,
    );
    expect(rows).toEqual([{ name: "Device workout" }]);
  });

  it("lets an arbitrary provider's 64-bit name priority beat device priority", async () => {
    const customGroupId = "10000000-0000-4000-8000-000000000135";
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('field-test-a', 'Field Test A') ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.provider_field_priority
      (provider_id, field_key, priority)
      VALUES ('field-test-a', 'activity.name', -2147483649)
      ON CONFLICT (provider_id, field_key) DO UPDATE SET priority = excluded.priority`);
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${customGroupId}, ${TEST_USER_ID}) ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, name, notes, source_name
    ) VALUES
      (${customGroupId}, 'apple_health', ${TEST_USER_ID}, 'device-custom',
       'climbing', 'Climbing', '2026-09-04T20:00:00Z', '2026-09-04T21:00:00Z',
       'Device name', 'Device note', 'Wahoo TICKR X'),
      (${customGroupId}, 'field-test-a', ${TEST_USER_ID}, 'custom-name',
       'climbing', 'Climbing', '2026-09-04T20:00:00Z', '2026-09-04T21:00:00Z',
       'Custom name', 'Custom note', 'Field Test A') ON CONFLICT DO NOTHING`);

    const rows = await executeWithSchema(
      context.db,
      z.object({ name: z.string(), notes: z.string(), provider_id: z.string() }),
      sql`SELECT name, notes, provider_id FROM fitness.v_activity WHERE id = ${customGroupId}`,
    );
    expect(rows).toEqual([
      { name: "Custom name", notes: "Device note", provider_id: "apple_health" },
    ]);
  });

  it("breaks equal-priority name ties by source activity ID", async () => {
    const tieGroupId = "10000000-0000-4000-8000-000000000140";
    const lowerId = "10000000-0000-4000-8000-000000000141";
    const higherId = "10000000-0000-4000-8000-000000000142";
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('field-test-b', 'Field Test B'), ('field-test-c', 'Field Test C')
      ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.provider_priority (provider_id, priority)
      VALUES ('field-test-b', 50), ('field-test-c', 50)
      ON CONFLICT (provider_id) DO UPDATE SET priority = excluded.priority`);
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${tieGroupId}, ${TEST_USER_ID}) ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      id, group_id, provider_id, user_id, external_id, canonical_type,
      provider_type, started_at, ended_at, name
    ) VALUES
      (${higherId}, ${tieGroupId}, 'field-test-b', ${TEST_USER_ID}, 'higher-id',
       'walking', 'walking', '2026-09-05T18:00:00Z', '2026-09-05T19:00:00Z',
       'Higher ID'),
      (${lowerId}, ${tieGroupId}, 'field-test-c', ${TEST_USER_ID}, 'lower-id',
       'walking', 'walking', '2026-09-05T18:00:00Z', '2026-09-05T19:00:00Z',
       'Lower ID') ON CONFLICT DO NOTHING`);

    const rows = await executeWithSchema(
      context.db,
      z.object({ name: z.string().nullable(), canonical_type: z.string() }),
      sql`SELECT name, canonical_type FROM fitness.v_activity WHERE id = ${tieGroupId}`,
    );
    expect(rows).toEqual([{ name: "Lower ID", canonical_type: "walking" }]);
  });

  it("keeps an unrelated group's name and canonical type without a field rule", async () => {
    const unrelatedGroupId = "10000000-0000-4000-8000-000000000150";
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id)
      VALUES (${unrelatedGroupId}, ${TEST_USER_ID}) ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      group_id, provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, name
    ) VALUES
      (${unrelatedGroupId}, 'whoop', ${TEST_USER_ID}, 'whoop-unrelated', 'cycling',
       'Cycling', '2026-09-06T18:00:00Z', '2026-09-06T19:00:00Z', NULL),
      (${unrelatedGroupId}, 'peloton', ${TEST_USER_ID}, 'peloton-unrelated', 'cardio',
       'Cardio', '2026-09-06T18:00:00Z', '2026-09-06T19:00:00Z', 'Morning ride')
      ON CONFLICT DO NOTHING`);

    const rows = await executeWithSchema(
      context.db,
      z.object({ name: z.string().nullable(), canonical_type: z.string() }),
      sql`SELECT name, canonical_type FROM fitness.v_activity WHERE id = ${unrelatedGroupId}`,
    );
    expect(rows).toEqual([{ name: "Morning ride", canonical_type: "cycling" }]);
  });

  it("audits field priority inserts, updates, and deletes with their field key", async () => {
    const auditProviderId = `field-audit-${randomUUID()}`;
    await context.db.execute(sql`INSERT INTO fitness.provider_field_priority
      (provider_id, field_key, priority) VALUES (${auditProviderId}, 'activity.notes', 5)`);
    await context.db.execute(sql`UPDATE fitness.provider_field_priority SET priority = 7
      WHERE provider_id = ${auditProviderId} AND field_key = 'activity.notes'`);
    await context.db.execute(sql`DELETE FROM fitness.provider_field_priority
      WHERE provider_id = ${auditProviderId} AND field_key = 'activity.notes'`);

    const auditIds = await executeWithSchema(
      context.db,
      z.object({ id: z.string() }),
      sql`SELECT id FROM fitness.provider_priority_audit
        WHERE provider_id = ${auditProviderId} AND priority_table = 'provider_field_priority'`,
    );
    expect(auditIds).toHaveLength(3);

    const auditRows = await executeWithSchema(
      context.db,
      z.object({
        field_key: z.string(),
        old_priority: z.number().nullable(),
        new_priority: z.number().nullable(),
      }),
      sql`SELECT field_key,
        (old_value->>'priority')::integer AS old_priority,
        (new_value->>'priority')::integer AS new_priority
        FROM fitness.provider_priority_audit
        WHERE provider_id = ${auditProviderId} AND priority_table = 'provider_field_priority'`,
    );
    expect(auditRows).toEqual(
      expect.arrayContaining([
        { field_key: "activity.notes", old_priority: null, new_priority: 5 },
        { field_key: "activity.notes", old_priority: 5, new_priority: 7 },
        { field_key: "activity.notes", old_priority: 7, new_priority: null },
      ]),
    );

    const seedAudit = await executeWithSchema(
      context.db,
      z.object({ field_key: z.string(), new_priority: z.number() }),
      sql`SELECT field_key, (new_value->>'priority')::integer AS new_priority
        FROM fitness.provider_priority_audit
        WHERE provider_id = 'kaya' AND priority_table = 'provider_field_priority'
          AND field_key = 'activity.name'`,
    );
    expect(seedAudit).toEqual([{ field_key: "activity.name", new_priority: 0 }]);
  });
});
