import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      entrypoint.kill("SIGTERM");
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
