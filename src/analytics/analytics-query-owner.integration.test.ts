import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../db/test-helpers.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import { withAnalyticsQueryOwner } from "./analytics-query-owner.ts";

describe("analytics query owner database boundaries", () => {
  let context: TestContext;
  let client: ClickHouseClient;
  beforeAll(async () => {
    context = await setupTestDatabase();
    client = createClickHouseClientFromEnv();
  });
  afterAll(async () => {
    await client?.close?.();
    await context?.cleanup();
  });

  async function ownerState(resourceId: string) {
    return context.db.execute(sql`SELECT quiescent,intent_id,query_id,query_terminal
      FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
  }

  it("allows the same erasure request to retry a terminal failure before admitting another account", async () => {
    const resourceId = randomUUID();
    const intentId = `account-erasure:${randomUUID()}`;
    await expect(
      withAnalyticsQueryOwner(context.db, client, { resourceId, intentId }, async (owner) => {
        await owner.client.command({ query: "SELECT throwIf(1)" });
      }),
    ).rejects.toThrow();
    expect((await ownerState(resourceId))[0]).toMatchObject({
      quiescent: true,
      query_terminal: true,
      intent_id: intentId,
    });
    const other = { resourceId, intentId: `account-erasure:${randomUUID()}` };
    await expect(
      withAnalyticsQueryOwner(context.db, client, other, async () => undefined),
    ).rejects.toThrow("pending intent");
    await withAnalyticsQueryOwner(context.db, client, { resourceId, intentId }, async (owner) => {
      await owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
    });
    await expect(
      withAnalyticsQueryOwner(context.db, client, other, async () => undefined),
    ).resolves.toBeUndefined();
  });

  it("registers the dbt child before spawn and admits a successor only after terminal completion", async () => {
    const input = { resourceId: randomUUID(), intentId: randomUUID() };
    const entered = createTestBarrier();
    const release = createTestBarrier();
    const active = withAnalyticsQueryOwner(context.db, client, input, async (owner) => {
      await owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
      expect(
        await owner.runSynchronousDbt(async () => {
          expect(await ownerState(input.resourceId)).toEqual([
            {
              quiescent: false,
              intent_id: input.intentId,
              query_id: null,
              query_terminal: false,
            },
          ]);
          entered.resolve();
          await release.promise;
          return 0;
        }),
      ).toBe(0);
      await owner.client.query({ query: "SELECT 2", format: "JSONEachRow" });
    });
    await Promise.race([entered.promise, active]);
    let successorEntered = false;
    const successor = withAnalyticsQueryOwner(
      context.db,
      client,
      { ...input, intentId: randomUUID() },
      async () => {
        successorEntered = true;
      },
    );
    try {
      await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true));
      expect(successorEntered).toBe(false);
    } finally {
      release.resolve();
    }
    await active;
    await successor;
    expect(successorEntered).toBe(true);
    expect(await ownerState(input.resourceId)).toEqual([
      {
        quiescent: true,
        intent_id: null,
        query_id: null,
        query_terminal: true,
      },
    ]);
  });

  it.each(["nonzero", "error"])("preserves a durable barrier after dbt %s", async (outcome) => {
    const input = { resourceId: randomUUID(), intentId: randomUUID() };
    await expect(
      withAnalyticsQueryOwner(context.db, client, input, async (owner) => {
        await owner.runSynchronousDbt(async () => {
          if (outcome === "error") throw new Error("fixture child failed");
          return 1;
        });
      }),
    ).rejects.toThrow(outcome === "error" ? "fixture child failed" : "dbt");
    expect(await ownerState(input.resourceId)).toEqual([
      {
        quiescent: false,
        intent_id: input.intentId,
        query_id: null,
        query_terminal: false,
      },
    ]);
    await expect(
      withAnalyticsQueryOwner(context.db, client, input, async () => undefined),
    ).rejects.toThrow("BLOCKED");
  });

  it("does not release an owner whose callback returns with a dbt child outstanding", async () => {
    const input = { resourceId: randomUUID(), intentId: randomUUID() };
    const entered = createTestBarrier(),
      release = createTestBarrier();
    let child: Promise<unknown> | undefined;
    let assertActive: () => Promise<void> = async () => {
      throw new Error("Fixture owner not entered");
    };
    const active = withAnalyticsQueryOwner(context.db, client, input, async (owner) => {
      assertActive = owner.assertActive;
      child = owner
        .runSynchronousDbt(async () => {
          entered.resolve();
          await release.promise;
          return 0;
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await entered.promise;
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    try {
      await vi.waitFor(async () => expect(assertActive()).rejects.toThrow("closed"));
    } finally {
      release.resolve();
    }
    expect(await active).toMatchObject({
      message: expect.stringMatching(/returned before|closed/),
    });
    await child;
    expect(await ownerState(input.resourceId)).toEqual([
      {
        quiescent: false,
        intent_id: input.intentId,
        query_id: null,
        query_terminal: false,
      },
    ]);
  });

  it("keeps a dbt child blocked after losing its PostgreSQL session", async () => {
    const input = { resourceId: randomUUID(), intentId: randomUUID() };
    await expect(
      withAnalyticsQueryOwner(context.db, client, input, async (owner) => {
        await owner.runSynchronousDbt(async () => {
          const terminated =
            await context.db.execute(sql`SELECT pg_terminate_backend(backend_pid::integer) AS terminated
          FROM fitness.analytics_query_owner WHERE resource_id=${input.resourceId}`);
          expect(terminated).toEqual([{ terminated: true }]);
          return 0;
        });
      }),
    ).rejects.toThrow(/session|connection/i);
    expect(await ownerState(input.resourceId)).toEqual([
      {
        quiescent: false,
        intent_id: input.intentId,
        query_id: null,
        query_terminal: false,
      },
    ]);
    await expect(
      withAnalyticsQueryOwner(context.db, client, input, async () => undefined),
    ).rejects.toThrow("BLOCKED");
  });

  it("retains child admission across actual executor termination", async () => {
    const input = { resourceId: randomUUID(), intentId: randomUUID() };
    const script = `
      import {createDatabase} from './src/db/index.ts';
      import {createClickHouseClientFromEnv} from './src/db/clickhouse.ts';
      import {withAnalyticsQueryOwner} from './src/analytics/analytics-query-owner.ts';
      const db=createDatabase(process.env.TEST_DATABASE_URL);
      await withAnalyticsQueryOwner(db,createClickHouseClientFromEnv(),JSON.parse(process.argv[1]),
        owner=>owner.runSynchronousDbt(()=>new Promise(()=>process.send('admitted'))));
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(input)],
      {
        env: { ...process.env, TEST_DATABASE_URL: context.connectionString },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    try {
      expect(
        (
          await Promise.race([
            once(child, "message"),
            once(child, "exit").then(() => {
              throw new Error("Fixture executor exited before admission");
            }),
          ])
        )[0],
      ).toBe("admitted");
      expect(await ownerState(input.resourceId)).toEqual([
        {
          quiescent: false,
          intent_id: input.intentId,
          query_id: null,
          query_terminal: false,
        },
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
    await expect(
      withAnalyticsQueryOwner(context.db, client, input, async () => undefined),
    ).rejects.toThrow("BLOCKED");
  });

  it.each(["valid", "missing", "insufficient", "multiple"] as const)(
    "clears a failed source intent only with one complete persisted reservation: %s",
    async (scenario) => {
      const first = {
        transport: "kafka" as const,
        epoch: randomUUID(),
        topic: "sensor",
        partition: 0,
        offset: "9",
      };
      const group = describeAnalyticsDeliveryGroup([first, { ...first, offset: "10" }], 500);
      const intentId = analyticsDeliveryGroupIntentId(group);
      const resourceId = randomUUID();
      await expect(
        withAnalyticsQueryOwner(context.db, client, { resourceId, intentId }, async (owner) => {
          const through = analyticsDeliveryGroupIngestionTimes(owner.ingestedAt, 2)[1];
          if (!through) throw new Error("Missing fixture reservation");
          if (scenario !== "insufficient") await owner.reserveIngestionThrough(through);
          const count = scenario === "missing" ? 0 : scenario === "multiple" ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            await context.db.execute(sql`INSERT INTO fitness.analytics_stream_state (
            transport,epoch,topic,partition,owner_id,pending,group_state,
            group_first_position,group_last_position,group_member_count,group_positions_digest,group_first_ingested_at
          ) VALUES ('kafka',${`${first.epoch}-${index}`},${first.topic},0,${randomUUID()}::uuid,
            ${JSON.stringify(group.last)}::jsonb,'pending',${JSON.stringify(group.first)}::jsonb,
            ${JSON.stringify(group.last)}::jsonb,2,${group.positionsDigest},${owner.ingestedAt}::timestamptz)`);
          }
          await owner.client.command({ query: "SELECT throwIf(1)" });
        }),
      ).rejects.toThrow(/non-zero/);
      const rows = await context.db.execute(sql`SELECT intent_id,quiescent,query_terminal
        FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
      expect(rows[0]).toMatchObject({
        intent_id: scenario === "valid" ? null : intentId,
        quiescent: true,
        query_terminal: true,
      });
    },
  );

  it("keeps a failing progress-producing command from completing its intent", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    await expect(
      withAnalyticsQueryOwner(context.db, client, { resourceId, intentId }, async (owner) => {
        await owner.client.command({
          query: "SELECT sleepEachRow(0.01),throwIf(number=20) FROM numbers(30)",
          clickhouse_settings: {
            max_block_size: "1",
            send_progress_in_http_headers: 1,
            http_headers_progress_interval_ms: "1",
          },
        });
      }),
    ).rejects.toThrow();
    const rows = await context.db.execute(
      sql`SELECT intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(rows[0]?.intent_id).toBe(intentId);
  });
});
