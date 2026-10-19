import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const workspaceDirectory = realpathSync(process.cwd());

beforeEach(() => {
  vi.resetModules();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  });
  vi.stubEnv("PWD", "/another/workspace");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("workspace archive", () => {
  it("tears down every workspace stack with its profiles, orphans, and volumes", async () => {
    await import("./workspace-archive.ts");

    const defaultFiles = ["-f", "docker-compose.yml", "-f", "docker-compose.peerdb.yml"];
    const shutdown = ["--profile", "*", "down", "--remove-orphans", "--volumes"];
    expect(vi.mocked(spawnSync).mock.calls).toEqual(
      [
        ["compose", "--", ...defaultFiles, ...shutdown],
        ["compose", "--", "--project-suffix", "e2e", "-f", "docker-compose.e2e.yml", ...shutdown],
        ["compose", "--", "--project-suffix", "peerdb-integration", ...defaultFiles, ...shutdown],
      ].map((arguments_) => [
        "pnpm",
        arguments_,
        {
          cwd: workspaceDirectory,
          env: expect.objectContaining({ PWD: workspaceDirectory }),
          stdio: "inherit",
        },
      ]),
    );
  });

  it("reports a failed shutdown instead of allowing archive to appear successful", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 23,
      signal: null,
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow("exited with status 23");
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing command prerequisite", async () => {
    const error = new Error("spawn pnpm ENOENT");
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error,
    });

    await expect(import("./workspace-archive.ts")).rejects.toBe(error);
  });

  it("reports an interrupted shutdown as a failure", async () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow("SIGTERM");
  });
});
