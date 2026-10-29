import { execFileSync } from "node:child_process";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const execute = vi.mocked(execFileSync);
const originalArguments = process.argv;
const snapshot = "2026-10-29-rehearsal";
let existingObjects: unknown[];
let workflowState: string;
let activeRuns: number;
let activeStatus: string;
let failCommand: string | undefined;
let sourceCount: number;
let sourcePaths: string[];
let migratedPaths: string[];
let otaReplicas: number;
let otaTaskStates: string[];
let snapshotReceipt: unknown;
const github = setupServer(
  http.get("https://api.github.com/repos/Asherlc/dofek/actions/workflows/:workflow", () =>
    HttpResponse.json({ state: workflowState }),
  ),
  http.get(
    "https://api.github.com/repos/Asherlc/dofek/actions/workflows/:workflow/runs",
    ({ request }) =>
      HttpResponse.json({
        total_count:
          new URL(request.url).searchParams.get("status") === activeStatus ? activeRuns : 0,
      }),
  ),
);
beforeAll(() => github.listen({ onUnhandledRequest: "error" }));
afterAll(() => github.close());

beforeEach(() => {
  vi.resetModules();
  existingObjects = [];
  workflowState = "disabled_manually";
  activeRuns = 0;
  activeStatus = "queued";
  failCommand = undefined;
  sourceCount = 10;
  otaReplicas = 0;
  otaTaskStates = ["shutdown", "complete"];
  snapshotReceipt = { version: 1, snapshotId: snapshot, count: 10, bytes: 100, runId: "1234" };
  vi.stubEnv("OTA_DOCKER_CONTEXT", "production-readonly");
  vi.stubEnv("GITHUB_RUN_ID", "1234");
  vi.stubEnv("ORACLE_SERVER_HOST", "production.example.invalid");
  sourcePaths = [
    "main/runtime-current/123/.check",
    "main/runtime-current/123/update-metadata.json",
    "main/runtime-current/123/assets/bundle",
  ];
  migratedPaths = [...sourcePaths.map((path) => `example-app/${path}`), ".migrationhistory"];
  process.argv = ["node", "ota-storage.ts", "snapshot", snapshot];
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: "Asherlc/dofek",
    GH_TOKEN: "test-token",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    EXPO_APP_ID: "example-app",
    OTA_REHEARSAL_STOPPED: "true",
  }))
    vi.stubEnv(key, value);
  execute.mockReset();
  execute.mockImplementation((_file, args) => {
    const command = z.array(z.string()).parse(args).join(" ");
    if (failCommand && command.includes(failCommand)) throw new Error("transfer failed");
    if (command.includes("context inspect"))
      return JSON.stringify([
        { Endpoints: { docker: { Host: "ssh://ubuntu@production.example.invalid" } } },
      ]);
    if (command.includes(" service inspect "))
      return JSON.stringify([{ Spec: { Mode: { Replicated: { Replicas: otaReplicas } } } }]);
    if (command.includes(" service ps "))
      return otaTaskStates.map((_, i) => `task-${i}`).join("\n");
    if (command.includes(" inspect --type task "))
      return JSON.stringify(
        otaTaskStates.map((State, i) => ({ ID: `task-${i}`, Status: { State } })),
      );
    if (command.includes("lsjson")) {
      if (["verify-migration", "verify-production-migration"].includes(process.argv[2] ?? ""))
        return JSON.stringify(
          (command.includes("/snapshots/") ? sourcePaths : migratedPaths).map((Path) => ({ Path })),
        );
      return JSON.stringify(existingObjects);
    }
    if (command.includes(" cat ") && command.includes(".verified.json"))
      return JSON.stringify(snapshotReceipt);
    if (command.includes(" cat "))
      return JSON.stringify({ platform: "ios", updateUUID: "retained-id" });
    if (command.includes("size")) return JSON.stringify({ count: sourceCount, bytes: 100 });
    return "";
  });
});
afterEach(() => {
  github.resetHandlers();
  process.argv = originalArguments;
  vi.unstubAllEnvs();
});

function transfers(): string[][] {
  return execute.mock.calls
    .filter(([file]) => file === "docker")
    .map(([, args]) => z.array(z.string()).parse(args));
}

