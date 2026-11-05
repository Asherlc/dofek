import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eraseClickHouseAccount,
  prepareClickHouseAccountErasure,
} from "../account-erasure/clickhouse-erasure.ts";
import { AccountErasureIdentifierStore } from "../account-erasure/identifier-store.ts";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import { claimAccountErasureRequest } from "../db/account-erasure-processing.ts";
import {
  seedSensorResourceHistory,
  sensorResourceRow,
} from "../db/bounded-sensor-resource-test-helpers.ts";
import { sensorRow } from "../db/bounded-sensor-test-helpers.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createProviderDataDeletionRequest } from "../db/provider-data-deletion.ts";
import { hasDatabaseLockWaiter } from "../db/test-helpers.ts";
import { applyMetricStreamEventsToClickHouse } from "../metric-stream/clickhouse-sink.ts";
import { createMetricStreamProviderGenerationDeletedEvent } from "../metric-stream/events.ts";
import { metricStreamSourceEffect } from "../metric-stream/source-effects.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import { loadAnalyticsRunFrontier } from "./analytics-run-frontier.ts";
import { BoundedExecutorFixture } from "./bounded-analytics-test-helpers.ts";
import { appendAnalyticsDelivery, readAnalyticsEffectPage } from "./effect-journal.ts";
import { resolveSourcePlacements } from "./source-placement.ts";

