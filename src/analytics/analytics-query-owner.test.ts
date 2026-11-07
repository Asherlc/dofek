// cspell:ignore xsource
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { ClickHouseError } from "@clickhouse/client";
import { Client, type PoolClient } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  analyticsDeliveryGroupIngestionTimes,
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import {
  withAnalyticsQueryOwner,
  withAnalyticsReceiptQueryOwner,
} from "./analytics-query-owner.ts";
import { completedExecResult } from "./test-helpers.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));
const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());
afterEach(() => {
  vi.mocked(captureException).mockClear();
  vi.restoreAllMocks();
});

const ingestedAt = "2026-11-04T00:00:00.000001Z";
const kafkaFirst = {
  transport: "kafka" as const,
  epoch: "capture-one",
  topic: "sensor",
  partition: 0,
  offset: "9007199254740993",
};

function fixture(previous?: {
  intentId?: string | null;
  quiescent?: boolean;
  terminal?: boolean;
  loseOwnerAfterAdmit?: boolean;
  corruptRegistration?: boolean;
  corruptCompletion?: boolean;
  corruptRetirement?: boolean;
  failLock?: boolean;
  failReservation?: boolean;
  failReuse?: boolean;
}) {
  const registrations: string[] = [],
    terminals: string[] = [],
    trace: string[] = [],
    locks: string[] = [],
    unlocks: string[] = [],
    writeIntentClears: string[] = [],
    sourceGroupClears: string[] = [],
    quiesced: string[] = [],
    reservations: string[] = [],
    reuseProofs: number[] = [];
  let ownerId = "",
    intentId: string | null = null,
    ownerVisible = true;
  const retired: string[] = [];
  const release = vi.fn();
  const session: PoolClient = Object.assign(new Client(), { release });
  const fake = new Proxy(session, {
    get(target, key) {
      if (key === "query")
        return async (statement: string, values: unknown[] = []) => {
          const result = (rows: object[]) => ({ rowCount: rows.length, rows });
          if (statement.includes("pg_advisory_lock")) {
            if (previous?.failLock) throw new Error("advisory lock unavailable");
            locks.push(String(values[0]));
            return result([]);
          }
          if (statement.includes("pg_advisory_unlock")) {
            unlocks.push(String(values[0] ?? ""));
            return result([]);
          }
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
            if (previous?.loseOwnerAfterAdmit) ownerVisible = false;
            return result([{ ingested_at: ingestedAt, intent_id: intentId }]);
          }
          if (/SET query_id=/.test(statement)) {
            registrations.push(String(values[2]));
            trace.push("register");
            if (previous?.corruptRegistration)
              return result([{ owner_id: "other", intent_id: intentId, query_id: values[2] }]);
            return result([{ owner_id: ownerId, intent_id: intentId, query_id: values[2] }]);
          }
          if (/SET query_terminal=true/.test(statement)) {
            terminals.push(String(values[2]));
            if (previous?.corruptCompletion)
              return result([{ owner_id: "other", intent_id: intentId, query_id: values[2] }]);
            return result([{ owner_id: ownerId, intent_id: intentId, query_id: values[2] }]);
          }
          if (statement.includes("SET intent_id=NULL") && statement.includes("RETURNING")) {
            if (previous?.corruptRetirement)
              return result([{ owner_id: ownerId, intent_id: "still-set", query_id: values[3] }]);
            retired.push(String(values[2]));
            intentId = null;
            return result([{ owner_id: ownerId, intent_id: null, query_id: values[3] }]);
          }
          if (
            statement.includes("group_positions_digest") &&
            statement.includes("SET intent_id=NULL")
          ) {
            sourceGroupClears.push(String(values[2]));
            intentId = null;
            return result([]);
          }
          if (statement.includes("SET intent_id=NULL")) {
            writeIntentClears.push(String(values[0]));
            intentId = null;
            return result([]);
          }
          if (statement.includes("SET quiescent=true")) {
            quiesced.push(ownerId);
            return result([]);
          }
          if (statement.includes("SET ingested_at=")) {
            reservations.push(String(values[2]));
            if (previous?.failReservation) return result([]);
            return result([{ owner_id: ownerId }]);
          }
          if (statement.includes("analytics_stream_state")) {
            reuseProofs.push(1);
            if (previous?.failReuse) return result([]);
            return result([{ owner_id: ownerId }]);
          }
          if (statement.startsWith("SELECT owner_id"))
            return ownerVisible ? result([{ owner_id: ownerId }]) : result([]);
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
  return {
    registrations,
    terminals,
    trace,
    input,
    client,
    retired,
    locks,
    unlocks,
    writeIntentClears,
    sourceGroupClears,
    quiesced,
    reservations,
    reuseProofs,
    release,
    session: fake,
  };
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

describe("analytics query owner release and fencing", () => {
  it("admits write ownership then unlocks and releases a healthy session without destroy", async () => {
    const context = fixture();
    await withAnalyticsQueryOwner(database, context.client, context.input, async () => undefined);
    expect(context.locks).toEqual([`dofek.analytics.query-owner:${context.input.resourceId}`]);
    expect(context.unlocks).toEqual([`dofek.analytics.query-owner:${context.input.resourceId}`]);
    expect(context.writeIntentClears).toEqual([context.input.resourceId]);
    expect(context.quiesced).toHaveLength(1);
    expect(context.release).toHaveBeenCalledWith(false);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("refuses a write while a different intent is already pending", async () => {
    const context = fixture({ intentId: "pending-other" });
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async () => undefined),
    ).rejects.toThrow(/pending intent pending-other/i);
    expect(context.writeIntentClears).toEqual([]);
    expect(context.quiesced).toEqual([]);
    expect(context.unlocks).toEqual([`dofek.analytics.query-owner:${context.input.resourceId}`]);
    expect(context.release).toHaveBeenCalledWith(false);
  });

  it("requires an insert-capable ClickHouse client for write ownership", async () => {
    const context = fixture();
    const client = { ...context.client, insert: undefined };
    await expect(
      withAnalyticsQueryOwner(database, client, context.input, async () => undefined),
    ).rejects.toThrow(/insert-capable/i);
    expect(context.writeIntentClears).toEqual([]);
    expect(context.release).toHaveBeenCalledWith(false);
  });

  it("fails closed when registration proof does not match the admitted owner", async () => {
    const context = fixture({ corruptRegistration: true });
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async (owner) => {
        await owner.client.command({ query: "SELECT 1" });
      }),
    ).rejects.toThrow(/registration did not confirm/i);
    expect(context.registrations).toHaveLength(1);
    expect(context.writeIntentClears).toEqual([]);
    expect(context.quiesced).toEqual([]);
  });

  it("rejects further work after the Postgres session reports an error", async () => {
    const context = fixture();
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async (owner) => {
        context.session.emit("error", new Error("session dropped"));
        await expect(owner.assertActive()).rejects.toThrow(/lost its session/i);
        await expect(owner.client.command({ query: "SELECT 1" })).rejects.toThrow(
          /lost its session/i,
        );
      }),
    ).rejects.toThrow(/lost its session/i);
    expect(context.unlocks).toEqual([]);
    expect(context.release).toHaveBeenCalledWith(true);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: "analytics-query-owner-session" } }),
    );
  });

  it("fails when the owner row is no longer active for this session", async () => {
    const context = fixture({ loseOwnerAfterAdmit: true });
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async (owner) => {
        await expect(owner.assertActive()).rejects.toThrow(/no longer active/i);
      }),
    ).rejects.toThrow(/no longer active/i);
    // Release re-checks owner activity before unlock; a lost owner fences unlock and
    // destroys the session instead of pretending the handoff completed.
    expect(context.quiesced).toEqual([]);
    expect(context.unlocks).toEqual([]);
    expect(context.release).toHaveBeenCalledWith(true);
  });

  it("rejects returning while a ClickHouse request is still in flight", async () => {
    const context = fixture();
    let resolveCommand!: () => void;
    const held = new Promise<void>((resolve) => {
      resolveCommand = resolve;
    });
    const client: ClickHouseClient = {
      ...context.client,
      command: async () => held,
    };
    const pending = withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
      void owner.client.command({ query: "SELECT held" });
      return undefined;
    });
    await vi.waitFor(() => expect(context.registrations).toHaveLength(1));
    resolveCommand();
    await expect(pending).rejects.toThrow(/returned before its request completed/i);
    expect(context.writeIntentClears).toEqual([]);
  });

  it("clears a durable source-group intent after a terminal native write failure", async () => {
    const group = describeAnalyticsDeliveryGroup([kafkaFirst], 500);
    const intentId = analyticsDeliveryGroupIntentId(group);
    const context = fixture();
    const client: ClickHouseClient = {
      ...context.client,
      command: async () => {
        throw new ClickHouseError({
          message: "memory",
          code: "241",
          type: "MEMORY_LIMIT_EXCEEDED",
        });
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        database,
        client,
        { resourceId: context.input.resourceId, intentId },
        async (owner) => {
          await owner.client.command({ query: "INSERT fixture" });
        },
      ),
    ).rejects.toMatchObject({ code: "241" });
    expect(context.sourceGroupClears).toEqual([intentId]);
    expect(context.quiesced).toHaveLength(1);
    expect(context.unlocks).toEqual([`dofek.analytics.query-owner:${context.input.resourceId}`]);
    expect(context.release).toHaveBeenCalledWith(false);
  });

  it("reports owner orchestration failures with the owner capture tag", async () => {
    const context = fixture({ intentId: "pending-other" });
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async () => undefined),
    ).rejects.toThrow(/pending intent/i);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: "analytics-query-owner" } }),
    );
  });
});

