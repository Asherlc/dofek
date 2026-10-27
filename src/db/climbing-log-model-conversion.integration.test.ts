import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupClimbingConversionDatabase } from "./climbing-log-conversion-test-helpers.ts";
import {
  convertClimbingLogBatch,
  inspectClimbingLogConversion,
  validateClimbingLogConversion,
} from "./climbing-log-model-conversion.ts";
import { persistClimbingLogEntries } from "./climbing-log-sync.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { executeWithSchema } from "./typed-sql.ts";

describe("bounded populated climbing conversion", () => {
  let context: Awaited<ReturnType<typeof setupClimbingConversionDatabase>>;
  beforeEach(async () => {
    context = await setupClimbingConversionDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${TEST_USER_ID}::uuid,'Conversion test user')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('openbeta','OpenBeta'),('mountain-project','Mountain Project'),('kaya','Kaya'),('kaya-export','Kaya CSV') ON CONFLICT DO NOTHING`,
    );
  }, 120000);
  afterEach(async () => {
    await context?.cleanup();
  });
  async function seed(
    raw: Record<string, unknown>,
    options: { provider?: string; result?: string; count?: number; external?: string } = {},
  ) {
    const id = randomUUID();
    const external = options.external ?? id;
    await context.db.execute(
      sql`INSERT INTO fitness.climbing_entry(id,user_id,provider_id,unattached_date,external_id,climb_type,grade_system,grade,result_style,attempt_count,route_name,location_path,source_name,raw,created_at,provider_absent_at) VALUES(${id}::uuid,${TEST_USER_ID}::uuid,${options.provider ?? "openbeta"},'2026-10-01',${external},'route','yds','5.10a',${options.result ?? null},${options.count ?? null},'Corner','[{"name":"Wall","externalId":"wall","kind":null}]'::jsonb,'Source',${JSON.stringify(raw)}::jsonb,'2026-10-01T10:00:00Z','2026-10-02T10:00:00Z')`,
    );
    return id;
  }
  const source = {
    _id: "source-tick",
    dateClimbed: 1790812800000,
    notes: "Recorded source note",
    grade: "5.10d",
    style: "Lead",
    attemptType: "Fell/Hung",
    climb: {
      uuid: "source-climb",
      name: "Corner",
      grades: { yds: "5.10a" },
      metadata: { lat: 0, lng: -122.25 },
      pitches: [
        { id: "source-pitch", parentId: "source-climb", pitchNumber: 1, grades: { yds: "5.9" } },
      ],
    },
  };
  it("preserves UUIDs, source date, coordinates, grade ownership, pitch definitions and nullable Fell/Hung completion", async () => {
    const id = await seed(source, { result: "Fell/Hung", count: 3 });
    const attemptId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.climbing_attempt(id,climbing_entry_id,attempt_index,outcome,failure_reason,notes,created_at) VALUES(${attemptId}::uuid,${id}::uuid,1,'failed','fell','Existing note','2026-10-01T11:00:00Z')`,
    );
    expect((await inspectClimbingLogConversion(context.db)).conflicts).toEqual([]);
    await context.prepare();
    await expect(context.finalize()).rejects.toThrow();
    expect(await convertClimbingLogBatch(context.db, 1)).toEqual({ converted: 1, remaining: 0 });
    expect(await convertClimbingLogBatch(context.db, 1)).toEqual({ converted: 0, remaining: 0 });
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual([]);
    await context.finalize();
    const [log] = await executeWithSchema(
      context.db,
      z.object({
        id: z.string(),
        climbed_on: z.string(),
        raw: z.record(z.string(), z.unknown()),
        notes: z.string(),
        point: z.string(),
        provider_absent_at: z.coerce.date(),
      }),
      sql`SELECT e.id,e.climbed_on,e.raw,e.notes,c.coordinates::text AS point,e.provider_absent_at FROM fitness.climbing_log_entry e JOIN fitness.climb c ON c.id=e.climb_id WHERE e.id=${id}::uuid`,
    );
    expect(log).toMatchObject({
      id,
      climbed_on: "2026-10-01",
      raw: source,
      notes: "Recorded source note",
      point: "(-122.25,0)",
    });
    const attempts = await executeWithSchema(
      context.db,
      z.object({
        id: z.string(),
        scope: z.string(),
        outcome: z.string().nullable(),
        fell_or_hung: z.boolean().nullable(),
        attempt_index: z.coerce.number().nullable(),
        notes: z.string().nullable(),
      }),
      sql`SELECT id,scope,outcome,fell_or_hung,attempt_index,notes FROM fitness.climbing_attempt WHERE climbing_log_entry_id=${id}::uuid`,
    );
    expect(attempts).toHaveLength(3);
    expect(attempts.find((a) => a.id === attemptId)).toMatchObject({
      scope: "climb",
      outcome: null,
      fell_or_hung: true,
      attempt_index: null,
      notes: "Existing note",
    });
    const grades = await executeWithSchema(
      context.db,
      z.object({ owner: z.string(), value: z.string() }),
      sql`SELECT 'published' AS owner,g.value FROM fitness.climb_grade g JOIN fitness.climbing_log_entry e ON e.climb_id=g.climb_id WHERE e.id=${id}::uuid UNION ALL SELECT 'reported',value FROM fitness.climbing_log_entry_grade WHERE climbing_log_entry_id=${id}::uuid UNION ALL SELECT 'pitch',g.value FROM fitness.pitch_grade g JOIN fitness.pitch p ON p.id=g.pitch_id JOIN fitness.climbing_log_entry e ON e.climb_id=p.climb_id WHERE e.id=${id}::uuid`,
    );
    expect(grades).toEqual(
      expect.arrayContaining([
        { owner: "published", value: "5.10a" },
        { owner: "reported", value: "5.10d" },
        { owner: "pitch", value: "5.9" },
      ]),
    );
  });
  it("rejects unresolved shared catalogue conflicts before any conversion and ignores row creation precedence", async () => {
    await seed(source);
    await seed({ ...source, climb: { ...source.climb, grades: { yds: "5.11a" } } });
    const report = await inspectClimbingLogConversion(context.db);
    expect(report.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "publishedGrades", externalId: "source-climb" }),
      ]),
    );
    await context.prepare();
    await expect(convertClimbingLogBatch(context.db, 1)).rejects.toThrow("conflict");
  });
  it("rejects conflicting coordinates after an omitted shared definition", async () => {
    await seed({
      ...source,
      climb: { uuid: source.climb.uuid, name: source.climb.name, grades: source.climb.grades },
    });
    await seed(source);
    await seed({ ...source, climb: { ...source.climb, metadata: { lat: 37.5, lng: -122.25 } } });
    expect((await inspectClimbingLogConversion(context.db)).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "coordinates", externalId: source.climb.uuid }),
      ]),
    );
  });
  it("rejects ambiguous clean=false and resumes bounded batches with unknown missing totals", async () => {
    const ambiguous = await seed({ clean: false }, { provider: "kaya-export" });
    expect((await inspectClimbingLogConversion(context.db)).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "attemptFacts", climbingLogEntryIds: [ambiguous] }),
      ]),
    );
    await context.db.execute(sql`DELETE FROM fitness.climbing_entry WHERE id=${ambiguous}::uuid`);
    await seed(source);
    await seed({ ...source, attemptType: null });
    await context.prepare();
    expect(await convertClimbingLogBatch(context.db, 1)).toEqual({ converted: 1, remaining: 1 });
    expect(await convertClimbingLogBatch(context.db, 1)).toEqual({ converted: 1, remaining: 0 });
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual([]);
  });
  it("rejects invalid converted parent or pitch graphs before finalization", async () => {
    await seed(source);
    await context.prepare();
    await convertClimbingLogBatch(context.db, 1);
    await context.db.execute(sql`UPDATE fitness.climbing_attempt SET parent_attempt_id=id`);
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "attemptGraph" })]),
    );
    await expect(context.finalize()).rejects.toThrow();
  });
  it("detects lost scoped counts, source facts and owned grades before dropping legacy evidence", async () => {
    const id = await seed(source, { result: "Fell/Hung", count: 3 });
    await context.prepare();
    await convertClimbingLogBatch(context.db, 1);
    await context.db.execute(
      sql`DELETE FROM fitness.climbing_attempt WHERE id=(SELECT id FROM fitness.climbing_attempt WHERE climbing_entry_id=${id}::uuid AND fell_or_hung IS NULL LIMIT 1)`,
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_attempt SET fell_or_hung=false WHERE climbing_entry_id=${id}::uuid`,
    );
    await context.db.execute(sql`UPDATE fitness.climb_grade SET value='5.11a'`);
    const report = await validateClimbingLogConversion(context.db);
    expect(report.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "attemptCount" }),
        expect.objectContaining({ field: "attemptFacts" }),
        expect.objectContaining({ field: "publishedGrades" }),
      ]),
    );
  });
  it("converts aid Onsight with compound published grades without inventing a fall or hang", async () => {
    const id = await seed(
      {
        URL: "https://www.mountainproject.com/route/1234/aid-corner",
        Rating: "5.10a A2",
        Date: "2026-10-01",
      },
      { provider: "mountain-project", result: "Onsight" },
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_entry SET climb_style='aid' WHERE id=${id}::uuid`,
    );
    await context.prepare();
    await convertClimbingLogBatch(context.db, 1);
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual([]);
    await context.finalize();
    const [attempt] = await executeWithSchema(
      context.db,
      z.object({
        outcome: z.string(),
        used_aid: z.boolean(),
        fell_or_hung: z.boolean().nullable(),
        attempt_index: z.coerce.number(),
        received_beta: z.boolean(),
      }),
      sql`SELECT outcome,used_aid,fell_or_hung,attempt_index,received_beta FROM fitness.climbing_attempt WHERE climbing_log_entry_id=${id}::uuid`,
    );
    expect(attempt).toEqual({
      outcome: "completed",
      used_aid: true,
      fell_or_hung: null,
      attempt_index: 1,
      received_beta: false,
    });
    const grades = await executeWithSchema(
      context.db,
      z.object({ value: z.string(), system: z.string() }),
      sql`SELECT g.value,g.system FROM fitness.climb_grade g JOIN fitness.climbing_log_entry e ON e.climb_id=g.climb_id WHERE e.id=${id}::uuid ORDER BY g.position`,
    );
    expect(grades).toEqual([
      { value: "5.10a", system: "yds" },
      { value: "A2", system: "aid" },
    ]);
  });
  it("collects compatible shared coordinates and pitches across bounded batches and validates their fidelity", async () => {
    const sparseId = await seed({
      ...source,
      climb: { uuid: source.climb.uuid, name: source.climb.name, grades: source.climb.grades },
    });
    const completeId = await seed(source);
    await context.db.execute(
      sql`UPDATE fitness.climbing_entry SET id='00000000-0000-4000-8000-000000000101' WHERE id=${sparseId}::uuid`,
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_entry SET id='00000000-0000-4000-8000-000000000102' WHERE id=${completeId}::uuid`,
    );
    await context.prepare();
    await convertClimbingLogBatch(context.db, 1);
    const [first] = await executeWithSchema(
      context.db,
      z.object({ point: z.string().nullable(), pitches: z.coerce.number() }),
      sql`SELECT c.coordinates::text AS point,(SELECT count(*) FROM fitness.pitch p WHERE p.climb_id=c.id) AS pitches FROM fitness.climbing_entry e JOIN fitness.climb c ON c.id=e.climb_id WHERE e.id='00000000-0000-4000-8000-000000000101'`,
    );
    expect(first).toEqual({ point: "(-122.25,0)", pitches: 1 });
    await convertClimbingLogBatch(context.db, 1);
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual([]);
    await context.db.execute(sql`UPDATE fitness.climb SET coordinates=NULL`);
    await context.db.execute(sql`UPDATE fitness.pitch_grade SET value='5.10a'`);
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "coordinates" }),
        expect.objectContaining({ field: "pitches" }),
      ]),
    );
  });
  it("blocks unsupported legacy failure evidence and retains it for source review", async () => {
    const id = await seed(source);
    const attemptId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.climbing_attempt(id,climbing_entry_id,attempt_index,outcome,failure_reason) VALUES(${attemptId}::uuid,${id}::uuid,1,'failed','technique')`,
    );
    expect((await inspectClimbingLogConversion(context.db)).conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "attemptFacts", climbingLogEntryIds: [id] }),
      ]),
    );
    await context.prepare();
    await expect(convertClimbingLogBatch(context.db, 1)).rejects.toThrow("conflict");
    const [retained] = await executeWithSchema(
      context.db,
      z.object({ reason: z.string() }),
      sql`SELECT legacy_failure_reason AS reason FROM fitness.climbing_attempt WHERE id=${attemptId}::uuid`,
    );
    expect(retained).toEqual({ reason: "technique" });
  });
  it("recovers a KAYA compound target and source count while retaining identities on subsequent canonical sync", async () => {
    const raw = {
      id: "1000_2001",
      attempts: 3,
      lead: false,
      climb_type: { name: "Route" },
      gym: null,
    };
    const id = await seed(raw, { provider: "kaya", result: "Attempt" });
    const activityId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${activityId}::uuid,${TEST_USER_ID}::uuid,'kaya','1000','climbing','climbing','2026-10-01T10:00:00Z')`,
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_entry SET activity_id=${activityId}::uuid,unattached_date=NULL,location_path='[{"name":"Session gym","externalId":"gym-1","kind":"gym"}]'::jsonb WHERE id=${id}::uuid`,
    );
    await context.prepare();
    await convertClimbingLogBatch(context.db, 1);
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual([]);
    await context.finalize();
    const [converted] = await executeWithSchema(
      context.db,
      z.object({
        climb_id: z.string(),
        target_id: z.string(),
        setting: z.string(),
        external_id: z.string(),
        count: z.coerce.number(),
      }),
      sql`SELECT e.climb_id,c.external_id AS target_id,c.setting,e.external_id,(SELECT count(*) FROM fitness.climbing_attempt a WHERE a.climbing_log_entry_id=e.id) AS count FROM fitness.climbing_log_entry e JOIN fitness.climb c ON c.id=e.climb_id WHERE e.id=${id}::uuid`,
    );
    expect(converted).toMatchObject({
      target_id: "2001",
      setting: "indoor",
      external_id: "kaya:session:1000:attempted:1000_2001",
      count: 3,
    });
    // Correct confirmed methods on anonymous legacy tries before enforcing the invariant.
    await context.db.execute(
      sql`UPDATE fitness.climbing_attempt SET rope_method='top_rope' WHERE climbing_log_entry_id=${id}::uuid`,
    );
    await context.migrateToCurrent();
    const result = await persistClimbingLogEntries(context.db, {
      userId: TEST_USER_ID,
      providerId: "kaya",
      entries: [
        {
          externalId: "kaya:session:1000:attempted:1000_2001",
          activityId,
          raw,
          climb: { externalId: "2001" },
          attempts: [{ scope: "climb" }],
          reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        },
      ],
    });
    expect(result.logEntryIds).toEqual([id]);
    const [retained] = await executeWithSchema(
      context.db,
      z.object({ climb_id: z.string(), count: z.coerce.number() }),
      sql`SELECT e.climb_id,(SELECT count(*) FROM fitness.climbing_attempt a WHERE a.climbing_log_entry_id=e.id) AS count FROM fitness.climbing_log_entry e WHERE e.id=${id}::uuid`,
    );
    expect(retained).toEqual({ climb_id: converted?.climb_id, count: 3 });
  });
  it("preserves attached unknown dates and detailed UUIDs without promoting local ordinals to global attempt order", async () => {
    const id = await seed({
      grade: "5.10a",
      climb: { uuid: "unknown-date-climb", grades: { yds: "5.10a" } },
    });
    const activityId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${activityId}::uuid,${TEST_USER_ID}::uuid,'openbeta',${activityId},'climbing','climbing','2026-10-01T10:00:00Z')`,
    );
    await context.db.execute(
      sql`UPDATE fitness.climbing_entry SET activity_id=${activityId}::uuid,unattached_date=NULL WHERE id=${id}::uuid`,
    );
    const attemptId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.climbing_attempt(id,climbing_entry_id,attempt_index,outcome) VALUES(${attemptId}::uuid,${id}::uuid,7,'sent')`,
    );
    await context.prepare();
    await convertClimbingLogBatch(context.db, 1);
    expect((await validateClimbingLogConversion(context.db)).conflicts).toEqual([]);
    await context.finalize();
    const [record] = await executeWithSchema(
      context.db,
      z.object({
        activity_id: z.string(),
        climbed_on: z.string().nullable(),
        id: z.string(),
        attempt_index: z.coerce.number().nullable(),
        outcome: z.string(),
      }),
      sql`SELECT e.activity_id,e.climbed_on,a.id,a.attempt_index,a.outcome FROM fitness.climbing_log_entry e JOIN fitness.climbing_attempt a ON a.climbing_log_entry_id=e.id WHERE e.id=${id}::uuid`,
    );
    expect(record).toEqual({
      activity_id: activityId,
      climbed_on: null,
      id: attemptId,
      attempt_index: null,
      outcome: "completed",
    });
  });
});
