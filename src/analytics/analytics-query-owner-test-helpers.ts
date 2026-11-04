import type { PoolClient } from "pg";
import type { Database } from "../db/index.ts";

export function databaseAtSessionBoundary(
  database: Database,
  exchange: (
    text: string,
    dispatch: () => Promise<unknown>,
    session: PoolClient,
    values: unknown[],
  ) => Promise<unknown>,
): Database {
  const pool = new Proxy(database.$client, {
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
                    Array.isArray(args[1]) ? args[1] : [],
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
  return new Proxy(database, {
    get(target, key) {
      if (key === "$client") return pool;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
