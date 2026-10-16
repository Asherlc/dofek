import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { waitForMigrationQuiescence } from "./wait-migration-quiescence.ts";

const docker = vi.mocked(execFileSync);
const consumers = [
  "worker",
  "analytics-worker",
  "metric-stream-clickhouse-sink",
  "metric-stream-live-clickhouse-sink",
  "metric-stream-history-clickhouse-sink",
  "processing-reconciliation",
];
type ServiceFixture = { replicas?: number; updateState?: string; tasks?: string[] };
const services = new Map<string, ServiceFixture>();
const tasks = new Map<string, { ID: string; Status: { State: string }; DesiredState: string }>();

function recordTask(id: string, state: string) {
  tasks.set(id, { ID: id, Status: { State: state }, DesiredState: "shutdown" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  services.clear();
  tasks.clear();
  docker.mockReset();
  docker.mockImplementation((_command, arguments_) => {
    if (!Array.isArray(arguments_)) throw new Error("Expected Docker arguments");
    if (arguments_[0] === "service" && arguments_[1] === "inspect") {
      const service = services.get(arguments_[2] ?? "") ?? {};
      return JSON.stringify([
        {
          Spec: { Mode: { Replicated: { Replicas: service.replicas ?? 0 } } },
          ...(service.updateState ? { UpdateStatus: { State: service.updateState } } : {}),
        },
      ]);
    }
    if (arguments_[0] === "service" && arguments_[1] === "ps") {
      return (services.get(arguments_.at(-1) ?? "")?.tasks ?? []).join("\n");
    }
    if (arguments_[0] === "inspect") {
      return JSON.stringify(arguments_.slice(3).map((id: string) => tasks.get(id)));
    }
    throw new Error(`Unexpected Docker command: ${arguments_.join(" ")}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("migration service quiescence", () => {
  it("checks the worker and every CDC consumer in rolling mode", async () => {
    const terminalStates = ["shutdown", "complete", "failed", "rejected", "remove"];
    for (const [index, state] of terminalStates.entries()) {
      const service = `dofek_${consumers[index]}`;
      const task = `terminal-task-${index}`;
      services.set(service, { tasks: [task] });
      recordTask(task, state);
    }
    await waitForMigrationQuiescence("dofek", "rolling");
    expect(
      docker.mock.calls
        .filter(([, args]) => Array.isArray(args) && args[0] === "service" && args[1] === "inspect")
        .map(([, args]) => (Array.isArray(args) ? args[2] : undefined)),
    ).toEqual(consumers.map((consumer) => `dofek_${consumer}`));
  });

  it("also checks web in maintenance mode and supports a different stack", async () => {
    await waitForMigrationQuiescence("another-stack", "maintenance");
    expect(docker).toHaveBeenCalledWith(
      "docker",
      ["service", "inspect", "another-stack_web"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it.each([
    ["rolling", "worker"],
    ["maintenance", "web"],
  ] as const)("waits for a draining %s task in %s to actually stop", async (mode, consumer) => {
    services.set(`dofek_${consumer}`, { tasks: ["old-task", "draining-task"] });
    recordTask("old-task", "shutdown");
    recordTask("draining-task", "running");
    let finished = false;
    const waiting = waitForMigrationQuiescence("dofek", mode).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).toBe(false);
    expect(docker).toHaveBeenCalledWith(
      "docker",
      ["service", "ps", "--quiet", "--no-trunc", `dofek_${consumer}`],
      expect.any(Object),
    );
    recordTask("draining-task", "shutdown");
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(finished).toBe(true);
  });

  it("fails immediately if a required consumer still has nonzero desired replicas", async () => {
    services.set("dofek_worker", { replicas: 1 });
    await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow(
      /dofek_worker.*zero replicas/i,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["paused", "rollback_started", "rollback_paused"])(
    "fails on a service update in %s state",
    async (updateState) => {
      services.set("dofek_worker", { updateState });
      await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow(
        new RegExp(`dofek_worker.*${updateState}`),
      );
    },
  );

  it("accepts a completed rollback to zero replicas after every old task stopped", async () => {
    services.set("dofek_web", { updateState: "rollback_completed", tasks: ["old-task"] });
    recordTask("old-task", "shutdown");
    await expect(waitForMigrationQuiescence("dofek", "maintenance")).resolves.toBeUndefined();
  });

  it("fails loudly when Docker cannot inspect a required service", async () => {
    docker.mockImplementationOnce(() => {
      throw new Error("No such service: dofek_worker");
    });
    await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow(
      "No such service: dofek_worker",
    );
  });

  it.each(["[]", "not-json", '[{"Spec":{"Mode":{"Global":{}}}}]'])(
    "rejects malformed or missing service evidence %s",
    async (evidence) => {
      docker.mockReturnValueOnce(evidence);
      await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow();
    },
  );

  it("rejects task inspection that omits a task returned by service ps", async () => {
    services.set("dofek_worker", { tasks: ["missing-task"] });
    recordTask("missing-task", "shutdown");
    docker.mockImplementation((command, arguments_, options) => {
      if (Array.isArray(arguments_) && arguments_[0] === "inspect") return "[]";
      if (Array.isArray(arguments_) && arguments_[1] === "inspect") {
        return '[{"Spec":{"Mode":{"Replicated":{"Replicas":0}}}}]';
      }
      if (Array.isArray(arguments_) && arguments_[1] === "ps") return "missing-task";
      throw new Error(`Unexpected Docker command ${command} ${arguments_} ${options}`);
    });
    await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow(
      /dofek_worker.*missing-task/,
    );
  });

  it("times out at 35 minutes with the actual draining task state", async () => {
    services.set("dofek_worker", { tasks: ["draining-task"] });
    recordTask("draining-task", "running");
    const waiting = expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow(
      /35 minutes.*dofek_worker.*draining-task.*running/,
    );
    await vi.advanceTimersByTimeAsync(35 * 60 * 1_000);
    await waiting;
  });
});
