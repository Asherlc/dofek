import { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runActivityIntegrityDbtBuild } from "./activity-data-integrity-dbt.ts";

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: vi.fn(),
}));

describe("runActivityIntegrityDbtBuild", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("rebuilds identity evidence after canonical membership and before activity summaries", async () => {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const build = runActivityIntegrityDbtBuild({
      userId: "00000000-0000-4000-8000-000000000001",
      activityIds: ["00000000-0000-4000-8000-000000000002"],
      eventTimeStart: new Date("2026-09-01T00:00:00.000Z"),
      eventTimeEnd: new Date("2026-09-08T00:00:00.000Z"),
    });
    const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
    const selection = args[args.indexOf("--select") + 1] ?? "";

    expect(selection).toContain(
      "deduped_activity_members activity_effort_identity activity_sensor_sample activity_location_sample",
    );
    expect(selection).toContain(
      "activity_sensor_sample activity_location_sample activity_sensor_summary_rows activity_location_summary_rows activity_stream_points activity_summary_rows activity_vo2max_estimate",
    );
    child.emit("close", 0);
    await expect(build).resolves.toBeUndefined();
  });

  it("passes the bounded scope and caller environment to dbt", async () => {
    vi.stubEnv("DBT_TARGET", "ci-target");
    vi.stubEnv("UV_PROJECT_ENVIRONMENT", "/tmp/analytics-env");
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const build = runActivityIntegrityDbtBuild({
      userId: "00000000-0000-4000-8000-000000000001",
      activityIds: ["00000000-0000-4000-8000-000000000002"],
      eventTimeStart: new Date("2026-09-01T00:00:00.000Z"),
      eventTimeEnd: new Date("2026-09-08T00:00:00.000Z"),
    });
    const call = vi.mocked(spawn).mock.calls[0];
    const args = call?.[1] ?? [];
    const variables = JSON.parse(args[args.indexOf("--vars") + 1] ?? "null");

    expect(call?.[0]).toBe("uv");
    expect(args[args.indexOf("--event-time-start") + 1]).toBe("2026-09-01T00:00:00");
    expect(args[args.indexOf("--event-time-end") + 1]).toBe("2026-09-08T00:00:00");
    expect(variables).toEqual({
      activity_refresh_user_id: "00000000-0000-4000-8000-000000000001",
      activity_refresh_activity_ids: ["00000000-0000-4000-8000-000000000002"],
      activity_sensor_sample_begin: "2026-09-01",
    });
    expect(call?.[2]).toMatchObject({
      cwd: process.cwd(),
      env: {
        DBT_TARGET: "ci-target",
        UV_PROJECT_ENVIRONMENT: "/tmp/analytics-env",
      },
      stdio: "inherit",
    });

    child.emit("close", 0);
    await expect(build).resolves.toBeUndefined();
  });

  it("uses the dbt environment defaults when the caller does not provide them", async () => {
    const priorTarget = process.env.DBT_TARGET;
    const priorUvEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
    delete process.env.DBT_TARGET;
    delete process.env.UV_PROJECT_ENVIRONMENT;
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    try {
      const build = runActivityIntegrityDbtBuild({
        userId: "00000000-0000-4000-8000-000000000001",
        activityIds: ["00000000-0000-4000-8000-000000000002"],
        eventTimeStart: new Date("2026-09-01T00:00:00.000Z"),
        eventTimeEnd: new Date("2026-09-08T00:00:00.000Z"),
      });
      expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject({
        DBT_TARGET: "dev",
        UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
      });
      child.emit("close", 0);
      await expect(build).resolves.toBeUndefined();
    } finally {
      if (priorTarget === undefined) delete process.env.DBT_TARGET;
      else process.env.DBT_TARGET = priorTarget;
      if (priorUvEnvironment === undefined) delete process.env.UV_PROJECT_ENVIRONMENT;
      else process.env.UV_PROJECT_ENVIRONMENT = priorUvEnvironment;
    }
  });

  it("treats a signal close without an exit code as a failed build", async () => {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const build = runActivityIntegrityDbtBuild({
      userId: "00000000-0000-4000-8000-000000000001",
      activityIds: ["00000000-0000-4000-8000-000000000002"],
      eventTimeStart: new Date("2026-09-01T00:00:00.000Z"),
      eventTimeEnd: new Date("2026-09-08T00:00:00.000Z"),
    });
    child.emit("close", null);

    await expect(build).rejects.toThrow("failed with exit code 1");
  });

  it("rejects a non-zero dbt exit code", async () => {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValue(child);

    const build = runActivityIntegrityDbtBuild({
      userId: "00000000-0000-4000-8000-000000000001",
      activityIds: ["00000000-0000-4000-8000-000000000002"],
      eventTimeStart: new Date("2026-09-01T00:00:00.000Z"),
      eventTimeEnd: new Date("2026-09-08T00:00:00.000Z"),
    });
    child.emit("close", 2);

    await expect(build).rejects.toThrow("failed with exit code 2");
  });
});
