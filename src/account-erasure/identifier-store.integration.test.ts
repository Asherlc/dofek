import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { escapeLiteral } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { findAccountErasureStatus } from "../db/account-erasure.ts";
import {
  completeAccountErasure,
  deleteAccountErasureUserProfile,
  saveAccountErasurePhaseProgress,
  scrubAccountErasureRequestPii,
} from "../db/account-erasure-processing.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
  writeTestMigrationFiles,
} from "../db/test-helpers.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { encryptCredentialValue } from "../security/credential-encryption.ts";
import {
  AccountErasureIdentifierStore,
  captureAccountErasurePostgresIdentifiers,
} from "./identifier-store.ts";
import { assertPostgresAccountErasureCoverage, erasePostgresAccount } from "./postgres-erasure.ts";

const storedRowSchema = z.object({
  identity_key: z.string(),
  encrypted_identifier: z.string(),
});
const families = ["activity", "sleep", "operation"] as const;
const scrubPrerequisites = [
  "work_verification",
  "consumer_drain_verification",
  "stripe_erasure_verification",
  "remote_revocation_verification",
  "processor_erasure_verification",
  "postgres_profile_delete",
  "peerdb_drain_verification",
  "clickhouse_verification",
  "archive_verification",
];

describe("request-owned account erasure identifiers", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  async function createRequest(seedBeforeFence?: (userId: string) => Promise<void>) {
    const requestId = randomUUID();
    const userId = randomUUID();
    const leaseOwner = randomUUID();
    const statusToken = randomBytes(32).toString("base64url");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await context.db.execute(sql`INSERT INTO fitness.user_profile(id,name)
      VALUES (${userId}::uuid,'Identifier fixture')`);
    await seedBeforeFence?.(userId);
    await context.db.execute(sql`INSERT INTO fitness.account_erasure_request
      (id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,
        encrypted_remote_snapshot,replay_retained_until,completion_deadline,
        lease_owner,lease_expires_at)
      VALUES (${requestId}::uuid,${userId}::uuid,${digest(requestId)},'test-v1',
        ${digest(userId)},${digest(statusToken)},'retained-snapshot',
        now()+interval '7 days',now()+interval '30 days',${leaseOwner},now()+interval '5 minutes')`);
    return { requestId, userId, leaseOwner, statusToken };
  }

  async function physicalFixture() {
    const request = await createRequest();
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    await store.sealClosure("initial");
    const intent = [
      "initial",
      "analytics",
      "owned_rows",
      randomUUID(),
      "a".repeat(64),
      "user",
    ] as const;
    return { ...request, store, intent };
  }

  async function appliedPhysicalFixture() {
    const fixture = await physicalFixture();
    await fixture.store.appendPhysical("physical_intent", "initial", [fixture.intent]);
    await fixture.store.sealPhysicalPlan("initial", "a".repeat(64));
    const [intent] = (await fixture.store.readPhysicalPage("physical_intent", "initial")).entries;
    if (!intent) throw new Error("Missing physical intent fixture");
    await fixture.store.startPhysicalIntent("initial", {
      expectedAfterKey: null,
      intentKey: intent.key,
    });
    await fixture.store.admitPhysicalIntent("initial", intent.key);
    const mutations = [
      ["initial", intent.key, Buffer.from("mutation_1.txt").toString("base64")],
      ["initial", intent.key, Buffer.from("mutation_2.txt").toString("base64")],
    ] as const;
    await fixture.store.appendPhysical("physical_mutation", "initial", mutations);
    await fixture.store.finishPhysicalIntent("initial", intent.key);
    await fixture.store.finishPhysicalApply("initial", intent.key);
    return { ...fixture, intentKey: intent.key };
  }

  async function seedParents(userId: string, count: number) {
    await context.db.execute(sql`INSERT INTO fitness.provider(id,name)
      VALUES ('identifier-parent-fixture','Identifier parent fixture') ON CONFLICT DO NOTHING`);
    const activity = Array.from({ length: count }, () => randomUUID());
    const sleep = Array.from({ length: count }, () => randomUUID());
    const operation = Array.from({ length: count }, () => randomUUID());
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id,user_id,provider_id,external_id,canonical_type,provider_type,started_at)
      VALUES ${sql.join(
        activity.map(
          (id) =>
            sql`(${id}::uuid,${userId}::uuid,'identifier-parent-fixture',${id},'cycling','cycling',now())`,
        ),
        sql`, `,
      )}`);
    await context.db.execute(sql`INSERT INTO fitness.sleep_session(id,user_id,provider_id,started_at)
      VALUES ${sql.join(
        sleep.map((id) => sql`(${id}::uuid,${userId}::uuid,'identifier-parent-fixture',now())`),
        sql`, `,
      )}`);
    await context.db.execute(sql`INSERT INTO fitness.processing_operation(id,user_id,kind,dataset_keys)
      VALUES ${sql.join(
        operation.map((id) => sql`(${id}::uuid,${userId}::uuid,'provider_sync',ARRAY['activity'])`),
        sql`, `,
      )}`);
    const groupRows = await executeWithSchema(
      context.db,
      z.object({ id: z.uuid(), anchor_activity_id: z.uuid().nullable() }),
      sql`SELECT id,anchor_activity_id FROM fitness.activity_group WHERE user_id=${userId}::uuid`,
    );
    return {
      activity: [
        ...new Set([
          ...activity,
          ...groupRows.flatMap((row) => [
            row.id,
            ...(row.anchor_activity_id ? [row.anchor_activity_id] : []),
          ]),
        ]),
      ],
      sleep,
      operation,
    };
  }

  test("binds a sealed physical plan to the managed schema at execution", async () => {
    const { store, intent } = await physicalFixture();
    await store.appendPhysical("physical_intent", "initial", [intent]);
    await store.sealPhysicalPlan("initial", "a".repeat(64));
    await expect(store.assertPhysicalPlanPrepared("initial", "b".repeat(64))).rejects.toThrow(
      "schema",
    );
  });
  test("reads exactly the frozen identity interval for a physical predicate", async () => {
    const request = await createRequest();
    await context.db.transaction((tx) => captureAccountErasurePostgresIdentifiers(tx, request));
    const store = new AccountErasureIdentifierStore(context.db, { ...request, pageSize: 500 });
    await store.append(
      "activity",
      Array.from({ length: 4 }, () => randomUUID()),
    );
    const all = await store.readPage("activity");
    const upper = all.entries[1]?.key;
    if (!upper) throw new Error("Missing range fixture");
    await expect(store.readPage("activity", undefined, upper)).resolves.toMatchObject({
      entries: all.entries.slice(0, 2),
    });
  });

  async function storedRows(requestId: string, family: (typeof families)[number]) {
    return executeWithSchema(
      context.db,
      storedRowSchema,
      sql`SELECT identity_key,encrypted_identifier
      FROM fitness.account_erasure_identifier
      WHERE request_id=${requestId}::uuid AND family=${family} ORDER BY identity_key COLLATE "C"`,
    );
  }

  test("cannot retain identifiers without their deletion request", async () => {
    await expect(
      context.db.execute(sql`INSERT INTO fitness.account_erasure_identifier
        (request_id, family, identity_key, encrypted_identifier)
        VALUES (${randomUUID()}::uuid, 'activity', ${"a".repeat(64)}, 'enc:v1:fixture')`),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  test("retains exact-byte String groups separately from UUID activities with bounded keyed pages", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const id = randomUUID();
    const values = [
      Buffer.from(id).toString("base64"),
      Buffer.from([0, 255, 128, 65]).toString("base64"),
      Buffer.from("A").toString("base64"),
      Buffer.from("a").toString("base64"),
    ];
    expect(await store.append("group_string", values.slice(0, 2))).toBe(true);
    expect(await store.append("group_string", values.slice(0, 2))).toBe(false);
    await store.append("group_string", values.slice(2));
    await store.append("activity", [id]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const first = await store.readPage("group_string");
    const second = await store.readPage("group_string", first.nextCursor ?? undefined);
    expect(first.entries).toHaveLength(2);
    expect(second.entries).toHaveLength(2);
    expect([...first.entries, ...second.entries].map((entry) => entry.value).sort()).toEqual(
      values.sort(),
    );
    for (const entry of [...first.entries, ...second.entries])
      expect(entry.key).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.findPresent("activity", [id])).toEqual([id]);
    expect(await store.findPresent("group_string", [Buffer.from("a").toString("base64")])).toEqual([
      Buffer.from("a").toString("base64"),
    ]);
  });

  test("bounds String pages before decryption and rejects oversized caller values without truncating", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    const values = Array.from({ length: 64 }, (_, index) =>
      Buffer.from(index.toString().padStart(4, "0") + "x".repeat(4096 - 4)).toString("base64"),
    );
    await store.append("group_string", values);
    await expect(
      store.append("group_string", [Buffer.alloc(4097).toString("base64")]),
    ).rejects.toMatchObject({
      name: "AccountErasureIdentifierBudgetError",
      message: expect.stringMatching(/identifier.*4 KiB.*Contact support/),
    });
    await expect(
      store.append("group_string", [...values, Buffer.alloc(4096, 90).toString("base64")]),
    ).rejects.toThrow(/identifier.*page/);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.readPage("group_string", cursor);
      expect(
        page.entries.reduce((sum, entry) => sum + Buffer.from(entry.value, "base64").length, 0),
      ).toBeLessThanOrEqual(256 * 1024);
      actual.push(...page.entries.map((entry) => entry.value));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(actual.sort()).toEqual(values.sort());
    await context.db.execute(sql`UPDATE fitness.account_erasure_identifier
      SET encrypted_identifier=${`enc:v1:${"A".repeat(1024 * 1024)}`}
      WHERE request_id=${request.requestId}::uuid AND family='group_string'`);
    await expect(store.readPage("group_string")).rejects.toThrow(/identifier.*wire.*budget/);
  });

  test("requires the current worker lease for identifier reads and additions", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    await store.append("activity", [randomUUID()]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    await context.db.execute(sql`UPDATE fitness.account_erasure_request SET lease_owner='next-worker'
      WHERE id=${request.requestId}::uuid`);
    await expect(store.append("activity", [randomUUID()])).rejects.toThrow(/lease/);
    await expect(store.readPage("activity")).rejects.toThrow(/lease/);
    await expect(store.findPresent("activity", [randomUUID()])).rejects.toThrow(/lease/);
  });

  test("seals closure independently of PG capture and gates final reopening on completed initial erasure and PeerDB proof", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    await expect(store.assertClosureComplete("initial")).rejects.toThrow(/closure.*incomplete/);
    expect(await store.beginClosure("initial")).toBe(true);
    await store.append("activity", [randomUUID()]);
    await store.sealClosure("initial");
    await expect(store.assertClosureComplete("initial")).resolves.toBeUndefined();
    expect(await store.beginClosure("initial")).toBe(false);
    await expect(store.append("activity", [randomUUID()])).rejects.toThrow(/closure/);
    await expect(store.beginClosure("final")).rejects.toThrow(/initial.*PeerDB/);
    await context.db.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase)
      VALUES (${request.requestId}::uuid,'clickhouse_initial'),(${request.requestId}::uuid,'peerdb_drain_verification')`);
    await store.sealPhysicalPlan("initial", "a".repeat(64));
    await store.finishPhysicalApply("initial", null);
    await store.markPhysicalComplete("initial");
    await store.finishPhysicalCleanup("initial", null);
    expect(await store.beginClosure("final")).toBe(true);
    await expect(store.assertClosureComplete("initial")).rejects.toThrow(/reopened/);
    await store.append("operation", [randomUUID()]);
    await store.sealClosure("final");
    await expect(store.assertClosureComplete("final")).resolves.toBeUndefined();
    await expect(store.append("operation", [randomUUID()])).rejects.toThrow(/closure/);
  });

  test("retains isolated canonical physical tuple codecs in encrypted bounded pages", async () => {
    const first = await physicalFixture();
    const second = await physicalFixture();
    const part = [
      "initial",
      first.intent[1],
      first.intent[2],
      first.intent[3],
      Buffer.from([0, 255, 128, 65]).toString("base64"),
    ] as const;
    expect(await first.store.appendPhysical("physical_intent", "initial", [first.intent])).toBe(
      true,
    );
    expect(await first.store.appendPhysical("physical_intent", "initial", [first.intent])).toBe(
      false,
    );
    await first.store.appendPhysical("physical_part", "initial", [part]);
    await second.store.appendPhysical("physical_part", "initial", [part]);
    const [entry] = (await first.store.readPhysicalPage("physical_part", "initial")).entries;
    if (!entry) throw new Error("Missing part fixture");
    expect(entry.value).toEqual(part);
    expect(await first.store.readPhysicalEntry("physical_part", "initial", entry.key)).toEqual(
      entry,
    );
    expect(await second.store.readPhysicalEntry("physical_part", "initial", entry.key)).toBeNull();
    await expect(first.store.appendPhysical("physical_part", "final", [part])).rejects.toThrow(
      /stage/,
    );
    const [source] = (await first.store.readPhysicalPage("physical_intent", "initial")).entries;
    const [ciphertext] = await executeWithSchema(
      context.db,
      storedRowSchema,
      sql`SELECT identity_key,encrypted_identifier FROM fitness.account_erasure_identifier
      WHERE request_id=${first.requestId}::uuid AND family='physical_intent' AND identity_key=${source?.key}`,
    );
    await context.db.execute(sql`UPDATE fitness.account_erasure_identifier SET encrypted_identifier=${ciphertext?.encrypted_identifier}
      WHERE request_id=${first.requestId}::uuid AND family='physical_part'`);
    await expect(first.store.readPhysicalPage("physical_part", "initial")).rejects.toThrow(
      /encryption context mismatch/,
    );
  });

  test("checks exact physical metadata bytes, frame count and encrypted wire size without partial writes", async () => {
    const fixture = await physicalFixture();
    const prefix = ["initial", "analytics", "rows", fixture.intent[3], ""] as const;
    const padding = (4096 - Buffer.byteLength(JSON.stringify(prefix), "utf8")) % 4;
    const table = prefix[2] + "x".repeat(padding);
    const overhead = Buffer.byteLength(
      JSON.stringify([prefix[0], prefix[1], table, prefix[3], ""]),
      "utf8",
    );
    const bytes = ((4096 - overhead) / 4) * 3;
    const parts = Array.from(
      { length: 64 },
      (_, index) =>
        [
          "initial",
          "analytics",
          table,
          fixture.intent[3],
          Buffer.from(index.toString().padStart(4, "0") + "x".repeat(bytes - 4)).toString("base64"),
        ] as const,
    );
    expect(Buffer.byteLength(JSON.stringify(parts[0]), "utf8")).toBe(4096);
    await fixture.store.appendPhysical("physical_part", "initial", parts);
    const over = [
      "initial",
      "analytics",
      `${table}x`,
      fixture.intent[3],
      parts[0]?.[4] ?? "",
    ] as const;
    await expect(
      fixture.store.appendPhysical("physical_part", "initial", [over]),
    ).rejects.toMatchObject({ name: "AccountErasureIdentifierBudgetError" });
    await expect(
      fixture.store.appendPhysical("physical_part", "initial", [...parts, parts[0] ?? over]),
    ).rejects.toThrow(/page.*budget/);
    const page = await fixture.store.readPhysicalPage("physical_part", "initial");
    expect(
      page.entries.reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value), "utf8"),
        0,
      ),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(page.entries.map((entry) => JSON.stringify(entry.value)).sort()).toEqual(
      parts.map((part) => JSON.stringify(part)).sort(),
    );
    await context.db.execute(sql`UPDATE fitness.account_erasure_identifier SET encrypted_identifier=${`enc:v1:${"A".repeat(1024 * 1024)}`}
      WHERE request_id=${fixture.requestId}::uuid AND family='physical_part'`);
    await expect(fixture.store.readPhysicalPage("physical_part", "initial")).rejects.toThrow(
      /wire.*budget/,
    );
  });

  test("seals physical preparation and admits each intent in order before accepting native mutation evidence", async () => {
    const fixture = await physicalFixture();
    await expect(
      fixture.store.assertPhysicalPlanPrepared("initial", "a".repeat(64)),
    ).rejects.toThrow(/physical.*incomplete/);
    await fixture.store.appendPhysical("physical_intent", "initial", [fixture.intent]);
    await fixture.store.sealPhysicalPlan("initial", "a".repeat(64));
    await fixture.store.sealPhysicalPlan("initial", "a".repeat(64));
    await expect(
      fixture.store.assertPhysicalPlanPrepared("initial", "a".repeat(64)),
    ).resolves.toBeUndefined();
    expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({
      step: "apply",
      afterIntentKey: null,
      pending: null,
    });
    await expect(
      fixture.store.appendPhysical("physical_intent", "initial", [fixture.intent]),
    ).rejects.toThrow(/sealed/);
    const [intent] = (await fixture.store.readPhysicalPage("physical_intent", "initial")).entries;
    if (!intent) throw new Error("Missing intent fixture");
    await expect(fixture.store.finishPhysicalApply("initial", null)).rejects.toThrow(/unapplied/);
    await fixture.store.startPhysicalIntent("initial", {
      expectedAfterKey: null,
      intentKey: intent.key,
    });
    const mutation = [
      "initial",
      intent.key,
      Buffer.from("mutation_1.txt").toString("base64"),
    ] as const;
    await expect(
      fixture.store.appendPhysical("physical_mutation", "initial", [mutation]),
    ).rejects.toThrow(/admi/);
    await fixture.store.admitPhysicalIntent("initial", intent.key);
    await expect(fixture.store.finishPhysicalIntent("initial", intent.key)).rejects.toThrow(
      /mutation.*evidence/,
    );
    await fixture.store.appendPhysical("physical_mutation", "initial", [mutation]);
    await fixture.store.finishPhysicalIntent("initial", intent.key);
    await fixture.store.finishPhysicalApply("initial", intent.key);
    expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({ step: "physical" });
    await expect(
      fixture.store.appendPhysical("physical_part", "initial", [
        [
          "initial",
          "analytics",
          "rows",
          fixture.intent[3],
          Buffer.from("late_part").toString("base64"),
        ],
      ]),
    ).rejects.toThrow(/frozen/);
  });

  test("saves global physical completion before retiring mutation descriptors and atomically compares cleanup cursors", async () => {
    const fixture = await appliedPhysicalFixture();
    const entries = (await fixture.store.readPhysicalPage("physical_mutation", "initial")).entries;
    const [first, second] = entries;
    if (!first || !second) throw new Error("Missing mutation descriptor fixtures");
    await expect(
      fixture.store.retirePhysicalMutation("initial", { key: first.key, expectedAfterKey: null }),
    ).rejects.toThrow(/physical completion/);
    await fixture.store.markPhysicalComplete("initial");
    expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({
      step: "cleanup",
      afterMutationKey: null,
    });
    expect(
      (await fixture.store.readPhysicalPage("physical_mutation", "initial")).entries,
    ).toHaveLength(2);
    await expect(
      fixture.store.appendPhysical("physical_mutation", "initial", [first.value]),
    ).rejects.toThrow(/frozen/);
    await fixture.store.retirePhysicalMutation("initial", {
      key: first.key,
      expectedAfterKey: null,
    });
    await expect(
      fixture.store.retirePhysicalMutation("initial", { key: second.key, expectedAfterKey: null }),
    ).rejects.toThrow(/cursor/);
    expect(
      await fixture.store.readPhysicalEntry("physical_mutation", "initial", second.key),
    ).not.toBeNull();
    expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({
      step: "cleanup",
      afterMutationKey: first.key,
    });
    await fixture.store.retirePhysicalMutation("initial", {
      key: second.key,
      expectedAfterKey: first.key,
    });
    await fixture.store.finishPhysicalCleanup("initial", second.key);
    expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({ step: "complete" });
    expect((await fixture.store.readPhysicalPage("physical_mutation", "initial")).entries).toEqual(
      [],
    );
  });

  test("rolls back descriptor deletion if its cleanup cursor update cannot commit", async () => {
    const fixture = await appliedPhysicalFixture();
    await fixture.store.markPhysicalComplete("initial");
    const [entry] = (await fixture.store.readPhysicalPage("physical_mutation", "initial")).entries;
    if (!entry) throw new Error("Missing mutation fixture");
    await context.db.execute(sql`ALTER TABLE fitness.account_erasure_request ADD CONSTRAINT physical_cursor_fixture_failure
      CHECK (id<>${sql.raw(escapeLiteral(fixture.requestId))}::uuid OR phase_progress->'clickhouse_initial'->>'afterMutationKey' IS NULL)`);
    try {
      await expect(
        fixture.store.retirePhysicalMutation("initial", { key: entry.key, expectedAfterKey: null }),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint: "physical_cursor_fixture_failure" },
      });
      expect(
        await fixture.store.readPhysicalEntry("physical_mutation", "initial", entry.key),
      ).not.toBeNull();
      expect(await fixture.store.loadPhysicalProgress("initial")).toEqual({
        step: "cleanup",
        afterMutationKey: null,
      });
    } finally {
      await context.db.execute(
        sql`ALTER TABLE fitness.account_erasure_request DROP CONSTRAINT physical_cursor_fixture_failure`,
      );
    }
  });

  test("rolls back the physical plan seal with its initial progress and rejects stale workers", async () => {
    const fixture = await physicalFixture();
    await fixture.store.appendPhysical("physical_intent", "initial", [fixture.intent]);
    await context.db.execute(sql`ALTER TABLE fitness.account_erasure_request ADD CONSTRAINT physical_plan_fixture_failure
      CHECK (id<>${sql.raw(escapeLiteral(fixture.requestId))}::uuid OR NOT (phase_progress ? 'clickhouse_initial'))`);
    try {
      await expect(fixture.store.sealPhysicalPlan("initial", "a".repeat(64))).rejects.toMatchObject(
        {
          cause: { code: "23514", constraint: "physical_plan_fixture_failure" },
        },
      );
      expect(await fixture.store.loadPhysicalProgress("initial")).toBeNull();
      await expect(
        fixture.store.assertPhysicalPlanPrepared("initial", "a".repeat(64)),
      ).rejects.toThrow(/incomplete/);
    } finally {
      await context.db.execute(
        sql`ALTER TABLE fitness.account_erasure_request DROP CONSTRAINT physical_plan_fixture_failure`,
      );
    }
    await context.db.execute(
      sql`UPDATE fitness.account_erasure_request SET lease_owner='replacement-worker' WHERE id=${fixture.requestId}::uuid`,
    );
    await expect(
      fixture.store.appendPhysical("physical_part", "initial", [
        ["initial", "analytics", "rows", fixture.intent[3], Buffer.from("part").toString("base64")],
      ]),
    ).rejects.toThrow(/lease/);
    await expect(fixture.store.sealPhysicalPlan("initial", "a".repeat(64))).rejects.toThrow(
      /lease/,
    );
  });

  test("requires completed metadata cleanup before final-stage reopening and keeps old-stage intents inert", async () => {
    const fixture = await physicalFixture();
    const part = [
      "initial",
      "analytics",
      "rows",
      fixture.intent[3],
      Buffer.from("initial_part").toString("base64"),
    ] as const;
    await fixture.store.appendPhysical("physical_intent", "initial", [fixture.intent]);
    await fixture.store.appendPhysical("physical_part", "initial", [part]);
    await fixture.store.sealPhysicalPlan("initial", "a".repeat(64));
    const [intent] = (await fixture.store.readPhysicalPage("physical_intent", "initial")).entries;
    if (!intent) throw new Error("Missing stage intent fixture");
    await fixture.store.startPhysicalIntent("initial", {
      expectedAfterKey: null,
      intentKey: intent.key,
    });
    await fixture.store.finishPhysicalIntent("initial", intent.key);
    await fixture.store.finishPhysicalApply("initial", intent.key);
    await fixture.store.markPhysicalComplete("initial");
    await context.db.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase)
      VALUES (${fixture.requestId}::uuid,'clickhouse_initial'),(${fixture.requestId}::uuid,'peerdb_drain_verification')`);
    await expect(fixture.store.beginClosure("final")).rejects.toThrow(/physical.*cleanup/);
    await fixture.store.finishPhysicalCleanup("initial", null);
    expect(await fixture.store.beginClosure("final")).toBe(true);
    await fixture.store.sealClosure("final");
    const finalPart = [
      "final",
      "analytics",
      "rows",
      fixture.intent[3],
      Buffer.from("final_part").toString("base64"),
    ] as const;
    await fixture.store.appendPhysical("physical_part", "final", [finalPart]);
    expect(
      (await fixture.store.readPhysicalPage("physical_part", "final")).entries.map(
        (entry) => entry.value,
      ),
    ).toEqual([finalPart]);
    await expect(
      fixture.store.readPhysicalEntry("physical_intent", "initial", intent.key),
    ).rejects.toThrow(/reopened/);
    await expect(
      fixture.store.startPhysicalIntent("initial", {
        expectedAfterKey: null,
        intentKey: intent.key,
      }),
    ).rejects.toThrow(/reopened/);
  });

  test("refuses malformed or oversized physical progress before loading unbounded payloads", async () => {
    const fixture = await physicalFixture();
    await fixture.store.sealPhysicalPlan("initial", "a".repeat(64));
    await context.db.execute(sql`UPDATE fitness.account_erasure_request SET phase_progress=jsonb_build_object(
      'clickhouse_initial',jsonb_build_object('step','apply','afterIntentKey',NULL,'pending',NULL,'extra',repeat('x',4097)))
      WHERE id=${fixture.requestId}::uuid`);
    await expect(fixture.store.loadPhysicalProgress("initial")).rejects.toMatchObject({
      name: "AccountErasureIdentifierBudgetError",
    });
  });

  test.each(["physical", "cleanup"] as const)(
    "requires its plan admission seal before advancing an independently saved %s step",
    async (step) => {
      const fixture = await physicalFixture();
      await saveAccountErasurePhaseProgress(
        context.db,
        fixture.requestId,
        fixture.leaseOwner,
        "clickhouse_initial",
        step === "physical" ? { step: "physical" } : { step: "cleanup", afterMutationKey: null },
      );
      await expect(
        step === "physical"
          ? fixture.store.markPhysicalComplete("initial")
          : fixture.store.finishPhysicalCleanup("initial", null),
      ).rejects.toThrow(/physical preparation.*incomplete/);
    },
  );

  test("isolates membership by request and family with encrypted canonical values", async () => {
    const first = await createRequest();
    const second = await createRequest();
    const firstStore = new AccountErasureIdentifierStore(context.db, {
      requestId: first.requestId,
      leaseOwner: first.leaseOwner,
      pageSize: 2,
    });
    const secondStore = new AccountErasureIdentifierStore(context.db, {
      requestId: second.requestId,
      leaseOwner: second.leaseOwner,
      pageSize: 2,
    });
    const shared = randomUUID();
    const exclusive = randomUUID();
    await firstStore.append("activity", [shared, exclusive]);
    await firstStore.append("sleep", [shared]);
    await secondStore.append("activity", [shared]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, first),
    );
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, second),
    );
    expect(await firstStore.findPresent("activity", [shared, exclusive])).toEqual(
      expect.arrayContaining([shared, exclusive]),
    );
    expect(await secondStore.findPresent("activity", [shared, exclusive])).toEqual([shared]);
    expect(await firstStore.findPresent("operation", [shared])).toEqual([]);
    expect(await firstStore.findPresent("sleep", [exclusive])).toEqual([]);
    const firstRows = await storedRows(first.requestId, "activity");
    const secondRows = await storedRows(second.requestId, "activity");
    const sleepRows = await storedRows(first.requestId, "sleep");
    expect(firstRows).toHaveLength(2);
    for (const row of [...firstRows, ...secondRows, ...sleepRows]) {
      expect(row.encrypted_identifier).toMatch(/^enc:v1:/);
      expect(JSON.stringify(row)).not.toContain(shared);
      expect(JSON.stringify(row)).not.toContain(exclusive);
    }
    expect(firstRows.map((row) => row.identity_key)).not.toContain(secondRows[0]?.identity_key);
    expect(firstRows.map((row) => row.identity_key)).not.toContain(sleepRows[0]?.identity_key);
  });

  test.each(families)(
    "pages %s identifiers in stable bounded key order without missing boundary values",
    async (family) => {
      const request = await createRequest();
      const store = new AccountErasureIdentifierStore(context.db, {
        requestId: request.requestId,
        leaseOwner: request.leaseOwner,
        pageSize: 2,
      });
      const identifiers = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await store.append(family, identifiers.slice(0, 2));
      await store.append(family, identifiers.slice(2, 4));
      await store.append(family, identifiers.slice(4));
      await context.db.transaction((transaction) =>
        captureAccountErasurePostgresIdentifiers(transaction, request),
      );
      const first = await store.readPage(family);
      const second = await store.readPage(family, first.nextCursor ?? undefined);
      const third = await store.readPage(family, second.nextCursor ?? undefined);
      expect(first.entries.map((entry) => entry.value)).toHaveLength(2);
      expect(second.entries.map((entry) => entry.value)).toHaveLength(2);
      expect(third.entries.map((entry) => entry.value)).toHaveLength(1);
      expect(third.nextCursor).toBeNull();
      expect(first.nextCursor).toMatch(/^[a-f0-9]{64}$/);
      expect(second.nextCursor).toMatch(/^[a-f0-9]{64}$/);
      expect(
        first.nextCursor !== null &&
          second.nextCursor !== null &&
          first.nextCursor < second.nextCursor,
      ).toBe(true);
      expect(
        [
          ...first.entries.map((entry) => entry.value),
          ...second.entries.map((entry) => entry.value),
          ...third.entries.map((entry) => entry.value),
        ].sort(),
      ).toEqual([...identifiers].sort());
      const reopened = new AccountErasureIdentifierStore(context.db, {
        requestId: request.requestId,
        leaseOwner: request.leaseOwner,
        pageSize: 2,
      });
      expect(await reopened.readPage(family, first.nextCursor ?? undefined)).toEqual(second);
      const rows = await storedRows(request.requestId, family);
      expect(first.nextCursor).toBe(rows[1]?.identity_key);
      expect(second.nextCursor).toBe(rows[3]?.identity_key);
      expect(await reopened.readPage(family, rows[4]?.identity_key)).toEqual({
        entries: [],
        nextCursor: null,
      });
    },
  );

  test("keeps retries idempotent across UUID spelling and duplicate inputs", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const id = "abcdefab-1234-4abc-8def-123456789abc";
    await store.append("operation", [id, id]);
    const before = await storedRows(request.requestId, "operation");
    await store.append("operation", [id.toUpperCase()]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    expect(await storedRows(request.requestId, "operation")).toEqual(before);
    expect(await store.findPresent("operation", [id.toUpperCase(), randomUUID()])).toEqual([id]);
    expect(await store.readPage("operation")).toEqual({
      entries: [{ key: expect.any(String), value: id }],
      nextCursor: null,
    });
  });

  test("rejects oversized writes and membership inputs without persisting a partial page", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await expect(store.append("activity", ids)).rejects.toThrow();
    await expect(store.findPresent("activity", ids)).rejects.toThrow();
    expect(await storedRows(request.requestId, "activity")).toHaveLength(0);
    await store.append("activity", []);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    expect(await store.findPresent("activity", [])).toEqual([]);
    await expect(store.readPage("activity", "invalid-cursor")).rejects.toThrow();
  });

  test.each(["request", "family", "item"] as const)(
    "fails closed when ciphertext is transplanted across %s context",
    async (boundary) => {
      const first = await createRequest();
      const second = await createRequest();
      const firstStore = new AccountErasureIdentifierStore(context.db, {
        requestId: first.requestId,
        leaseOwner: first.leaseOwner,
        pageSize: 2,
      });
      const secondStore = new AccountErasureIdentifierStore(context.db, {
        requestId: second.requestId,
        leaseOwner: second.leaseOwner,
        pageSize: 2,
      });
      const sourceId = randomUUID();
      const targetId = boundary === "item" ? randomUUID() : sourceId;
      const targetRequest = boundary === "request" ? second.requestId : first.requestId;
      const targetFamily = boundary === "family" ? "sleep" : "activity";
      const targetStore = boundary === "request" ? secondStore : firstStore;
      await firstStore.append("activity", [sourceId]);
      const [source] = await storedRows(first.requestId, "activity");
      await targetStore.append(targetFamily, [targetId]);
      await context.db.transaction((transaction) =>
        captureAccountErasurePostgresIdentifiers(transaction, first),
      );
      await context.db.transaction((transaction) =>
        captureAccountErasurePostgresIdentifiers(transaction, second),
      );
      const target = (await storedRows(targetRequest, targetFamily)).find(
        (row) => boundary !== "item" || row.identity_key !== source?.identity_key,
      );
      await context.db.execute(sql`UPDATE fitness.account_erasure_identifier
      SET encrypted_identifier=${source?.encrypted_identifier}
      WHERE request_id=${targetRequest}::uuid AND family=${targetFamily}
        AND identity_key=${target?.identity_key}`);
      await expect(targetStore.readPage(targetFamily)).rejects.toThrow(
        "encryption context mismatch",
      );
      await expect(targetStore.findPresent(targetFamily, [targetId])).rejects.toThrow(
        "encryption context mismatch",
      );
    },
  );

  test("rolls back captured pages with their activation transaction", async () => {
    const request = await createRequest();
    await expect(
      context.db.transaction(async (transaction) => {
        const store = new AccountErasureIdentifierStore(transaction, {
          requestId: request.requestId,
          leaseOwner: request.leaseOwner,
          pageSize: 2,
        });
        await store.append("activity", [randomUUID()]);
        throw new Error("activation fixture rollback");
      }),
    ).rejects.toThrow("activation fixture rollback");
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    expect(await store.readPage("activity")).toEqual({ entries: [], nextCursor: null });
  });

  test("rejects an authenticated identifier that does not belong to its lookup key", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const original = randomUUID();
    await store.append("activity", [original]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const [stored] = await storedRows(request.requestId, "activity");
    const encrypted = await encryptCredentialValue(randomUUID(), {
      tableName: "fitness.account_erasure_identifier",
      columnName: "encrypted_identifier",
      scopeId: JSON.stringify([request.requestId, "activity", stored?.identity_key]),
    });
    await context.db.execute(sql`UPDATE fitness.account_erasure_identifier
      SET encrypted_identifier=${encrypted} WHERE request_id=${request.requestId}::uuid`);
    await expect(store.readPage("activity")).rejects.toThrow(
      "does not match its retained identity key",
    );
    await expect(store.findPresent("activity", [original])).rejects.toThrow(
      "does not match its retained identity key",
    );
  });

  test("rechecks retained state after waiting for a concurrent PII scrub", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const locked = createTestBarrier();
    const release = createTestBarrier();
    const scrub = context.db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT id FROM fitness.account_erasure_request
        WHERE id=${request.requestId}::uuid FOR UPDATE`);
      locked.resolve();
      await release.promise;
      await transaction.execute(sql`UPDATE fitness.account_erasure_request
        SET user_id=NULL,encrypted_remote_snapshot=NULL,pii_scrubbed_at=now()
        WHERE id=${request.requestId}::uuid`);
    });
    await locked.promise;
    const append = expect(store.append("activity", [randomUUID()])).rejects.toThrow(
      "does not retain identifying state",
    );
    try {
      await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true));
    } finally {
      release.resolve();
      await scrub;
    }
    await append;
    expect(await storedRows(request.requestId, "activity")).toHaveLength(0);
  });

  test("preserves identifiers through application erasure and scrubs them atomically with request PII", async () => {
    const request = await createRequest();
    const other = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const otherStore = new AccountErasureIdentifierStore(context.db, {
      requestId: other.requestId,
      leaseOwner: other.leaseOwner,
      pageSize: 2,
    });
    const id = randomUUID();
    for (const family of families) await store.append(family, [id]);
    await otherStore.append("activity", [id]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, other),
    );
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
    await erasePostgresAccount(context.db, request.requestId, request.userId);
    expect((await store.readPage("activity")).entries.map((entry) => entry.value)).toEqual([id]);
    await deleteAccountErasureUserProfile(
      context.db,
      request.requestId,
      request.userId,
      request.leaseOwner,
    );
    for (const phase of scrubPrerequisites) {
      await context.db.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase)
        VALUES (${request.requestId}::uuid,${phase}) ON CONFLICT DO NOTHING`);
    }
    await context.db.execute(sql`ALTER TABLE fitness.account_erasure_request
      ADD CONSTRAINT identifier_fixture_scrub_failure CHECK (
        id<>${sql.raw(escapeLiteral(request.requestId))}::uuid OR user_id IS NOT NULL)`);
    await expect(
      scrubAccountErasureRequestPii(
        context.db,
        request.requestId,
        request.userId,
        request.leaseOwner,
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "identifier_fixture_scrub_failure" },
    });
    for (const family of families)
      expect((await store.readPage(family)).entries.map((entry) => entry.value)).toEqual([id]);
    await context.db.execute(
      sql`ALTER TABLE fitness.account_erasure_request DROP CONSTRAINT identifier_fixture_scrub_failure`,
    );
    await scrubAccountErasureRequestPii(
      context.db,
      request.requestId,
      request.userId,
      request.leaseOwner,
    );
    for (const family of families)
      expect(await storedRows(request.requestId, family)).toHaveLength(0);
    expect((await otherStore.readPage("activity")).entries.map((entry) => entry.value)).toEqual([
      id,
    ]);
    await expect(store.append("activity", [randomUUID()])).rejects.toThrow(
      "does not retain identifying state",
    );
    await expect(store.readPage("activity")).rejects.toThrow("does not retain identifying state");
    await context.db.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase)
      VALUES (${request.requestId}::uuid,'retention_verification')`);
    await completeAccountErasure(context.db, request.requestId, request.leaseOwner);
    expect((await findAccountErasureStatus(context.db, request.statusToken))?.status).toBe(
      "completed",
    );
  });

  test("fails immediately for a missing request", async () => {
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: randomUUID(),
      leaseOwner: "missing-request-worker",
      pageSize: 2,
    });
    await expect(store.append("activity", [randomUUID()])).rejects.toThrow(
      "does not retain identifying state",
    );
    await expect(store.readPage("activity")).rejects.toThrow("does not retain identifying state");
  });

  test("requires a complete PostgreSQL capture before paging or membership reads", async () => {
    const request = await createRequest();
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    const id = randomUUID();
    await store.append("activity", [id]);
    await expect(store.readPage("activity")).rejects.toThrow(
      "PostgreSQL parent identifier capture is incomplete",
    );
    await expect(store.findPresent("activity", [id])).rejects.toThrow(
      "PostgreSQL parent identifier capture is incomplete",
    );
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    expect((await store.readPage("activity")).entries.map((entry) => entry.value)).toEqual([id]);
    const laterBinding = randomUUID();
    await store.append("activity", [laterBinding]);
    expect(await store.findPresent("activity", [laterBinding])).toEqual([laterBinding]);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const reopened = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    expect(await reopened.findPresent("activity", [id])).toEqual([id]);
  });

  test("rejects page sizes above the finite production candidate cap", async () => {
    const request = await createRequest();
    expect(
      () =>
        new AccountErasureIdentifierStore(context.db, {
          requestId: request.requestId,
          leaseOwner: request.leaseOwner,
          pageSize: 501,
        }),
    ).toThrow();
  });

  test("retains group, anchor, and alias roots in the same UUID activity family", async () => {
    const groupId = randomUUID();
    const anchorId = randomUUID();
    const aliasId = randomUUID();
    const request = await createRequest(async (userId) => {
      await context.db.execute(sql`INSERT INTO fitness.activity_group(id,user_id,anchor_activity_id)
        VALUES (${groupId}::uuid,${userId}::uuid,${anchorId}::uuid)`);
      await context.db.execute(sql`INSERT INTO fitness.activity_group_alias(alias_id,group_id,user_id,reason)
        VALUES (${aliasId}::uuid,${groupId}::uuid,${userId}::uuid,'merge')`);
    });
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    expect((await store.findPresent("activity", [groupId, anchorId, aliasId])).sort()).toEqual(
      [groupId, anchorId, aliasId].sort(),
    );
  });

  test("captures all three PostgreSQL parent families across the 500-item boundary", async () => {
    let expected: Awaited<ReturnType<typeof seedParents>> | undefined;
    const request = await createRequest(async (userId) => {
      expected = await seedParents(userId, 501);
    });
    const other = await createRequest(async (userId) => {
      await seedParents(userId, 1);
    });
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    for (const family of families) {
      const identifiers: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.readPage(family, cursor);
        identifiers.push(...page.entries.map((entry) => entry.value));
        pageSizes.push(page.entries.map((entry) => entry.value).length);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pageSizes).toEqual(family === "activity" ? [500, 500, 2] : [500, 1]);
      expect(identifiers.sort()).toEqual(expected?.[family].slice().sort());
      expect(await storedRows(other.requestId, family)).toHaveLength(0);
    }
    await erasePostgresAccount(context.db, request.requestId, request.userId);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    const reopened = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 500,
    });
    for (const family of families) {
      const candidates = expected?.[family].slice(0, 2) ?? [];
      expect((await reopened.findPresent(family, candidates)).sort()).toEqual(
        candidates.slice().sort(),
      );
    }
  });

  test("rolls back parent pages and the capture seal when activation rolls back", async () => {
    const request = await createRequest(async (userId) => {
      await seedParents(userId, 1);
    });
    await expect(
      context.db.transaction(async (transaction) => {
        await captureAccountErasurePostgresIdentifiers(transaction, request);
        throw new Error("activation failed after parent capture");
      }),
    ).rejects.toThrow("activation failed after parent capture");
    for (const family of families)
      expect(await storedRows(request.requestId, family)).toHaveLength(0);
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    await expect(store.readPage("activity")).rejects.toThrow(
      "PostgreSQL parent identifier capture is incomplete",
    );
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    for (const family of families)
      expect((await store.readPage(family)).entries.map((entry) => entry.value)).toHaveLength(
        family === "activity" ? 2 : 1,
      );
  });

  test("does not seal or retain a partial parent capture when a later family write fails", async () => {
    const request = await createRequest(async (userId) => {
      await seedParents(userId, 1);
    });
    await context.db.execute(sql`ALTER TABLE fitness.account_erasure_identifier
      ADD CONSTRAINT identifier_fixture_capture_failure CHECK (
        request_id<>${sql.raw(escapeLiteral(request.requestId))}::uuid OR family<>'sleep')`);
    try {
      await expect(
        context.db.transaction((transaction) =>
          captureAccountErasurePostgresIdentifiers(transaction, request),
        ),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint: "identifier_fixture_capture_failure" },
      });
      for (const family of families)
        expect(await storedRows(request.requestId, family)).toHaveLength(0);
      const store = new AccountErasureIdentifierStore(context.db, {
        requestId: request.requestId,
        leaseOwner: request.leaseOwner,
        pageSize: 2,
      });
      await expect(store.findPresent("activity", [randomUUID()])).rejects.toThrow(
        "PostgreSQL parent identifier capture is incomplete",
      );
    } finally {
      await context.db.execute(
        sql`ALTER TABLE fitness.account_erasure_identifier DROP CONSTRAINT identifier_fixture_capture_failure`,
      );
    }
  });

  test("seals an empty capture without changing public deletion status", async () => {
    const request = await createRequest();
    const before = await findAccountErasureStatus(context.db, request.statusToken);
    await context.db.transaction((transaction) =>
      captureAccountErasurePostgresIdentifiers(transaction, request),
    );
    expect(await findAccountErasureStatus(context.db, request.statusToken)).toEqual(before);
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    for (const family of families)
      expect(await store.readPage(family)).toEqual({ entries: [], nextCursor: null });
  });

  test("rejects a parent capture for a different account", async () => {
    const request = await createRequest();
    const other = await createRequest();
    await expect(
      context.db.transaction((transaction) =>
        captureAccountErasurePostgresIdentifiers(transaction, {
          requestId: request.requestId,
          userId: other.userId,
        }),
      ),
    ).rejects.toThrow("does not own the supplied PostgreSQL capture");
    const store = new AccountErasureIdentifierStore(context.db, {
      requestId: request.requestId,
      leaseOwner: request.leaseOwner,
      pageSize: 2,
    });
    await expect(store.readPage("activity")).rejects.toThrow(
      "PostgreSQL parent identifier capture is incomplete",
    );
  });
});

