import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  command: vi.fn<(params: { query: string; query_id: string }) => Promise<unknown>>(),
  query:
    vi.fn<
      (params: { query: string; query_id: string; format: string }) => Promise<{
        json: () => Promise<Record<string, unknown>[]>;
      }>
    >(),
  insert:
    vi.fn<
      (params: {
        table: string;
        query_id: string;
        values: unknown[];
        format: string;
      }) => Promise<unknown>
    >(),
  close: vi.fn<() => Promise<void>>(),
}));
vi.mock("@clickhouse/client", () => ({ createClient: () => client }));

import { BoundedSensorFixture, sensorRow } from "./bounded-sensor-test-helpers.ts";

interface RequestLedger {
  database: string;
  requests: { queryId: string; sql: string; state: string; firstFatal?: string; code?: string }[];
}

const fixtures: BoundedSensorFixture[] = [];

function fixture(): BoundedSensorFixture {
  const result = new BoundedSensorFixture();
  fixtures.push(result);
  return result;
}

function ledger(subject: BoundedSensorFixture): RequestLedger {
  return JSON.parse(readFileSync(subject.evidencePath, "utf8"));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CLICKHOUSE_URL", "http://fixture.invalid");
  client.command.mockResolvedValue(undefined);
  client.insert.mockResolvedValue(undefined);
  client.close.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const subject of fixtures.splice(0)) {
    rmSync(dirname(subject.evidencePath), { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe("bounded sensor fixture request ledger", () => {
  it("persists the scoped SQL and UUID before dispatch, then settles a successful response", async () => {
    const subject = fixture();
    let complete: (() => void) | undefined;
    client.command.mockImplementationOnce(({ query, query_id }) => {
      expect(query_id).toMatch(/^bounded-sensor-[0-9a-f-]{36}$/);
      expect(query).toBe(`SELECT 1 FROM ${subject.database}.metric_stream`);
      expect(ledger(subject)).toEqual({
        database: subject.database,
        requests: [{ queryId: query_id, sql: query, state: "dispatched" }],
      });
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    });

    const pending = subject.command("SELECT 1 FROM ingest.metric_stream");
    expect(ledger(subject).requests[0]?.state).toBe("dispatched");
    expect(complete).toBeTypeOf("function");
    complete?.();
    await pending;

    expect(ledger(subject).requests).toEqual([
      {
        queryId: subject.queryIds[0],
        sql: `SELECT 1 FROM ${subject.database}.metric_stream`,
        state: "terminal-success",
      },
    ]);
  });

  it("keeps a read dispatched until its response body has been consumed", async () => {
    const subject = fixture();
    const rows = [{ scalar: 115 }];
    client.query.mockImplementationOnce(async ({ query, query_id }) => {
      expect(ledger(subject).requests).toEqual([
        { queryId: query_id, sql: query, state: "dispatched" },
      ]);
      return {
        json: async () => {
          expect(ledger(subject).requests[0]?.state).toBe("dispatched");
          return rows;
        },
      };
    });

    await expect(
      subject.read("SELECT scalar FROM analytics.sensor_scalar_sample"),
    ).resolves.toEqual(rows);
    expect(ledger(subject).requests[0]).toMatchObject({ state: "terminal-success" });
  });

  it("persists each seed insert before dispatch with distinct request identities", async () => {
    const subject = fixture();
    const dispatchedIds: string[] = [];
    client.insert.mockImplementation(async ({ query_id }) => {
      dispatchedIds.push(query_id);
      expect(ledger(subject).requests.at(-1)).toMatchObject({
        queryId: query_id,
        state: "dispatched",
      });
    });
    const row = sensorRow(1);

    await subject.seed([row]);
    await subject.seed([{ ...row, version: "9007199254740994" }]);

    expect(dispatchedIds).toHaveLength(2);
    expect(new Set(dispatchedIds).size).toBe(2);
    expect(ledger(subject).requests.map(({ queryId, state }) => ({ queryId, state }))).toEqual(
      dispatchedIds.map((queryId) => ({ queryId, state: "terminal-success" })),
    );
  });

  it.each([241, "241"])(
    "records numeric server code %s as terminal and permits cleanup",
    async (code) => {
      const subject = fixture();
      const failure = Object.assign(new Error("Memory limit exceeded"), { code });
      client.command.mockRejectedValueOnce(failure);

      await expect(subject.command("SELECT 1")).rejects.toBe(failure);
      expect(ledger(subject).requests[0]).toMatchObject({
        state: "terminal-error",
        code: "241",
        firstFatal: "Memory limit exceeded",
      });
      await subject.close();

      expect(client.command).toHaveBeenLastCalledWith({
        query: `DROP DATABASE IF EXISTS ${subject.database} SYNC`,
        query_id: subject.queryIds[1],
      });
      expect(ledger(subject).requests[1]).toMatchObject({ state: "terminal-success" });
      expect(client.close).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "ECONNRESET", "ETIMEDOUT"])(
    "preserves the fixture on transport failure %s, closes the client, and refuses DROP",
    async (code) => {
      const subject = fixture();
      const failure = Object.assign(new Error("socket hang up"), code ? { code } : {});
      client.command.mockRejectedValueOnce(failure);

      await expect(subject.command("SELECT 1")).rejects.toBe(failure);
      const beforeClose = readFileSync(subject.evidencePath, "utf8");
      const closeOutcome = await subject.close().then(
        () => null,
        (error: unknown) => error,
      );

      expect(client.command).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledOnce();
      expect(closeOutcome).toMatchObject({
        message: expect.stringContaining(`preserve ${subject.database}`),
      });
      expect(ledger(subject).requests[0]).toMatchObject({
        state: "unknown",
        firstFatal: "socket hang up",
        ...(code ? { code } : {}),
      });
      expect(readFileSync(subject.evidencePath, "utf8")).toBe(beforeClose);
    },
  );

  it("awaits client closure before reporting an unknown outcome", async () => {
    const subject = fixture();
    client.command.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(subject.command("SELECT 1")).rejects.toThrow("socket hang up");
    let finishClose: (() => void) | undefined;
    client.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    let reported = false;
    const closing = subject.close().catch((error: unknown) => {
      reported = true;
      return error;
    });
    await Promise.resolve();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.command).toHaveBeenCalledTimes(1);
    expect(reported).toBe(false);

    finishClose?.();
    await expect(closing).resolves.toMatchObject({
      message: expect.stringContaining(`preserve ${subject.database}`),
    });
    expect(reported).toBe(true);
  });

  it.each([
    { code: "241", state: "terminal-error" },
    { code: "ECONNRESET", state: "unknown" },
  ])(
    "releases the client when DROP fails with $code and preserves its error and ledger",
    async ({ code, state }) => {
      const subject = fixture();
      await subject.command("SELECT 1");
      const firstRequest = ledger(subject).requests[0];
      const failure = Object.assign(new Error("cleanup failed"), { code });
      client.command.mockRejectedValueOnce(failure);

      await expect(subject.close()).rejects.toBe(failure);

      expect(client.close).toHaveBeenCalledOnce();
      expect(ledger(subject)).toEqual({
        database: subject.database,
        requests: [
          firstRequest,
          {
            queryId: subject.queryIds[1],
            sql: `DROP DATABASE IF EXISTS ${subject.database} SYNC`,
            state,
            code,
            firstFatal: "cleanup failed",
          },
        ],
      });
    },
  );

  it.each(["command", "read"] as const)(
    "preserves a still-dispatched %s without DROP and awaits client closure",
    async (operation) => {
      const subject = fixture();
      let finishRequest: (() => void) | undefined;
      const response = new Promise<void>((resolve) => {
        finishRequest = resolve;
      });
      if (operation === "command") {
        client.command.mockImplementationOnce(() => response);
      } else {
        client.query.mockImplementationOnce(async () => {
          await response;
          return { json: async () => [{ scalar: 115 }] };
        });
      }
      const pending = subject[operation]("SELECT 1");
      expect(ledger(subject).requests[0]?.state).toBe("dispatched");
      const beforeClose = readFileSync(subject.evidencePath, "utf8");
      let finishClose: (() => void) | undefined;
      client.close.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      );
      let reported = false;
      const closing = subject.close().then(
        () => null,
        (error: unknown) => {
          reported = true;
          return error;
        },
      );
      await Promise.resolve();

      expect(client.close).toHaveBeenCalledOnce();
      expect(client.command).toHaveBeenCalledTimes(operation === "command" ? 1 : 0);
      expect(client.query).toHaveBeenCalledTimes(operation === "read" ? 1 : 0);
      expect(reported).toBe(false);
      expect(readFileSync(subject.evidencePath, "utf8")).toBe(beforeClose);

      finishClose?.();
      await expect(closing).resolves.toMatchObject({
        message: expect.stringContaining(`preserve ${subject.database}`),
      });
      expect(readFileSync(subject.evidencePath, "utf8")).toBe(beforeClose);
      finishRequest?.();
      await pending;
    },
  );
});
