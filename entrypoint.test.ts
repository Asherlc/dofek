import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const entrypoints: ChildProcess[] = [];
const runtimeSafetyTimeoutMilliseconds = 30_000;

afterEach(() => {
  for (const entrypoint of entrypoints.splice(0)) {
    terminateProcessGroup(entrypoint);
  }
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

describe("entrypoint cdc-health mode", () => {
  it("records a successful CDC result before its scheduled sleep", async () => {
    const { commandDirectory, eventPath, temporaryDirectory } = createRuntimeHarness();
    temporaryDirectories.push(temporaryDirectory);

    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
action=""
for argument in "$@"; do
  case "$argument" in scripts/*) script="$argument" ;; esac
  action="$argument"
done
case "$script" in
  scripts/cdc-health-state.ts) printf 'state-%s\n' "$action" >> "$FAKE_EVENT_PATH" ;;
  scripts/check-clickhouse-cdc.ts) printf 'check\n' >> "$FAKE_EVENT_PATH" ;;
  scripts/*)
    printf 'unexpected-%s\n' "$script" >> "$FAKE_EVENT_PATH"
    printf 'unexpected fake Node invocation: %s\n' "$script" >&2
    exit 64
    ;;
esac
`,
    );
    writeStopAfterFirstSleep(commandDirectory);

    const entrypoint = startEntrypoint("cdc-health", commandDirectory, eventPath);
    await waitForExit(entrypoint);

    expect(readEvents(eventPath)).toEqual([
      "state-initialize",
      "check",
      "state-success",
      "sleep-300",
    ]);
  });

  it("records a failed CDC result and retries on its scheduled cadence", async () => {
    const { commandDirectory, eventPath, temporaryDirectory } = createRuntimeHarness();
    temporaryDirectories.push(temporaryDirectory);

    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
action=""
for argument in "$@"; do
  case "$argument" in scripts/*) script="$argument" ;; esac
  action="$argument"
done
case "$script" in
  scripts/cdc-health-state.ts) printf 'state-%s\n' "$action" >> "$FAKE_EVENT_PATH" ;;
  scripts/check-clickhouse-cdc.ts) printf 'check\n' >> "$FAKE_EVENT_PATH"; exit 17 ;;
  scripts/*)
    printf 'unexpected-%s\n' "$script" >> "$FAKE_EVENT_PATH"
    printf 'unexpected fake Node invocation: %s\n' "$script" >&2
    exit 64
    ;;
esac
`,
    );
    writeStopAfterFirstSleep(commandDirectory);

    const entrypoint = startEntrypoint("cdc-health", commandDirectory, eventPath);
    let standardError = "";
    entrypoint.stderr?.on("data", (chunk: Buffer) => {
      standardError += chunk.toString();
    });
    await waitForExit(entrypoint);

    expect(readEvents(eventPath)).toEqual([
      "state-initialize",
      "check",
      "state-failure",
      "sleep-300",
    ]);
    expect(standardError).toContain(
      "cdc-health: check failed with exit status 17; retrying in 300s",
    );
  });
});

describe("entrypoint processing-reconciliation mode", () => {
  it("logs a failed run and continues serially to the next scheduled reconciliation", async () => {
    const { commandDirectory, eventPath, temporaryDirectory } = createRuntimeHarness();
    temporaryDirectories.push(temporaryDirectory);
    const reconciliationCountPath = join(temporaryDirectory, "reconciliation-count");

    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
for argument in "$@"; do
  case "$argument" in scripts/*) script="$argument" ;; esac
done
case "$script" in
  scripts/reconcile-pending-processing.ts)
    reconciliation_count=0
    if [ -f "$FAKE_RECONCILIATION_COUNT_PATH" ]; then reconciliation_count=$(cat "$FAKE_RECONCILIATION_COUNT_PATH"); fi
    reconciliation_count=$((reconciliation_count + 1))
    printf '%s\n' "$reconciliation_count" > "$FAKE_RECONCILIATION_COUNT_PATH"
    printf 'reconciliation-%s\n' "$reconciliation_count" >> "$FAKE_EVENT_PATH"
    if [ "$reconciliation_count" -eq 1 ]; then exit 23; fi
    ;;
  scripts/*)
    printf 'unexpected-%s\n' "$script" >> "$FAKE_EVENT_PATH"
    printf 'unexpected fake Node invocation: %s\n' "$script" >&2
    exit 64
    ;;
esac
`,
    );
    writeStopAfterSecondSleep(commandDirectory);

    const entrypoint = startEntrypoint("processing-reconciliation", commandDirectory, eventPath, {
      FAKE_RECONCILIATION_COUNT_PATH: reconciliationCountPath,
    });
    let standardError = "";
    entrypoint.stderr?.on("data", (chunk: Buffer) => {
      standardError += chunk.toString();
    });
    await waitForExit(entrypoint);

    expect(readEvents(eventPath)).toEqual([
      "reconciliation-1",
      "sleep-300",
      "reconciliation-2",
      "sleep-300",
    ]);
    expect(standardError).toContain(
      "processing-reconciliation: reconciliation failed with exit status 23; retrying in 300s",
    );
  });
});

describe("entrypoint runtime harness", () => {
  it("requires a parent PATH before constructing a child command path", () => {
    const { commandDirectory, eventPath, temporaryDirectory } = createRuntimeHarness();
    temporaryDirectories.push(temporaryDirectory);
    const parentPath = process.env.PATH;

    try {
      delete process.env.PATH;
      expect(() => startEntrypoint("cdc-health", commandDirectory, eventPath)).toThrow(
        "Parent PATH is required for entrypoint runtime tests",
      );
    } finally {
      if (parentPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = parentPath;
      }
    }
  });

  it("fails loudly when fake Node receives an unexpected script", () => {
    const { commandDirectory, eventPath, temporaryDirectory } = createRuntimeHarness();
    temporaryDirectories.push(temporaryDirectory);

    writeExecutable(
      join(commandDirectory, "node"),
      String.raw`#!/bin/sh
script=""
for argument in "$@"; do
  case "$argument" in scripts/*) script="$argument" ;; esac
done
case "$script" in
  scripts/check-clickhouse-cdc.ts) printf 'check\n' >> "$FAKE_EVENT_PATH" ;;
  scripts/*)
    printf 'unexpected-%s\n' "$script" >> "$FAKE_EVENT_PATH"
    printf 'unexpected fake Node invocation: %s\n' "$script" >&2
    exit 64
    ;;
esac
`,
    );

    const unexpectedNode = spawn(
      join(commandDirectory, "node"),
      ["scripts/reconcile-pending-processing.ts"],
      {
        env: { ...process.env, FAKE_EVENT_PATH: eventPath },
      },
    );

    return waitForExit(unexpectedNode).then(() => {
      expect(readEvents(eventPath)).toEqual(["unexpected-scripts/reconcile-pending-processing.ts"]);
      expect(unexpectedNode.exitCode).toBe(64);
    });
  });
});

describe("entrypoint provider connection cutover mode", () => {
  it("runs the resumable connection backfill as a one-shot command", () => {
    const entrypoint = readFileSync(new URL("./entrypoint.sh", import.meta.url), "utf8");

    expect(entrypoint).toContain(`provider-connection-cutover)
    exec $NODE scripts/backfill-provider-connections.ts`);
  });
});

function createRuntimeHarness(): {
  commandDirectory: string;
  eventPath: string;
  temporaryDirectory: string;
} {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-entrypoint-"));
  const commandDirectory = join(temporaryDirectory, "commands");
  const eventPath = join(temporaryDirectory, "events.log");
  mkdirSync(commandDirectory);
  return { commandDirectory, eventPath, temporaryDirectory };
}

function startEntrypoint(
  mode: "cdc-health" | "processing-reconciliation",
  commandDirectory: string,
  eventPath: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const parentPath = process.env.PATH;
  if (!parentPath) {
    throw new Error("Parent PATH is required for entrypoint runtime tests");
  }

  const entrypoint = spawn("sh", [resolve("entrypoint.sh"), mode], {
    detached: true,
    env: {
      ...process.env,
      ...environment,
      FAKE_EVENT_PATH: eventPath,
      PATH: `${commandDirectory}:${parentPath}`,
    },
  });
  entrypoints.push(entrypoint);
  return entrypoint;
}

function writeStopAfterFirstSleep(commandDirectory: string): void {
  writeExecutable(
    join(commandDirectory, "sleep"),
    String.raw`#!/bin/sh
printf 'sleep-%s\n' "$1" >> "$FAKE_EVENT_PATH"
kill -TERM "$PPID"
`,
  );
}

function writeStopAfterSecondSleep(commandDirectory: string): void {
  writeExecutable(
    join(commandDirectory, "sleep"),
    String.raw`#!/bin/sh
sleep_count_file="$FAKE_EVENT_PATH.sleep-count"
sleep_count=0
if [ -f "$sleep_count_file" ]; then sleep_count=$(cat "$sleep_count_file"); fi
sleep_count=$((sleep_count + 1))
printf '%s\n' "$sleep_count" > "$sleep_count_file"
printf 'sleep-%s\n' "$1" >> "$FAKE_EVENT_PATH"
if [ "$sleep_count" -eq 2 ]; then kill -TERM "$PPID"; fi
`,
  );
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function readEvents(eventPath: string): string[] {
  return readFileSync(eventPath, "utf8").trim().split("\n");
}

async function waitForExit(entrypoint: ChildProcess): Promise<void> {
  let safetyTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await new Promise<void>((resolveExit, rejectExit) => {
      safetyTimeout = setTimeout(() => {
        terminateProcessGroup(entrypoint);
        rejectExit(
          new Error(
            `Entrypoint process group did not exit within ${runtimeSafetyTimeoutMilliseconds}ms`,
          ),
        );
      }, runtimeSafetyTimeoutMilliseconds);
      entrypoint.once("error", rejectExit);
      entrypoint.once("exit", () => resolveExit());
    });
  } finally {
    if (safetyTimeout !== undefined) {
      clearTimeout(safetyTimeout);
    }
    terminateProcessGroup(entrypoint);
  }
}

function terminateProcessGroup(entrypoint: ChildProcess): void {
  if (entrypoint.pid === undefined) {
    return;
  }

  const termination = spawnSync("/bin/kill", ["-TERM", `-${entrypoint.pid}`], {
    encoding: "utf8",
  });
  if (termination.status === 0) {
    return;
  }
  if (termination.status === 1 && termination.stderr.includes("No such process")) {
    return;
  }
  throw new Error(
    `Could not terminate entrypoint process group ${entrypoint.pid}: ${termination.error?.message ?? termination.stderr}`,
  );
}
