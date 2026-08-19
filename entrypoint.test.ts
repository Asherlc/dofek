import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

function readEntrypoint(): string {
  return readFileSync(new URL("./entrypoint.sh", import.meta.url), "utf8");
}

describe("entrypoint cdc-health mode", () => {
  it("persists each CDC health result while continuing checks at the configured interval", () => {
    const entrypoint = readEntrypoint();
    const cdcHealthBlockMatch = entrypoint.match(/ {2}cdc-health\)\n(?<body>[\s\S]*?)\n {4};;/);
    const cdcHealthBlock = cdcHealthBlockMatch?.groups?.body;

    expect(cdcHealthBlock).toContain("$NODE scripts/cdc-health-state.ts initialize");
    expect(cdcHealthBlock).toContain("$NODE scripts/cdc-health-state.ts success");
    expect(cdcHealthBlock).toContain("$NODE scripts/cdc-health-state.ts failure");
    expect(cdcHealthBlock).toMatch(
      /echo "cdc-health: check failed with exit status \$status; retrying in \$\{interval_seconds\}s"/,
    );
    expect(cdcHealthBlock).toContain('sleep "$interval_seconds"');
  });

  it("records successful CDC health before starting reconciliation and skips reconciliation after a failed check", () => {
    const entrypoint = readEntrypoint();
    const cdcHealthBlockMatch = entrypoint.match(/ {2}cdc-health\)\n(?<body>[\s\S]*?)\n {4};;/);
    const cdcHealthBlock = cdcHealthBlockMatch?.groups?.body;
    const cdcCheckMatch = cdcHealthBlock?.match(
      /if \$NODE scripts\/check-clickhouse-cdc\.ts; then\n(?<successfulCheckBody>[\s\S]*?)\n {6}else\n {8}status="\$\?"\n(?<failedCheckBody>[\s\S]*?)\n {6}fi/,
    );
    const successfulCheckBlock = cdcCheckMatch?.groups?.successfulCheckBody;
    const failedCheckBlock = cdcCheckMatch?.groups?.failedCheckBody;

    expect(successfulCheckBlock).toContain("$NODE scripts/cdc-health-state.ts success");
    expect(successfulCheckBlock).toContain("$NODE scripts/reconcile-pending-processing.ts");
    expect(successfulCheckBlock?.indexOf("$NODE scripts/cdc-health-state.ts success")).toBeLessThan(
      successfulCheckBlock?.indexOf("$NODE scripts/reconcile-pending-processing.ts") ?? 0,
    );
    expect(failedCheckBlock).not.toContain("scripts/reconcile-pending-processing.ts");
  });

  it("continues CDC checks while one delayed reconciliation is in flight", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-entrypoint-cdc-health-"));
    temporaryDirectories.push(temporaryDirectory);
    const commandDirectory = join(temporaryDirectory, "commands");
    const eventPath = join(temporaryDirectory, "events.log");
    const checkCountPath = join(temporaryDirectory, "check-count");
    const reconciliationReleasePath = join(temporaryDirectory, "release-reconciliation");

    mkdirSync(commandDirectory);

    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
action=""
for argument in "$@"; do
  case "$argument" in
    scripts/*) script="$argument" ;;
  esac
  action="$argument"
done

case "$script" in
  scripts/cdc-health-state.ts)
    printf 'state-%s\n' "$action" >> "$FAKE_EVENT_PATH"
    ;;
  scripts/check-clickhouse-cdc.ts)
    check_count=0
    if [ -f "$FAKE_CHECK_COUNT_PATH" ]; then
      check_count=$(cat "$FAKE_CHECK_COUNT_PATH")
    fi
    check_count=$((check_count + 1))
    printf '%s\n' "$check_count" > "$FAKE_CHECK_COUNT_PATH"
    printf 'check-%s\n' "$check_count" >> "$FAKE_EVENT_PATH"
    if [ "$check_count" -eq 3 ]; then
      touch "$FAKE_RECONCILIATION_RELEASE_PATH"
    elif [ "$check_count" -ge 4 ]; then
      entrypoint_pid="$PPID"
      (
        /bin/sleep 0.05
        kill -TERM "$entrypoint_pid"
      ) &
    fi
    ;;
  scripts/reconcile-pending-processing.ts)
    printf 'reconciliation-start\n' >> "$FAKE_EVENT_PATH"
    while [ ! -f "$FAKE_RECONCILIATION_RELEASE_PATH" ]; do
      /bin/sleep 0.01
    done
    printf 'reconciliation-finish\n' >> "$FAKE_EVENT_PATH"
    ;;
esac
`,
    );

    const entrypoint = spawn("sh", [resolve("entrypoint.sh"), "cdc-health"], {
      detached: true,
      env: {
        ...process.env,
        CDC_HEALTH_INTERVAL_SECONDS: "1",
        FAKE_CHECK_COUNT_PATH: checkCountPath,
        FAKE_EVENT_PATH: eventPath,
        FAKE_RECONCILIATION_RELEASE_PATH: reconciliationReleasePath,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
      },
    });

    const outcome = await Promise.race([
      waitForExit(entrypoint).then(() => "completed" as const),
      new Promise<"timed out">((resolveTimeout) => {
        setTimeout(() => resolveTimeout("timed out"), 4_500);
      }),
    ]);
    if (outcome === "timed out") {
      stopProcessGroup(entrypoint, "SIGTERM");
      await waitForExit(entrypoint);
    }

    const events = readFileSync(eventPath, "utf8").trim().split("\n");
    expect(outcome, events.join(",")).toBe("completed");
    expect(
      events.filter(
        (event) =>
          event === "check-1" || event === "check-2" || event === "check-3" || event === "check-4",
      ),
    ).toEqual(["check-1", "check-2", "check-3", "check-4"]);
    expect(events.filter((event) => event === "state-success")).toHaveLength(4);
    expect(events.filter((event) => event === "reconciliation-start")).toHaveLength(2);
    expect(events.indexOf("check-2")).toBeGreaterThan(events.indexOf("reconciliation-start"));
    expect(events.indexOf("check-3")).toBeGreaterThan(events.indexOf("reconciliation-start"));
    expect(events.indexOf("reconciliation-finish")).toBeLessThan(
      events.lastIndexOf("reconciliation-start"),
    );
  });

  it("logs a failed reconciliation child and retries it after the next successful CDC check", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-entrypoint-cdc-health-retry-"));
    temporaryDirectories.push(temporaryDirectory);
    const commandDirectory = join(temporaryDirectory, "commands");
    const eventPath = join(temporaryDirectory, "events.log");
    const checkCountPath = join(temporaryDirectory, "check-count");
    const reconciliationCountPath = join(temporaryDirectory, "reconciliation-count");

    mkdirSync(commandDirectory);
    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
for argument in "$@"; do
  case "$argument" in
    scripts/*) script="$argument" ;;
  esac
done

case "$script" in
  scripts/cdc-health-state.ts)
    ;;
  scripts/check-clickhouse-cdc.ts)
    check_count=0
    if [ -f "$FAKE_CHECK_COUNT_PATH" ]; then check_count=$(cat "$FAKE_CHECK_COUNT_PATH"); fi
    check_count=$((check_count + 1))
    printf '%s\n' "$check_count" > "$FAKE_CHECK_COUNT_PATH"
    printf 'check-%s\n' "$check_count" >> "$FAKE_EVENT_PATH"
    if [ "$check_count" -ge 3 ]; then
      entrypoint_pid="$PPID"
      ( /bin/sleep 0.05; kill -TERM "$entrypoint_pid" ) &
    fi
    ;;
  scripts/reconcile-pending-processing.ts)
    reconciliation_count=0
    if [ -f "$FAKE_RECONCILIATION_COUNT_PATH" ]; then reconciliation_count=$(cat "$FAKE_RECONCILIATION_COUNT_PATH"); fi
    reconciliation_count=$((reconciliation_count + 1))
    printf '%s\n' "$reconciliation_count" > "$FAKE_RECONCILIATION_COUNT_PATH"
    printf 'reconciliation-start-%s\n' "$reconciliation_count" >> "$FAKE_EVENT_PATH"
    if [ "$reconciliation_count" -eq 1 ]; then exit 23; fi
    while true; do /bin/sleep 1; done
    ;;
esac
`,
    );

    const entrypoint = spawn("sh", [resolve("entrypoint.sh"), "cdc-health"], {
      detached: true,
      env: {
        ...process.env,
        CDC_HEALTH_INTERVAL_SECONDS: "1",
        FAKE_CHECK_COUNT_PATH: checkCountPath,
        FAKE_EVENT_PATH: eventPath,
        FAKE_RECONCILIATION_COUNT_PATH: reconciliationCountPath,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
      },
    });
    let standardError = "";
    entrypoint.stderr?.on("data", (chunk: Buffer) => {
      standardError += chunk.toString();
    });

    try {
      const outcome = await Promise.race([
        waitForExit(entrypoint).then(() => "completed" as const),
        new Promise<"timed out">((resolveTimeout) => {
          setTimeout(() => resolveTimeout("timed out"), 4_500);
        }),
      ]);
      if (outcome === "timed out") {
        stopProcessGroup(entrypoint, "SIGTERM");
        await waitForExit(entrypoint);
      }

      expect(outcome).toBe("completed");
      expect(readFileSync(eventPath, "utf8").trim().split("\n")).toContain(
        "reconciliation-start-2",
      );
      expect(readFileSync(checkCountPath, "utf8").trim()).toBe("3");
      expect(standardError).toContain(
        "cdc-health: processing reconciliation failed with exit status 23; retrying after the next successful CDC check",
      );
    } finally {
      stopProcessGroup(entrypoint, "SIGKILL");
    }
  });

  it("cleans up a blocked reconciliation child when the runtime test stops", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-entrypoint-cdc-health-cleanup-"));
    temporaryDirectories.push(temporaryDirectory);
    const commandDirectory = join(temporaryDirectory, "commands");
    const reconciliationPidPath = join(temporaryDirectory, "reconciliation.pid");

    mkdirSync(commandDirectory);
    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
for argument in "$@"; do
  case "$argument" in
    scripts/*) script="$argument" ;;
  esac
done

case "$script" in
  scripts/cdc-health-state.ts|scripts/check-clickhouse-cdc.ts)
    ;;
  scripts/reconcile-pending-processing.ts)
    printf '%s\n' "$$" > "$FAKE_RECONCILIATION_PID_PATH"
    while true; do /bin/sleep 1; done
    ;;
esac
`,
    );

    const entrypoint = spawn("sh", [resolve("entrypoint.sh"), "cdc-health"], {
      detached: true,
      env: {
        ...process.env,
        CDC_HEALTH_INTERVAL_SECONDS: "1",
        FAKE_RECONCILIATION_PID_PATH: reconciliationPidPath,
        PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
      },
    });

    let reconciliationPid: number | undefined;
    try {
      await waitForFile(reconciliationPidPath);
      reconciliationPid = Number.parseInt(readFileSync(reconciliationPidPath, "utf8"), 10);
      stopProcessGroup(entrypoint, "SIGTERM");
      await waitForExit(entrypoint);

      expect(isProcessRunning(reconciliationPid)).toBe(false);
    } finally {
      stopProcessGroup(entrypoint, "SIGKILL");
      if (reconciliationPid !== undefined && isProcessRunning(reconciliationPid)) {
        process.kill(reconciliationPid, "SIGKILL");
      }
    }
  });
});

describe("entrypoint provider connection cutover mode", () => {
  it("runs the resumable connection backfill as a one-shot command", () => {
    const entrypoint = readEntrypoint();

    expect(entrypoint).toContain(`provider-connection-cutover)
    exec $NODE scripts/backfill-provider-connections.ts`);
  });
});

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

async function waitForExit(entrypoint: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolveExit, rejectExit) => {
    entrypoint.once("error", rejectExit);
    entrypoint.once("exit", () => resolveExit());
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcessGroup(entrypoint: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (entrypoint.pid === undefined) {
    return;
  }
  try {
    process.kill(-entrypoint.pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ESRCH")) {
      throw error;
    }
  }
}
