import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { ClickHouseError } from "@clickhouse/client";
import { Client, type PoolClient } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import {
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import { completedExecResult } from "./test-helpers.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());
afterEach(() => vi.restoreAllMocks());

function fixture(previous?: { intentId: string | null; quiescent?: boolean; terminal?: boolean }) {
  const registrations: string[] = [],
    trace: string[] = [];
  let ownerId = "",
    intentId: string | null = null;
  const retired: string[] = [];
  const session: PoolClient = Object.assign(new Client(), { release: vi.fn() });
  const fake = new Proxy(session, {
    get(target, key) {
      if (key === "query")
        return async (statement: string, values: unknown[] = []) => {
          const result = (rows: object[]) => ({ rowCount: rows.length, rows });
          if (statement.startsWith("SELECT quiescent"))
            return result([
              {
                quiescent: previous?.quiescent ?? true,
                intent_id: previous?.intentId ?? null,
                query_terminal: previous?.terminal ?? true,
              },
            ]);
          if (statement.includes("backend_pid=pg_backend_pid()")) {
            ownerId = String(values[1]);
            intentId = values.length > 2 ? String(values[2]) : (previous?.intentId ?? null);
            return result([{ ingested_at: "2026-11-04T00:00:00.000001Z", intent_id: intentId }]);
          }
          if (/SET query_id=/.test(statement)) {
            registrations.push(String(values[2]));
            trace.push("register");
            return result([{ owner_id: ownerId, intent_id: intentId, query_id: values[2] }]);
          }
          if (/SET query_terminal=true/.test(statement))
            return result([{ owner_id: ownerId, intent_id: intentId, query_id: values[2] }]);
          if (statement.includes("SET intent_id=NULL") && statement.includes("RETURNING")) {
            retired.push(String(values[2]));
            intentId = null;
            return result([{ owner_id: ownerId, intent_id: null, query_id: values[3] }]);
          }
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
    exec: async () => completedExecResult("0"),
    command: async () => {
      trace.push("native-command");
    },
    query: async () => ({ json: async () => [] }),
    insert: async () => undefined,
  };
  return { registrations, trace, input, client, retired };
}

describe("analytics query owner input contracts", () => {
  it.each([
    [{ resourceId: "", intentId: randomUUID() }, /resourceId/i],
    [{ resourceId: randomUUID(), intentId: "" }, /intentId/i],
    [{ resourceId: "", intentId: "" }, /resourceId|intentId/i],
  ] as const)("rejects blank write ownership input %#", async (input, pattern) => {
    const context = fixture();
    await expect(
      withAnalyticsQueryOwner(database, context.client, input, async () => undefined),
    ).rejects.toThrow(pattern);
  });

  it("rejects blank receipt ownership resource ids", async () => {
    const context = fixture();
    await expect(
      withAnalyticsReceiptQueryOwner(database, context.client, { resourceId: "" }, async () => ({
        completedIntentId: randomUUID(),
      })),
    ).rejects.toThrow(/resourceId/i);
  });
});

describe("analytics query owner serial terminal invariant", () => {
  it("keeps streamed exec in flight until EOF and registers no successor early", async () => {
    const context = fixture();
    const response = new PassThrough();
    let reachedExec!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedExec = resolve;
    });
    const client: ClickHouseClient = {
      ...context.client,
      exec: async (options) => {
        expect(options.query_id).toBe(context.registrations[0]);
        expect(options.clickhouse_settings).toMatchObject({
          wait_end_of_query: 1,
          async_insert: 0,
        });
        reachedExec();
        return completedExecResult("1", response);
      },
    };
    await withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
      const pending = owner.client.exec({
        query: "INSERT fixture FORMAT JSONEachRow",
        values: Readable.from(['{"value":1}\n']),
      });
      await reached;
      await expect(owner.client.command({ query: "SELECT successor" })).rejects.toThrow(
        /serial requests/i,
      );
      expect(context.registrations).toHaveLength(1);
      response.end();
      await pending;
      expect(response.readableEnded).toBe(true);
      await owner.client.command({ query: "SELECT successor" });
    });
    expect(context.registrations).toHaveLength(2);
  });

  it.each(["premature-close", "response-error", "native-response-error"])(
    "does not confirm a streamed request after %s",
    async (kind) => {
      const context = fixture();
      const response = new Readable({
        read() {
          if (kind === "native-response-error")
            this.destroy(
              new ClickHouseError({
                message: "response failed",
                code: "241",
                type: "MEMORY_LIMIT_EXCEEDED",
              }),
            );
          else if (kind === "response-error") this.destroy(new Error("response failed"));
          else this.destroy();
        },
      });
      const client: ClickHouseClient = {
        ...context.client,
        exec: async () => completedExecResult("1", response),
      };
      await expect(
        withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
          await expect(
            owner.client.exec({ query: "INSERT fixture", values: Readable.from([]) }),
          ).rejects.toThrow(kind === "premature-close" ? /premature close/i : /response failed/);
          await expect(owner.client.command({ query: "SELECT successor" })).rejects.toThrow(
            /verified recovery/i,
          );
        }),
      ).rejects.toThrow(/verified recovery/i);
      expect(context.registrations).toHaveLength(1);
    },
  );

  it("permits a successor after exec rejects with a consumed native error response", async () => {
    const context = fixture();
    const client: ClickHouseClient = {
      ...context.client,
      exec: async () => {
        throw new ClickHouseError({
          message: "memory",
          code: "241",
          type: "MEMORY_LIMIT_EXCEEDED",
        });
      },
    };
    await withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
      await expect(
        owner.client.exec({ query: "INSERT fixture", values: Readable.from([]) }),
      ).rejects.toMatchObject({ code: "241" });
      await owner.client.command({ query: "SELECT successor" });
    });
    expect(context.registrations).toHaveLength(2);
  });
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

describe("analytics receipt recovery ownership", () => {
  it.each(["completed-A", "pending-B", null])(
    "retires only the exact verified completed intent when admitted intent is %s",
    async (intentId) => {
      const context = fixture({ intentId });
      await withAnalyticsReceiptQueryOwner(
        database,
        {
          ...context.client,
          query: async (options) => {
            expect(options.clickhouse_settings?.readonly).toBe(1);
            return { json: async () => [] };
          },
        },
        { resourceId: context.input.resourceId },
        async (owner) => {
          await owner.client.query({ query: "SELECT receipt proof", format: "JSONEachRow" });
          await owner.assertActive();
          return { completedIntentId: "completed-A" };
        },
      );
      expect(context.retired).toEqual(intentId === "completed-A" ? ["completed-A"] : []);
    },
  );

  it.each([
    { quiescent: false, terminal: true },
    { quiescent: true, terminal: false },
  ])("blocks receipt proof for uncertain owner state %j", async (state) => {
    const context = fixture({ ...state, intentId: "completed-A" });
    const verify = vi.fn();
    await expect(
      withAnalyticsReceiptQueryOwner(
        database,
        context.client,
        { resourceId: context.input.resourceId },
        verify,
      ),
    ).rejects.toThrow(/verified recovery/i);
    expect(verify).not.toHaveBeenCalled();
    expect(context.retired).toEqual([]);
  });

  it("preserves the admitted intent when receipt verification fails", async () => {
    const context = fixture({ intentId: "completed-A" });
    await expect(
      withAnalyticsReceiptQueryOwner(
        database,
        context.client,
        { resourceId: context.input.resourceId },
        async () => {
          throw new Error("receipt incomplete");
        },
      ),
    ).rejects.toThrow("receipt incomplete");
    expect(context.retired).toEqual([]);
  });
});
