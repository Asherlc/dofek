import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import {
  drainMigrationConsumers,
  waitForMigrationQuiescence,
} from "./wait-migration-quiescence.ts";

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
let deployedServices = new Set<string>();
let scaleCalls: string[][] = [];
let discoveryFailure = "";
let scaleFailure = "";

function recordTask(id: string, state: string) {
  tasks.set(id, { ID: id, Status: { State: state }, DesiredState: "shutdown" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  services.clear();
  tasks.clear();
  deployedServices = new Set();
  scaleCalls = [];
  discoveryFailure = "";
  scaleFailure = "";
  docker.mockReset();
  docker.mockImplementation((_command, arguments_) => {
    if (!Array.isArray(arguments_)) throw new Error("Expected Docker arguments");
    if (arguments_[0] === "service" && arguments_[1] === "ls") {
      if (discoveryFailure) throw new Error(discoveryFailure);
      return [...deployedServices].join("\n");
    }
    if (arguments_[0] === "service" && arguments_[1] === "scale") {
      if (scaleFailure) throw new Error(scaleFailure);
      scaleCalls.push(arguments_);
      return "";
    }
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
      const taskIds = services.get(arguments_.at(-1) ?? "")?.tasks ?? [];
      return taskIds
        .map((id) => {
          const task = tasks.get(id);
          if (!task) throw new Error(`Missing task fixture for ${id}`);
          return JSON.stringify({
            ID: id,
            CurrentState: task.Status.State,
            DesiredState: task.DesiredState,
          });
        })
        .join("\n");
    }
    throw new Error(`Unexpected Docker command: ${arguments_.join(" ")}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("migration service quiescence", () => {
  it("waits for a running task marked for removal to disappear from the next snapshot", async () => {
    const snapshots = new Map<string, number>();
    docker.mockImplementation((_command, arguments_) => {
      if (!Array.isArray(arguments_)) throw new Error("Expected Docker arguments");
      if (arguments_[0] === "service" && arguments_[1] === "inspect") {
        return '[{"Spec":{"Mode":{"Replicated":{"Replicas":0}}}}]';
      }
      if (arguments_[0] === "service" && arguments_[1] === "ps") {
        if (arguments_.includes("--format")) {
          const serviceName = arguments_.at(-1) ?? "";
          const snapshotCount = (snapshots.get(serviceName) ?? 0) + 1;
          snapshots.set(serviceName, snapshotCount);
          return serviceName === "dofek_worker" && snapshotCount === 1
            ? '{"ID":"running-task","CurrentState":"Running 3 minutes ago","DesiredState":"Remove"}'
            : "";
        }
        return "running-task";
      }
      if (arguments_[0] === "inspect") {
        throw new Error("Error response from daemon: task running-task not found");
      }
      throw new Error(`Unexpected Docker command: ${arguments_.join(" ")}`);
    });

    const waiting = waitForMigrationQuiescence("dofek", "rolling");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waiting).resolves.toBeUndefined();
    expect([...snapshots.entries()]).toEqual(consumers.map((consumer) => [`dofek_${consumer}`, 2]));
  });

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
    expect(
      docker.mock.calls
        .filter(([, args]) => Array.isArray(args) && args[0] === "service" && args[1] === "ps")
        .map(([, args]) => (Array.isArray(args) ? args.at(-1) : undefined)),
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
      ["service", "ps", "--no-trunc", "--format", "{{json .}}", `dofek_${consumer}`],
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

  it.each([
    "not-json",
    '{"CurrentState":"Running"}',
    '{"ID":"missing-state"}',
    '{"ID":"unknown-state","CurrentState":"FutureState"}',
  ])("rejects malformed task snapshot evidence %s", async (evidence) => {
    docker.mockImplementation((_command, arguments_) => {
      if (!Array.isArray(arguments_)) throw new Error("Expected Docker arguments");
      if (arguments_[0] === "service" && arguments_[1] === "inspect") {
        return '[{"Spec":{"Mode":{"Replicated":{"Replicas":0}}}}]';
      }
      if (arguments_[0] === "service" && arguments_[1] === "ps") return evidence;
      throw new Error(`Unexpected Docker command: ${arguments_.join(" ")}`);
    });
    await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow();
  });

  it("fails loudly when Docker cannot read a required task snapshot", async () => {
    docker.mockImplementation((_command, arguments_) => {
      if (!Array.isArray(arguments_)) throw new Error("Expected Docker arguments");
      if (arguments_[0] === "service" && arguments_[1] === "inspect") {
        return '[{"Spec":{"Mode":{"Replicated":{"Replicas":0}}}}]';
      }
      if (arguments_[0] === "service" && arguments_[1] === "ps") {
        throw new Error("Error response from daemon: cannot list service tasks");
      }
      throw new Error(`Unexpected Docker command: ${arguments_.join(" ")}`);
    });
    await expect(waitForMigrationQuiescence("dofek", "rolling")).rejects.toThrow(
      "Error response from daemon: cannot list service tasks",
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

describe("pre-apply migration publisher drain", () => {
  it("scales exactly the deployed stack-prefixed consumer set to zero", async () => {
    for (const consumer of consumers) {
      deployedServices.add(`other_${consumer}`);
      deployedServices.add(`dofek_${consumer}`);
    }
    deployedServices.add("dofek_worker_old");
    deployedServices.add("dofek_clickhouse");

    await drainMigrationConsumers("dofek", "rolling");

    expect(docker).toHaveBeenCalledWith(
      "docker",
      ["service", "ls", "--format", "{{.Name}}"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(scaleCalls).toEqual([
      ["service", "scale", "--detach=true", ...consumers.map((consumer) => `dofek_${consumer}=0`)],
    ]);
  });

  it("keeps web live in rolling mode and drains it in maintenance mode", async () => {
    for (const consumer of consumers) deployedServices.add(`dofek_${consumer}`);
    deployedServices.add("dofek_web");

    await drainMigrationConsumers("dofek", "rolling");
    expect(scaleCalls).toEqual([
      ["service", "scale", "--detach=true", ...consumers.map((consumer) => `dofek_${consumer}=0`)],
    ]);

    scaleCalls = [];
    await drainMigrationConsumers("dofek", "maintenance");
    expect(scaleCalls).toEqual([
      [
        "service",
        "scale",
        "--detach=true",
        ...consumers.map((consumer) => `dofek_${consumer}=0`),
        "dofek_web=0",
      ],
    ]);
  });

  it("drains only services present on an older or partially deployed stack", async () => {
    deployedServices.add("dofek_worker");
    deployedServices.add("dofek_clickhouse");

    await drainMigrationConsumers("dofek", "rolling");

    expect(scaleCalls).toEqual([["service", "scale", "--detach=true", "dofek_worker=0"]]);
  });

  it("does nothing when no migration consumer is deployed on bootstrap", async () => {
    deployedServices.add("dofek_clickhouse");

    await expect(drainMigrationConsumers("dofek", "rolling")).resolves.toBeUndefined();
    expect(scaleCalls).toEqual([]);
  });

  it("waits for a draining deployed task to reach a terminal state", async () => {
    deployedServices.add("dofek_worker");
    services.set("dofek_worker", { tasks: ["draining-task"] });
    recordTask("draining-task", "running");
    let completed = false;
    const draining = drainMigrationConsumers("dofek", "rolling").then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(completed).toBe(false);
    recordTask("draining-task", "shutdown");
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(completed).toBe(true);
  });

  it("reuses the replica check for a scaled service that is still running", async () => {
    deployedServices.add("dofek_worker");
    services.set("dofek_worker", { replicas: 1 });

    await expect(drainMigrationConsumers("dofek", "rolling")).rejects.toThrow(
      /dofek_worker.*zero replicas/i,
    );
  });

  it("aborts before scaling when discovery fails", async () => {
    discoveryFailure = "cannot list services";

    await expect(drainMigrationConsumers("dofek", "rolling")).rejects.toThrow(
      "cannot list services",
    );
    expect(scaleCalls).toEqual([]);
  });

  it("aborts without polling when scaling fails", async () => {
    deployedServices.add("dofek_worker");
    scaleFailure = "cannot scale services";

    await expect(drainMigrationConsumers("dofek", "rolling")).rejects.toThrow(
      "cannot scale services",
    );
    expect(
      docker.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === "service" && args[1] === "ps",
      ),
    ).toEqual([]);
  });
});
