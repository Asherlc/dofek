import { ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { ActivityIntegrityClickHouseClient } from "./activity-data-integrity-clickhouse.ts";
import {
  type ActivityIntegrityDbtBuildInput,
  runActivityIntegrityDbtBuild,
} from "./activity-data-integrity-dbt.ts";

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: vi.fn(),
}));
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const input: ActivityIntegrityDbtBuildInput = {
  userId: id(99999),
  activityIds: [id(1)],
  eventTimeStart: new Date("2026-09-01"),
  eventTimeEnd: new Date("2026-09-08"),
};
const upstream =
  "activity_source_records activity_duplicate_matches activity_duplicate_groups deduped_activities deduped_activity_members activity_effort_identity activity_sensor_sample activity_location_sample activity_route_identity";
const downstream =
  "activity_sensor_summary_rows activity_location_summary_rows activity_stream_points activity_summary_rows activity_vo2max_estimate";
const configSchema = z.object({
  "model-paths": z.array(z.string()),
  vars: z.object({
    activity_refresh_user_id: z.string(),
    activity_refresh_activity_ids_base64: z.string().transform((encoded) => {
      const bytes = Buffer.from(encoded, "base64");
      return Array.from({ length: bytes.length / 16 }, (_, index) => {
        const hex = bytes.subarray(index * 16, (index + 1) * 16).toString("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      });
    }),
    activity_sensor_sample_begin: z.string(),
    activity_step_cadence_repair_activity_ids: z.array(z.string()).optional(),
  }),
});

function fixture(keys: readonly string[] = [id(1)]) {
  const afterUpstreamAliases: string[] = [];
  const verifiedBatches: string[][] = [];
  const state = {
    keys: [...keys],
    aliases: [...keys],
    afterUpstreamAliases,
    upstreamComplete: false,
    targetExists: true,
    skipTargetCreation: false,
    failPhase: 0,
    signalPhase: 0,
    errorPhase: 0,
    leaveStale: new Set<string>(),
    versions: new Map(keys.map((key) => [key, 9007199254740993n])),
    summaryVersions: new Map<string, bigint>(),
    verifiedBatches,
  };
  const phases: Array<{
    selection: string;
    project: string;
    config: z.infer<typeof configSchema>;
    args: readonly string[];
    mode: number;
  }> = [];
  const client: ActivityIntegrityClickHouseClient = {
    query: vi.fn(async ({ query, query_params }) => {
      const requested = z.array(z.string()).parse(query_params?.activityIds ?? []);
      let rows: unknown[];
      if (query.includes("system.tables"))
        rows = state.targetExists ? [{ name: "activity_step_cadence_rows" }] : [];
      else if (query.includes("SELECT expanded_id"))
        rows = [
          ...state.aliases,
          ...(state.upstreamComplete ? state.afterUpstreamAliases : []),
        ].map((activity_id) => ({ activity_id }));
      else if (query.includes("canonical_type = 'running'"))
        rows = state.keys
          .filter((key) => requested.includes(key))
          .map((activity_id) => ({ activity_id }));
      else if (query.includes("toString(refresh_version)")) {
        rows = requested.flatMap((activity_id) => {
          const version = state.versions.get(activity_id);
          return version === undefined ? [] : [{ activity_id, refresh_version: String(version) }];
        });
        state.verifiedBatches.push(requested);
      } else throw new Error(`Unexpected identity query: ${query}`);
      return { json: async () => rows };
    }),
  };
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const arguments_ = args ?? [];
    const selection = arguments_[arguments_.indexOf("--select") + 1] ?? "";
    const project = arguments_[arguments_.indexOf("--project-dir") + 1] ?? "";
    const path = join(project, "dbt_project.yml");
    const config = configSchema.parse(parse(readFileSync(path, "utf8")));
    phases.push({
      selection,
      project,
      config,
      args: arguments_,
      mode: statSync(path).mode & 0o777,
    });
    const phase = phases.length;
    const child = new ChildProcess();
    queueMicrotask(() => {
      if (phase === state.errorPhase) {
        child.emit("error", new Error("spawn unavailable"));
        return;
      }
      if (phase === state.signalPhase) {
        child.emit("close", null);
        return;
      }
      if (phase === state.failPhase) {
        child.emit("close", 2);
        return;
      }
      if (selection === upstream) state.upstreamComplete = true;
      if (selection === "activity_step_cadence_rows") {
        if (!state.skipTargetCreation) state.targetExists = true;
        for (const key of config.vars.activity_step_cadence_repair_activity_ids ?? []) {
          if (!state.leaveStale.has(key))
            state.versions.set(key, (state.versions.get(key) ?? 0n) + 1n);
        }
      }
      if (selection === downstream) state.summaryVersions = new Map(state.versions);
      child.emit("close", 0);
    });
    return child;
  });
  return { state, phases, client };
}

describe("runActivityIntegrityDbtBuild", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it("runs upstream once, verifies disjoint exact batches, then runs summaries with all advanced keys", async () => {
    const keys = Array.from({ length: 201 }, (_, i) => id(i + 10));
    const run = fixture(keys);
    run.state.aliases.push(id(1), id(2));
    run.state.afterUpstreamAliases.push(id(3));
    await runActivityIntegrityDbtBuild(input, run.client);
    expect(run.phases.map((phase) => phase.selection)).toEqual([
      upstream,
      "activity_step_cadence_rows",
      "activity_step_cadence_rows",
      "activity_step_cadence_rows",
      downstream,
    ]);
    const batches = run.phases
      .slice(1, -1)
      .map((phase) => phase.config.vars.activity_step_cadence_repair_activity_ids);
    expect(batches.map((batch) => batch?.length)).toEqual([100, 100, 1]);
    expect(batches.flat()).toEqual(keys);
    expect(run.phases[0]?.config.vars.activity_refresh_activity_ids_base64).toEqual([
      id(1),
      id(2),
      ...keys,
    ]);
    expect(run.phases.at(-1)?.config.vars.activity_refresh_activity_ids_base64).toEqual([
      id(1),
      id(2),
      id(3),
      ...keys,
    ]);
    expect([...run.state.summaryVersions.values()]).toEqual(keys.map(() => 9007199254740994n));
    expect(
      run.phases.at(-1)?.config.vars.activity_step_cadence_repair_activity_ids,
    ).toBeUndefined();
    for (const batch of batches)
      expect(
        run.state.verifiedBatches.filter((ids) => JSON.stringify(ids) === JSON.stringify(batch)),
      ).toHaveLength(2);
    expect(run.phases.every((phase) => !existsSync(phase.project))).toBe(true);
  });
  it.each([100, 200])("publishes %i cadence keys without an extra empty batch", async (count) => {
    const keys = Array.from({ length: count }, (_, index) => id(index + 1));
    const run = fixture(keys);
    await runActivityIntegrityDbtBuild(input, run.client);
    const batches = run.phases
      .filter((phase) => phase.selection === "activity_step_cadence_rows")
      .map((phase) => phase.config.vars.activity_step_cadence_repair_activity_ids);
    expect(batches.map((batch) => batch?.length)).toEqual(Array(count / 100).fill(100));
    expect(batches.flat()).toEqual(keys);
    expect([...run.state.summaryVersions.values()]).toEqual(keys.map(() => 9007199254740994n));
  });
  it.each([
    [new Date("invalid"), input.eventTimeEnd],
    [input.eventTimeStart, new Date("invalid")],
    [input.eventTimeStart, input.eventTimeStart],
    [input.eventTimeEnd, input.eventTimeStart],
  ])(
    "rejects invalid or non-increasing event bounds %s to %s",
    async (eventTimeStart, eventTimeEnd) => {
      const run = fixture();
      await expect(
        runActivityIntegrityDbtBuild({ ...input, eventTimeStart, eventTimeEnd }, run.client),
      ).rejects.toThrow("activity integrity dbt build requires valid increasing event-time bounds");
      expect(run.phases).toEqual([]);
    },
  );
  it("keeps the event-day string intact for dbt's YAML 1.1 loader", async () => {
    const run = fixture();
    const original = vi.mocked(spawn).getMockImplementation();
    if (!original) throw new Error("Missing fixture spawn");
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      const project = args?.[(args?.indexOf("--project-dir") ?? -1) + 1] ?? "";
      const config: unknown = parse(readFileSync(join(project, "dbt_project.yml"), "utf8"), {
        version: "1.1",
      });
      expect(config).toMatchObject({ vars: { activity_sensor_sample_begin: "2026-09-01" } });
      return original(command, args, options);
    });
    await runActivityIntegrityDbtBuild(input, run.client);
    expect(run.phases).toHaveLength(3);
  });
  it("makes every default project resource discoverable through the private project", async () => {
    const directory = mkdtempSync(join(tmpdir(), "activity-integrity-project-test-"));
    const resourcePaths = {
      "model-paths": "models",
      "macro-paths": "macros",
      "test-paths": "tests",
      "analysis-paths": "analyses",
      "seed-paths": "seeds",
      "snapshot-paths": "snapshots",
    };
    for (const path of Object.values(resourcePaths)) {
      mkdirSync(join(directory, "analytics", path), { recursive: true });
      writeFileSync(join(directory, "analytics", path, "fixture.sql"), `resource:${path}`);
    }
    writeFileSync(
      join(directory, "analytics", "dbt_project.yml"),
      stringify({ name: "fixture", version: "1.0.0", profile: "fixture" }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      const run = fixture();
      const original = vi.mocked(spawn).getMockImplementation();
      if (!original) throw new Error("Missing fixture spawn");
      vi.mocked(spawn).mockImplementation((command, args, options) => {
        const project = args?.[(args?.indexOf("--project-dir") ?? -1) + 1] ?? "";
        const config = z
          .record(z.string(), z.unknown())
          .parse(parse(readFileSync(join(project, "dbt_project.yml"), "utf8")));
        for (const [key, sourcePath] of Object.entries(resourcePaths)) {
          const paths = z.array(z.string()).parse(config[key]);
          expect(paths).toHaveLength(1);
          const mountedPath = join(project, paths[0] ?? "");
          expect(realpathSync(mountedPath)).toBe(
            realpathSync(join(directory, "analytics", sourcePath)),
          );
          expect(readFileSync(join(mountedPath, "fixture.sql"), "utf8")).toBe(
            `resource:${sourcePath}`,
          );
        }
        return original(command, args, options);
      });
      await runActivityIntegrityDbtBuild(input, run.client);
      expect(run.phases).toHaveLength(3);
      expect(run.phases.every((phase) => !existsSync(phase.project))).toBe(true);
    } finally {
      cwd.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("creates an initially absent empty target with an exact empty batch and retained ordinary scope", async () => {
    const run = fixture([]);
    run.state.aliases = [id(1)];
    run.state.targetExists = false;
    await runActivityIntegrityDbtBuild(input, run.client);
    expect(run.phases.map((phase) => phase.selection)).toEqual([
      upstream,
      "activity_step_cadence_rows",
      downstream,
    ]);
    expect(run.phases[1]?.config.vars.activity_step_cadence_repair_activity_ids).toEqual([]);
    expect(run.phases[1]?.config.vars.activity_refresh_activity_ids_base64).toEqual([id(1)]);
    expect(run.state.targetExists).toBe(true);
  });
  it("rejects an empty build that fails to create its target", async () => {
    const run = fixture([]);
    run.state.aliases = [id(1)];
    run.state.targetExists = false;
    run.state.skipTargetCreation = true;
    await expect(runActivityIntegrityDbtBuild(input, run.client)).rejects.toThrow(
      "did not create activity_step_cadence_rows",
    );
    expect(run.phases.map((phase) => phase.selection)).toEqual([
      upstream,
      "activity_step_cadence_rows",
    ]);
  });
  it("propagates a middle batch failure before downstream and removes its private project", async () => {
    const run = fixture(Array.from({ length: 201 }, (_, i) => id(i + 1)));
    run.state.failPhase = 3;
    await expect(runActivityIntegrityDbtBuild(input, run.client)).rejects.toThrow(
      "failed with exit code 2",
    );
    expect(run.phases.map((phase) => phase.selection)).toEqual([
      upstream,
      "activity_step_cadence_rows",
      "activity_step_cadence_rows",
    ]);
    expect(run.state.summaryVersions.size).toBe(0);
    expect(run.phases.every((phase) => !existsSync(phase.project))).toBe(true);
  });
  it.each(["stale", "missing"] as const)(
    "rejects a successful subprocess leaving a %s key without starting summaries",
    async (kind) => {
      const run = fixture();
      run.state.leaveStale.add(id(1));
      if (kind === "missing") run.state.versions.clear();
      await expect(runActivityIntegrityDbtBuild(input, run.client)).rejects.toThrow(
        `missing or stale key ${id(1)}`,
      );
      expect(run.phases.map((phase) => phase.selection)).toEqual([
        upstream,
        "activity_step_cadence_rows",
      ]);
    },
  );
  it.each(["error", "signal", "exit"] as const)(
    "propagates child %s failure and cleans the project",
    async (kind) => {
      const run = fixture();
      if (kind === "error") run.state.errorPhase = 1;
      else if (kind === "signal") run.state.signalPhase = 1;
      else run.state.failPhase = 1;
      await expect(runActivityIntegrityDbtBuild(input, run.client)).rejects.toThrow(
        kind === "error"
          ? "spawn unavailable"
          : `failed with exit code ${kind === "signal" ? 1 : 2}`,
      );
      expect(run.phases).toHaveLength(1);
      expect(run.phases.every((phase) => !existsSync(phase.project))).toBe(true);
    },
  );
  it("transports all10000 IDs privately without oversized argv and preserves event/profile/environment paths", async () => {
    const ids = Array.from({ length: 10000 }, (_, i) => id(i + 1));
    const run = fixture([]);
    run.state.aliases = ids;
    vi.stubEnv("DBT_TARGET", "ci-target");
    vi.stubEnv("UV_PROJECT_ENVIRONMENT", "/tmp/analytics-env");
    const observedPaths: string[] = [];
    const original = vi.mocked(spawn).getMockImplementation();
    if (!original) throw new Error("Missing fixture spawn");
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      const project = args?.[(args?.indexOf("--project-dir") ?? -1) + 1] ?? "";
      const config = configSchema.parse(
        parse(readFileSync(join(project, "dbt_project.yml"), "utf8")),
      );
      observedPaths.push(realpathSync(join(project, config["model-paths"][0] ?? "")));
      expect(command).toBe("uv");
      expect(options?.env).toMatchObject({
        DBT_TARGET: "ci-target",
        UV_PROJECT_ENVIRONMENT: "/tmp/analytics-env",
      });
      return original(command, args, options);
    });
    await runActivityIntegrityDbtBuild({ ...input, activityIds: ids }, run.client);
    expect(run.phases).toHaveLength(3);
    for (const phase of run.phases) {
      expect(phase.config.vars.activity_refresh_activity_ids_base64).toEqual(ids);
      expect(phase.config.vars.activity_refresh_user_id).toBe(input.userId);
      expect(phase.config.vars.activity_sensor_sample_begin).toBe("2026-09-01");
      expect(phase.args[phase.args.indexOf("--event-time-start") + 1]).toBe("2026-09-01T00:00:00");
      expect(phase.args[phase.args.indexOf("--event-time-end") + 1]).toBe("2026-09-08T00:00:00");
      expect(phase.args[phase.args.indexOf("--profiles-dir") + 1]).toBe("analytics");
      expect(phase.args[phase.args.indexOf("--project") + 1]).toBe("analytics");
      expect(Math.max(...phase.args.map((arg) => Buffer.byteLength(arg)))).toBeLessThan(128 * 1024);
      expect(phase.mode).toBe(0o600);
      expect(existsSync(phase.project)).toBe(false);
    }
    expect(new Set(run.phases.map((phase) => phase.project)).size).toBe(1);
    expect(observedPaths).toEqual(run.phases.map(() => realpathSync(resolve("analytics/models"))));
  });
  it("uses the existing environment defaults", async () => {
    vi.stubEnv("DBT_TARGET", undefined);
    vi.stubEnv("UV_PROJECT_ENVIRONMENT", undefined);
    const run = fixture();
    await runActivityIntegrityDbtBuild(input, run.client);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject({
      DBT_TARGET: "dev",
      UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
    });
  });
  it.each([{ activityIds: [] }, { activityIds: ["invalid"] }])(
    "rejects malformed ordinary scope before spawning",
    async ({ activityIds }) => {
      const run = fixture();
      await expect(
        runActivityIntegrityDbtBuild({ ...input, activityIds }, run.client),
      ).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("rejects identity expansion overflow and failure to converge before spawning", async () => {
    const run = fixture([]);
    run.state.aliases = Array.from({ length: 10001 }, (_, i) => id(i + 1));
    await expect(runActivityIntegrityDbtBuild(input, run.client)).rejects.toThrow("exceeded 10000");
    expect(spawn).not.toHaveBeenCalled();
    let iteration = 0;
    const expanding: ActivityIntegrityClickHouseClient = {
      query: async () => ({ json: async () => [{ activity_id: id(++iteration + 1) }] }),
    };
    await expect(runActivityIntegrityDbtBuild(input, expanding)).rejects.toThrow(
      "within 32 iterations",
    );
    expect(iteration).toBe(32);
    expect(spawn).not.toHaveBeenCalled();
  });
});
