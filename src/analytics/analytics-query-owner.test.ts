import { randomUUID } from "node:crypto";
import { ClickHouseError } from "@clickhouse/client";
import { Client, type PoolClient } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import { withAnalyticsQueryOwner } from "./analytics-query-owner.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const registrations: string[] = [],
    trace: string[] = [];
  let ownerId = "",
    intentId: string | null = null;
  const session: PoolClient = Object.assign(new Client(), { release: vi.fn() });
  const fake = new Proxy(session, {
    get(target, key) {
      if (key === "query")
        return async (statement: string, values: unknown[] = []) => {
          const result = (rows: object[]) => ({ rowCount: rows.length, rows });
          if (statement.startsWith("SELECT quiescent"))
            return result([{ quiescent: true, intent_id: null, query_terminal: true }]);
          if (statement.includes("backend_pid=pg_backend_pid()")) {
            ownerId = String(values[1]);
            intentId = String(values[2]);
            return result([{ ingested_at: "2026-11-04T00:00:00.000001Z", intent_id: intentId }]);
          }
          if (/SET query_id=/.test(statement)) {
            registrations.push(String(values[2]));
            trace.push("register");
            return result([{ owner_id: ownerId, intent_id: intentId, query_id: values[2] }]);
          }
          if (/SET query_terminal=true/.test(statement))
            return result([{ owner_id: ownerId, intent_id: intentId, query_id: values[2] }]);
          if (statement.startsWith("SELECT owner_id")) return result([{ owner_id: ownerId }]);
          return result([]);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.spyOn(database.$client, "connect").mockImplementation(async () => fake);
  const input = { resourceId: randomUUID(), intentId: randomUUID() };
  const client: ClickHouseClient = {
    command: async () => {
      trace.push("native-command");
    },
    query: async () => ({ json: async () => [] }),
    insert: async () => undefined,
  };
  return { registrations, trace, input, client };
}

describe("analytics query owner serial terminal invariant", () => {
  it("does not register a successor until the predecessor response body is consumed", async () => {
    const context = fixture();
    let releaseBody = () => {},
      signalBody = () => {};
    const body = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const reachedBody = new Promise<void>((resolve) => {
      signalBody = resolve;
    });
    const client: ClickHouseClient = {
      ...context.client,
      query: async () => {
        context.trace.push("native-query");
        return {
          json: async () => {
            signalBody();
            await body;
            context.trace.push("body-consumed");
            return [];
          },
        };
      },
    };
    await withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
      const pending = owner.client.query({ query: "SELECT 1", format: "JSONEachRow" });
      await reachedBody;
      await expect(owner.client.command({ query: "SELECT 2" })).rejects.toThrow("serial requests");
      expect(context.registrations).toHaveLength(1);
      releaseBody();
      await pending;
      await owner.client.command({ query: "SELECT 2" });
    });
    expect(context.trace).toEqual([
      "register",
      "native-query",
      "body-consumed",
      "register",
      "native-command",
    ]);
  });
  it("allows a successor only after a fully consumed native error response", async () => {
    const context = fixture();
    let rejected = false;
    const client: ClickHouseClient = {
      ...context.client,
      command: async () => {
        if (!rejected) {
          rejected = true;
          context.trace.push("native-error");
          throw new ClickHouseError({
            message: "memory",
            code: "241",
            type: "MEMORY_LIMIT_EXCEEDED",
          });
        }
        context.trace.push("native-command");
      },
    };
    await withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
      await expect(owner.client.command({ query: "SELECT 1" })).rejects.toMatchObject({
        code: "241",
      });
      await owner.client.command({ query: "SELECT 2" });
    });
    expect(context.trace).toEqual(["register", "native-error", "register", "native-command"]);
  });
  it("retains the predecessor identity after an unknown transport error", async () => {
    const context = fixture();
    const client: ClickHouseClient = {
      ...context.client,
      command: async () => {
        throw new Error("socket lost");
      },
    };
    await expect(
      withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
        await expect(owner.client.command({ query: "INSERT fixture" })).rejects.toThrow(
          "socket lost",
        );
        await expect(owner.client.command({ query: "SELECT successor" })).rejects.toThrow(
          "verified recovery",
        );
      }),
    ).rejects.toThrow("verified recovery");
    expect(context.registrations).toHaveLength(1);
  });
});
