import { randomUUID } from "node:crypto";
import Pulsar from "pulsar-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { logger } from "../logger.ts";
import { metricStreamPosition } from "../metric-stream/transport-position.ts";
import {
  beginAnalyticsDelivery,
  checkpointAnalyticsPage,
  claimAnalyticsRunOwnership,
  claimAnalyticsStream,
  completeAnalyticsDelivery,
  sealAnalyticsRun,
} from "./analytics-work-store.ts";
import {
  appendAnalyticsDelivery,
  appendAnalyticsEffects,
  commitPreparedAnalyticsDelivery,
  prepareAnalyticsDelivery,
  readAnalyticsEffectPage,
  readPreparedAnalyticsEffectPages,
  verifyAnalyticsDeliveryReceipt,
} from "./effect-journal.ts";
import { journalDeliveryKey } from "./journal-position.ts";
import {
  analyticsEffect,
  analyticsPosition,
  createAnalyticsTestContext,
  seedAnalyticsKeysetFixture,
} from "./test-helpers.ts";

describe("analytics effect journal", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });

  it("twentyEffectPreflightUsesThreeBoundedProofReadsBeforeExistingWrites", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 5n);
    const effects = Array.from({ length: 20 }, (_, ordinal) =>
      analyticsEffect(position, BigInt(ordinal), context.userId),
    );
    const reads: string[] = [];
    const client: ClickHouseClient = {
      ...context.clickhouse,
      query<T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) {
        reads.push(options.query);
        return context.clickhouse.query<T>(options);
      },
    };
    await appendAnalyticsEffects(client, effects);
    expect(reads).toHaveLength(3);
    const rows = await context.clickhouse.query<{ count: string }>({
      query:
        "SELECT toString(count()) AS count FROM analytics.effect_journal FINAL WHERE epoch={epoch:String}",
      query_params: { epoch: position.epoch },
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([{ count: "20" }]);
    reads.length = 0;
    await appendAnalyticsEffects(client, effects);
    expect(reads).toHaveLength(3);
  });

  it("twentyDiscoveryReferencesUseOneExactPayloadFetch", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 6n);
    const effects = Array.from({ length: 20 }, (_, ordinal) =>
      analyticsEffect(position, BigInt(ordinal), context.userId),
    );
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    let payloadReads = 0;
    const client: ClickHouseClient = {
      ...context.clickhouse,
      query<T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) {
        if (options.query.includes("FROM analytics.effect_journal")) payloadReads++;
        return context.clickhouse.query<T>(options);
      },
    };
    expect(await verifyAnalyticsDeliveryReceipt(client, position)).toEqual({ effectCount: 20n });
    expect(payloadReads).toBe(1);
  });

  it("publicAppendPreflightsAllChunksBeforeWritingWhenTwentyFirstIdentityConflicts", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 7n);
    const effects = Array.from({ length: 21 }, (_, ordinal) =>
      analyticsEffect(position, BigInt(ordinal), context.userId),
    );
    const last = effects[20];
    if (!last || !context.clickhouse.insert) throw new Error("Fixture requires last effect/insert");
    await appendAnalyticsEffects(context.clickhouse, [last]);
    let writes = 0;
    const insert = context.clickhouse.insert.bind(context.clickhouse);
    const client: ClickHouseClient = {
      ...context.clickhouse,
      insert: async (options) => {
        writes++;
        return insert(options);
      },
    };
    await expect(
      appendAnalyticsEffects(client, [
        ...effects.slice(0, 20),
        { ...last, operationId: randomUUID() },
      ]),
    ).rejects.toThrow("changed an existing");
    expect(writes).toBe(0);
    const rows = await context.clickhouse.query<{ count: string }>({
      query:
        "SELECT toString(count()) AS count FROM analytics.effect_journal FINAL WHERE epoch={epoch:String}",
      query_params: { epoch: position.epoch },
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([{ count: "1" }]);
  });

  it.each([0, 19])("proofLookupRejectsTamperedJournalHashAtPageEdge%s", async (ordinal) => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 8n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    await appendAnalyticsEffects(context.clickhouse, effects);
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal UPDATE effect_hash=repeat('0',64) WHERE epoch={epoch:String} AND effect_ordinal={ordinal:UInt64} SETTINGS mutations_sync=2",
      query_params: { epoch: position.epoch, ordinal },
    });
    await expect(appendAnalyticsEffects(context.clickhouse, effects)).rejects.toThrow(
      "changed an existing analytics effect identity",
    );
  });

  it.each([0, 19])("proofLookupRejectsTamperedDiscoveryHashAtPageEdge%s", async (ordinal) => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 9n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    await appendAnalyticsEffects(context.clickhouse, effects);
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_receipt UPDATE effect_hash=repeat('0',64) WHERE epoch={epoch:String} AND effect_ordinal={ordinal:Int128} SETTINGS mutations_sync=2",
      query_params: { epoch: position.epoch, ordinal },
    });
    await expect(appendAnalyticsEffects(context.clickhouse, effects)).rejects.toThrow(
      "effect receipt identity",
    );
  });

  it.each([0, 19])("payloadFetchRejectsMissingPageEdge%s", async (ordinal) => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 10n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal DELETE WHERE epoch={epoch:String} AND effect_ordinal={ordinal:UInt64} SETTINGS mutations_sync=2",
      query_params: { epoch: position.epoch, ordinal },
    });
    await expect(verifyAnalyticsDeliveryReceipt(context.clickhouse, position)).rejects.toThrow(
      "Missing analytics journal effect",
    );
  });

  it.each([0, 19])(
    "closedStageCannotAdoptMissingDiscoveryIdentityAtPageEdge%s",
    async (ordinal) => {
      const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 11n);
      const effects = Array.from({ length: 20 }, (_, index) =>
        analyticsEffect(position, BigInt(index), context.userId),
      );
      await appendAnalyticsDelivery(context.clickhouse, { position, effects });
      await context.clickhouse.command({
        query:
          "ALTER TABLE analytics.effect_receipt DELETE WHERE epoch={epoch:String} AND effect_ordinal={ordinal:Int128} SETTINGS mutations_sync=2",
        query_params: { epoch: position.epoch, ordinal },
      });
      await expect(appendAnalyticsEffects(context.clickhouse, effects)).rejects.toThrow(
        "closed stage",
      );
    },
  );

  it("closedStageRejectsANewLastKeyWithoutPublishingEarlierKeys", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 12n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    await expect(
      appendAnalyticsEffects(context.clickhouse, [
        ...effects.slice(0, 19),
        analyticsEffect(position, 20n, context.userId),
      ]),
    ).rejects.toThrow("closed stage");
  });

  it("proofSetsPreserveMixedStreamStageAndLosslessNativeKafkaIdentities", async () => {
    const stream = { ...context.stream, partition: 0, epoch: randomUUID() };
    const native = analyticsPosition(stream, 9007199254740993n);
    const kafka = {
      transport: "kafka" as const,
      epoch: stream.epoch,
      topic: stream.topic,
      partition: 0,
      offset: "9007199254740993",
    };
    const stages = ["scalar", "dedup", "activity"] as const;
    const effects = Array.from({ length: 20 }, (_, index) => {
      const base = analyticsEffect(native, 9007199254740993n + BigInt(index), context.userId);
      const position = index % 2 ? kafka : native;
      return {
        ...base,
        stream: { ...stream, transport: position.transport },
        position,
        cursor: {
          delivery: journalDeliveryKey(position),
          effectOrdinal: base.cursor.effectOrdinal,
        },
        stage: stages[index % 3] ?? "scalar",
      };
    });
    await appendAnalyticsEffects(context.clickhouse, effects);
    await appendAnalyticsEffects(context.clickhouse, effects);
    for (const index of [0, 19]) {
      const selected = effects[index];
      if (!selected) throw new Error("Fixture requires page edge");
      await expect(
        appendAnalyticsEffects(
          context.clickhouse,
          effects.map((effect, offset) =>
            offset === index ? { ...selected, operationId: randomUUID() } : effect,
          ),
        ),
      ).rejects.toThrow("changed an existing");
    }
  });

  it.each(["user_id", "serialized_message_id"])(
    "payloadFetchRejectsCorrupt%sAtLastKey",
    async (column) => {
      const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 13n);
      const effects = Array.from({ length: 20 }, (_, index) =>
        analyticsEffect(position, BigInt(index), context.userId),
      );
      await appendAnalyticsDelivery(context.clickhouse, { position, effects });
      await context.clickhouse.command({
        query: `ALTER TABLE analytics.effect_journal UPDATE ${column}={value:${column === "user_id" ? "UUID" : "String"}} WHERE epoch={epoch:String} AND effect_ordinal=19 SETTINGS mutations_sync=2`,
        query_params: {
          epoch: position.epoch,
          value: column === "user_id" ? randomUUID() : "AA==",
        },
      });
      await expect(verifyAnalyticsDeliveryReceipt(context.clickhouse, position)).rejects.toThrow();
    },
  );

  it.each(["duplicate", "unexpected"])("payloadFetchRejectsActualSQL%sRows", async (kind) => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 14n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    const foreign = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 15n);
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    await appendAnalyticsDelivery(context.clickhouse, {
      position: foreign,
      effects: [analyticsEffect(foreign, 0n, context.userId)],
    });
    const client: ClickHouseClient = {
      ...context.clickhouse,
      query<T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) {
        if (
          !options.query.startsWith("SELECT * FROM analytics.effect_journal") ||
          !options.query.includes("LIMIT 2 BY")
        )
          return context.clickhouse.query<T>(options);
        const extra =
          kind === "duplicate"
            ? options.query
            : "SELECT * FROM analytics.effect_journal FINAL WHERE epoch={foreignEpoch:String} LIMIT 1";
        return context.clickhouse.query<T>({
          ...options,
          query: `(${options.query}) UNION ALL (${extra})`,
          query_params: { ...options.query_params, foreignEpoch: foreign.epoch },
        });
      },
    };
    await expect(verifyAnalyticsDeliveryReceipt(client, position)).rejects.toThrow(
      kind === "duplicate"
        ? "Missing analytics journal effect"
        : "Unexpected analytics proof identity",
    );
  });

  it("duplicateIdentityAcrossChunksRejectsBeforeAnyPublicAppendWrite", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 16n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    const first = effects[0];
    if (!first || !context.clickhouse.insert) throw new Error("Fixture requires effect/insert");
    let writes = 0;
    const insert = context.clickhouse.insert.bind(context.clickhouse);
    const client = {
      ...context.clickhouse,
      insert: async (options: Parameters<typeof insert>[0]) => {
        writes++;
        return insert(options);
      },
    };
    await expect(appendAnalyticsEffects(client, [...effects, first])).rejects.toThrow(
      "duplicate effect identities",
    );
    expect(writes).toBe(0);
  });

  it("perKeyTwoRowBoundDoesNotHideTheLastConflictingIdentity", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 17n);
    const effects = Array.from({ length: 20 }, (_, index) =>
      analyticsEffect(position, BigInt(index), context.userId),
    );
    await appendAnalyticsEffects(context.clickhouse, effects);
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal UPDATE effect_hash=repeat('0',64) WHERE epoch={epoch:String} AND effect_ordinal=19 SETTINGS mutations_sync=2",
      query_params: { epoch: position.epoch },
    });
    const client: ClickHouseClient = {
      ...context.clickhouse,
      query<T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) {
        if (!options.query.includes("effect_hash FROM analytics.effect_journal"))
          return context.clickhouse.query<T>(options);
        const from =
          "FROM (SELECT * FROM analytics.effect_journal FINAL UNION ALL SELECT * FROM analytics.effect_journal FINAL WHERE epoch={fixtureEpoch:String} AND effect_ordinal=0)";
        const query = options.query
          .replace("FROM analytics.effect_journal FINAL", from)
          .replace(/\bLIMIT\b/, "ORDER BY effect_ordinal LIMIT");
        return context.clickhouse.query<T>({
          ...options,
          query,
          query_params: { ...options.query_params, fixtureEpoch: position.epoch },
        });
      },
    };
    await expect(appendAnalyticsEffects(client, effects)).rejects.toThrow(
      "changed an existing analytics effect identity",
    );
  });

  it("preparedIntentIsImmutableAndUndiscoverableUntilRawSuccess", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 1n);
    const effect = analyticsEffect(position, 0n, context.userId);
    await prepareAnalyticsDelivery(context.clickhouse, {
      position,
      async *pages() {
        yield [effect];
      },
    });
    await expect(verifyAnalyticsDeliveryReceipt(context.clickhouse, position)).rejects.toThrow(
      "missing",
    );
    const receipt = await context.clickhouse.query<{ count: string }>({
      query:
        "SELECT toString(count()) AS count FROM analytics.effect_receipt WHERE epoch={epoch:String}",
      query_params: { epoch: position.epoch },
      format: "JSONEachRow",
    });
    expect(await receipt.json()).toEqual([{ count: "0" }]);
    await prepareAnalyticsDelivery(context.clickhouse, {
      position,
      pages() {
        throw new Error("Must not re-derive a changed preimage");
      },
    });
    const restarted = context.makeClient();
    try {
      const restored = [];
      for await (const page of readPreparedAnalyticsEffectPages(restarted, position))
        restored.push(...page);
      expect(restored).toEqual([effect]);
      await commitPreparedAnalyticsDelivery(restarted, position);
      await verifyAnalyticsDeliveryReceipt(restarted, position);
    } finally {
      await restarted.close?.();
    }
  });

  it("partialIntentCannotBeMistakenForCompleteAndReplayPreservesPrefix", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 2n);
    const first = analyticsEffect(position, 0n, context.userId);
    const second = analyticsEffect(position, 1n, context.userId);
    await expect(
      prepareAnalyticsDelivery(context.clickhouse, {
        position,
        async *pages() {
          yield [first];
          throw new Error("crash during preparation");
        },
      }),
    ).rejects.toThrow("crash during preparation");
    await expect(commitPreparedAnalyticsDelivery(context.clickhouse, position)).rejects.toThrow(
      "complete preparation",
    );
    await expect(
      prepareAnalyticsDelivery(context.clickhouse, {
        position,
        async *pages() {
          yield [{ ...first, operationId: randomUUID() }];
        },
      }),
    ).rejects.toThrow("changed an existing");
    await expect(
      prepareAnalyticsDelivery(context.clickhouse, {
        position,
        async *pages() {
          yield [first, second];
          throw new Error("crash after both intent rows");
        },
      }),
    ).rejects.toThrow("crash after both");
    await expect(
      prepareAnalyticsDelivery(context.clickhouse, {
        position,
        async *pages() {
          yield [first];
        },
      }),
    ).rejects.toThrow("previously persisted intent was complete");
    await prepareAnalyticsDelivery(context.clickhouse, {
      position,
      async *pages() {
        yield [first];
        yield [second];
      },
    });
    await commitPreparedAnalyticsDelivery(context.clickhouse, position);
    await verifyAnalyticsDeliveryReceipt(context.clickhouse, position);
  });

  it("zeroEffectIntentNeedsExplicitCompletePreparation", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 3n);
    await expect(
      prepareAnalyticsDelivery(context.clickhouse, {
        position,
        pages() {
          throw new Error("crash before empty preparation completes");
        },
      }),
    ).rejects.toThrow("crash before empty");
    await expect(commitPreparedAnalyticsDelivery(context.clickhouse, position)).rejects.toThrow(
      "complete preparation",
    );
    await prepareAnalyticsDelivery(context.clickhouse, {
      position,
      async *pages() {
        yield [];
      },
    });
    await expect(verifyAnalyticsDeliveryReceipt(context.clickhouse, position)).rejects.toThrow(
      "missing",
    );
    await commitPreparedAnalyticsDelivery(context.clickhouse, position);
    await verifyAnalyticsDeliveryReceipt(context.clickhouse, position);
  });

  it("scopeSizedIntentUsesBoundedPagesAndStreamedReceiptFinalization", async () => {
    const position = analyticsPosition({ ...context.stream, epoch: randomUUID() }, 4n);
    const effects = Array.from({ length: 45 }, (_, ordinal) =>
      analyticsEffect(position, BigInt(ordinal), context.userId),
    );
    let maximumInsert = 0;
    const insert = context.clickhouse.insert?.bind(context.clickhouse);
    if (!insert) throw new Error("Fixture requires insert");
    const bounded = {
      ...context.clickhouse,
      insert: async (options: Parameters<typeof insert>[0]) => {
        maximumInsert = Math.max(maximumInsert, options.values.length);
        return insert(options);
      },
    };
    await prepareAnalyticsDelivery(bounded, {
      position,
      async *pages() {
        for (let index = 0; index < effects.length; index += 20)
          yield effects.slice(index, index + 20);
      },
    });
    const lengths = [];
    for await (const page of readPreparedAnalyticsEffectPages(bounded, position))
      lengths.push(page.length);
    expect(lengths).toEqual([20, 20, 5]);
    await commitPreparedAnalyticsDelivery(bounded, position);
    expect(maximumInsert).toBe(20);
    await verifyAnalyticsDeliveryReceipt(bounded, position);
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  it("rejectsNoncanonicalInactiveTransportStorageColumns", async () => {
    if (!context.clickhouse.insert) throw new Error("Fixture needs insert");
    for (const transport of ["kafka", "pulsar"]) {
      await expect(
        context.clickhouse.insert({
          table: "analytics.effect_receipt",
          format: "JSONEachRow",
          values: [
            {
              ...context.stream,
              transport,
              kafka_offset: "42",
              major: "10",
              minor: "0",
              batch: -1,
              effect_ordinal: "-1",
              stage: "scalar",
              effect_hash: "0".repeat(64),
              is_empty: 1,
              user_id: null,
            },
          ],
        }),
      ).rejects.toThrow(/constraint/i);
    }
  });

  it("keepsKafkaAndNativeReceiptsFrontiersAndCursorsDistinctAcrossRestart", async () => {
    const nativeStream = {
      ...context.stream,
      epoch: randomUUID(),
      transport: "pulsar" as const,
      partition: 0,
    };
    const nativePosition = analyticsPosition(nativeStream, 0n);
    const nativeEffect = analyticsEffect(nativePosition, 0n, context.userId);
    const kafkaStream = { ...nativeStream, transport: "kafka" as const };
    const kafkaPosition = { ...kafkaStream, offset: "9007199254740993" };
    const kafkaEffect = {
      ...nativeEffect,
      stream: kafkaStream,
      position: kafkaPosition,
      cursor: { delivery: { offset: kafkaPosition.offset }, effectOrdinal: "0" },
    };
    const runId = randomUUID();
    for (const effect of [nativeEffect, kafkaEffect]) {
      const ownerId = randomUUID();
      await claimAnalyticsStream(context.database, {
        stream: effect.stream,
        ownerId,
        expectedOwnerId: null,
      });
      await beginAnalyticsDelivery(context.database, {
        stream: effect.stream,
        ownerId,
        expected: null,
        position: effect.position,
      });
      if (effect.position.transport === "kafka") {
        await expect(
          sealAnalyticsRun(context.database, {
            runId: randomUUID(),
            frontiers: [
              {
                operationId: context.operation.id,
                datasetKey: "activity",
                stream: effect.stream,
                position: effect.position,
              },
            ],
          }),
        ).rejects.toThrow(/processed delivery frontier/);
      }
      await appendAnalyticsDelivery(context.clickhouse, {
        position: effect.position,
        effects: [effect],
      });
      await completeAnalyticsDelivery(context.database, context.clickhouse, {
        stream: effect.stream,
        ownerId,
        position: effect.position,
      });
    }
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [nativeEffect, kafkaEffect].map((effect) => ({
        operationId: context.operation.id,
        datasetKey: "activity" as const,
        stream: effect.stream,
        position: effect.position,
      })),
    });
    const restarted = context.makeClient();
    const runOwnerId = randomUUID();
    await claimAnalyticsRunOwnership(context.database, {
      runId,
      ownerId: runOwnerId,
      expectedOwnerId: null,
    });
    try {
      for (const effect of [nativeEffect, kafkaEffect]) {
        await verifyAnalyticsDeliveryReceipt(restarted, effect.position);
        const page = await readAnalyticsEffectPage(
          { clickhouse: restarted, database: context.database },
          {
            runId,
            stream: effect.stream,
            stage: "scalar",
            after: null,
            limit: 20,
          },
        );
        expect(page.effects).toEqual([effect]);
        expect(page.next).toEqual(effect.cursor);
        expect(page.exhausted).toBe(true);
        await checkpointAnalyticsPage(context.database, {
          runId,
          ownerId: runOwnerId,
          stream: effect.stream,
          stage: "scalar",
          expected: null,
          next: effect.cursor,
        });
      }
      await expect(
        verifyAnalyticsDeliveryReceipt(restarted, { ...kafkaPosition, offset: "9007199254740992" }),
      ).rejects.toThrow(/missing/);
    } finally {
      await restarted.close?.();
    }
  });

  it("directAppendPreservesEveryStorageIdentityComponent", async () => {
    const stream = { ...context.stream, epoch: randomUUID() };
    const position = analyticsPosition(stream, 0n);
    const effect = analyticsEffect(position, 0n, context.userId);
    const alternateEpoch = { ...stream, epoch: randomUUID() };
    const alternateTopic = { ...stream, topic: `${stream.topic}-other` };
    const native = (hex: string, partition = -1) =>
      metricStreamPosition(
        { ...stream, partition },
        Pulsar.MessageId.deserialize(Buffer.from(hex, "hex")),
      );
    const effects = [
      effect,
      analyticsEffect(analyticsPosition(alternateEpoch, 0n), 0n, context.userId),
      analyticsEffect(analyticsPosition(alternateTopic, 0n), 0n, context.userId),
      analyticsEffect(native("080a10001800", 0), 0n, context.userId),
      analyticsEffect(native("080b1000"), 0n, context.userId),
      analyticsEffect(analyticsPosition(stream, 1n), 0n, context.userId),
      analyticsEffect(native("080a10002000"), 0n, context.userId),
      analyticsEffect(position, 1n, context.userId),
      { ...effect, stage: "dedup" as const },
    ];
    await appendAnalyticsEffects(context.clickhouse, effects);
    for (const table of ["effect_journal", "effect_receipt"]) {
      const result = await context.clickhouse.query<{ row_count: string; identity_count: string }>({
        query: `SELECT toString(count()) AS row_count,toString(uniqExact((epoch,topic,partition,major,minor,batch,effect_ordinal,stage))) AS identity_count FROM analytics.${table} FINAL WHERE epoch IN {epochs:Array(String)}`,
        query_params: { epochs: [stream.epoch, alternateEpoch.epoch] },
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ row_count: "9", identity_count: "9" }]);
    }
  });

  it.each(["identical", "conflicting"] as const)(
    "directAppendRejectsDuplicateIdentitiesWithoutPersistingAnyWork: %s",
    async (kind) => {
      const stream = { ...context.stream, epoch: randomUUID() };
      const position = analyticsPosition(stream, 0n);
      const effect = analyticsEffect(position, 0n, context.userId);
      if (!effect.after) throw new Error("Missing source fixture");
      const duplicate =
        kind === "identical"
          ? effect
          : {
              ...effect,
              sourceVersion: "9007199254740994",
              after: { ...effect.after, sourceVersion: "9007199254740994" },
            };
      await expect(
        appendAnalyticsEffects(context.clickhouse, [
          analyticsEffect(position, 1n, context.userId),
          effect,
          duplicate,
        ]),
      ).rejects.toThrow(/duplicate effect identit/i);
      for (const table of ["effect_journal", "effect_receipt"]) {
        const result = await context.clickhouse.query<{ row_count: string }>({
          query: `SELECT toString(count()) AS row_count FROM analytics.${table} WHERE epoch={epoch:String}`,
          query_params: { epoch: stream.epoch },
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ row_count: "0" }]);
      }
    },
  );

  async function sealDelivery(count: number, firstOrdinal = 0n) {
    const stream = { ...context.stream, epoch: randomUUID() };
    const position = analyticsPosition(stream, 1000n);
    const ownerId = randomUUID();
    await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
    await beginAnalyticsDelivery(context.database, { stream, ownerId, expected: null, position });
    const effects = Array.from({ length: count }, (_, index) =>
      analyticsEffect(position, firstOrdinal + BigInt(index), context.userId),
    );
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      stream,
      ownerId,
      position,
    });
    const runId = randomUUID();
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [{ operationId: context.operation.id, datasetKey: "activity", stream, position }],
    });
    return { effects, runId, stream, position, ownerId };
  }

  it("limitsEffectsBeforeDistinctKeys", async () => {
    const { runId, stream, effects } = await sealDelivery(25);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual(effects.slice(0, 20));
    expect(new Set(page.effects.map((effect) => effect.after?.key.recordedAt)).size).toBe(1);
    expect(page.exhausted).toBe(false);
    expect(page.next?.effectOrdinal).toBe("19");
    const next = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: page.next,
      limit: 20,
    });
    expect(next.effects).toEqual(effects.slice(20));
    expect(next.exhausted).toBe(true);
  });

  it("replaysDuplicateDeliveryWithoutMissingEffects", async () => {
    const { runId, stream, effects, position } = await sealDelivery(25);
    await appendAnalyticsDelivery(context.clickhouse, { position, effects });
    const first = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    const second = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: first.next,
      limit: 20,
    });
    expect([...first.effects, ...second.effects]).toEqual(effects);
    const recreated = context.makeClient();
    try {
      expect(
        await readAnalyticsEffectPage(
          { database: context.database, clickhouse: recreated },
          { runId, stage: "scalar", stream, after: first.next, limit: 20 },
        ),
      ).toEqual(second);
    } finally {
      await recreated.close?.();
    }
  });

  it("laterDeliveryCannotEnterAnAlreadySealedPrefix", async () => {
    const { runId, stream, position, ownerId, effects } = await sealDelivery(1);
    const later = analyticsPosition(stream, 1000000n);
    const laterEffects = [analyticsEffect(later, 0n, context.userId)];
    await beginAnalyticsDelivery(context.database, {
      stream,
      ownerId,
      expected: position,
      position: later,
    });
    await appendAnalyticsDelivery(context.clickhouse, { position: later, effects: laterEffects });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      stream,
      ownerId,
      position: later,
    });
    await expect(
      beginAnalyticsDelivery(context.database, { stream, ownerId, expected: later, position }),
    ).rejects.toThrow(/order/i);
    await expect(
      appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: [...effects, analyticsEffect(position, 1n, context.userId)],
      }),
    ).rejects.toThrow(/receipt/i);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual(effects);
    expect(page.exhausted).toBe(true);
  });

  it("missingAllEffectsOfAnEarlierReceiptedDeliveryCannotBecomeExhausted", async () => {
    const { stream, position, ownerId } = await sealDelivery(1);
    const later = analyticsPosition(stream, 1000000n);
    await beginAnalyticsDelivery(context.database, {
      stream,
      ownerId,
      expected: position,
      position: later,
    });
    await appendAnalyticsDelivery(context.clickhouse, {
      position: later,
      effects: [analyticsEffect(later, 0n, context.userId)],
    });
    await completeAnalyticsDelivery(context.database, context.clickhouse, {
      stream,
      ownerId,
      position: later,
    });
    const runId = randomUUID();
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [
        { operationId: context.operation.id, datasetKey: "activity", stream, position: later },
      ],
    });
    await context.clickhouse.command({
      query:
        "ALTER TABLE analytics.effect_journal DELETE WHERE epoch={epoch:String} AND minor=1000 SETTINGS mutations_sync=2",
      query_params: { epoch: stream.epoch },
    });
    const ownership = await context.clickhouse.query<{ user_id: string }>({
      query:
        "SELECT user_id FROM analytics.effect_receipt FINAL WHERE epoch={epoch:String} AND minor=1000",
      query_params: { epoch: stream.epoch },
      format: "JSONEachRow",
    });
    expect(await ownership.json()).toEqual([{ user_id: context.userId }]);
    await expect(
      readAnalyticsEffectPage(context, { runId, stage: "scalar", stream, after: null, limit: 20 }),
    ).rejects.toThrow(/receipt|missing|identity/i);
  });

  it("zeroEffectReceiptAdvancesANoncollidingDurableCursor", async () => {
    const { runId, stream, position } = await sealDelivery(0);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual([]);
    expect(page.next).toEqual({ delivery: position.delivery, effectOrdinal: "-1" });
    expect(page.exhausted).toBe(true);
    if (!page.next) throw new Error("Empty delivery receipt did not progress");
    const writerOwnerId = randomUUID();
    await claimAnalyticsRunOwnership(context.database, {
      runId,
      ownerId: writerOwnerId,
      expectedOwnerId: null,
    });
    await checkpointAnalyticsPage(context.database, {
      ownerId: writerOwnerId,
      runId,
      stage: "scalar",
      stream,
      expected: null,
      next: page.next,
    });
  });

  it("emptyButNotExhaustedPagesAdvanceThroughBoundedReceiptSpans", async () => {
    const stream = { ...context.stream, epoch: randomUUID() };
    const ownerId = randomUUID();
    await claimAnalyticsStream(context.database, { stream, ownerId, expectedOwnerId: null });
    let previous: ReturnType<typeof analyticsPosition> | null = null;
    for (let index = 1; index <= 22; index++) {
      const position = analyticsPosition(stream, BigInt(index) * 1000n);
      await beginAnalyticsDelivery(context.database, {
        stream,
        ownerId,
        expected: previous,
        position,
      });
      await appendAnalyticsDelivery(context.clickhouse, {
        position,
        effects: index === 22 ? [analyticsEffect(position, 0n, context.userId)] : [],
      });
      await completeAnalyticsDelivery(context.database, context.clickhouse, {
        stream,
        ownerId,
        position,
      });
      previous = position;
    }
    if (!previous) throw new Error("Missing finite fixture frontier");
    const runId = randomUUID();
    await sealAnalyticsRun(context.database, {
      runId,
      frontiers: [
        { operationId: context.operation.id, datasetKey: "activity", stream, position: previous },
      ],
    });
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 20,
    });
    expect(page.effects).toEqual([]);
    expect(page.exhausted).toBe(false);
    expect(page.next).toEqual({
      delivery: analyticsPosition(stream, 20000n).delivery,
      effectOrdinal: "-1",
    });
    const next = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: page.next,
      limit: 20,
    });
    expect(next.effects).toHaveLength(1);
    expect(next.exhausted).toBe(true);
    expect(next.next?.effectOrdinal).toBe("0");
  });

  it("largeEffectOrdinalsRoundTripWithoutNumericTruncation", async () => {
    const { runId, stream, effects } = await sealDelivery(2, 9007199254740993n);
    const page = await readAnalyticsEffectPage(context, {
      runId,
      stage: "scalar",
      stream,
      after: null,
      limit: 1,
    });
    expect(page.effects).toEqual(effects.slice(0, 1));
    expect(page.next?.effectOrdinal).toBe("9007199254740993");
    expect(
      (
        await readAnalyticsEffectPage(context, {
          runId,
          stage: "scalar",
          stream,
          after: page.next,
          limit: 1,
        })
      ).next?.effectOrdinal,
    ).toBe("9007199254740994");
  });

  it("missingDiscoveryReceiptSchemaFailsHard", async () => {
    const { runId, stream } = await sealDelivery(1);
    await context.clickhouse.command({
      query: "RENAME TABLE analytics.effect_receipt TO analytics.fixture_receipt_removed",
    });
    try {
      await expect(
        readAnalyticsEffectPage(context, {
          runId,
          stage: "scalar",
          stream,
          after: null,
          limit: 20,
        }),
      ).rejects.toThrow(/effect_receipt|UNKNOWN_TABLE|does not exist/i);
    } finally {
      await context.clickhouse.command({
        query: "RENAME TABLE analytics.fixture_receipt_removed TO analytics.effect_receipt",
      });
    }
  });

  it.each([
    ["pulsar", "one-delivery"],
    ["pulsar", "many-deliveries"],
    ["kafka", "one-delivery"],
    ["kafka", "many-deliveries"],
  ] as const)(
    "keysetPrunesTransportDeliveryAndOrdinalGranules: %s/%s",
    async (transport, shape) => {
      const input = await seedAnalyticsKeysetFixture(context, shape, transport);
      const queryId = randomUUID();
      let captured: Parameters<ClickHouseClient["query"]>[0] | undefined;
      const lookups: Parameters<ClickHouseClient["query"]>[0][] = [];
      const clickhouse: ClickHouseClient = {
        ...context.clickhouse,
        query<TRow extends object>(options: Parameters<ClickHouseClient["query"]>[0]) {
          if (options.query.includes("PREWHERE")) {
            captured = { ...options, query_id: queryId };
            return context.clickhouse.query<TRow>(captured);
          }
          if (options.query.includes("LIMIT 2 BY")) {
            const lookup = { ...options, query_id: options.query_id ?? randomUUID() };
            lookups.push(lookup);
            return context.clickhouse.query<TRow>(lookup);
          }
          return context.clickhouse.query<TRow>(options);
        },
      };
      const page = await readAnalyticsEffectPage(
        { database: context.database, clickhouse },
        { ...input, stage: "scalar", limit: 20 },
      );
      expect(page.effects).toEqual(input.expected);
      await appendAnalyticsEffects(clickhouse, input.expected);
      expect(lookups).toHaveLength(4);
      if (!captured) throw new Error("Missing captured native page query");
      const plan = await context.clickhouse.query<{ explain: string }>({
        ...captured,
        query_id: undefined,
        query: `EXPLAIN PLAN indexes=1 ${captured.query}`,
      });
      const text = (await plan.json()).map((row) => row.explain).join("\n");
      const condition = text.split("Condition:")[1]?.split("Parts:")[0] ?? "";
      expect(text).toContain("Read type: InOrder");
      for (const coordinate of transport === "pulsar"
        ? ["major", "minor", "batch", "effect_ordinal"]
        : ["kafka_offset", "effect_ordinal"]) {
        expect(condition).toContain(`${coordinate} in`);
      }
      const granules = /Granules: (\d+)\/(\d+)/.exec(text);
      if (!granules) throw new Error(`Missing native primary-key granule evidence: ${text}`);
      expect(Number(granules[1]), text).toBeLessThan(Number(granules[2]));
      await context.clickhouse.command({ query: "SYSTEM FLUSH LOGS" });
      const statistics = await context.clickhouse.query<{ read_rows: string }>({
        query:
          "SELECT toString(read_rows) AS read_rows FROM system.query_log WHERE query_id={id:String} AND type='QueryFinish' ORDER BY event_time_microseconds DESC LIMIT 1",
        query_params: { id: queryId },
        format: "JSONEachRow",
      });
      const [row] = await statistics.json();
      if (!row) throw new Error("Missing native query read_rows evidence");
      expect(Number(row.read_rows), text).toBeLessThan(input.total);
      for (const lookup of lookups) {
        const explanation = await context.clickhouse.query<{ explain: string }>({
          ...lookup,
          query_id: undefined,
          query: `EXPLAIN PLAN indexes=1 ${lookup.query}`,
        });
        const lookupPlan = (await explanation.json()).map((line) => line.explain).join("\n");
        expect(lookupPlan).toContain("PrimaryKey");
        if (
          !(shape === "one-delivery" && lookup.query.includes("FROM analytics.delivery_receipt"))
        ) {
          const selected = /Granules: (\d+)\/(\d+)/.exec(lookupPlan);
          if (!selected) throw new Error(`Missing bounded lookup granules: ${lookupPlan}`);
          expect(Number(selected[1]), lookupPlan).toBeLessThan(Number(selected[2]));
        }
        const profile = await context.clickhouse.query<{ read_rows: string }>({
          query:
            "SELECT toString(read_rows) AS read_rows FROM system.query_log WHERE query_id={id:String} AND type='QueryFinish'",
          query_params: { id: lookup.query_id },
          format: "JSONEachRow",
        });
        const statistics = await profile.json();
        expect(statistics).toHaveLength(1);
        expect(Number(statistics[0]?.read_rows), lookupPlan).toBeLessThan(input.total);
        logger.info(
          `[bounded-journal-lookup] ${JSON.stringify({ transport, shape, queryId: lookup.query_id, readRows: statistics[0]?.read_rows, plan: lookupPlan })}`,
        );
      }
    },
  );
});
