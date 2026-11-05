import { randomUUID } from "node:crypto";
import { ClickHouseError } from "@clickhouse/client";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  type PersistedAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";

export const ANALYTICS_PUBLICATION_RESOURCE = "metric-stream-source";

export interface AnalyticsQueryOwner {
  client: ClickHouseClient;
  ingestedAt: string;
  reserveIngestionThrough(through: string): Promise<void>;
  reuseIngestionReservation(group: PersistedAnalyticsDeliveryGroup): Promise<void>;
  assertActive(): Promise<void>;
}

export interface AnalyticsReceiptQueryOwner {
  client: Pick<ClickHouseClient, "query">;
  assertActive(): Promise<void>;
}

const ownerRowSchema = z.object({
  quiescent: z.boolean(),
  intent_id: z.string().nullable(),
  query_terminal: z.boolean(),
});

/**
 * Cooperative handoff only. An abandoned owner needs verified operator recovery;
 * neither an available PG lock nor an absent CH process proves it cannot publish.
 */
export async function withAnalyticsQueryOwner<T>(
  database: Pick<Database, "$client">,
  clickhouse: ClickHouseClient,
  input: { resourceId: string; intentId: string },
  operation: (owner: AnalyticsQueryOwner) => Promise<T>,
): Promise<T> {
  z.object({ resourceId: z.string().min(1), intentId: z.string().min(1) }).parse(input);
  return withOwnedQueries(database, clickhouse, { ...input, mode: "write" }, operation);
}

/** Verify completed receipts read-only; retire only their exact admitted intent.
 * Unrelated pending intents are preserved. Receipt proof never proves recovery.
 */
export async function withAnalyticsReceiptQueryOwner(
  database: Pick<Database, "$client">,
  clickhouse: ClickHouseClient,
  input: { resourceId: string },
  verify: (owner: AnalyticsReceiptQueryOwner) => Promise<{ completedIntentId: string }>,
): Promise<void> {
  z.object({ resourceId: z.string().min(1) }).parse(input);
  await withOwnedQueries(database, clickhouse, { ...input, mode: "receipt" }, (owner) =>
    verify({ client: { query: owner.client.query }, assertActive: owner.assertActive }),
  );
}