describe("analytics query owner high-water reservation", () => {
  it("advances and reuses a durable ingestion reservation for the admitted intent", async () => {
    const group = describeAnalyticsDeliveryGroup(
      [kafkaFirst, { ...kafkaFirst, offset: "9007199254740994" }],
      500,
    );
    const intentId = analyticsDeliveryGroupIntentId(group);
    const context = fixture();
    const groupThrough = analyticsDeliveryGroupIngestionTimes(ingestedAt, group.memberCount).at(-1);
    const maximum = analyticsDeliveryGroupIngestionTimes(ingestedAt, 500).at(-1);
    if (groupThrough === undefined || maximum === undefined)
      throw new Error("expected ingestion high-water reservation");
    const pastHighWater = analyticsDeliveryGroupIngestionTimes(maximum, 2).at(-1);
    if (pastHighWater === undefined) throw new Error("expected past-high-water timestamp");
    await withAnalyticsQueryOwner(
      database,
      context.client,
      { resourceId: context.input.resourceId, intentId },
      async (owner) => {
        expect(owner.ingestedAt).toBe(ingestedAt);
        await expect(owner.reserveIngestionThrough("2020-01-01T00:00:00.000000Z")).rejects.toThrow(
          /outside this owners bounded reservation/i,
        );
        // Exact base and exact 500-slot high-water remain inside the closed interval.
        await owner.reserveIngestionThrough(ingestedAt);
        await owner.reserveIngestionThrough(groupThrough);
        await owner.reserveIngestionThrough(maximum);
        await expect(owner.reserveIngestionThrough(pastHighWater)).rejects.toThrow(
          /outside this owners bounded reservation/i,
        );
        await owner.reuseIngestionReservation({
          ...group,
          ingestedAt,
          intentId,
        });
        await expect(
          owner.reuseIngestionReservation({
            ...group,
            ingestedAt,
            intentId:
              "source-group:0000000000000000000000000000000000000000000000000000000000000000",
          }),
        ).rejects.toThrow(/does not belong to this intent/i);
      },
    );
    expect(context.reservations).toEqual([ingestedAt, groupThrough, maximum]);
    expect(context.reuseProofs).toEqual([1]);
    expect(context.writeIntentClears).toEqual([context.input.resourceId]);
    expect(context.release).toHaveBeenCalledWith(false);
  });

  it("fails closed when reservation or reuse proof loses the admitted owner", async () => {
    const group = describeAnalyticsDeliveryGroup([kafkaFirst], 500);
    const intentId = analyticsDeliveryGroupIntentId(group);
    const lostReservation = fixture({ failReservation: true });
    await expect(
      withAnalyticsQueryOwner(
        database,
        lostReservation.client,
        { resourceId: lostReservation.input.resourceId, intentId },
        async (owner) => {
          await owner.reserveIngestionThrough(ingestedAt);
        },
      ),
    ).rejects.toThrow(/lost its owner or high-watermark/i);

    const lostReuse = fixture({ failReuse: true });
    await expect(
      withAnalyticsQueryOwner(
        database,
        lostReuse.client,
        { resourceId: lostReuse.input.resourceId, intentId },
        async (owner) => {
          await owner.reuseIngestionReservation({ ...group, ingestedAt, intentId });
        },
      ),
    ).rejects.toThrow(/missing, changed or exceeds its high-watermark/i);
  });

  it("rejects reuse when the admitted intent id does not match the group digest identity", async () => {
    const group = describeAnalyticsDeliveryGroup([kafkaFirst], 500);
    const intentId = analyticsDeliveryGroupIntentId(group);
    const context = fixture();
    await withAnalyticsQueryOwner(
      database,
      context.client,
      { resourceId: context.input.resourceId, intentId },
      async (owner) => {
        await expect(
          owner.reuseIngestionReservation({
            ...group,
            positionsDigest: "0".repeat(64),
            ingestedAt,
            intentId,
          }),
        ).rejects.toThrow(/does not belong to this intent/i);
      },
    );
    expect(context.reuseProofs).toEqual([]);
  });
});

