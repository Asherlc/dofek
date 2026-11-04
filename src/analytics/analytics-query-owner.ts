import { randomUUID } from "node:crypto";
import { ClickHouseError } from "@clickhouse/client";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";

export interface AnalyticsQueryOwner {
  client: ClickHouseClient;
  ingestedAt: string;
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
  database: Database,
  clickhouse: ClickHouseClient,
  input: { resourceId: string; intentId: string },
  operation: (owner: AnalyticsQueryOwner) => Promise<T>,
): Promise<T> {
  z.object({ resourceId: z.string().min(1), intentId: z.string().min(1) }).parse(input);
  return withOwnedQueries(database, clickhouse, { ...input, mode: "write" }, operation);
}

/** Receipt checks cannot mutate data, clear a pending intent, or prove recovery. */
export async function withAnalyticsReceiptQueryOwner<T>(
  database: Database,
  clickhouse: ClickHouseClient,
  input: { resourceId: string },
  operation: (owner: AnalyticsReceiptQueryOwner) => Promise<T>,
): Promise<T> {
  z.object({ resourceId: z.string().min(1) }).parse(input);
  return withOwnedQueries(database, clickhouse, { ...input, mode: "receipt" }, (owner) =>
    operation({ client: { query: owner.client.query }, assertActive: owner.assertActive }),
  );
}

async function withOwnedQueries<T>(
  database: Database,
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
  let admittedIntentId: string | null = null;
  let inFlight: Promise<unknown> | null = null;
  let outcome: { value: T } | { error: unknown } | undefined;
  let releaseFailed = false;
  const onError = (error: Error) => {
    connectionError = error;
    captureException(error, { tags: { source: "analytics-query-owner-session" } });
  };
  session.on("error", onError);

  function assertSessionActive() {
    if (closed || connectionError)
      throw new Error("Analytics query owner lost its session; verified recovery is required");
  }

  async function assertActive() {
    assertSessionActive();
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
    assertSessionActive();
    const result = await session.query(
      `UPDATE fitness.analytics_query_owner SET query_terminal=true
       WHERE resource_id=$1 AND owner_id=$2 AND query_id=$3
         AND intent_id IS NOT DISTINCT FROM $4 AND NOT quiescent AND NOT query_terminal
       RETURNING owner_id,intent_id,query_id`,
      [input.resourceId, ownerId, queryId, admittedIntentId],
    );
    assertRequestRow(result, queryId, "completion");
    assertSessionActive();
    queryTerminal = true;
  }

  async function execute<R>(dispatch: (queryId: string) => Promise<R>): Promise<R> {
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
           AND intent_id IS NOT DISTINCT FROM $4 AND query_terminal
         RETURNING owner_id,intent_id,query_id`,
        [input.resourceId, ownerId, queryId, admittedIntentId],
      );
      assertRequestRow(registration, queryId, "registration");
      assertSessionActive();
      let value: R;
      try {
        value = await dispatch(queryId);
      } catch (error) {
        // The official client consumes the server's error response before
        // constructing ClickHouseError. A socket/client error has no such proof.
        if (error instanceof ClickHouseError) {
          await markRequestTerminal(queryId);
        }
        throw error;
      }
      // A successful, fully consumed response is terminal for this request. A
      // rejected HTTP promise is deliberately not interpreted as server death.
      await markRequestTerminal(queryId);
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
    const value = await operation({ client, ingestedAt, assertActive });
    if (inFlight) throw new Error("Analytics owner callback returned before its request completed");
    assertKnownRequestOutcome();
    await assertActive();
    if (input.mode === "write")
      await session.query(
        "UPDATE fitness.analytics_query_owner SET intent_id=NULL WHERE resource_id=$1 AND owner_id=$2",
        [input.resourceId, ownerId],
      );
    outcome = { value };
  } catch (error) {
    outcome = { error };
    captureException(error, { tags: { source: "analytics-query-owner" } });
  } finally {
    closed = true;
    try {
      if (inFlight) await inFlight;
      if (admitted && queryTerminal && !connectionError) {
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
