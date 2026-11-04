import { describe, expect, it } from "vitest";
import { assertAnalyticsPlanAdmission } from "./analytics-plan-admission.ts";

const admitted = {
  architecture: "arm64",
  memAvailableKiB: 8 * 1024 * 1024,
  containers: {
    clickhouse: { memory: 3 * 1024 ** 3, nanoCpus: 1_000_000_000 },
    postgres: { memory: 1024 ** 3 },
    redis: { memory: 256 * 1024 ** 2 },
  },
  cgroupMemoryMax: String(3 * 1024 ** 3),
  cgroupCpuMax: "100000 100000",
  native: {
    version: "26.10.2.103",
    serverMemory: String(2.7 * 1024 ** 3),
    serverRatio: "0.9",
  },
  packages: [
    { name: "dbt-core", version: "1.11.16" },
    { name: "dbt-clickhouse", version: "1.10.3" },
  ],
};

describe("assertAnalyticsPlanAdmission", () => {
  it("admits the fixed ARM qualification environment", () => {
    expect(() => assertAnalyticsPlanAdmission(admitted)).not.toThrow();
  });

  it.each([
    ["architecture", { ...admitted, architecture: "x64" }],
    ["MemAvailable", { ...admitted, memAvailableKiB: admitted.memAvailableKiB - 1 }],
    ["cgroup memory", { ...admitted, cgroupMemoryMax: "max" }],
    ["cgroup CPU", { ...admitted, cgroupCpuMax: "max 100000" }],
    ["native version", { ...admitted, native: { ...admitted.native, version: "26.6.1" } }],
    ["server memory", { ...admitted, native: { ...admitted.native, serverRatio: "0" } }],
    ["server memory", { ...admitted, native: { ...admitted.native, serverRatio: "NaN" } }],
    ["server memory", { ...admitted, native: { ...admitted.native, serverRatio: "1.1" } }],
    ["server memory", { ...admitted, native: { ...admitted.native, serverMemory: "" } }],
    ["server memory", { ...admitted, native: { ...admitted.native, serverMemory: "4000000000" } }],
    ["dbt-core", { ...admitted, packages: admitted.packages.slice(1) }],
    ["dbt-clickhouse", { ...admitted, packages: [{ name: "dbt-core", version: "1.11.16" }] }],
    [
      "container ceilings",
      {
        ...admitted,
        containers: { ...admitted.containers, clickhouse: { memory: 0, nanoCpus: 0 } },
      },
    ],
    [
      "container ceilings",
      { ...admitted, containers: { ...admitted.containers, postgres: { memory: 0 } } },
    ],
    [
      "container ceilings",
      { ...admitted, containers: { ...admitted.containers, redis: { memory: 0 } } },
    ],
  ])("rejects an unqualified %s", (reason, input) => {
    expect(() => assertAnalyticsPlanAdmission(input)).toThrow(reason);
  });

  it("records the native automatic server limit with its explicit finite ratio", () => {
    expect(() =>
      assertAnalyticsPlanAdmission({
        ...admitted,
        native: { ...admitted.native, serverMemory: "0" },
      }),
    ).not.toThrow();
  });
});
