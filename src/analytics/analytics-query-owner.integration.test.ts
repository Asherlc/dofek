import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Database } from "../db/index.ts";
import {
  type AnalyticsReceiptQueryOwner,
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import { createAnalyticsTestContext } from "./test-helpers.ts";

describe("analytics query ownership", () => {
  let context: Awaited<ReturnType<typeof createAnalyticsTestContext>>;
  beforeAll(async () => {
    context = await createAnalyticsTestContext();
  });
  afterAll(async () => {
    await context?.cleanup();
  });

  function databaseAtSessionBoundary(
    exchange: (
      text: string,
      dispatch: () => Promise<unknown>,
      session: PoolClient,
    ) => Promise<unknown>,
  ): Database {
    const pool = new Proxy(context.database.$client, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const session = await target.connect();
            return new Proxy(session, {
              get(client, property) {
                if (property === "query")
                  return (...args: unknown[]) => {
                    if (typeof args[0] !== "string")
                      throw new Error("Owner query fixture requires a statement string");
                    return exchange(
                      args[0],
                      async () => Reflect.apply(client.query, client, args),
                      client,
                    );
                  };
                const value = Reflect.get(client, property, client);
                return typeof value === "function" ? value.bind(client) : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(context.database, {
      get(target, key) {
        if (key === "$client") return pool;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  test("oneOwnedRequestUsesTwoActualPostgresExchanges", async () => {
    let counting = false;
    const exchanges: string[] = [];
    const database = databaseAtSessionBoundary(async (text, dispatch) => {
      if (counting) exchanges.push(text);
      return dispatch();
    });
    await withAnalyticsQueryOwner(
      database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        counting = true;
        try {
          await owner.client.command({ query: "SELECT 1" });
        } finally {
          counting = false;
        }
      },
    );
    expect(exchanges).toHaveLength(2);
  });

  test("lostCommittedRegistrationResponseBlocksContinuationAndCallbackSuccess", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    const boundaryError = new Error("committed registration response lost");
    let firstQueryId: unknown;
    let fail = true;
    let dispatched = 0;
    const database = databaseAtSessionBoundary(async (text, dispatch) => {
      const result = await dispatch();
      if (fail && /\bSET\s+query_id\s*=/i.test(text)) {
        fail = false;
        const rows = await context.database.execute(
          sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        );
        firstQueryId = rows[0]?.query_id;
        throw boundaryError;
      }
      return result;
    });
    const clickhouse = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        dispatched++;
        return context.clickhouse.command(options);
      },
    };
    let caught: unknown;
    let continuation: unknown;
    await expect(
      withAnalyticsQueryOwner(database, clickhouse, { resourceId, intentId }, async (owner) => {
        try {
          await owner.client.command({ query: "SELECT 1" });
        } catch (error) {
          caught = error;
        }
        try {
          await owner.client.command({ query: "SELECT 2" });
        } catch (error) {
          continuation = error;
        }
        return "swallowed registration failure";
      }),
    ).rejects.toThrow("unknown request outcome");
    expect(caught).toBe(boundaryError);
    expect(continuation).toEqual(
      expect.objectContaining({ message: expect.stringContaining("unknown request outcome") }),
    );
    expect(dispatched).toBe(0);
    expect(firstQueryId).toEqual(expect.any(String));
    const state = await context.database.execute(
      sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(state).toEqual([
      { intent_id: intentId, query_id: firstQueryId, query_terminal: false, quiescent: false },
    ]);
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test.each(["write", "receipt"])(
    "registrationRejectsChangedAdmittedIntentFor%sOwnerBeforeDispatch",
    async (mode) => {
      const resourceId = randomUUID(),
        intentId = randomUUID(),
        changedIntent = randomUUID();
      if (mode === "receipt")
        await expect(
          withAnalyticsQueryOwner(
            context.database,
            context.clickhouse,
            { resourceId, intentId },
            async () => {
              throw new Error("leave known pending intent");
            },
          ),
        ).rejects.toThrow("leave known pending intent");
      let dispatched = 0;
      const clickhouse = {
        ...context.clickhouse,
        query: <T extends object>(options: Parameters<typeof context.clickhouse.query>[0]) => {
          dispatched++;
          return context.clickhouse.query<T>(options);
        },
      };
      const operation = async (owner: AnalyticsReceiptQueryOwner) => {
        await context.database.execute(
          sql`UPDATE fitness.analytics_query_owner SET intent_id=${changedIntent} WHERE resource_id=${resourceId}`,
        );
        await owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
      };
      const result =
        mode === "write"
          ? withAnalyticsQueryOwner(
              context.database,
              clickhouse,
              { resourceId, intentId },
              operation,
            )
          : withAnalyticsReceiptQueryOwner(context.database, clickhouse, { resourceId }, operation);
      await expect(result).rejects.toThrow("registration");
      expect(dispatched).toBe(0);
      const state = await context.database.execute(
        sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      );
      expect(state).toEqual([
        { intent_id: changedIntent, query_id: null, query_terminal: true, quiescent: false },
      ]);
    },
  );

  test.each(["success", "server rejection"])(
    "terminalUpdateRequiresExactIntentAfter%s",
    async (response) => {
      const resourceId = randomUUID(),
        intentId = randomUUID(),
        changedIntent = randomUUID();
      let firstQueryId: unknown;
      const database = databaseAtSessionBoundary(async (text, dispatch) => {
        if (/\bSET\s+query_terminal\s*=\s*true\b/i.test(text)) {
          const rows = await context.database.execute(
            sql`SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
          );
          firstQueryId = rows[0]?.query_id;
          await context.database.execute(
            sql`UPDATE fitness.analytics_query_owner SET intent_id=${changedIntent} WHERE resource_id=${resourceId}`,
          );
        }
        return dispatch();
      });
      await expect(
        withAnalyticsQueryOwner(
          database,
          context.clickhouse,
          { resourceId, intentId },
          async (owner) => {
            await owner.client.command({
              query:
                response === "success" ? "SELECT 1" : "SELECT throwIf(1,'terminal proof boundary')",
            });
          },
        ),
      ).rejects.toThrow("completion");
      expect(firstQueryId).toEqual(expect.any(String));
      const state = await context.database.execute(
        sql`SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
      );
      expect(state).toEqual([
        {
          intent_id: changedIntent,
          query_id: firstQueryId,
          query_terminal: false,
          quiescent: false,
        },
      ]);
    },
  );

  test("registrationCannotReplaceAnUnterminatedPredecessorQuery", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID(),
      predecessor = randomUUID();
    let dispatched = 0;
    const clickhouse = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        dispatched++;
        return context.clickhouse.command(options);
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        clickhouse,
        { resourceId, intentId },
        async (owner) => {
          await context.database.execute(
            sql`UPDATE fitness.analytics_query_owner SET query_id=${predecessor},query_terminal=false WHERE resource_id=${resourceId}`,
          );
          await owner.client.command({ query: "SELECT 1" });
        },
      ),
    ).rejects.toThrow("registration");
    expect(dispatched).toBe(0);
    const rows = await context.database.execute(
      sql`SELECT query_id,query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(rows).toEqual([
      { query_id: predecessor, query_terminal: false, quiescent: false, intent_id: intentId },
    ]);
  });

  test("lostSessionAfterCommittedRegistrationPreventsClickHouseDispatch", async () => {
    const resourceId = randomUUID(),
      intentId = randomUUID();
    let fail = true;
    let dispatched = 0;
    const database = databaseAtSessionBoundary(async (text, dispatch, session) => {
      const result = await dispatch();
      if (fail && /\bSET\s+query_id\s*=/i.test(text)) {
        fail = false;
        const lost = new Promise<void>((resolve) => session.once("error", () => resolve()));
        await context.database.execute(
          sql`SELECT pg_terminate_backend(backend_pid) FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
        );
        await lost;
      }
      return result;
    });
    const clickhouse = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        dispatched++;
        return context.clickhouse.command(options);
      },
    };
    await expect(
      withAnalyticsQueryOwner(database, clickhouse, { resourceId, intentId }, async (owner) => {
        await owner.client.command({ query: "SELECT 1" });
      }),
    ).rejects.toThrow("lost its session");
    expect(dispatched).toBe(0);
    const rows = await context.database.execute(
      sql`SELECT query_terminal,quiescent,intent_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`,
    );
    expect(rows).toEqual([{ query_terminal: false, quiescent: false, intent_id: intentId }]);
  });

  test("serialAdmissionRejectsOverlappingRequestsWithoutPoisoningSuccessfulOwner", async () => {
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        const first = owner.client.command({ query: "SELECT 1" });
        await expect(owner.client.command({ query: "SELECT 2" })).rejects.toThrow(
          "serial requests",
        );
        await first;
      },
    );
  });

  test("cooperativeFailureKeepsPendingIntentAndFreezesIngestionTime", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    let originalTimestamp = "";
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          originalTimestamp = owner.ingestedAt;
          await owner.client.command({ query: "SELECT 1" });
          throw new Error("failure after known terminal raw insert");
        },
      ),
    ).rejects.toThrow("failure after known terminal raw insert");
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("pending intent");
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(originalTimestamp);
        await owner.assertActive();
      },
    );
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async (owner) => {
        expect(owner.ingestedAt > originalTimestamp).toBe(true);
      },
    );
  });

  test("liveAndHistoryOwnersHandOffCooperativelyWithoutFailing", async () => {
    const resourceId = randomUUID();
    let releaseFirst: () => void = () => {
      throw new Error("Owner not started");
    };
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => {
      throw new Error("Barrier not initialized");
    };
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const order: string[] = [];
    const first = withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async () => {
        order.push("live");
        firstEntered();
        await release;
      },
    );
    await entered;
    const second = withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId: randomUUID() },
      async (owner) => {
        order.push("history");
        await owner.client.command({ query: "SELECT 1" });
      },
    );
    // Attach immediately so the old try-lock implementation reports an assertion
    // failure rather than an unhandled rejected promise while observing the waiter.
    const secondOutcome = second.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(async () => {
        const waiting = await context.database.execute<{ waiting: boolean }>(sql`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND wait_event='advisory'
              AND query LIKE '%pg_advisory_lock%') AS waiting`);
        expect(waiting[0]?.waiting).toBe(true);
        expect(order).toEqual(["live"]);
      });
    } finally {
      releaseFirst();
      await first;
    }
    expect(await secondOutcome).toBeNull();
    expect(order).toEqual(["live", "history"]);
  });

  test("lostPostgresLockDoesNotPermitAnotherPublication", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          await context.database.execute(sql`
          SELECT pg_terminate_backend(backend_pid)
          FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
          await expect(owner.client.command({ query: "SELECT 1" })).rejects.toThrow();
        },
      ),
    ).rejects.toThrow();
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test("unknownClickHouseRequestOutcomeBlocksEvenSameIntent", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    // The transport loses its response after the real server completed this request.
    const disconnected = {
      ...context.clickhouse,
      command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
        await context.clickhouse.command(options);
        throw new Error("response transport disconnected");
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        disconnected,
        { resourceId, intentId },
        async (owner) => {
          await owner.client.command({ query: "SELECT 1" });
        },
      ),
    ).rejects.toThrow("response transport disconnected");
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });

  test.each(["second request", "callback return"])(
    "caughtUnknownOutcomeBlocks%sAndRetainsFirstQueryWhileLateInsertCompletes",
    async (continuation) => {
      const resourceId = randomUUID();
      const intentId = randomUUID();
      const table = `analytics.owner_unknown_${randomUUID().replaceAll("-", "")}`;
      await context.clickhouse.command({
        query: `CREATE TABLE ${table}(value UInt8) ENGINE=MergeTree ORDER BY tuple()`,
      });
      const transportError = new Error("unknown client response while insert still runs");
      const dispatched: string[] = [];
      let lateResult: Promise<{ error?: unknown }> | undefined;
      let firstQueryId = "";
      let caught: unknown;
      let secondCaught: unknown;
      const disconnected = {
        ...context.clickhouse,
        command: async (options: Parameters<typeof context.clickhouse.command>[0]) => {
          if (!options.query_id) throw new Error("Fixture requires owned query ID");
          dispatched.push(options.query_id);
          if (!options.query.startsWith(`INSERT INTO ${table}`))
            return context.clickhouse.command(options);
          firstQueryId = options.query_id;
          lateResult = context.clickhouse.command(options).then(
            () => ({}),
            (error: unknown) => ({ error }),
          );
          // Observe the actual server request before losing the client boundary.
          await vi.waitFor(async () => {
            const running = await context.clickhouse.query<{ count: string }>({
              query:
                "SELECT toString(count()) AS count FROM system.processes WHERE query_id={id:String}",
              query_params: { id: firstQueryId },
              format: "JSONEachRow",
            });
            expect(await running.json()).toEqual([{ count: "1" }]);
          });
          throw transportError;
        },
      };
      try {
        const outcome = await withAnalyticsQueryOwner(
          context.database,
          disconnected,
          { resourceId, intentId },
          async (owner) => {
            try {
              await owner.client.command({
                query: `INSERT INTO ${table} SELECT sleepEachRow(0.1) FROM numbers(30) SETTINGS max_block_size=1`,
              });
            } catch (error) {
              caught = error;
            }
            if (continuation === "second request") {
              try {
                await owner.client.command({ query: "SELECT 1" });
              } catch (error) {
                secondCaught = error;
              }
            }
            return "swallowed failure";
          },
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        expect(caught).toBe(transportError);
        if (continuation === "second request")
          expect(secondCaught).toEqual(
            expect.objectContaining({
              message: expect.stringContaining("unknown request outcome"),
            }),
          );
        expect(dispatched).toEqual([firstQueryId]);
        expect(outcome).toEqual({
          error: expect.objectContaining({
            message: expect.stringContaining("unknown request outcome"),
          }),
        });
        const state = await context.database.execute(sql`
          SELECT intent_id,query_id,query_terminal,quiescent FROM fitness.analytics_query_owner
          WHERE resource_id=${resourceId}`);
        expect(state).toEqual([
          { intent_id: intentId, query_id: firstQueryId, query_terminal: false, quiescent: false },
        ]);
        for (const replayIntent of [intentId, randomUUID()])
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId: replayIntent },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
      } finally {
        // The deliberately disconnected client does not own the server lifetime.
        // Always await the real request before the suite may drop its database.
        expect(lateResult).toBeDefined();
        expect(await lateResult).toEqual({});
      }
      const rows = await context.clickhouse.query<{ count: string }>({
        query: `SELECT toString(count()) AS count FROM ${table}`,
        format: "JSONEachRow",
      });
      expect(await rows.json()).toEqual([{ count: "30" }]);
      await expect(
        withAnalyticsQueryOwner(
          context.database,
          context.clickhouse,
          { resourceId, intentId },
          async () => undefined,
        ),
      ).rejects.toThrow("verified recovery");
    },
  );

  test("terminalServerRejectionAllowsOriginalIntentReplay", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    let originalTimestamp = "";
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          originalTimestamp = owner.ingestedAt;
          await owner.client.command({ query: "SELECT throwIf(1, 'terminal fixture rejection')" });
        },
      ),
    ).rejects.toThrow("terminal fixture rejection");
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(originalTimestamp);
        await owner.client.command({ query: "SELECT 1" });
      },
    );
  });

  test("caughtDefinitiveServerRejectionStillAllowsNextOwnedRequest", async () => {
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId: randomUUID(), intentId: randomUUID() },
      async (owner) => {
        await expect(
          owner.client.command({ query: "SELECT throwIf(1, 'caught terminal rejection')" }),
        ).rejects.toThrow("caught terminal rejection");
        const result = await owner.client.query<{ value: number }>({
          query: "SELECT 7 AS value",
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ value: 7 }]);
      },
    );
  });

  test("receiptVerificationRetainsPendingIntentAndCannotMutate", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    let originalTimestamp = "";
    await context.clickhouse.command({
      query: "CREATE TABLE analytics.owner_readonly(value UInt8) ENGINE=MergeTree ORDER BY tuple()",
    });
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          originalTimestamp = owner.ingestedAt;
          await owner.client.command({ query: "SELECT 1" });
          throw new Error("known boundary failure");
        },
      ),
    ).rejects.toThrow("known boundary failure");
    await withAnalyticsReceiptQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId },
      async (owner) => {
        const result = await owner.client.query<{ value: number }>({
          query: "SELECT 1 AS value",
          format: "JSONEachRow",
        });
        expect(await result.json()).toEqual([{ value: 1 }]);
      },
    );
    await expect(
      withAnalyticsReceiptQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId },
        async (owner) => {
          await owner.client.query({
            query: "INSERT INTO analytics.owner_readonly VALUES (1)",
            format: "JSONEachRow",
            clickhouse_settings: { readonly: 0 },
          });
        },
      ),
    ).rejects.toThrow(/readonly|read.only/i);
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId: randomUUID() },
        async () => undefined,
      ),
    ).rejects.toThrow("pending intent");
    await withAnalyticsQueryOwner(
      context.database,
      context.clickhouse,
      { resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(originalTimestamp);
      },
    );
    const rows = await context.clickhouse.query<{ count: string }>({
      query: "SELECT toString(count()) AS count FROM analytics.owner_readonly",
      format: "JSONEachRow",
    });
    expect(await rows.json()).toEqual([{ count: "0" }]);
  });

  test("lateClickHouseInsertAfterLostPostgresSessionKeepsReplacementBlocked", async () => {
    const resourceId = randomUUID();
    const intentId = randomUUID();
    await context.clickhouse.command({
      query:
        "CREATE TABLE analytics.owner_late_insert(value UInt8) ENGINE=MergeTree ORDER BY tuple()",
    });
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async (owner) => {
          const finished = expect(
            owner.client.command({
              query:
                "INSERT INTO analytics.owner_late_insert SELECT sleepEachRow(0.1) FROM numbers(30) SETTINGS max_block_size=1",
            }),
          ).rejects.toThrow();
          await vi.waitFor(async () => {
            const rows = await context.database.execute<{ query_id: string | null }>(sql`
            SELECT query_id FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
            const queryId = rows[0]?.query_id;
            expect(queryId).toBeTruthy();
            const running = await context.clickhouse.query<{ count: string }>({
              query:
                "SELECT toString(count()) AS count FROM system.processes WHERE query_id={id:String}",
              query_params: { id: queryId },
              format: "JSONEachRow",
            });
            expect(await running.json()).toEqual([{ count: "1" }]);
          });
          await context.database.execute(sql`
          SELECT pg_terminate_backend(backend_pid)
          FROM fitness.analytics_query_owner WHERE resource_id=${resourceId}`);
          await expect(
            withAnalyticsQueryOwner(
              context.database,
              context.clickhouse,
              { resourceId, intentId: randomUUID() },
              async () => undefined,
            ),
          ).rejects.toThrow("verified recovery");
          await finished;
        },
      ),
    ).rejects.toThrow();
    const inserted = await context.clickhouse.query<{ count: string }>({
      query: "SELECT toString(count()) AS count FROM analytics.owner_late_insert",
      format: "JSONEachRow",
    });
    expect(await inserted.json()).toEqual([{ count: "30" }]);
    await expect(
      withAnalyticsQueryOwner(
        context.database,
        context.clickhouse,
        { resourceId, intentId },
        async () => undefined,
      ),
    ).rejects.toThrow("verified recovery");
  });
});
