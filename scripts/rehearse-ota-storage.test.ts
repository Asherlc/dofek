import { ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("./verify-ota-update.ts", () => ({ verifyOtaUpdate: vi.fn() }));
const originalArguments = process.argv;
const originalExitCode = process.exitCode;
const execute = vi.mocked(execFileSync);
const image = `ghcr.io/asherlc/dofek-ota@sha256:${"a".repeat(64)}`;

beforeEach(() => {
  vi.resetModules();
  process.argv = ["node", "rehearse-ota-storage.ts", "2026-10-29-rehearsal"];
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: "Asherlc/dofek",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    OTA_REHEARSAL_IMAGE: image,
    EXPO_APP_ID: "test-app",
    EXPO_TOKEN: "test-token",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    OTA_JWT_SECRET: "test-jwt",
    OTA_PRIVATE_KEY_B64: "test-private",
    OTA_PUBLIC_KEY_B64: "test-public",
  }))
    vi.stubEnv(key, value);
  execute.mockReset();
  execute.mockImplementation((_file, args) => {
    const command = z.array(z.string()).parse(args).join(" ");
    if (command.includes("verify-migration"))
      return JSON.stringify({ id: "retained-id", runtimeVersion: "current-runtime" });
    return "";
  });
  vi.mocked(verifyOtaUpdate).mockReset().mockResolvedValue("retained-id");
  vi.mocked(spawnSync)
    .mockReset()
    .mockReturnValue({ pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null });
  vi.mocked(spawn)
    .mockReset()
    .mockImplementation(() => {
      const child = new ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      vi.spyOn(child, "kill").mockReturnValue(true);
      queueMicrotask(() =>
        child.stderr?.emit("data", Buffer.from("Server is ready to serve traffic.\n")),
      );
      return child;
    });
});
afterEach(() => {
  process.exitCode = originalExitCode;
  process.argv = originalArguments;
  vi.unstubAllEnvs();
});

describe("CI OTA migration rehearsal", () => {
  it("rejects an image outside the reviewed private package", async () => {
    vi.stubEnv("OTA_REHEARSAL_IMAGE", "untrusted/image:latest");
    await expect(import("./rehearse-ota-storage.ts")).rejects.toThrow("immutable");
    expect(execute).not.toHaveBeenCalled();
  });
  it("runs migration only against the isolated copy, then verifies restore and unchanged production", async () => {
    await import("./rehearse-ota-storage.ts");
    const start = execute.mock.calls.find(
      ([file, args]) => file === "docker" && z.array(z.string()).parse(args).includes("--detach"),
    );
    const environment = z
      .object({
        env: z.object({
          S3_BUCKET_NAME: z.string(),
          BUCKET_KEY_PREFIX: z.string(),
          CACHE_MODE: z.string(),
        }),
      })
      .parse(start?.[2]).env;
    expect(environment.S3_BUCKET_NAME).toBe("dofek-ota-backups");
    expect(environment.BUCKET_KEY_PREFIX).toBe("rehearsals/2026-10-29-rehearsal/");
    expect(environment.CACHE_MODE).toBe("local");
    const operations = execute.mock.calls
      .filter(([file]) => file === "pnpm")
      .map(([, args]) => z.array(z.string()).parse(args)[2]);
    expect(operations).toEqual([
      "verify-snapshot",
      "verify-rehearsal",
      "verify-migration",
      "restore-rehearsal",
      "verify-snapshot",
    ]);
    expect(verifyOtaUpdate).toHaveBeenCalledTimes(2);
    expect(verifyOtaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ expectedId: "retained-id", runtimeVersion: "current-runtime" }),
    );
  });
  it("stops the candidate before propagating a failed signature/asset audit", async () => {
    vi.mocked(verifyOtaUpdate).mockRejectedValue(new Error("audit failed"));
    await expect(import("./rehearse-ota-storage.ts")).rejects.toThrow("audit failed");
    const commands = vi
      .mocked(spawnSync)
      .mock.calls.map(([, args]) => z.array(z.string()).parse(args));
    expect(commands.some((args) => args[0] === "stop")).toBe(true);
    expect(commands.some((args) => args[0] === "rm")).toBe(true);
  });

  it("refuses restore if the candidate cannot be stopped", async () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "stop failed",
      status: 1,
      signal: null,
    });
    await expect(import("./rehearse-ota-storage.ts")).rejects.toThrow("quiesce");
    const operations = execute.mock.calls
      .filter(([file]) => file === "pnpm")
      .map(([, args]) => z.array(z.string()).parse(args)[2]);
    expect(operations).toEqual(["verify-snapshot", "verify-rehearsal", "verify-migration"]);
  });
  it("fails if the candidate exits before reporting migration readiness", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });
    await expect(import("./rehearse-ota-storage.ts")).rejects.toThrow("before migration readiness");
    expect(verifyOtaUpdate).not.toHaveBeenCalled();
  });
  it("refuses to launch against a dirty or previously migrated rehearsal copy", async () => {
    execute.mockImplementation((_file, args) => {
      if (z.array(z.string()).parse(args).includes("verify-rehearsal"))
        throw new Error("copy differs from original snapshot");
      return "";
    });
    await expect(import("./rehearse-ota-storage.ts")).rejects.toThrow("copy differs");
    expect(
      execute.mock.calls.some(
        ([file, args]) => file === "docker" && z.array(z.string()).parse(args).includes("--detach"),
      ),
    ).toBe(false);
  });
});
