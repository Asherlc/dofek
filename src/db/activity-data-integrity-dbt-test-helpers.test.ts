import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn, captureException } = vi.hoisted(() => ({
  spawn: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

import {
  bootstrapActivityIntegrityIdentityModels,
  seedProductionDbtFixture,
} from "./activity-data-integrity-dbt-test-helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function observe() {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(fs, "writeSync").mockImplementation((_fd, data) => {
    events.push(JSON.parse(String(data)));
    return String(data).length;
  });
  return events;
}

describe("activity integrity fixture diagnostics", () => {
  it("identifies each pending statement without exposing SQL or the database", async () => {
    const events = observe();
    const client = createClient({ url: "http://fixture.invalid" });
    const commands: string[] = [];
    let finish: (() => void) | undefined;
    vi.spyOn(client, "command").mockImplementation(async ({ query }) => {
      commands.push(query);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { query_id: "", response_headers: {} };
    });
    const pending = seedProductionDbtFixture(client, "private_database");
    expect(commands).toEqual(["DROP DATABASE IF EXISTS private_database SYNC"]);
    expect(events).toEqual([
      expect.objectContaining({
        event: "fixture.statement.start",
        stage: "drop_database",
        statementIndex: 0,
      }),
    ]);
    const operationId = events[0]?.operationId;
    expect(operationId).toEqual(expect.any(Number));
    finish?.();
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]).toBe("CREATE DATABASE private_database");
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({
        event: "fixture.statement.end",
        stage: "drop_database",
        operationId,
      }),
      expect.objectContaining({
        event: "fixture.statement.start",
        stage: "create_database",
        statementIndex: 1,
        operationId,
      }),
    ]);
    finish?.();
    await vi.waitFor(() => expect(commands).toHaveLength(3));
    expect(events.at(-1)).toMatchObject({
      event: "fixture.statement.start",
      stage: "seed",
      statementIndex: 2,
    });
    vi.mocked(client.command).mockResolvedValue({ query_id: "", response_headers: {} });
    finish?.();
    await pending;
    expect(events.filter((event) => event.event === "fixture.statement.start")).toHaveLength(19);
    expect(events.filter((event) => event.event === "fixture.statement.end")).toHaveLength(19);
    expect(events.at(-1)).toMatchObject({ event: "fixture.statement.end", statementIndex: 18 });
    for (const event of events) {
      expect(event).toMatchObject({
        operationId,
        timestamp: expect.any(String),
        elapsedMs: expect.any(Number),
      });
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(events)).not.toMatch(/private|DROP|CREATE|INSERT|fixture\.invalid/);
    await client.close();
  });

  it("preserves a rejected statement and leaves its stage open", async () => {
    const events = observe();
    const client = createClient({ url: "http://fixture.invalid" });
    const failure = new Error("private statement failure");
    vi.spyOn(client, "command").mockRejectedValue(failure);
    await expect(seedProductionDbtFixture(client, "private_database")).rejects.toBe(failure);
    expect(events).toEqual([
      expect.objectContaining({ event: "fixture.statement.start", stage: "drop_database" }),
    ]);
    await client.close();
  });

  it.each([
    [0, null],
    [7, null],
    [null, "SIGTERM"],
  ] as const)(
    "observes child spawn and close (%s, %s) without changing completion",
    async (code, signal) => {
      const events = observe();
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 12345 });
      spawn.mockReturnValue(child);
      const pending = bootstrapActivityIntegrityIdentityModels();
      const result =
        code === 0
          ? expect(pending).resolves.toBeUndefined()
          : expect(pending).rejects.toThrow(
              `Identity fixture dbt bootstrap failed with exit code ${code ?? 1}`,
            );
      expect(events).toEqual([expect.objectContaining({ event: "fixture.bootstrap.start" })]);
      expect(spawn).toHaveBeenLastCalledWith(
        "uv",
        [
          "run",
          "--project",
          "analytics",
          "dbt",
          "build",
          "--project-dir",
          "analytics",
          "--profiles-dir",
          "analytics",
          "--threads",
          "1",
          "--select",
          "activity_source_records activity_duplicate_matches activity_duplicate_groups deduped_activities deduped_activity_members",
        ],
        {
          env: {
            ...process.env,
            UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT ?? "../.venv-analytics",
          },
          stdio: "inherit",
        },
      );
      child.emit("spawn");
      expect(events.at(-1)).toMatchObject({ event: "fixture.bootstrap.spawn", pid: 12345 });
      child.emit("close", code, signal);
      await result;
      expect(events[2]).toMatchObject({
        event: "fixture.bootstrap.close",
        pid: 12345,
        code,
        signal,
      });
      expect(events.map((event) => event.event)).toEqual([
        "fixture.bootstrap.start",
        "fixture.bootstrap.spawn",
        "fixture.bootstrap.close",
        ...(code === 0 ? ["fixture.bootstrap.end"] : []),
      ]);
      for (const event of events) expect(event.operationId).toBe(events[0]?.operationId);
      expect(JSON.stringify(events)).not.toMatch(/analytics|uv|--|\.venv|DBT|UV_PROJECT/);
    },
  );

  it("retains the original child spawn rejection", async () => {
    const events = observe();
    const child = new ChildProcess();
    spawn.mockReturnValue(child);
    const failure = new Error("private spawn failure");
    const pending = bootstrapActivityIntegrityIdentityModels();
    const result = expect(pending).rejects.toBe(failure);
    child.emit("error", failure);
    await result;
    expect(events).toEqual([expect.objectContaining({ event: "fixture.bootstrap.start" })]);
  });

  it.each([
    ["spawn", 0, null],
    ["spawn", 7, null],
    ["spawn", null, "SIGTERM"],
    ["close", 0, null],
    ["close", 7, null],
    ["close", null, "SIGTERM"],
  ] as const)(
    "preserves child completion when the %s diagnostic write fails (%s, %s)",
    async (failedEvent, code, signal) => {
      observe();
      const writeFailure = Object.assign(new Error("private SQL argv env write failure"), {
        code: "EPIPE",
        syscall: "write",
        stack: "Error: private SQL argv env write failure",
      });
      const child = new ChildProcess();
      spawn.mockReturnValue(child);
      const pending = bootstrapActivityIntegrityIdentityModels();
      const result =
        code === 0
          ? expect(pending).resolves.toBeUndefined()
          : expect(pending).rejects.toThrow(
              `Identity fixture dbt bootstrap failed with exit code ${code ?? 1}`,
            );
      vi.mocked(fs.writeSync).mockImplementation((_fd, data) => {
        if (JSON.parse(String(data)).event === `fixture.bootstrap.${failedEvent}`) {
          throw writeFailure;
        }
        return String(data).length;
      });
      expect(() => child.emit("spawn")).not.toThrow();
      expect(() => child.emit("close", code, signal)).not.toThrow();
      await result;
      expect(captureException).toHaveBeenCalledExactlyOnceWith(
        new Error("Identity fixture bootstrap diagnostics failed"),
        {
          extra: {
            diagnostic: {
              errors: [
                { name: "Error", code: "EPIPE", syscall: "write", locations: [], aborted: false },
              ],
              truncated: false,
            },
          },
        },
      );
      const [reported, context] = captureException.mock.calls[0] ?? [];
      expect(reported).not.toBe(writeFailure);
      expect(`${reported.message} ${JSON.stringify(context)}`).not.toMatch(/private|SQL|argv|env/);
    },
  );

  it("retains the original spawn error when the subsequent close diagnostic write fails", async () => {
    observe();
    const child = new ChildProcess();
    spawn.mockReturnValue(child);
    const failure = new Error("private spawn failure");
    const pending = bootstrapActivityIntegrityIdentityModels();
    const result = expect(pending).rejects.toBe(failure);
    child.emit("error", failure);
    await result;
    vi.mocked(fs.writeSync).mockImplementation(() => {
      throw Object.assign(new Error("private close write failure"), { code: "EPIPE" });
    });
    expect(() => child.emit("close", -2, null)).not.toThrow();
    await expect(pending).rejects.toBe(failure);
    expect(captureException).toHaveBeenCalledExactlyOnceWith(
      new Error("Identity fixture bootstrap diagnostics failed"),
      {
        extra: {
          diagnostic: {
            errors: [expect.objectContaining({ code: "EPIPE" })],
            truncated: false,
          },
        },
      },
    );
    expect(JSON.stringify(captureException.mock.calls)).not.toMatch(/private|spawn failure/);
  });
});