async function withOwnedQueries<T>(
  database: Pick<Database, "$client">,
  clickhouse: ClickHouseClient,
  input: { resourceId: string } & ({ mode: "write"; intentId: string } | { mode: "receipt" }),
  operation: (owner: AnalyticsQueryOwner) => Promise<T>,
): Promise<T> {
  const session = await database.$client.connect();
  const ownerId = randomUUID();
  let connectionError: Error | null = null;
  let locked = false;
  let admitted = false;
  let closed = false;
  let queryTerminal = true;
  // Terminal evidence belongs to this live executor only. Request promises may
  // resolve before it is persisted; a crash still requires external Q7 proof.
  let acknowledgedQueryId: string | null = null;
  let returnedWithRequest = false;
  let admittedIntentId: string | null = null;
  let completedIntentId: string | null = null;
  let inFlight: Promise<unknown> | null = null;
  let outcome: { value: T } | { error: unknown } | undefined;
  let releaseFailed = false;
  const onError = (error: Error) => {
    connectionError = error;
    captureException(error, { tags: { source: "analytics-query-owner-session" } });
  };
  session.on("error", onError);

  function assertSessionConnected() {
    if (connectionError)
      throw new Error("Analytics query owner lost its session; verified recovery is required");
  }

  function assertSessionActive() {
    if (closed) throw new Error("Analytics query owner is closed");
    assertSessionConnected();
  }

  async function assertActive() {
    assertSessionActive();
    await assertOwnerActive();
  }

  async function assertOwnerActive() {
    assertSessionConnected();
    const result = await session.query(
      `SELECT owner_id FROM fitness.analytics_query_owner
       WHERE resource_id=$1 AND owner_id=$2 AND NOT quiescent`,
      [input.resourceId, ownerId],
    );
    if (result.rowCount !== 1) throw new Error("Analytics query owner is no longer active");
  }

  function assertKnownRequestOutcome() {
    // A settled client promise can leave its server request running.
    if (!queryTerminal)
      throw new Error(
        "Analytics query owner has an unknown request outcome; verified recovery is required",
      );
  }

  function assertRequestRow(
    result: { rowCount: number | null; rows: unknown[] },
    queryId: string,
    boundary: "registration" | "completion",
  ) {
    const proof = z
      .tuple([
        z.object({
          owner_id: z.literal(ownerId),
          intent_id: z.literal(admittedIntentId),
          query_id: z.literal(queryId),
        }),
      ])
      .safeParse(result.rows);
    if (result.rowCount !== 1 || !proof.success)
      throw new Error(
        `Analytics query ${boundary} did not confirm the exact admitted owner and intent; verified recovery is required`,
      );
  }

  async function markRequestTerminal(queryId: string) {
    assertSessionConnected();
    // Lost completion proof must block release even when PG committed it.
    queryTerminal = false;
    const result = await session.query(
      `UPDATE fitness.analytics_query_owner SET query_terminal=true
       WHERE resource_id=$1 AND owner_id=$2 AND query_id=$3
         AND intent_id IS NOT DISTINCT FROM $4 AND NOT quiescent AND NOT query_terminal
       RETURNING owner_id,intent_id,query_id`,
      [input.resourceId, ownerId, queryId, admittedIntentId],
    );
    assertRequestRow(result, queryId, "completion");
    assertSessionConnected();
    queryTerminal = true;
  }

  async function retireCompletedIntent() {
    // A committed update with a lost proof is uncertain even if intent is NULL.
    queryTerminal = false;
    const result = await session.query(
      `UPDATE fitness.analytics_query_owner SET intent_id=NULL
       WHERE resource_id=$1 AND owner_id=$2 AND intent_id=$3
         AND NOT quiescent AND query_terminal
         AND query_id IS NOT DISTINCT FROM $4
       RETURNING owner_id,intent_id,query_id`,
      [input.resourceId, ownerId, admittedIntentId, acknowledgedQueryId],
    );
    const proof = z
      .tuple([
        z.object({
          owner_id: z.literal(ownerId),
          intent_id: z.null(),
          query_id: z.literal(acknowledgedQueryId),
        }),
      ])
      .safeParse(result.rows);
    if (result.rowCount !== 1 || !proof.success)
      throw new Error(
        "Analytics completed-intent retirement did not confirm the exact admitted owner and intent; verified recovery is required",
      );
    assertSessionConnected();
    queryTerminal = true;
  }

  async function execute<R>(
    dispatch: (queryId: string) => Promise<R>,
    consumeResponse?: (result: R) => Promise<void>,
  ): Promise<R> {
    if (inFlight) throw new Error("Analytics query owner requires serial requests");
    assertSessionActive();
    assertKnownRequestOutcome();

    const pending = (async () => {
      const queryId = randomUUID();
      // A committed registration with a lost PG response is uncertain too.
      queryTerminal = false;
      const registration = await session.query(
        `UPDATE fitness.analytics_query_owner SET query_id=$3,query_terminal=false
         WHERE resource_id=$1 AND owner_id=$2 AND NOT quiescent
           AND intent_id IS NOT DISTINCT FROM $4
           AND ${acknowledgedQueryId === null ? "query_id IS NULL AND query_terminal" : "query_id=$5 AND NOT query_terminal"}
         RETURNING owner_id,intent_id,query_id`,
        acknowledgedQueryId === null
          ? [input.resourceId, ownerId, queryId, admittedIntentId]
          : [input.resourceId, ownerId, queryId, admittedIntentId, acknowledgedQueryId],
      );
      assertRequestRow(registration, queryId, "registration");
      assertSessionActive();
      acknowledgedQueryId = queryId;
      let value: R;
      try {
        value = await dispatch(queryId);
      } catch (error) {
        // The official client consumes the server's error response before
        // constructing ClickHouseError. A socket/client error has no such proof.
        if (error instanceof ClickHouseError) {
          assertSessionConnected();
          queryTerminal = true;
        }
        throw error;
      }
      if (consumeResponse) await consumeResponse(value);
      // A successful, fully consumed response is terminal for this request. A
      // rejected HTTP promise is deliberately not interpreted as server death.
      assertSessionConnected();
      queryTerminal = true;
      return value;
    })();
    inFlight = pending;
    try {
      return await pending;
    } finally {
      inFlight = null;
    }
  }

  try {
    await session.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      `dofek.analytics.query-owner:${input.resourceId}`,
    ]);
    locked = true;
    await session.query(
      "INSERT INTO fitness.analytics_query_owner(resource_id) VALUES($1) ON CONFLICT DO NOTHING",
      [input.resourceId],
    );
    const previous = await session.query(
      "SELECT quiescent,intent_id,query_terminal FROM fitness.analytics_query_owner WHERE resource_id=$1",
      [input.resourceId],
    );
    const state = ownerRowSchema.parse(previous.rows[0]);
    if (!state.quiescent || !state.query_terminal)
      throw new Error(
        `Analytics resource ${input.resourceId} is BLOCKED: verified recovery must establish that the previous executor and ClickHouse requests terminated`,
      );
    if (input.mode === "write" && state.intent_id !== null && state.intent_id !== input.intentId)
      throw new Error(
        `Analytics resource ${input.resourceId} has pending intent ${state.intent_id}; replay that intent before admitting another delivery`,
      );
    const admittedRow = await session.query(
      input.mode === "write"
        ? `UPDATE fitness.analytics_query_owner SET owner_id=$2,backend_pid=pg_backend_pid(),
         quiescent=false,intent_id=$3,query_id=NULL,
         ingested_at=CASE WHEN intent_id IS NULL
           THEN greatest(clock_timestamp(),ingested_at + interval '1 microsecond')
           ELSE ingested_at END
       WHERE resource_id=$1
       RETURNING to_char(ingested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ingested_at,intent_id`
        : `UPDATE fitness.analytics_query_owner SET owner_id=$2,backend_pid=pg_backend_pid(),
         quiescent=false,query_id=NULL WHERE resource_id=$1
         RETURNING to_char(ingested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ingested_at,intent_id`,
      input.mode === "write"
        ? [input.resourceId, ownerId, input.intentId]
        : [input.resourceId, ownerId],
    );
    admitted = true;
    const { ingested_at: ingestedAt, intent_id: intentId } = z
      .object({ ingested_at: z.string(), intent_id: z.string().nullable() })
      .parse(admittedRow.rows[0]);
    admittedIntentId = intentId;
    const insert = clickhouse.insert?.bind(clickhouse);
    if (input.mode === "write" && !insert)
      throw new Error("Analytics query ownership requires an insert-capable client");
    const client: ClickHouseClient = {
      exec: (options) =>
        execute(
          (queryId) =>
            clickhouse.exec({
              ...options,
              query_id: queryId,
              clickhouse_settings: {
                ...options.clickhouse_settings,
                async_insert: 0,
                wait_end_of_query: 1,
              },
            }),
          async (result) => {
            for await (const _chunk of result.stream) {
              // EOF, not HTTP headers or close, is the owned request boundary.
            }
          },
        ),
      command: (options) =>
        execute((queryId) =>
          clickhouse.command({
            ...options,
            query_id: queryId,
            clickhouse_settings: { ...options.clickhouse_settings, async_insert: 0 },
          }),
        ),
      insert: insert
        ? (options) =>
            execute((queryId) =>
              insert({
                ...options,
                query_id: queryId,
                clickhouse_settings: { ...options.clickhouse_settings, async_insert: 0 },
              }),
            )
        : undefined,
      query: <R extends object>(options: Parameters<ClickHouseClient["query"]>[0]) =>
        execute(async (queryId) => {
          const result = await clickhouse.query<R>({
            ...options,
            query_id: queryId,
            clickhouse_settings: {
              ...options.clickhouse_settings,
              ...(input.mode === "receipt" ? { readonly: 1 } : {}),
            },
          });
          const rows = await result.json();
          return { json: async () => rows };
        }),
    };
    const value = await operation({
      client,
      ingestedAt,
      assertActive,
      reserveIngestionThrough: async (through) => {
        assertSessionActive();
        z.iso.datetime({ precision: 6 }).parse(through);
        const maximum = analyticsDeliveryGroupIngestionTimes(ingestedAt, 500).at(-1);
        if (!maximum || through < ingestedAt || through > maximum)
          throw new Error("Ingestion timestamp is outside this owners bounded reservation");
        const rows = await session.query(
          `UPDATE fitness.analytics_query_owner SET ingested_at=$3::timestamptz
           WHERE resource_id=$1 AND owner_id=$2 AND quiescent=false AND intent_id IS NOT NULL
             AND ingested_at<=$3::timestamptz RETURNING owner_id`,
          [input.resourceId, ownerId, through],
        );
        assertSessionConnected();
        const parsed = z.array(z.object({ owner_id: z.literal(ownerId) })).parse(rows.rows);
        if (parsed.length !== 1)
          throw new Error("Analytics ingestion reservation lost its owner or high-watermark");
      },
      reuseIngestionReservation: async (group) => {
        assertSessionActive();
        if (
          group.intentId !== admittedIntentId ||
          group.intentId !== analyticsDeliveryGroupIntentId(group)
        )
          throw new Error("Durable ingestion reservation does not belong to this intent");
        const through = analyticsDeliveryGroupIngestionTimes(
          group.ingestedAt,
          group.memberCount,
        ).at(-1);
        if (!through) throw new Error("Durable ingestion reservation has no time slots");
        const result = await session.query(
          `SELECT publication.owner_id FROM fitness.analytics_query_owner AS publication
           JOIN fitness.analytics_stream_state AS stream
             ON stream.transport=$3 AND stream.epoch=$4 AND stream.topic=$5 AND stream.partition=$6
           WHERE publication.resource_id=$1 AND publication.owner_id=$2
             AND NOT publication.quiescent AND publication.intent_id=$7
             AND publication.ingested_at >= $8::timestamptz
             AND stream.group_state IN ('pending','completed')
             AND stream.group_first_position=$9::jsonb AND stream.group_last_position=$10::jsonb
             AND stream.group_member_count=$11 AND stream.group_positions_digest=$12
             AND stream.group_first_ingested_at=$13::timestamptz`,
          [
            input.resourceId,
            ownerId,
            group.stream.transport,
            group.stream.epoch,
            group.stream.topic,
            group.stream.partition,
            group.intentId,
            through,
            JSON.stringify(group.first),
            JSON.stringify(group.last),
            group.memberCount,
            group.positionsDigest,
            group.ingestedAt,
          ],
        );
        assertSessionConnected();
        const proof = z.tuple([z.object({ owner_id: z.literal(ownerId) })]).safeParse(result.rows);
        if (result.rowCount !== 1 || !proof.success)
          throw new Error(
            "Durable ingestion reservation is missing, changed or exceeds its high-watermark",
          );
      },
    });
    closed = true;
    returnedWithRequest = inFlight !== null;
    if (returnedWithRequest)
      throw new Error("Analytics owner callback returned before its request completed");
    assertKnownRequestOutcome();
    if (input.mode === "receipt")
      completedIntentId = z
        .object({ completedIntentId: z.string().min(1) })
        .parse(value).completedIntentId;
    outcome = { value };
  } catch (error) {
    returnedWithRequest ||= inFlight !== null;
    outcome = { error };
    captureException(error, { tags: { source: "analytics-query-owner" } });
  } finally {
    closed = true;
    try {
      if (inFlight) await inFlight;
      if (outcome && "value" in outcome) assertSessionConnected();
      if (admitted && queryTerminal && !connectionError && !returnedWithRequest) {
        if (acknowledgedQueryId !== null) await markRequestTerminal(acknowledgedQueryId);
        await assertOwnerActive();
        if (
          input.mode === "receipt" &&
          outcome &&
          "value" in outcome &&
          admittedIntentId !== null &&
          admittedIntentId === completedIntentId
        )
          await retireCompletedIntent();
        if (input.mode === "write" && outcome && "value" in outcome)
          await session.query(
            "UPDATE fitness.analytics_query_owner SET intent_id=NULL WHERE resource_id=$1 AND owner_id=$2",
            [input.resourceId, ownerId],
          );
        else if (
          input.mode === "write" &&
          outcome &&
          "error" in outcome &&
          /^source-group:[a-f0-9]{64}$/.test(input.intentId)
        ) {
          // The descriptor retains the dirty work and its exact time slots.
          // Release only a terminal request whose entire reservation is durable;
          // otherwise a full journal could prevent the erasure writer from running.
          await session.query(
            `UPDATE fitness.analytics_query_owner AS publication SET intent_id=NULL
             WHERE resource_id=$1 AND owner_id=$2 AND intent_id=$3 AND query_terminal
               AND (SELECT count(*) FROM fitness.analytics_stream_state AS stream
                    WHERE stream.group_positions_digest=$4
                      AND stream.group_state IN ('pending','completed')
                      AND publication.ingested_at >= stream.group_first_ingested_at
                        + (stream.group_member_count-1) * interval '1 microsecond')=1`,
            [
              input.resourceId,
              ownerId,
              input.intentId,
              input.intentId.slice("source-group:".length),
            ],
          );
        }
        await session.query(
          `UPDATE fitness.analytics_query_owner SET quiescent=true,backend_pid=NULL
           WHERE resource_id=$1 AND owner_id=$2`,
          [input.resourceId, ownerId],
        );
      }
      if (locked && !connectionError)
        await session.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          `dofek.analytics.query-owner:${input.resourceId}`,
        ]);
    } catch (error) {
      releaseFailed = true;
      captureException(error, { tags: { source: "analytics-query-owner-release" } });
      if (!outcome || "value" in outcome) outcome = { error };
    } finally {
      session.removeListener("error", onError);
      session.release(connectionError !== null || releaseFailed);
    }
  }
  if (!outcome) throw new Error("Analytics query owner did not produce an outcome");
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
