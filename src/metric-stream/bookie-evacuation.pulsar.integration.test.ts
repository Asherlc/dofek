import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("evacuates surviving native ledgers before retiring exclusive source storage", {
  retry: 0,
  timeout: 300_000,
}, () => {
  // This is a Linux CI fixture: local admission is an explicit, independent prerequisite.
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
  if (!available?.[1] || Number(available[1]) < 2816 * 1024) {
    throw new Error("Native BookKeeper fixture requires MemAvailable >= 2816 MiB before startup");
  }
  const compiler = "javac"; // CI explicitly selects the runner image's documented installed JDK.
  const owned = resolve("reports/bookie-evacuation", randomUUID());
  const fixture = join(owned, "fixture");
  for (const path of [fixture, join(owned, "source"), join(owned, "replacement")]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o777);
  }
  const suffix = `bookie-evacuation-${randomUUID()}`;
  const environment = { ...process.env, BOOKIE_EVACUATION_DIR: owned };
  const deadline = Date.now() + 300_000;
  let sequence = 0;
  let phase = "setup";
  let succeeded = false;
  const cleanupFailures: unknown[] = [];
  const run = (command: string, args: string[], limit = 60_000, evidence = false): string => {
    const timeout = evidence ? limit : Math.min(limit, deadline - Date.now());
    if (timeout <= 0) throw new Error(`Native fixture deadline exceeded in ${phase}`);
    const prefix = join(owned, `${String(++sequence).padStart(3, "0")}-${phase}`);
    writeFileSync(`${prefix}.command.json`, JSON.stringify({ command, args, timeout }));
    // GNU timeout kills the full command process group, including pnpm/Compose children.
    const result = spawnSync("timeout", ["--signal=KILL", `${timeout / 1000}s`, command, ...args], {
      env: environment,
      encoding: "utf8",
      timeout: timeout + 1000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(`${prefix}.stdout`, result.stdout ?? "");
    writeFileSync(`${prefix}.stderr`, result.stderr ?? "");
    if (result.error || result.status !== 0) {
      throw new Error(
        `Native fixture phase ${phase} failed; evidence ${prefix}; status=${result.status} signal=${result.signal}`,
        { cause: result.error },
      );
    }
    return result.stdout;
  };
  const compose = (args: string[], limit?: number, evidence = false) =>
    run(
      "pnpm",
      [
        "compose",
        "--",
        "--project-suffix",
        suffix,
        "-f",
        "docker-compose.bookie-evacuation.yml",
        ...args,
      ],
      limit,
      evidence,
    );
  const client = (...args: string[]) => compose(["exec", "-T", "client", ...args]);
  const java = (mode: string) => {
    phase = mode;
    return client(
      "java",
      "-Xms32m",
      "-Xmx192m",
      "-XX:MaxDirectMemorySize=128m",
      "-cp",
      "/fixture:/pulsar/conf:/pulsar/lib/*",
      "BookieEvacuationFixture",
      mode,
    );
  };
  const shell = (...args: string[]) =>
    client("bin/bookkeeper", "shell", "-conf", "conf/bookkeeper.conf", ...args);
  const state = (service: string) =>
    JSON.parse(
      client(
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        `http://${service}:8000/api/v1/bookie/state`,
      ),
    );
  try {
    compose(["up", "-d", "pulsar-oxia", "pulsar-oxia-coordinator", "client"]);
    compose(["cp", "client:/pulsar/lib", join(owned, "lib")]);
    run(compiler, [
      "-J-Xmx256m",
      "-proc:none",
      "--release",
      "21",
      "-cp",
      `${join(owned, "lib")}/*`,
      "-d",
      fixture,
      "src/metric-stream/BookieEvacuationFixture.java",
    ]);
    phase = "metadata-format";
    shell("metaformat", "-nonInteractive");
    phase = "source-ready";
    compose(["up", "-d", "--wait", "--wait-timeout", "90", "source"], 90_000);
    expect(state("source")).toMatchObject({ running: true, readOnly: false, shuttingDown: false });
    java("initial");
    java("seed");
    java("scan-source");
    java("delete");
    phase = "replacement-ready";
    compose(["up", "-d", "--wait", "--wait-timeout", "90", "replacement"], 90_000);
    expect(state("replacement")).toMatchObject({
      running: true,
      readOnly: false,
      shuttingDown: false,
    });
    phase = "manual-readonly";
    const readonly = JSON.parse(
      client(
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "-X",
        "PUT",
        "-H",
        "Content-Type: application/json",
        "--data",
        '{"readOnly":true}',
        "http://source:8000/api/v1/bookie/state/readonly",
      ),
    );
    expect(readonly).toMatchObject({ readOnly: true });
    expect(state("source")).toMatchObject({ running: true, readOnly: true, shuttingDown: false });
    java("registered"); // Includes independent source readback after the manual transition.
    phase = "recover";
    shell("recover", "-f", "source:3181");
    expect(state("source")).toMatchObject({ running: true, readOnly: true, shuttingDown: false });
    java("verify"); // Enumerates ALL surviving ledgers and ALL ensembles, with full entry hashes.
    phase = "old-offline";
    compose(["stop", "-t", "10", "source"]);
    java("verify");
    java("new");
    phase = "replacement-process-crash";
    compose(["kill", "-s", "SIGKILL", "replacement"]);
    compose(["up", "-d", "--wait", "--wait-timeout", "90", "replacement"], 90_000);
    expect(state("replacement")).toMatchObject({
      running: true,
      readOnly: false,
      shuttingDown: false,
    });
    java("verify");
    java("scan-replacement");
    phase = "retire-source-storage";
    compose(["rm", "-f", "source"]);
    client("rm", "-rf", "/old/journal", "/old/ledgers");
    rmSync(join(owned, "source"), { recursive: true });
    expect(existsSync(join(owned, "source"))).toBe(false);
    java("verify");
    writeFileSync(
      join(owned, "result.json"),
      JSON.stringify({ status: "PASS", restart: "SIGKILL", sourceStorageRetired: true }),
    );
    succeeded = true;
  } catch (error) {
    writeFileSync(join(owned, "failure.txt"), String(error instanceof Error ? error.stack : error));
    throw error;
  } finally {
    // Gather synthetic evidence BEFORE stopping any still-running process on failure.
    // Synchronous commands cannot escape timeout/failure cleanup.
    const failedPhase = phase;
    phase = "evidence";
    const failures = cleanupFailures;
    for (const args of [
      ["logs", "--no-color"],
      ["ps", "--all", "--format", "json"],
    ]) {
      try {
        compose(args, 15_000, true);
      } catch (error) {
        failures.push(error);
      }
    }
    writeFileSync(join(owned, "phase.json"), JSON.stringify({ succeeded, phase: failedPhase }));
    phase = "cleanup";
    try {
      if (succeeded) {
        compose(["stop", "-t", "10", "replacement"], 30_000, true);
        compose(
          ["exec", "-T", "client", "rm", "-rf", "/replacement/journal", "/replacement/ledgers"],
          15_000,
          true,
        );
      }
      compose(
        succeeded
          ? ["down", "--remove-orphans", "--volumes", "--timeout", "10"]
          : ["stop", "-t", "10"],
        30_000,
        true,
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      writeFileSync(join(owned, "cleanup-failures.txt"), failures.map(String).join("\n"));
    }
    if (succeeded && failures.length === 0) {
      // Native fixture data is disposable only after all assertions passed.
      rmSync(owned, { recursive: true });
    }
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, "Native fixture cleanup failed");
});