describe("real bounded scalar executor", () => {
  let fixture: BoundedExecutorFixture;
  beforeEach(async () => {
    fixture = new BoundedExecutorFixture();
    await fixture.create();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  async function prepare() {
    const row = sensorRow(1);
    await fixture.seed([row]);
    await fixture.page([{ before: null, after: row }], "1", "kafka", ["scalar"]);
    return row;
  }
  async function erasePublishedAccount(userId: string) {
    const [request] = await fixture.work.database.execute(
      sql`SELECT id FROM fitness.account_erasure_request WHERE user_id=${userId}::uuid`,
    );
    if (!request || typeof request.id !== "string")
      throw new Error("Missing accepted erasure fixture");
    const leaseOwner = randomUUID();
    await claimAccountErasureRequest(fixture.work.database, request.id, leaseOwner, 300000);
    const store = new AccountErasureIdentifierStore(fixture.work.database, {
      requestId: request.id,
      leaseOwner,
      pageSize: 500,
    });
    const input = { userId, stage: "initial" as const };
    const options = { managedDatabases: ["analytics", "ingest", "postgres_fitness"] };
    await withAnalyticsQueryOwner(
      fixture.work.database,
      fixture.ownedClient,
      {
        resourceId: ANALYTICS_PUBLICATION_RESOURCE,
        intentId: `account-erasure:${request.id}:erase`,
      },
      async (owner) => {
        await prepareClickHouseAccountErasure(owner, store, input, options);
        await eraseClickHouseAccount(owner, store, input, options);
      },
    );
  }
  async function cursor() {
    return fixture.work.database.execute(
      sql`SELECT cursor FROM fitness.analytics_stage_cursor WHERE run_id=${fixture.work.runId}`,
    );
  }
  it("missingGenerationDefaultsToZeroAndPublishesCompiledScalarWithVerifiedDedupReceipts", async () => {
    const row = await prepare();
    await expect(fixture.execute()).resolves.toEqual({ progressed: true, remaining: false });
    expect(
      await fixture.read(
        "SELECT id,scalar,_peerdb_is_deleted FROM analytics.sensor_scalar_sample FINAL",
      ),
    ).toEqual([{ id: row.id, scalar: row.scalar, _peerdb_is_deleted: 0 }]);
    expect(await cursor()).toHaveLength(1);
    const downstream = await readAnalyticsEffectPage(
      { database: fixture.work.database, clickhouse: fixture.ownedClient },
      {
        ...fixture.work,
        stage: "dedup",
        after: null,
        limit: 20,
      },
    );
    expect(downstream.effects).toMatchObject([{ stage: "dedup", sourceId: row.id }]);
    expect(fixture.ownedQueryIds.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });
  it("currentClickHouseGenerationRetractsPreviouslyPublishedScalar", async () => {
    const row = await prepare();
    await fixture.execute();
    await fixture.command(
      `INSERT INTO ingest.provider_data_generation (user_id,provider_id,generation) VALUES ('${row.user_id}','${row.provider_id}',2)`,
    );
    await fixture.page([{ before: row, after: row }], "2", "kafka", ["scalar"]);
    await fixture.execute();
    expect(
      await fixture.read("SELECT id,_peerdb_is_deleted FROM analytics.sensor_scalar_sample FINAL"),
    ).toEqual([{ id: row.id, _peerdb_is_deleted: 1 }]);
    expect(await fixture.dedup()).toMatchObject([{ is_deleted: 1, scalar: null }]);
  });
  it("postgresGenerationBeforeCommandRemainsCoveredUntilNativeTombstoneEffectsRetractOutput", async () => {
    const row = await prepare();
    await fixture.work.database.execute(
      sql`INSERT INTO fitness.provider_data_generation(user_id,provider_id,current_generation) VALUES (${row.user_id},${row.provider_id},1)`,
    );
    const deletion = await createProviderDataDeletionRequest(
      fixture.work.database,
      row.user_id,
      row.provider_id,
      randomUUID(),
    );
    expect(deletion.generation).toBe(2);
    // PG advancement precedes its CH command; old output still has causal work.
    await fixture.execute();
    expect(
      await fixture.read(
        "SELECT id,scalar,_peerdb_is_deleted FROM analytics.sensor_scalar_sample FINAL",
      ),
    ).toEqual([{ id: row.id, scalar: 115, _peerdb_is_deleted: 0 }]);
    const stream = fixture.work.stream;
    const frontier = await loadAnalyticsRunFrontier(fixture.work.database, fixture.work);
    if (frontier.transport !== "kafka") throw new Error("Fixture expects Kafka source coordinates");
    const position = {
      transport: "kafka" as const,
      epoch: stream.epoch,
      topic: stream.topic,
      partition: stream.partition,
      offset: String(BigInt(frontier.offset) + 1n),
    };
    const fence = createMetricStreamProviderGenerationDeletedEvent({
      deletionEventId: deletion.eventId,
      userId: row.user_id,
      providerId: row.provider_id,
      generation: deletion.generation,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    });
    const command = createMetricStreamProviderGenerationDeletedEvent({
      deletionEventId: deletion.eventId,
      userId: row.user_id,
      providerId: row.provider_id,
      generation: deletion.generation,
      sourceIds: [row.id],
      complete: false,
      previousCommandId: fence.commandId,
    });
    const terminal = createMetricStreamProviderGenerationDeletedEvent({
      deletionEventId: deletion.eventId,
      userId: row.user_id,
      providerId: row.provider_id,
      generation: deletion.generation,
      sourceIds: [],
      complete: true,
      previousCommandId: command.commandId,
    });
    const commandPosition = { ...position, offset: String(BigInt(frontier.offset) + 2n) };
    const terminalPosition = { ...position, offset: String(BigInt(frontier.offset) + 3n) };
    await applyMetricStreamEventsToClickHouse(
      fixture.ownedClient,
      [fence, command, terminal],
      {
        topic: stream.topic,
        partition: stream.partition,
        positions: [position, commandPosition, terminalPosition],
        assertActive: async () => undefined,
      },
      fixture.work.database,
    );
    const pending = await fixture.read(
      `SELECT count() AS count FROM analytics.effect_receipt WHERE stage='scalar' AND kafka_offset=${commandPosition.offset}`,
    );
    expect(pending).toEqual([{ count: "1" }]);
    await fixture.sealPosition(terminalPosition);
    await fixture.execute();
    expect(
      await fixture.read("SELECT id,_peerdb_is_deleted FROM analytics.sensor_scalar_sample FINAL"),
    ).toEqual([{ id: row.id, _peerdb_is_deleted: 1 }]);
    expect(await fixture.dedup()).toMatchObject([{ scalar: null, is_deleted: 1 }]);
  });
  it("failureAfterOutputBeforeEffectsReplaysCurrentStateWithANewerAttemptRevision", async () => {
    const row = await prepare();
    await expect(fixture.execute(fixture.failAfterOutputClient())).rejects.toThrow(
      "after output fixture",
    );
    const first = await fixture.work.database.execute<{ page_publication_revision: string }>(
      sql`SELECT page_publication_revision FROM fitness.analytics_stage_cursor WHERE run_id=${fixture.work.runId}`,
    );
    expect(await cursor()).toEqual([{ cursor: null }]);
    await fixture.seed([
      {
        ...row,
        version: "9007199254740994",
        scalar: 157,
        ingested_at: "2026-01-03 00:00:00.123456782",
      },
    ]);
    await fixture.execute();
    const latest = await fixture.read(
      "SELECT id,scalar,toString(refresh_version) AS revision FROM analytics.sensor_scalar_sample FINAL",
    );
    expect(latest).toMatchObject([{ id: row.id, scalar: 157 }]);
    expect(BigInt(String(latest[0]?.revision))).toBeGreaterThan(
      BigInt(first[0]?.page_publication_revision ?? "0"),
    );
    expect(
      await fixture.read(
        "SELECT count() AS count FROM (SELECT id,refresh_version FROM analytics.sensor_scalar_sample GROUP BY id,refresh_version HAVING uniqExact(tuple(scalar,_peerdb_version,_peerdb_is_deleted))>1)",
      ),
    ).toEqual([{ count: "0" }]);
  });
  it("newAttemptSupersedesEveryPartialKeyAndPreservesLaterSourceCoverage", async () => {
    const rows = [sensorRow(1), sensorRow(2, { recorded_at: "2026-01-01 00:00:01.123456" })];
    await fixture.seed(rows);
    await fixture.page(
      rows.map((after) => ({ before: null, after })),
      "1",
      "kafka",
      ["scalar"],
    );
    const original = await readAnalyticsEffectPage(
      { database: fixture.work.database, clickhouse: fixture.ownedClient },
      { ...fixture.work, stage: "scalar", after: null, limit: 20 },
    );
    await expect(fixture.execute(fixture.failAfterOutputClient())).rejects.toThrow(
      "after output fixture",
    );
    const oldRevision = await fixture.work.database.execute<{ page_publication_revision: string }>(
      sql`SELECT page_publication_revision FROM fitness.analytics_stage_cursor WHERE run_id=${fixture.work.runId}`,
    );
    await fixture.seed(
      rows.map((row, index) => ({
        ...row,
        version: "9007199254740994",
        ingested_at: "2026-01-03 00:00:00.123456782",
        scalar: 157,
        recorded_at: index === 0 ? "2026-01-01 00:00:02.123456" : row.recorded_at,
      })),
    );
    const frontier = await loadAnalyticsRunFrontier(fixture.work.database, fixture.work);
    if (frontier.transport !== "kafka") throw new Error("Fixture expects Kafka coordinates");
    const laterPosition = { ...frontier, offset: String(BigInt(frontier.offset) + 1n) };
    const current = await resolveSourcePlacements(
      fixture.ownedClient,
      rows.map((row) => row.id),
    );
    await appendAnalyticsDelivery(fixture.ownedClient, {
      position: laterPosition,
      effects: original.effects.map((effect, index) => {
        const after = current.find((placement) => placement.sourceId === effect.sourceId);
        if (!after) throw new Error("Updated fixture placement is missing");
        return metricStreamSourceEffect(laterPosition, BigInt(index), effect.after, after);
      }),
    });
    await fixture.execute();
    const output = await fixture.read(
      "SELECT id,scalar,_peerdb_is_deleted,toString(refresh_version) AS revision FROM analytics.sensor_scalar_sample FINAL ORDER BY id",
    );
    expect(output).toMatchObject([
      { id: rows[0]?.id, _peerdb_is_deleted: 1 },
      { id: rows[1]?.id, scalar: 157, _peerdb_is_deleted: 0 },
    ]);
    for (const row of output)
      expect(BigInt(String(row.revision))).toBeGreaterThan(
        BigInt(oldRevision[0]?.page_publication_revision ?? "0"),
      );
    expect(
      await fixture.read(
        "SELECT count() AS count FROM (SELECT id,recorded_at,refresh_version FROM analytics.sensor_scalar_sample GROUP BY id,recorded_at,refresh_version HAVING uniqExact(tuple(scalar,_peerdb_version,_peerdb_is_deleted))>1)",
      ),
    ).toEqual([{ count: "0" }]);
    expect(
      await fixture.read(
        `SELECT count() AS count FROM analytics.effect_receipt WHERE stage='scalar' AND kafka_offset=${laterPosition.offset}`,
      ),
    ).toEqual([{ count: "2" }]);
    const saved = await cursor();
    expect(saved).toEqual([
      { cursor: { delivery: { offset: frontier.offset }, effectOrdinal: "1" } },
    ]);
  });
  it.each(["output", "effects", "before cursor", "after cursor"] as const)(
    "realExecutorDeathAfter%sRequiresVerifiedRecoveryAndConverges",
    async (boundary) => {
      const row = await prepare();
      const child = fork(
        new URL("./bounded-analytics-executor-test-helpers.ts", import.meta.url),
        [],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      child.stdout?.resume();
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      try {
        const stopped = new Promise<string>((resolve, reject) => {
          child.once("message", (message) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "queryId" in message &&
              typeof message.queryId === "string"
            )
              resolve(message.queryId);
            else reject(new Error("Executor returned an invalid crash boundary"));
          });
          child.once("error", reject);
          child.once("exit", () =>
            reject(new Error(`Executor exited before crash boundary: ${stderr}`)),
          );
        });
        child.send({
          connectionString: fixture.work.connectionString,
          databases: fixture.databases,
          runId: fixture.work.runId,
          stream: fixture.work.stream,
          artifactDirectory: dirname(fixture.evidencePath),
          boundary,
        });
        const queryId = await stopped;
        expect(child.kill("SIGKILL")).toBe(true);
        expect(await exited).toEqual({ code: null, signal: "SIGKILL" });
        const prior = await fixture.work.database.execute(
          sql`SELECT page_publication_revision FROM fitness.analytics_stage_cursor WHERE run_id=${fixture.work.runId}`,
        );
        await expect(fixture.execute()).rejects.toThrow("verified recovery");
        expect(
          await fixture.work.database.execute(
            sql`SELECT page_publication_revision FROM fitness.analytics_stage_cursor WHERE run_id=${fixture.work.runId}`,
          ),
        ).toEqual(prior);
        // Explicit operator action in the fixture: actual worker death AND exact
        // native terminal evidence, never process absence or a free lock alone.
        await fixture.command("SYSTEM FLUSH LOGS");
        expect(
          await fixture.read(
            `SELECT query_id FROM system.query_log WHERE query_id='${queryId}' AND is_initial_query=1 AND type='QueryFinish'`,
          ),
        ).toEqual([{ query_id: queryId }]);
        const recovered = await fixture.work.database.execute(
          sql`UPDATE fitness.analytics_query_owner SET quiescent=true,query_terminal=true,intent_id=NULL,backend_pid=NULL WHERE resource_id=${ANALYTICS_PUBLICATION_RESOURCE} AND query_id=${queryId} RETURNING resource_id`,
        );
        expect(recovered).toHaveLength(1);
        const before = await fixture.read(
          "SELECT count() AS count FROM analytics.sensor_scalar_sample",
        );
        await fixture.execute();
        expect(
          await fixture.read("SELECT id,scalar FROM analytics.sensor_scalar_sample FINAL"),
        ).toEqual([{ id: row.id, scalar: 115 }]);
        expect(await cursor()).toHaveLength(1);
        if (boundary === "before cursor" || boundary === "after cursor")
          expect(
            await fixture.read("SELECT count() AS count FROM analytics.sensor_scalar_sample"),
          ).toEqual(before);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
    120_000,
  );
  it("accountActivationWaitsForGuardedPublicationBeforeErasureAcquiresTheOwner", async () => {
    const row = await prepare();
    await fixture.enablePhysicalErasureFixture();
    let activation: ReturnType<typeof initiateAccountErasure> | undefined;
    let committed = false;
    let activated = false;
    const client: ClickHouseClient = {
      ...fixture.ownedClient,
      command: async (options) => {
        if (!activated && options.query.startsWith("INSERT INTO")) {
          activated = true;
          activation = initiateAccountErasure(
            fixture.work.database,
            row.user_id,
            async () => "encrypted-fixture",
            async () => undefined,
          ).then((result) => {
            committed = true;
            return result;
          });
          await vi.waitFor(async () =>
            expect(await hasDatabaseLockWaiter(fixture.work.database)).toBe(true),
          );
          expect(committed).toBe(false);
        }
        return fixture.ownedClient.command(options);
      },
    };
    await fixture.execute(client);
    await activation;
    expect(committed).toBe(true);
    await erasePublishedAccount(row.user_id);
    expect(activated).toBe(true);
    expect(
      await fixture.read("SELECT count() AS count FROM analytics.sensor_scalar_sample"),
    ).toEqual([{ count: "0" }]);
  }, 120_000);
  it("accountFenceCommittedBeforeGuardAcquisitionPreventsPublicationAndCursorCommit", async () => {
    const row = await prepare();
    await initiateAccountErasure(
      fixture.work.database,
      row.user_id,
      async () => "encrypted-fixture",
      async () => undefined,
    );
    await expect(fixture.execute()).rejects.toThrow("active account erasure");
    expect(
      await fixture.read("SELECT count() AS count FROM analytics.sensor_scalar_sample"),
    ).toEqual([{ count: "0" }]);
    expect(
      await fixture.read(
        "SELECT count() AS count FROM analytics.effect_receipt WHERE stage='dedup'",
      ),
    ).toEqual([{ count: "0" }]);
    expect(await cursor()).toEqual([{ cursor: null }]);
  });
  it("pathologicalPageMemoryFailureDoesNotCheckpoint", async () => {
    await seedSensorResourceHistory(fixture, "pathological");
    await fixture.page(
      Array.from({ length: 20 }, (_, index) => ({
        before: sensorResourceRow(index, 1, 1),
        after: sensorResourceRow(index, 2, 1),
      })),
      "3",
      "kafka",
      ["scalar"],
    );
    const loggedFailure: ClickHouseClient = {
      ...fixture.ownedClient,
      command: async (options) => {
        try {
          return await fixture.ownedClient.command(options);
        } finally {
          await fixture.client.command({ query: "SYSTEM FLUSH LOGS" });
        }
      },
    };
    await expect(fixture.execute(loggedFailure)).rejects.toMatchObject({
      state: "failed",
      stage: "scalar",
      cause: { code: "241" },
    });
    expect(await cursor()).toEqual([{ cursor: null }]);
    expect(
      await fixture.read("SELECT count() AS count FROM analytics.sensor_scalar_sample"),
    ).toEqual([{ count: "0" }]);
    expect(
      await fixture.read(
        "SELECT count() AS count FROM analytics.effect_receipt WHERE stage='dedup'",
      ),
    ).toEqual([{ count: "0" }]);
    expect(
      await fixture.work.database.execute(
        sql`SELECT intent_id,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${ANALYTICS_PUBLICATION_RESOURCE}`,
      ),
    ).toEqual([{ intent_id: null, quiescent: true }]);
    expect(
      await fixture.work.database.execute(
        sql`SELECT page_state,cursor FROM fitness.analytics_stage_cursor WHERE run_id=${fixture.work.runId}`,
      ),
    ).toEqual([{ page_state: "pending", cursor: null }]);
  }, 120_000);
  it("knownTerminalPageFailureAllowsConcreteErasureWhileItsPageRemainsPending", async () => {
    const row = await prepare();
    await fixture.enablePhysicalErasureFixture();
    await expect(fixture.execute(fixture.failAfterOutputClient())).rejects.toThrow(
      "after output fixture",
    );
    expect(await cursor()).toEqual([{ cursor: null }]);
    const userId = row.user_id;
    await initiateAccountErasure(
      fixture.work.database,
      userId,
      async () => "encrypted-fixture",
      async () => undefined,
    );
    await erasePublishedAccount(userId);
    await expect(fixture.execute()).rejects.toMatchObject({ state: "failed" });
    expect(
      await fixture.read("SELECT count() AS count FROM analytics.sensor_scalar_sample"),
    ).toEqual([{ count: "0" }]);
    expect(await cursor()).toEqual([{ cursor: null }]);
  }, 120_000);
  it("staleRunOwnerCannotCheckpoint", async () => {
    await prepare();
    const client = {
      ...fixture.ownedClient,
      command: async (options: Parameters<typeof fixture.ownedClient.command>[0]) => {
        const result = await fixture.ownedClient.command(options);
        await fixture.work.database.execute(
          sql`UPDATE fitness.analytics_run SET owner_id=${randomUUID()} WHERE id=${fixture.work.runId}`,
        );
        return result;
      },
    };
    await expect(fixture.execute(client)).rejects.toThrow(/owner changed|stale writer/);
    expect(await cursor()).toEqual([{ cursor: null }]);
  });
});
