import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listComposeContainers } from "./compose-container-inventory.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => {
  vi.mocked(spawnSync).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listComposeContainers", () => {
  it("reads Compose containers with the stock docker ps label filter and JSON template", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [null, "", ""],
      stdout: `${JSON.stringify({
        name: "demo-db-1",
        project: "demo",
        directory: "/worktrees/demo",
        configFiles: "/worktrees/demo/docker-compose.yml,/worktrees/demo/docker-compose.peerdb.yml",
      })}\n`,
      stderr: "",
      status: 0,
      signal: null,
    });

    expect(listComposeContainers()).toEqual([
      {
        name: "demo-db-1",
        project: "demo",
        directory: "/worktrees/demo",
        configFiles: "/worktrees/demo/docker-compose.yml,/worktrees/demo/docker-compose.peerdb.yml",
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith(
      "docker",
      [
        "ps",
        "--all",
        "--filter",
        "label=com.docker.compose.project",
        "--format",
        expect.stringContaining("com.docker.compose.project.working_dir"),
      ],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("preserves docker CLI failures instead of treating them as an empty inventory", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [null, "", "cannot connect"],
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      status: 1,
      signal: null,
    });

    expect(() => listComposeContainers()).toThrow(/Compose inventory exited with status 1/);
  });

  it("tolerates empty working-directory and config-file labels on inventory rows", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [null, "", ""],
      stdout: `${JSON.stringify({
        name: "other-redis-1",
        project: "other",
        directory: "",
        configFiles: "",
      })}\n`,
      stderr: "",
      status: 0,
      signal: null,
    });

    expect(listComposeContainers()).toEqual([
      {
        name: "other-redis-1",
        project: "other",
        directory: "",
        configFiles: "",
      },
    ]);
  });

  it("rejects inventory rows that omit required Compose identity fields", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1,
      output: [null, "", ""],
      stdout: `${JSON.stringify({ name: "broken", directory: "/worktrees/demo" })}\n`,
      stderr: "",
      status: 0,
      signal: null,
    });

    expect(() => listComposeContainers()).toThrow(/failed validation/);
  });
});