describe("OTA storage operator CLI", () => {
  it("requires confirmation of candidate shutdown before an explicit rehearsal restore", async () => {
    process.argv[2] = "restore-rehearsal";
    vi.stubEnv("OTA_REHEARSAL_STOPPED", "false");
    await expect(import("./ota-storage.ts")).rejects.toThrow(
      "Confirm the rehearsal candidate has stopped",
    );
    expect(transfers()).toEqual([]);
  });
  it.each([
    null,
    { version: 1, snapshotId: "another-snapshot", count: 10, bytes: 100, runId: "1234" },
    { version: 1, snapshotId: snapshot, count: 9, bytes: 100, runId: "1234" },
  ])("refuses an uncertified or changed snapshot before production restore", async (receipt) => {
    process.argv[2] = "restore-production";
    snapshotReceipt = receipt;
    await expect(import("./ota-storage.ts")).rejects.toThrow();
    expect(transfers().some((args) => args.includes("sync"))).toBe(false);
  });

  it("writes the locked verification receipt only after successful snapshot byte comparison", async () => {
    await import("./ota-storage.ts");
    const receipt = execute.mock.calls.find(([, args]) =>
      z.array(z.string()).parse(args).includes("rcat"),
    );
    expect(receipt).toBeDefined();
    expect(receipt?.[1]).toContain(`ota:dofek-ota-backups/snapshots/${snapshot}.verified.json`);
    expect(JSON.parse(z.object({ input: z.string() }).parse(receipt?.[2]).input)).toEqual(
      snapshotReceipt,
    );
    const checkIndex = execute.mock.calls.findIndex(([, args]) =>
      z.array(z.string()).parse(args).includes("check"),
    );
    const receiptIndex = execute.mock.calls.findIndex(([, args]) =>
      z.array(z.string()).parse(args).includes("rcat"),
    );
    expect(receiptIndex).toBeGreaterThan(checkIndex);
  });
  it("restores production from a nonempty snapshot only after inspecting quiescence", async () => {
    process.argv[2] = "restore-production";
    await import("./ota-storage.ts");
    const commands = transfers();
    expect(commands[1]).toEqual([
      "--context",
      "production-readonly",
      "service",
      "inspect",
      "dofek_ota",
    ]);
    expect(commands.some((args) => args.includes("task-0") && args.includes("task-1"))).toBe(true);
    const sync = commands.find((args) => args.includes("sync"));
    expect(sync?.slice(-3)).toEqual([
      "sync",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "ota:dofek-ota",
    ]);
    expect(commands.at(-1)?.slice(-4)).toEqual([
      "check",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "ota:dofek-ota",
      "--download",
    ]);
  });

  it("rejects a Docker context pointing at a different host", async () => {
    process.argv[2] = "restore-production";
    vi.stubEnv("ORACLE_SERVER_HOST", "other.example.invalid");
    await expect(import("./ota-storage.ts")).rejects.toThrow("production Docker endpoint");
    expect(transfers().some((args) => args.includes("run"))).toBe(false);
  });

  it("requires backup provenance before accessing storage", async () => {
    vi.stubEnv("GITHUB_RUN_ID", "");
    await expect(import("./ota-storage.ts")).rejects.toThrow("GITHUB_RUN_ID is required");
    expect(transfers()).toEqual([]);
  });

  it.each([
    "new",
    "pending",
    "assigned",
    "accepted",
    "preparing",
    "ready",
    "starting",
    "running",
    "orphaned",
  ])("refuses production restore while an OTA task is %s", async (state) => {
    process.argv[2] = "restore-production";
    otaTaskStates = ["shutdown", state];
    await expect(import("./ota-storage.ts")).rejects.toThrow("tasks must be stopped");
    expect(transfers().some((args) => args.includes("run"))).toBe(false);
  });

  it("refuses production restore while the service can schedule tasks", async () => {
    process.argv[2] = "restore-production";
    otaReplicas = 1;
    await expect(import("./ota-storage.ts")).rejects.toThrow("zero replicas");
    expect(transfers().some((args) => args.includes("run"))).toBe(false);
  });

  it("requires an explicit remote Docker context before production restore", async () => {
    process.argv[2] = "restore-production";
    vi.stubEnv("OTA_DOCKER_CONTEXT", "");
    await expect(import("./ota-storage.ts")).rejects.toThrow("OTA_DOCKER_CONTEXT is required");
    expect(transfers()).toEqual([]);
  });

  it("refuses an empty snapshot before production restore", async () => {
    process.argv[2] = "restore-production";
    sourceCount = 0;
    await expect(import("./ota-storage.ts")).rejects.toThrow("Source must contain objects");
    expect(transfers().some((args) => args.includes("sync"))).toBe(false);
  });

  it.each([" sync ", " check "])("fails production restore when %s fails", async (command) => {
    process.argv[2] = "restore-production";
    failCommand = command;
    await expect(import("./ota-storage.ts")).rejects.toThrow("transfer failed");
  });
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

  it.each(["queued", "in_progress", "waiting", "pending", "requested"])(
    "refuses outstanding %s publisher or cleanup runs",
    async (status) => {
      activeRuns = 1;
      activeStatus = status;
      await expect(import("./ota-storage.ts")).rejects.toThrow(`still has ${status} runs`);
      expect(transfers()).toEqual([]);
    },
  );
  it("fails before storage access when GitHub permissions cannot be verified", async () => {
    github.use(
      http.get("https://api.github.com/repos/Asherlc/dofek/actions/workflows/:workflow", () =>
        HttpResponse.json({ message: "Forbidden" }, { status: 403 }),
      ),
    );
    await expect(import("./ota-storage.ts")).rejects.toThrow("HTTP 403");
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

  it("streams transfer diagnostics while retaining machine-readable stdout", async () => {
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await import("./ota-storage.ts");
      for (const [, arguments_, options] of execute.mock.calls) {
        expect(options?.stdio).toEqual(["pipe", "pipe", "inherit"]);
        expect(arguments_).toEqual(
          expect.arrayContaining([
            "--stats",
            "30s",
            "--stats-one-line",
            "--stats-log-level",
            "NOTICE",
          ]),
        );
      }
      expect(diagnostics).toHaveBeenCalledWith("OTA storage: starting copy");
      expect(diagnostics).toHaveBeenCalledWith(
        expect.stringMatching(/^OTA storage: finished copy in \d+ms$/),
      );
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("reports elapsed time when a transfer fails without suppressing the error", async () => {
    failCommand = " copy ";
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(import("./ota-storage.ts")).rejects.toThrow("transfer failed");
      expect(diagnostics).toHaveBeenCalledWith(
        expect.stringMatching(/^OTA storage: finished copy in \d+ms$/),
      );
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("copies production to a fresh snapshot and verifies every byte", async () => {
    await import("./ota-storage.ts");
    const commands = transfers();
    expect(commands).toHaveLength(5);
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
  it("checks an untouched rehearsal copy against the original snapshot", async () => {
    process.argv[2] = "verify-rehearsal";
    await import("./ota-storage.ts");
    expect(transfers()[1]?.slice(-4)).toEqual([
      "check",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      `ota:dofek-ota-backups/rehearsals/${snapshot}`,
      "--download",
    ]);
  });

  it("verifies relocated bytes and returns the retained latest iOS identity", async () => {
    process.argv[2] = "verify-migration";
    sourcePaths.push("orphan/file");
    migratedPaths.push("orphan/file");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await import("./ota-storage.ts");
      expect(output).toHaveBeenCalledWith(
        JSON.stringify({ id: "retained-id", runtimeVersion: "runtime-current" }),
      );
      expect(
        transfers().some(
          (command) =>
            command.includes(`ota:dofek-ota-backups/rehearsals/${snapshot}/example-app`) &&
            command.includes("--download"),
        ),
      ).toBe(true);
    } finally {
      output.mockRestore();
    }
  });

  it("byte-verifies the entire production migration without writing storage", async () => {
    process.argv[2] = "verify-production-migration";
    sourcePaths.push("orphan/file");
    migratedPaths.push("orphan/file");
    await import("./ota-storage.ts");
    const checks = transfers().filter((args) => args.includes("check"));
    expect(checks).toHaveLength(2);
    expect(checks[0]?.slice(-6)).toEqual([
      "check",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "ota:dofek-ota/example-app",
      "--download",
      "--files-from0",
      "-",
    ]);
    expect(checks[1]?.slice(-6)).toEqual([
      "check",
      `ota:dofek-ota-backups/snapshots/${snapshot}`,
      "ota:dofek-ota",
      "--download",
      "--files-from0",
      "-",
    ]);
    expect(
      transfers()
        .flat()
        .some((arg) => ["copy", "sync", "rcat"].includes(arg)),
    ).toBe(false);
  });

  it("refuses to certify production when migrated keys differ from the snapshot", async () => {
    process.argv[2] = "verify-production-migration";
    migratedPaths.pop();
    await expect(import("./ota-storage.ts")).rejects.toThrow("object set");
  });

  it("requires the locked verification receipt before certifying production", async () => {
    process.argv[2] = "verify-production-migration";
    snapshotReceipt = null;
    await expect(import("./ota-storage.ts")).rejects.toThrow();
    expect(transfers().some((args) => args.includes("lsjson"))).toBe(false);
  });

  it("fails migration verification when an original key remains behind", async () => {
    process.argv[2] = "verify-migration";
    migratedPaths.push("main/runtime-current/123/.check");
    await expect(import("./ota-storage.ts")).rejects.toThrow("object set");
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
