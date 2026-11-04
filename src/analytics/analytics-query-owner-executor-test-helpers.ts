import { z } from "zod";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { withAnalyticsQueryOwner } from "./analytics-query-owner.ts";

// A separate executor is deliberately killed by the integration test. IPC keeps
// connection configuration out of command arguments and test output.
process.once("message", async (message) => {
  try {
    const input = z
      .object({
        connectionString: z.string(),
        resourceId: z.string(),
        intentId: z.string(),
        boundary: z.enum(["consumed response", "successor registered"]),
      })
      .parse(message);
    const database = createDatabase(input.connectionString);
    const clickhouse = createClickHouseClientFromEnv();
    let registrations = 0;
    const stop = async (queryId: string) => {
      process.send?.({ queryId });
      await new Promise<never>(() => {});
    };
    const pool = new Proxy(database.$client, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const session = await target.connect();
            return new Proxy(session, {
              get(client, property) {
                if (property === "query")
                  return async (...args: unknown[]) => {
                    const result = await Reflect.apply(client.query, client, args);
                    if (
                      typeof args[0] === "string" &&
                      /SET query_id=/.test(args[0]) &&
                      ++registrations === 2 &&
                      input.boundary === "successor registered"
                    ) {
                      await stop(z.object({ query_id: z.string() }).parse(result.rows[0]).query_id);
                    }
                    return result;
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
    const ownedDatabase = new Proxy(database, {
      get(target, key) {
        if (key === "$client") return pool;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let firstId = "";
    await withAnalyticsQueryOwner(
      ownedDatabase,
      {
        ...clickhouse,
        command: async (options) => {
          firstId = z.string().parse(options.query_id);
          return clickhouse.command(options);
        },
      },
      input,
      async (owner) => {
        await owner.client.command({ query: "SELECT 1" });
        if (input.boundary === "consumed response") await stop(firstId);
        await owner.client.command({ query: "SELECT 2" });
      },
    );
    throw new Error("Executor fixture escaped its controlled boundary");
  } catch (error) {
    captureException(error, { tags: { source: "analytics-query-owner-executor-fixture" } });
    throw error;
  }
});
