import { z } from "zod";

const admissionSchema = z.object({
  architecture: z.string(),
  memAvailableKiB: z.number().finite(),
  containers: z.object({
    clickhouse: z.object({ memory: z.number(), nanoCpus: z.number() }),
    postgres: z.object({ memory: z.number() }),
    redis: z.object({ memory: z.number() }),
  }),
  cgroupMemoryMax: z.string(),
  cgroupCpuMax: z.string(),
  native: z.object({ version: z.string(), serverMemory: z.string(), serverRatio: z.string() }),
  packages: z.array(z.object({ name: z.string(), version: z.string() })),
});

/** Admission policy for the fixed CI environment, consumed by its preflight command. */
export function assertAnalyticsPlanAdmission(input: unknown): void {
  const state = admissionSchema.parse(input);
  const require = (condition: boolean, prerequisite: string) => {
    if (!condition) throw new Error(`Analytics access-plan admission failed: ${prerequisite}`);
  };
  require(state.architecture === "arm64", "architecture must be arm64");
  require(state.memAvailableKiB >= 8 * 1024 ** 2, "MemAvailable must be at least 8GiB");
  const ceiling = 3 * 1024 ** 3;
  const ceilingsMatch =
    state.containers.clickhouse.memory === ceiling &&
    state.containers.clickhouse.nanoCpus === 1_000_000_000 &&
    state.containers.postgres.memory === 1024 ** 3 &&
    state.containers.redis.memory === 256 * 1024 ** 2;
  require(ceilingsMatch, "container ceilings must match ClickHouse 3GiB/1CPU, Postgres 1GiB and Redis 256MiB");
  require(state.cgroupMemoryMax === String(ceiling), "cgroup memory must be 3GiB");
  const cpu = /^(\d+) (\d+)$/.exec(state.cgroupCpuMax.trim());
  require(!!cpu && Number(cpu[1]) > 0 && cpu[1] === cpu[2], "cgroup CPU must be one core");
  require(state.native.version === "26.10.2.103", "native version must be 26.10.2.103");
  const memory = Number(state.native.serverMemory);
  const ratio = Number(state.native.serverRatio);
  const memoryPolicyValid =
    state.native.serverMemory.trim() !== "" &&
    Number.isFinite(memory) &&
    memory >= 0 &&
    memory <= ceiling &&
    state.native.serverRatio.trim() !== "" &&
    Number.isFinite(ratio) &&
    ratio > 0 &&
    ratio <= 1;
  require(memoryPolicyValid, "server memory policy must fit the verified cgroup ceiling");
  for (const [name, version] of [
    ["dbt-core", "1.11.16"],
    ["dbt-clickhouse", "1.10.3"],
  ]) {
    const versionMatches = state.packages.some(
      (pkg) => pkg.name === name && pkg.version === version,
    );
    require(versionMatches, `${name} must be ${version}`);
  }
}
