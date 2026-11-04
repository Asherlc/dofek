import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { captureException } from "../src/lib/error-reporting.ts";
import { assertAnalyticsPlanAdmission } from "./analytics-plan-admission.ts";

const [outputDirectory, clickhouse, postgres, redis, ...extra] = process.argv.slice(2);
const evidence: { commands: unknown[]; state?: unknown; error?: string } = { commands: [] };
let artifact: string | undefined;
function persist() {
  if (artifact) writeFileSync(artifact, JSON.stringify(evidence, null, 2));
}
function run(command: string, args: string[]): string {
  const request = {
    command,
    args,
    state: "dispatched",
    stdout: "",
    stderr: "",
    exitCode: null,
  };
  evidence.commands.push(request);
  persist();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  Object.assign(request, {
    state: result.error || result.signal ? "unknown" : "settled",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  });
  persist();
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`Admission command failed: ${command}`);
  return result.stdout.trim();
}

try {
  if (
    !outputDirectory ||
    !clickhouse ||
    !postgres ||
    !redis ||
    extra.length ||
    ![clickhouse, postgres, redis].every((id) => /^[a-f0-9]{12,64}$/.test(id))
  ) {
    throw new Error(
      "Usage: check-analytics-plan-ci-admission.ts <output-directory> <clickhouse-id> <postgres-id> <redis-id>",
    );
  }
  mkdirSync(outputDirectory, { recursive: true });
  artifact = join(outputDirectory, "admission.json");
  persist();
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  if (!available) throw new Error("MemAvailable missing from /proc/meminfo");
  const containers = Object.fromEntries(
    (
      [
        ["clickhouse", clickhouse],
        ["postgres", postgres],
        ["redis", redis],
      ] as const
    ).map(([name, id]) => {
      const value = JSON.parse(
        run("docker", [
          "inspect",
          "--format",
          '{"Memory":{{json .HostConfig.Memory}},"NanoCpus":{{json .HostConfig.NanoCpus}}}',
          id,
        ]),
      );
      const limits = z.object({ Memory: z.number(), NanoCpus: z.number() }).parse(value);
      return [name, { memory: limits.Memory, nanoCpus: limits.NanoCpus }];
    }),
  );
  const queryId = randomUUID();
  const query = `SELECT version() AS version,
    (SELECT value FROM system.server_settings WHERE name='max_server_memory_usage') AS serverMemory,
    (SELECT value FROM system.server_settings WHERE name='max_server_memory_usage_to_ram_ratio') AS serverRatio
    SETTINGS max_memory_usage=134217728,max_threads=1 FORMAT JSONEachRow`;
  const native = JSON.parse(
    run("docker", [
      "exec",
      clickhouse,
      "clickhouse-client",
      "--password",
      "test",
      "--query_id",
      queryId,
      "--query",
      query,
    ]),
  );
  const state = {
    architecture: process.arch,
    memAvailableKiB: Number(available[1]),
    containers,
    cgroupMemoryMax: run("docker", ["exec", clickhouse, "cat", "/sys/fs/cgroup/memory.max"]),
    cgroupCpuMax: run("docker", ["exec", clickhouse, "cat", "/sys/fs/cgroup/cpu.max"]),
    native,
    packages: JSON.parse(
      run("uv", ["pip", "list", "--python", ".venv-analytics/bin/python", "--format", "json"]),
    ),
  };
  evidence.state = state;
  persist();
  assertAnalyticsPlanAdmission(state);
} catch (error) {
  captureException(error);
  evidence.error =
    error instanceof Error ? error.message : "Analytics access-plan admission failed";
  persist();
  process.stderr.write(`${evidence.error}\n`);
  process.exitCode = 1;
}
