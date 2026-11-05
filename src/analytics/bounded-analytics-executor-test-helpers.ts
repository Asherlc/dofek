import { createClient } from "@clickhouse/client";
import { type SQLWrapper, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import { createAccountErasureWorkLockPool } from "../jobs/account-erasure-work-guard.ts";
import { captureException } from "../lib/error-reporting.ts";
import { databaseAtSessionBoundary } from "./analytics-query-owner-test-helpers.ts";
import { runBoundedAnalyticsPage } from "./bounded-analytics.ts";
import { analyticsStreamSchema } from "./effect-journal.ts";

// This real executor is killed at a durable boundary. Connection values use IPC.
process.once("message", async (message) => {
  try {
    const input = z
      .object({
        connectionString: z.string(),
        databases: z.object({
          analytics: z.string(),
          ingest: z.string(),
          postgres_fitness: z.string(),
        }),
        runId: z.uuid(),
        stream: analyticsStreamSchema,
        artifactDirectory: z.string(),
        boundary: z.enum(["output", "effects", "before cursor", "after cursor"]),
      })
      .parse(message);
    const database = createDatabase(input.connectionString);
    const native = createClient({
      url: z.string().parse(process.env.CLICKHOUSE_URL),
      clickhouse_settings: {
        max_threads: 1,
        max_memory_usage: "134217728",
        log_queries: 1,
        output_format_json_quote_64bit_integers: 1,
      },
    });
    const scope = (query: string) => {
      let scoped = query;
      for (const [logical, physical] of Object.entries(input.databases))
        scoped = scoped
          .replaceAll(`${logical}.`, `${physical}.`)
          .replaceAll(`\`${logical}\`.`, `\`${physical}\`.`);
      return scoped;
    };
    let lastId = "",
      stopNextRegistration = false;
    const stop = async () => {
      process.send?.({ queryId: lastId });
      await new Promise<never>(() => {});
    };
    const clickhouse: ClickHouseClient = {
      command: async (options) => {
        const result = await native.command({ ...options, query: scope(options.query) });
        lastId = z.string().parse(options.query_id);
        if (input.boundary === "output" && options.query.startsWith("INSERT INTO"))
          stopNextRegistration = true;
        return result;
      },
      query: async <T extends object>(options: Parameters<ClickHouseClient["query"]>[0]) => {
        const result = await native.query({ ...options, query: scope(options.query) });
        const rows = await result.json<T>();
        lastId = z.string().parse(options.query_id);
        return { json: async () => rows };
      },
      insert: async (options) => {
        await native.insert({
          ...options,
          values: [...options.values],
          table: scope(options.table),
        });
        lastId = z.string().parse(options.query_id);
        if (input.boundary === "effects" && options.table === "analytics.effect_receipt")
          stopNextRegistration = true;
      },
    };
    const sessionDatabase = databaseAtSessionBoundary(database, async (statement, dispatch) => {
      if (
        (stopNextRegistration && /SET query_id=/.test(statement)) ||
        (input.boundary === "after cursor" && /SET query_terminal=true/.test(statement))
      )
        await stop();
      return dispatch();
    });
    const ownedDatabase = new Proxy(sessionDatabase, {
      get(target, key) {
        if (key === "transaction")
          return (operation: Parameters<typeof database.transaction>[0]) =>
            target.transaction((transaction) =>
              operation(
                new Proxy(transaction, {
                  get(tx, property) {
                    if (property === "execute")
                      return async (query: SQLWrapper | string) => {
                        const text = new PgDialect().sqlToQuery(
                          typeof query === "string" ? sql.raw(query) : query.getSQL(),
                        ).sql;
                        if (
                          input.boundary === "before cursor" &&
                          /UPDATE fitness.analytics_stage_cursor SET cursor=/.test(text)
                        )
                          await stop();
                        return tx.execute(query);
                      };
                    const value = Reflect.get(tx, property, tx);
                    return typeof value === "function" ? value.bind(tx) : value;
                  },
                }),
              ),
            );
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runBoundedAnalyticsPage(
      {
        database: ownedDatabase,
        clickhouse,
        guards: createAccountErasureWorkLockPool(input.connectionString),
      },
      {
        runId: input.runId,
        stage: "scalar",
        stream: input.stream,
        pageSize: 20,
        artifactDirectory: input.artifactDirectory,
      },
    );
    throw new Error("Executor escaped the controlled crash boundary");
  } catch (error) {
    captureException(error, { tags: { source: "bounded-executor-crash-fixture" } });
    throw error;
  }
});