describe("analytics query owner serial registration and release boundaries", () => {
  it("does not unlock when advisory lock acquisition fails before ownership", async () => {
    const context = fixture({ failLock: true });
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async () => undefined),
    ).rejects.toThrow(/advisory lock unavailable/i);
    expect(context.locks).toEqual([]);
    expect(context.unlocks).toEqual([]);
    expect(context.quiesced).toEqual([]);
    expect(context.release).toHaveBeenCalledWith(false);
  });

  it("replays the same pending intent without treating it as a foreign fence", async () => {
    const intentId = randomUUID();
    const context = fixture({ intentId });
    await withAnalyticsQueryOwner(
      database,
      context.client,
      { resourceId: context.input.resourceId, intentId },
      async () => undefined,
    );
    expect(context.writeIntentClears).toEqual([context.input.resourceId]);
    expect(context.quiesced).toHaveLength(1);
    expect(context.release).toHaveBeenCalledWith(false);
  });

  it("marks only the final registered request terminal after serial successors", async () => {
    const context = fixture();
    await withAnalyticsQueryOwner(database, context.client, context.input, async (owner) => {
      await owner.client.command({ query: "SELECT 1" });
      await owner.client.command({ query: "SELECT 2" });
    });
    expect(context.registrations).toHaveLength(2);
    expect(context.terminals).toEqual([context.registrations[1]]);
    expect(context.writeIntentClears).toEqual([context.input.resourceId]);
  });

  it("skips completion marking when the owner never registered a request", async () => {
    const context = fixture();
    await withAnalyticsQueryOwner(database, context.client, context.input, async () => undefined);
    expect(context.registrations).toEqual([]);
    expect(context.terminals).toEqual([]);
    expect(context.writeIntentClears).toEqual([context.input.resourceId]);
  });

  it("fails closed when completion proof does not match the admitted owner", async () => {
    const context = fixture({ corruptCompletion: true });
    await expect(
      withAnalyticsQueryOwner(database, context.client, context.input, async (owner) => {
        await owner.client.command({ query: "SELECT 1" });
      }),
    ).rejects.toThrow(/completion did not confirm/i);
    expect(context.terminals).toHaveLength(1);
    expect(context.writeIntentClears).toEqual([]);
    expect(context.quiesced).toEqual([]);
    expect(context.release).toHaveBeenCalledWith(true);
  });

  it("fails closed when completed-intent retirement proof is wrong", async () => {
    const context = fixture({ intentId: "completed-A", corruptRetirement: true });
    await expect(
      withAnalyticsReceiptQueryOwner(
        database,
        context.client,
        { resourceId: context.input.resourceId },
        async (owner) => {
          await owner.client.query({ query: "SELECT receipt proof", format: "JSONEachRow" });
          return { completedIntentId: "completed-A" };
        },
      ),
    ).rejects.toThrow(/retirement did not confirm/i);
    expect(context.retired).toEqual([]);
    expect(context.release).toHaveBeenCalledWith(true);
  });

  it("publishes through insert on the owned write client", async () => {
    const context = fixture();
    const inserts: string[] = [];
    const client: ClickHouseClient = {
      ...context.client,
      insert: async (options) => {
        inserts.push(String(options.query_id));
      },
    };
    await withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
      const insert = owner.client.insert;
      if (insert === undefined) throw new Error("owned write client must expose insert");
      await insert({
        table: "fixture",
        values: [{ value: 1 }],
        format: "JSONEachRow",
      });
    });
    expect(inserts).toEqual([context.registrations[0]]);
    expect(context.terminals).toEqual([context.registrations[0]]);
  });

  it("does not clear a non source-group intent after a terminal native write failure", async () => {
    const context = fixture();
    const client: ClickHouseClient = {
      ...context.client,
      command: async () => {
        throw new ClickHouseError({
          message: "memory",
          code: "241",
          type: "MEMORY_LIMIT_EXCEEDED",
        });
      },
    };
    await expect(
      withAnalyticsQueryOwner(database, client, context.input, async (owner) => {
        await owner.client.command({ query: "INSERT fixture" });
      }),
    ).rejects.toMatchObject({ code: "241" });
    expect(context.sourceGroupClears).toEqual([]);
    expect(context.writeIntentClears).toEqual([]);
    expect(context.quiesced).toHaveLength(1);
  });

  it.each([
    "source-group:not-a-digest",
    `xsource-group:${"ab".repeat(32)}`,
    `source-group:${"ab".repeat(32)}trailing`,
  ])("does not clear a malformed source-group intent %s", async (intentId) => {
    const context = fixture();
    const client: ClickHouseClient = {
      ...context.client,
      command: async () => {
        throw new ClickHouseError({
          message: "memory",
          code: "241",
          type: "MEMORY_LIMIT_EXCEEDED",
        });
      },
    };
    await expect(
      withAnalyticsQueryOwner(
        database,
        client,
        { resourceId: context.input.resourceId, intentId },
        async (owner) => {
          await owner.client.command({ query: "INSERT fixture" });
        },
      ),
    ).rejects.toMatchObject({ code: "241" });
    expect(context.sourceGroupClears).toEqual([]);
  });
});
