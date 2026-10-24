import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureMobilePreviewChannel } from "./ensure-mobile-preview-channel.ts";

const channel = "pr-3060";
const mapping = { currentPage: { name: channel, updateBranches: [{ name: channel }] } };

function options(results: unknown[]) {
  return {
    channel,
    projectId: "00000000-0000-4000-8000-000000000001",
    expoToken: "test-token",
    runCommand: vi.fn((_args: string[], _cwd: string, _environment: NodeJS.ProcessEnv) => ({
      status: 0,
      stdout: JSON.stringify(results.shift()),
      stderr: "",
    })),
  };
}

describe("ensureMobilePreviewChannel", () => {
  it("keeps an existing channel mapped to its PR branch", async () => {
    const input = options([{ currentPage: [{ name: channel }] }, mapping]);
    await expect(ensureMobilePreviewChannel(input)).resolves.toBe("existing");
    expect(input.runCommand.mock.calls.map(([args]) => args[2])).toEqual([
      "channel:list",
      "channel:view",
    ]);
  });

  it("creates and verifies a missing channel through an isolated EAS project", async () => {
    const input = options([{ currentPage: [] }, { name: channel }, mapping]);
    const directories: string[] = [];
    const run = input.runCommand.getMockImplementation();
    if (!run) throw new Error("Missing test runner");
    input.runCommand.mockImplementation((args, cwd, environment) => {
      directories.push(cwd);
      expect(environment.EXPO_TOKEN).toBe("test-token");
      expect(JSON.parse(readFileSync(join(cwd, "app.json"), "utf8")).expo.extra.eas.projectId).toBe(
        input.projectId,
      );
      return run(args, cwd, environment);
    });
    await expect(ensureMobilePreviewChannel(input)).resolves.toBe("created");
    expect(input.runCommand.mock.calls.map(([args]) => args[2])).toEqual([
      "channel:list",
      "channel:create",
      "channel:view",
    ]);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);
  });

  it("paginates channel names before deciding to create", async () => {
    const input = options([
      { currentPage: Array.from({ length: 25 }, (_, index) => ({ name: `pr-${index}` })) },
      { currentPage: [{ name: channel }] },
      mapping,
    ]);
    await expect(ensureMobilePreviewChannel(input)).resolves.toBe("existing");
    expect(input.runCommand.mock.calls[1]?.[0]).toContain("25");
    expect(input.runCommand.mock.calls.map(([args]) => args[2])).toEqual([
      "channel:list",
      "channel:list",
      "channel:view",
    ]);
  });

  it("refuses a channel mapped to another branch", async () => {
    const input = options([
      { currentPage: [{ name: channel }] },
      { currentPage: { name: channel, updateBranches: [{ name: "main" }] } },
    ]);
    await expect(ensureMobilePreviewChannel(input)).rejects.toThrow("not mapped exclusively");
  });

  it("fails on CLI errors without attempting creation and removes its temporary directory", async () => {
    const input = options([]);
    let directory = "";
    input.runCommand.mockImplementation((_args, cwd) => {
      directory = cwd;
      return { status: 1, stdout: "", stderr: "permission denied" };
    });
    await expect(ensureMobilePreviewChannel(input)).rejects.toThrow("permission denied");
    expect(input.runCommand).toHaveBeenCalledTimes(1);
    expect(existsSync(directory)).toBe(false);
  });

  it("requires a confirmed mapping after channel creation", async () => {
    await expect(
      ensureMobilePreviewChannel(
        options([
          { currentPage: [] },
          { name: channel },
          { currentPage: { name: channel, updateBranches: [] } },
        ]),
      ),
    ).rejects.toThrow("not mapped exclusively");
  });

  it.each(["production", "pr-", "pr-3060/other"])("rejects non-PR channel %s", async (name) => {
    const input = { ...options([]), channel: name };
    await expect(ensureMobilePreviewChannel(input)).rejects.toThrow("pr-<number>");
    expect(input.runCommand).not.toHaveBeenCalled();
  });

  it.each(["projectId", "expoToken"] as const)(
    "fails on missing %s before commands",
    async (key) => {
      const input = { ...options([]), [key]: "" };
      await expect(ensureMobilePreviewChannel(input)).rejects.toThrow(
        key === "projectId" ? "EXPO_APP_ID" : "EXPO_TOKEN",
      );
      expect(input.runCommand).not.toHaveBeenCalled();
    },
  );
});
