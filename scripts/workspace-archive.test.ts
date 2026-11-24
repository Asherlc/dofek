import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const workspaceDirectory = realpathSync(process.cwd());
const workspaceProject = basename(workspaceDirectory);
const defaultFiles = ["-f", "docker-compose.yml", "-f", "docker-compose.peerdb.yml"];
const shutdown = ["--profile", "*", "down", "--remove-orphans", "--volumes"];
const stringArgumentsSchema = z.array(z.string());

type InventoryRow = {
  configFiles: string;
  directory: string;
  name: string;
  project: string;
};

function successResult(stdout = "") {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  };
}

function inventoryLines(rows: InventoryRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

function isInventoryCall(arguments_: readonly string[]): boolean {
  return (
    arguments_[0] === "ps" &&
    arguments_.includes("--filter") &&
    arguments_.includes("label=com.docker.compose.project")
  );
}

function spawnArguments(arguments_: unknown): string[] {
  return stringArgumentsSchema.parse(arguments_ ?? []);
}

function mockArchiveInventory(options: {
  afterShutdown?: InventoryRow[];
  beforeShutdown?: InventoryRow[];
  shutdownStatus?: number;
}) {
  let inventoryPass = 0;
  vi.mocked(spawnSync).mockImplementation((command, arguments_) => {
    const args = spawnArguments(arguments_);
    if (command === "docker" && isInventoryCall(args)) {
      inventoryPass += 1;
      const rows =
        inventoryPass === 1 ? (options.beforeShutdown ?? []) : (options.afterShutdown ?? []);
      return successResult(inventoryLines(rows));
    }
    if (command === "pnpm") {
      return {
        ...successResult(),
        status: options.shutdownStatus ?? 0,
      };
    }
    return successResult();
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.mocked(spawnSync).mockReset();
  mockArchiveInventory({});
  vi.stubEnv("PWD", "/another/workspace");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("workspace archive", () => {
  it("tears down every workspace stack with its profiles, orphans, and volumes", async () => {
    await import("./workspace-archive.ts");

    const pnpmCalls = vi
      .mocked(spawnSync)
      .mock.calls.filter(([command]) => command === "pnpm")
      .map(([, arguments_, options]) => [commandCall("pnpm", spawnArguments(arguments_)), options]);

    expect(pnpmCalls).toEqual(
      [
        ["compose", "--", ...defaultFiles, ...shutdown],
        ["compose", "--", "--project-suffix", "e2e", "-f", "docker-compose.e2e.yml", ...shutdown],
        ["compose", "--", "--project-suffix", "peerdb-integration", ...defaultFiles, ...shutdown],
      ].map((arguments_) => [
        ["pnpm", arguments_],
        {
          cwd: workspaceDirectory,
          env: expect.objectContaining({ PWD: workspaceDirectory }),
          stdio: "inherit",
        },
      ]),
    );
  });

  it("discovers and tears down owned custom suffix projects with recorded Compose files", async () => {
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: `${workspaceProject}-fly-provider-queue-redis-1`,
          project: `${workspaceProject}-fly-provider-queue`,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
        {
          name: `${workspaceProject}-db-1`,
          project: workspaceProject,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
      ],
    });

    await import("./workspace-archive.ts");

    const pnpmArgumentLists = vi
      .mocked(spawnSync)
      .mock.calls.filter(([command]) => command === "pnpm")
      .map(([, arguments_]) => spawnArguments(arguments_));

    expect(pnpmArgumentLists).toContainEqual([
      "compose",
      "--",
      "--project-suffix",
      "fly-provider-queue",
      "-f",
      `${workspaceDirectory}/docker-compose.yml`,
      ...shutdown,
    ]);
  });

  it("rejects custom projects with conflicting recorded Compose config file lists", async () => {
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: `${workspaceProject}-custom-redis-1`,
          project: `${workspaceProject}-custom`,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
        {
          name: `${workspaceProject}-custom-worker-1`,
          project: `${workspaceProject}-custom`,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.e2e.yml`,
        },
      ],
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow(
      new RegExp(`${workspaceProject}-custom.*(config|conflict|Compose file)`, "i"),
    );
    expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === "pnpm")).toBe(false);
  });

  it("fails closed when a targeted Compose project is shared with another directory", async () => {
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: `${workspaceProject}-db-1`,
          project: workspaceProject,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
        {
          name: `${workspaceProject}-collision-1`,
          project: workspaceProject,
          directory: `${workspaceDirectory}-neighbor`,
          configFiles: `${workspaceDirectory}-neighbor/docker-compose.yml`,
        },
      ],
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow(
      /shared across directories|collision/i,
    );
    expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === "pnpm")).toBe(false);
  });

  it("fails closed when a targeted Compose project has an empty working-directory label", async () => {
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: `${workspaceProject}-db-1`,
          project: workspaceProject,
          directory: "",
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
      ],
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow(
      /indeterminate|working.directory|ownership/i,
    );
    expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === "pnpm")).toBe(false);
  });

  it("ignores unrelated Compose rows with empty working-directory labels", async () => {
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: "other-redis-1",
          project: "other",
          directory: "",
          configFiles: "",
        },
      ],
    });

    await import("./workspace-archive.ts");

    expect(vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "pnpm")).toHaveLength(
      3,
    );
  });

  it("does not claim ownership of same-prefix projects from a neighboring workspace", async () => {
    const neighborDirectory = `${workspaceDirectory}-neighbor`;
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: `${workspaceProject}-neighbor-db-1`,
          project: `${workspaceProject}-neighbor`,
          directory: neighborDirectory,
          configFiles: `${neighborDirectory}/docker-compose.yml`,
        },
      ],
    });

    await import("./workspace-archive.ts");

    const pnpmArgumentLists = vi
      .mocked(spawnSync)
      .mock.calls.filter(([command]) => command === "pnpm")
      .map(([, arguments_]) => spawnArguments(arguments_));

    expect(pnpmArgumentLists).toHaveLength(3);
    expect(
      pnpmArgumentLists.some((arguments_) => arguments_.includes(`${workspaceProject}-neighbor`)),
    ).toBe(false);
    expect(pnpmArgumentLists.some((arguments_) => arguments_.includes("neighbor"))).toBe(false);
  });

  it("errors with remaining owned project and container names after an incomplete shutdown", async () => {
    mockArchiveInventory({
      beforeShutdown: [
        {
          name: `${workspaceProject}-custom-redis-1`,
          project: `${workspaceProject}-custom`,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
      ],
      afterShutdown: [
        {
          name: `${workspaceProject}-custom-redis-1`,
          project: `${workspaceProject}-custom`,
          directory: workspaceDirectory,
          configFiles: `${workspaceDirectory}/docker-compose.yml`,
        },
      ],
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow(
      new RegExp(`${workspaceProject}-custom.*${workspaceProject}-custom-redis-1`, "s"),
    );
  });

  it("reports a failed shutdown instead of allowing archive to appear successful", async () => {
    mockArchiveInventory({ shutdownStatus: 23 });

    await expect(import("./workspace-archive.ts")).rejects.toThrow("exited with status 23");
    expect(vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "pnpm")).toHaveLength(
      1,
    );
  });

  it("surfaces a missing command prerequisite", async () => {
    const error = new Error("spawn pnpm ENOENT");
    vi.mocked(spawnSync).mockImplementation((command, arguments_) => {
      const args = spawnArguments(arguments_);
      if (command === "docker" && isInventoryCall(args)) {
        return successResult("");
      }
      return {
        pid: 0,
        output: [],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error,
      };
    });

    await expect(import("./workspace-archive.ts")).rejects.toBe(error);
  });

  it("reports an interrupted shutdown as a failure", async () => {
    vi.mocked(spawnSync).mockImplementation((command, arguments_) => {
      const args = spawnArguments(arguments_);
      if (command === "docker" && isInventoryCall(args)) {
        return successResult("");
      }
      return {
        pid: 1,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: "SIGTERM",
      };
    });

    await expect(import("./workspace-archive.ts")).rejects.toThrow("SIGTERM");
  });
});

function commandCall(command: string, arguments_: string[]): [string, string[]] {
  return [command, arguments_];
}