describe("identifier storage migration cutover", () => {
  let context: TestContext;
  let migrationsDirectory: string;
  const migrationBody = readFileSync(
    new URL("../../drizzle/0181_account_erasure_identifiers.sql", import.meta.url),
    "utf8",
  );

  beforeEach(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`DROP TABLE fitness.account_erasure_identifier`);
    migrationsDirectory = mkdtempSync(join(tmpdir(), "erasure-identifier-cutover-"));
    writeTestMigrationFiles(migrationsDirectory, [
      {
        file: "0181_account_erasure_identifiers.sql",
        content: migrationBody,
        when: 2_000_000_000_000,
      },
    ]);
  }, 120_000);

  afterEach(async () => {
    await context?.cleanup();
    if (migrationsDirectory) rmSync(migrationsDirectory, { recursive: true, force: true });
  });

  function insertRequest(input: {
    userId: string | null;
    snapshot: string | null;
    scrubbed: boolean;
  }) {
    const id = randomUUID();
    const hash = createHash("sha256").update(id).digest("hex");
    return sql`INSERT INTO fitness.account_erasure_request
      (id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,
        encrypted_remote_snapshot,replay_retained_until,completion_deadline,pii_scrubbed_at)
      VALUES (${id}::uuid,${input.userId}::uuid,${hash},'test-v1',${hash},${hash},
        ${input.snapshot},now()+interval '7 days',now()+interval '30 days',
        ${input.scrubbed ? sql`now()` : sql`NULL`})`;
  }

  async function retainedState() {
    return executeWithSchema(
      context.db,
      z.object({
        identifier_table: z.boolean(),
        requests: z.array(z.unknown()),
      }),
      sql`SELECT to_regclass('fitness.account_erasure_identifier') IS NOT NULL AS identifier_table,
      coalesce((SELECT jsonb_agg(to_jsonb(request) ORDER BY id)
        FROM fitness.account_erasure_request AS request),'[]'::jsonb) AS requests`,
    );
  }

  test("installs the full production migration through the canonical transaction runner when empty", async () => {
    await expect(runMigrations(context.connectionString, migrationsDirectory)).resolves.toBe(1);
    expect(await retainedState()).toEqual([{ identifier_table: true, requests: [] }]);
  });

  test.each([
    { userId: randomUUID(), snapshot: null, scrubbed: true },
    { userId: null, snapshot: "legacy-retained-ciphertext", scrubbed: true },
    { userId: null, snapshot: null, scrubbed: false },
  ])(
    "refuses identifying or unconverted request state without changing rows or installing schema: %j",
    async (input) => {
      await context.db.execute(insertRequest(input));
      const before = await retainedState();
      await expect(runMigrations(context.connectionString, migrationsDirectory)).rejects.toThrow(
        /identifier cutover blocked: 1.*Keep.*quiesced.*recovery/i,
      );
      expect(await retainedState()).toEqual(before);
      const history = await executeWithSchema(
        context.db,
        z.object({ count: z.coerce.number() }),
        sql`SELECT count(*) AS count FROM drizzle.__drizzle_migrations`,
      );
      expect(history).toEqual([{ count: 0 }]);
    },
  );

  test("keeps already scrubbed pseudonymous requests unchanged", async () => {
    await context.db.execute(insertRequest({ userId: null, snapshot: null, scrubbed: true }));
    const before = await retainedState();
    await expect(runMigrations(context.connectionString, migrationsDirectory)).resolves.toBe(1);
    expect((await retainedState())[0]?.requests).toEqual(before[0]?.requests);
  });

  test("waits for an in-flight request insert before deciding whether the canonical migration can proceed", async () => {
    const inserted = createTestBarrier();
    const release = createTestBarrier();
    const writer = context.db.transaction(async (transaction) => {
      await transaction.execute(
        insertRequest({ userId: null, snapshot: "in-flight-legacy", scrubbed: false }),
      );
      inserted.resolve();
      await release.promise;
    });
    await inserted.promise;
    const migration = expect(
      runMigrations(context.connectionString, migrationsDirectory),
    ).rejects.toThrow(/identifier cutover blocked: 1/i);
    try {
      await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true));
    } finally {
      release.resolve();
      await writer;
    }
    await migration;
    expect((await retainedState())[0]).toMatchObject({
      identifier_table: false,
      requests: [expect.anything()],
    });
  });

  test.each(["commit", "rollback"] as const)(
    "blocks new request inserts until the complete migration transaction ends with %s",
    async (outcome) => {
      const migrated = createTestBarrier();
      const release = createTestBarrier();
      const migration = context.db.transaction(async (transaction) => {
        await transaction.execute(sql.raw(migrationBody));
        migrated.resolve();
        await release.promise;
        if (outcome === "rollback") throw new Error("fixture migration rollback");
      });
      const expectedMigration =
        outcome === "rollback"
          ? expect(migration).rejects.toThrow("fixture migration rollback")
          : expect(migration).resolves.toBeUndefined();
      await migrated.promise;
      const writer = context.db.execute(
        insertRequest({ userId: null, snapshot: "after-cutover", scrubbed: false }),
      );
      try {
        await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true));
      } finally {
        release.resolve();
        await expectedMigration;
      }
      await writer;
      expect((await retainedState())[0]).toMatchObject({
        identifier_table: outcome === "commit",
        requests: [expect.anything()],
      });
    },
  );
});
