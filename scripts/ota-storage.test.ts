import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const execute = vi.mocked(execFileSync);
const originalArguments = process.argv;
const snapshot = "2026-10-29-rehearsal";
let existingObjects: unknown[];
let workflowState: string;
let activeRuns: number;
let failCommand: string | undefined;
let sourceCount: number;

beforeEach(() => {
  vi.resetModules();
  existingObjects = [];
  workflowState = "disabled_manually";
  activeRuns = 0;
  failCommand = undefined;
  sourceCount = 10;
  process.argv = ["node", "ota-storage.ts", "snapshot", snapshot];
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: "Asherlc/dofek",
    GH_TOKEN: "test-token",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
  }))
    vi.stubEnv(key, value);
  execute.mockReset();
  execute.mockImplementation((_file, args) => {
    const command = z.array(z.string()).parse(args).join(" ");
    if (failCommand && command.includes(failCommand)) throw new Error("transfer failed");
    if (_file === "gh") {
      if (command.includes("/runs?")) return JSON.stringify({ total_count: activeRuns });
      return JSON.stringify({ state: workflowState });
    }
    if (command.includes("lsjson")) return JSON.stringify(existingObjects);
    if (command.includes("size")) return JSON.stringify({ count: sourceCount, bytes: 100 });
    return "";
  });
});
afterEach(() => {
  process.argv = originalArguments;
  vi.unstubAllEnvs();
});

function transfers(): string[][] {
  return execute.mock.calls
    .filter(([file]) => file === "docker")
    .map(([, args]) => z.array(z.string()).parse(args));
}

describe("OTA storage operator CLI", () => {
  it.each(["../production", "", "a/b", "UPPERCASE-ID"])(
    "rejects unsafe snapshot ID %j",
    async (id) => {
      process.argv[3] = id;
      await expect(import("./ota-storage.ts")).rejects.toThrow("snapshot ID");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("refuses an enabled publisher before accessing storage", async () => {
    workflowState = "active";
    await expect(import("./ota-storage.ts")).rejects.toThrow("must be disabled");
    expect(transfers()).toEqual([]);
  });

  it("refuses outstanding publisher or cleanup runs", async () => {
    activeRuns = 1;
    await expect(import("./ota-storage.ts")).rejects.toThrow("still has");
    expect(transfers()).toEqual([]);
  });

  it("refuses to overwrite a snapshot", async () => {
    existingObjects = [{ Path: "main/update" }];
    await expect(import("./ota-storage.ts")).rejects.toThrow("must be empty");
    expect(transfers()).toHaveLength(2);
  });

  it("refuses an empty source before a destructive rehearsal restore", async () => {
    sourceCount = 0;
    process.argv[2] = "restore-rehearsal";
    await expect(import("./ota-storage.ts")).rejects.toThrow("Source must contain objects");
    expect(transfers()).toHaveLength(1);
  });

  it("copies production to a fresh snapshot and verifies every byte", async () => {
    await import("./ota-storage.ts");
    const commands = transfers();
    expect(commands).toHaveLength(4);
    expect(commands[2]?.slice(-4)).toEqual([
      "copy",
      "ota:dofek-ota",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "--immutable",
    ]);
    expect(commands[3]?.slice(-4)).toEqual([
      "check",
      "ota:dofek-ota",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "--download",
    ]);
    expect(JSON.stringify(commands)).not.toContain("test-secret");
  });

  it.each([" copy ", " check "])("fails closed when %s fails", async (command) => {
    failCommand = command;
    await expect(import("./ota-storage.ts")).rejects.toThrow("transfer failed");
    expect(transfers()).toHaveLength(command.includes("copy") ? 3 : 4);
  });

  it("creates the rehearsal only from the immutable snapshot", async () => {
    process.argv[2] = "rehearsal-copy";
    await import("./ota-storage.ts");
    expect(transfers()[2]?.slice(-4)).toEqual([
      "copy",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      `ota:dofek-ota-backups/rehearsals/${snapshot}`,
      "--immutable",
    ]);
  });

  it("proves production still matches the snapshot without writing either", async () => {
    process.argv[2] = "verify-snapshot";
    await import("./ota-storage.ts");
    expect(transfers()).toHaveLength(2);
    expect(transfers()[1]?.slice(-4)).toEqual([
      "check",
      "ota:dofek-ota",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "--download",
    ]);
  });

  it("rehearses restore with sync and byte verification, without targeting production", async () => {
    process.argv[2] = "restore-rehearsal";
    await import("./ota-storage.ts");
    expect(transfers()[1]?.slice(-3)).toEqual([
      "sync",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      `ota:dofek-ota-backups/rehearsals/${snapshot}`,
    ]);
    expect(transfers().flat()).not.toContain("ota:dofek-ota");
    expect(transfers()[2]?.at(-1)).toBe("--download");
  });
});
