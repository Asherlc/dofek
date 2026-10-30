import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectClickHouseDiagnostics } from "./clickhouse-ci-diagnostics.ts";

const directories: string[] = [];
const containerId = "a".repeat(64);
const password = "private-ci-password";

function fixture(failCapture = "", extraLog = "", exception?: string) {
  const directory = mkdtempSync(join(tmpdir(), "clickhouse-diagnostics-test-"));
  directories.push(directory);
  const commands = join(directory, "commands.jsonl");
  const executable = join(directory, "docker");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.DIAGNOSTIC_COMMANDS, JSON.stringify(args) + '\\n');
const query = args.at(-1);
if (args[0] === 'inspect') {
  process.stdout.write(JSON.stringify(args.includes('--format') ? { id: '${containerId}', state: { status: 'running', oomKilled: false }, image: 'clickhouse:test' } : { Env: ['PASSWORD=${password}'] }));
} else if (args[0] === 'stats') {
  process.stdout.write(JSON.stringify({ CPUPerc: '1%', MemUsage: '100MiB' }));
} else if (args[0] === 'logs' || args.includes('tail')) {
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {drop-id} <Error> DatabaseAtomic: Code: 473. Cannot drop table \\'fixture.source\\': waiting for lock held by query other-id\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {query-id} <Debug> executeQuery: SELECT \\'payload-secret\\', \\'${password}\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {comment-id} <Debug> executeQuery: (from 127.0.0.1, user: default) /* {"app":"dbt"} */ SELECT \\'comment-payload-secret\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {explain-id} <Debug> executeQuery: EXPLAIN SELECT \\'explain-payload-secret\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {query-boundary-id} <Debug> executeQuery: SELECT \\'earliest-query-secret\\', \\'query: later-value\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {scope-boundary-id} <Debug> executeQuery: SELECT \\'earliest-scope-secret\\', \\'In scope later-value\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {execution-boundary-id} <Debug> executeQuery: SELECT \\'earliest-execution-secret\\', \\'while executing later-value\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {malformed-code-id} <Debug> executeQuery: (from 127.0.0.1) Code: 473. \\'<Error> malformed-code-secret\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {malformed-exception-id} <Debug> executeQuery: (from 127.0.0.1) DB::Exception: \\'<Information> malformed-exception-secret\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {fatal-id} <Error> executeQuery: Code: 473. Cannot drop table \\'fixture.source\\': waiting for lock held by query other-id (in query: /* dbt */ SELECT \\'fatal-payload-secret\\')\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {info-fatal-id} <Information> executeQuery: Code: 473. Cannot drop table \\'fixture.source\\': waiting for lock held by query other-id (in query: /* dbt */ SELECT \\'fatal-payload-secret\\')\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {query-id} <Error> Code: 60. Unknown table. In scope SELECT \\'exception-payload-secret\\'\\n');
  process.stdout.write('2026.10.28 22:21:27 [ 42 ] {query-id} <Error> url=http://user:${password}@example.test/?token=unknown-token Authorization: Bearer unknown-bearer\\n');
  process.stdout.write('0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x123\\n');
  process.stdout.write(${JSON.stringify(extraLog)});
} else if (query.includes('system.stack_trace')) {
  process.stdout.write(JSON.stringify({ query_id: 'drop-id', thread_id: 42, thread_name: 'QueryWorker', trace: [123,456] }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ query_id: 'drop-id', exception: ${JSON.stringify(exception ?? "waiting for lock (in query: /* dbt */ EXPLAIN SELECT 'query-payload-secret')")}, query_duration_ms: 120000, stack_trace: 'DB::DatabaseAtomic::waitTableFinallyDropped()' }) + '\\n');
}
if (${JSON.stringify(failCapture)} && query.includes(${JSON.stringify(failCapture)})) {
  process.stderr.write('capture failed password=${password} http://user:${password}@example.test');
  process.exit(7);
}
`,
  );
  chmodSync(executable, 0o755);
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("DIAGNOSTIC_COMMANDS", commands);
  const outputDirectory = join(directory, "artifacts");
  return { outputDirectory, commands };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ClickHouse CI diagnostics", () => {
  it("captures bounded read-only evidence and preserves wait signatures while removing credentials and SQL payloads", async () => {
    const { outputDirectory, commands } = fixture();
    const result = await collectClickHouseDiagnostics({
      containerId,
      outputDirectory,
      credentialUrl: `http://default:${password}@example.test:8123`,
    });
    expect(result.failures).toEqual([]);
    const files = readdirSync(outputDirectory);
    const artifacts = files
      .map((file) => readFileSync(join(outputDirectory, file), "utf8"))
      .join("\n");
    expect(artifacts).toContain(
      "Cannot drop table 'fixture.source': waiting for lock held by query other-id",
    );
    expect(artifacts).toContain("DatabaseAtomic::waitTableFinallyDropped");
    expect(artifacts).toContain("drop-id");
    for (const secret of [
      password,
      "payload-secret",
      "exception-payload-secret",
      "comment-payload-secret",
      "explain-payload-secret",
      "fatal-payload-secret",
      "unknown-token",
      "unknown-bearer",
      "http://user:",
    ])
      expect(artifacts).not.toContain(secret);
    expect(files).toContain("server-error.stdout.log");
    expect(files).toContain("query-log-drops-errors.stdout.log");
    expect(files).toContain("manifest.json");
    const invocations: string[][] = readFileSync(commands, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations.every((args) => !args.join(" ").includes(password))).toBe(true);
    const inspection = invocations.find((args) => args[0] === "inspect")?.join(" ") ?? "";
    expect(inspection).not.toMatch(/\.Env|Healthcheck|\.Output/);
    const queries = invocations.filter((args) => args.some((arg) => arg.includes("--query")));
    expect(queries.length).toBeGreaterThanOrEqual(7);
    expect(queries.every((args) => args.join(" ").includes("--readonly=1"))).toBe(true);
    expect(queries.every((args) => args.join(" ").includes("--max_execution_time=5"))).toBe(true);
    expect(queries.some((args) => args.at(-1)?.includes("INTERVAL 20 MINUTE"))).toBe(true);
    expect(
      queries.every((args) => !/SYSTEM FLUSH|KILL QUERY|DROP DATABASE/.test(args.at(-1) ?? "")),
    ).toBe(true);
  });

  it("retains successful and partial output, records collection failures, and continues independent captures", async () => {
    const { outputDirectory } = fixture("system.query_log");
    const result = await collectClickHouseDiagnostics({
      containerId,
      outputDirectory,
      credentialUrl: `http://default:${password}@example.test`,
    });
    expect(result.failures).toContain("query-log");
    expect(result.failures).toContain("query-log-drops-errors");
    expect(readFileSync(join(outputDirectory, "query-log.stdout.log"), "utf8")).toContain(
      "drop-id",
    );
    expect(readFileSync(join(outputDirectory, "mutations.stdout.log"), "utf8")).toContain(
      "drop-id",
    );
    const manifest = JSON.parse(readFileSync(join(outputDirectory, "manifest.json"), "utf8"));
    expect(
      manifest.captures.find((capture: { name: string }) => capture.name === "query-log"),
    ).toMatchObject({ status: "failed", exitCode: 7 });
    expect(readFileSync(join(outputDirectory, "query-log.stderr.log"), "utf8")).not.toContain(
      password,
    );
  });

  it("rejects an unsafe service identifier before invoking Docker", async () => {
    const { outputDirectory, commands } = fixture();
    await expect(
      collectClickHouseDiagnostics({ containerId: "--privileged", outputDirectory }),
    ).rejects.toThrow("container");
    expect(() => readFileSync(commands)).toThrow();
  });

  it("keeps structured exception evidence valid and retains stack fields after removing embedded SQL", async () => {
    const { outputDirectory } = fixture();
    await collectClickHouseDiagnostics({ containerId, outputDirectory });
    const row = JSON.parse(readFileSync(join(outputDirectory, "query-log.stdout.log"), "utf8"));
    expect(row).toMatchObject({
      query_id: "drop-id",
      query_duration_ms: 120000,
      stack_trace: "DB::DatabaseAtomic::waitTableFinallyDropped()",
    });
    expect(row.exception).toContain("waiting for lock");
    expect(row.exception).not.toContain("query-payload-secret");
  });

  it("records Docker launch failures without losing the diagnostic manifest", async () => {
    const { outputDirectory } = fixture();
    vi.stubEnv("PATH", "/no-such-diagnostics-command-directory");
    const result = await collectClickHouseDiagnostics({ containerId, outputDirectory });
    expect(result.failures).toContain("container");
    expect(result.failures).toContain("mutations");
    const manifest = JSON.parse(readFileSync(join(outputDirectory, "manifest.json"), "utf8"));
    expect(
      manifest.captures.every(
        (capture: { status: string; error: string }) =>
          capture.status === "failed" && capture.error.includes("ENOENT"),
      ),
    ).toBe(true);
  });

  it("reports malformed credential configuration without exposing its value", async () => {
    const { outputDirectory, commands } = fixture();
    await expect(
      collectClickHouseDiagnostics({
        containerId,
        outputDirectory,
        credentialUrl: `bad-url-${password}`,
      }),
    ).rejects.toThrow("CLICKHOUSE_URL must be valid for diagnostics credential redaction");
    expect(() => readFileSync(commands)).toThrow();
  });

  it("captures raw stacks limited to active DROP thread IDs", async () => {
    const { outputDirectory, commands } = fixture();
    await collectClickHouseDiagnostics({ containerId, outputDirectory });
    const row = JSON.parse(readFileSync(join(outputDirectory, "drop-stacks.stdout.log"), "utf8"));
    expect(row).toMatchObject({ query_id: "drop-id", thread_id: 42, trace: [123, 456] });
    const invocations: string[][] = readFileSync(commands, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const query = invocations
      .map((args) => args.at(-1))
      .find((arg) => arg?.includes("system.stack_trace"));
    expect(query).toContain("thread_id IN (SELECT arrayJoin(thread_ids)");
    expect(query).toContain("query_kind = 'Drop' LIMIT 100");
    expect(query).not.toMatch(/addressTo|allow_introspection/);
  });

  it.each([
    ["query:", "earliest-query-secret"],
    ["In scope", "earliest-scope-secret"],
    ["while executing", "earliest-execution-secret"],
  ])(
    "uses the earlier logger boundary when SQL contains a later %s marker",
    async (_marker, sentinel) => {
      const { outputDirectory } = fixture();
      await collectClickHouseDiagnostics({ containerId, outputDirectory });
      const log = readFileSync(join(outputDirectory, "server-error.stdout.log"), "utf8");
      expect(log).not.toContain(sentinel);
      expect(log).toContain(
        "Cannot drop table 'fixture.source': waiting for lock held by query other-id",
      );
    },
  );

  it.each(["malformed-code-secret", "malformed-exception-secret"])(
    "redacts Debug payload %s without trusting severity-like text inside SQL",
    async (sentinel) => {
      const { outputDirectory } = fixture();
      await collectClickHouseDiagnostics({ containerId, outputDirectory });
      const log = readFileSync(join(outputDirectory, "server-error.stdout.log"), "utf8");
      expect(log).not.toContain(sentinel);
      for (const queryId of ["fatal-id", "info-fatal-id"]) {
        const fatal = log.split("\n").find((line) => line.includes(`{${queryId}}`));
        expect(fatal).toContain(
          "Code: 473. Cannot drop table 'fixture.source': waiting for lock held by query other-id",
        );
      }
    },
  );
});

describe("SQL continuation record boundaries", () => {
  it.each(["query:", "query_text=", "In scope", "while executing", "executeQuery:"])(
    "redacts active raw continuations containing another %s marker before retaining later diagnostics",
    async (marker) => {
      const { outputDirectory } = fixture(
        "",
        [
          "2026.10.28 22:21:27.100 [ 42 ] {sql-id} <Debug> executeQuery: SELECT",
          `2026-10-28 22:21:28 PRIVATE_TIMESTAMP_CONTINUATION_SENTINEL ${marker} more-sql`,
          `PRIVATE_CONTINUATION_SENTINEL ${marker} more-sql`,
          "0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x456",
          "2026.10.28 22:21:30.123 [ 43 ] {later-id} <Information> DatabaseAtomic: waiting for lock",
          "2026-10-28T22:21:31.000000000Z 2026.10.28 22:21:31.123 [ 44 ] {later-error-id} <Error> executeQuery: Code: 473. Cannot drop table: waiting for lock (in query: SELECT 'later-payload-secret')",
          "0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x789",
          "",
        ].join("\n"),
      );
      await collectClickHouseDiagnostics({ containerId, outputDirectory });
      for (const name of ["docker-logs", "server", "server-error"]) {
        const artifact = readFileSync(join(outputDirectory, `${name}.stdout.log`), "utf8");
        expect(artifact).not.toContain("PRIVATE_TIMESTAMP_CONTINUATION_SENTINEL");
        expect(artifact).not.toContain("PRIVATE_CONTINUATION_SENTINEL");
        expect(artifact).not.toContain("later-payload-secret");
        expect(artifact).toContain("DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x456");
        expect(artifact).toContain("{later-id} <Information> DatabaseAtomic: waiting for lock");
        expect(artifact).toContain(
          "{later-error-id} <Error> executeQuery: Code: 473. Cannot drop table: waiting for lock",
        );
        expect(artifact).toContain("DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x789");
      }
    },
  );

  it.each(["query:", "query_text=", "In scope", "while executing", "executeQuery:"])(
    "redacts active structured continuations containing another %s marker while retaining error and stack evidence",
    async (marker) => {
      const { outputDirectory } = fixture(
        "",
        "",
        [
          "Code: 473. waiting for lock (in query: SELECT",
          `2026-10-28 22:21:28 PRIVATE_STRUCTURED_TIMESTAMP_SENTINEL ${marker} more-sql`,
          `2026.10.28 22:21:29.123 [ 42 ] {fake-id} <Error> fake: PRIVATE_STRUCTURED_HEADER_SENTINEL ${marker} more-sql`,
          "0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x789",
        ].join("\n"),
      );
      await collectClickHouseDiagnostics({ containerId, outputDirectory });
      for (const name of ["query-log", "query-log-drops-errors", "mutations"]) {
        const row = JSON.parse(readFileSync(join(outputDirectory, `${name}.stdout.log`), "utf8"));
        expect(row).toMatchObject({
          query_id: "drop-id",
          query_duration_ms: 120000,
          stack_trace: "DB::DatabaseAtomic::waitTableFinallyDropped()",
        });
        expect(row.exception).toContain("Code: 473. waiting for lock");
        expect(row.exception).not.toContain("PRIVATE_STRUCTURED_TIMESTAMP_SENTINEL");
        expect(row.exception).not.toContain("PRIVATE_STRUCTURED_HEADER_SENTINEL");
        expect(row.exception).toContain("DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x789");
      }
    },
  );

  it("redacts timestamp-like SQL across every public log artifact and preserves later records", async () => {
    const { outputDirectory } = fixture(
      "",
      [
        "2026.10.28 22:21:27.100 [ 42 ] {sql-id} <Debug> executeQuery: SELECT 'start-secret',",
        "2026-10-28 22:21:28 'timestamp-payload-secret',",
        "2026.10.28 22:21:29 'dotted-payload-secret'",
        "2026.10.28 22:21:30.123 [ 43 ] {later-query-id} <Information> DatabaseAtomic: waiting for drop lock",
        "2026-10-28T22:21:31.000000000Z 2026.10.28 22:21:31.123 [ 44 ] {later-error-id} <Error> executeQuery: Code: 473. Cannot drop table: waiting for lock (in query: SELECT 'later-sql-secret')",
        "0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x456",
        "",
      ].join("\n"),
    );
    await collectClickHouseDiagnostics({ containerId, outputDirectory });
    for (const name of ["docker-logs", "server", "server-error"]) {
      const artifact = readFileSync(join(outputDirectory, `${name}.stdout.log`), "utf8");
      expect(artifact).not.toContain("timestamp-payload-secret");
      expect(artifact).not.toContain("dotted-payload-secret");
      expect(artifact).not.toContain("later-sql-secret");
      expect(artifact).toContain(
        "{later-query-id} <Information> DatabaseAtomic: waiting for drop lock",
      );
      expect(artifact).toContain(
        "{later-error-id} <Error> executeQuery: Code: 473. Cannot drop table: waiting for lock",
      );
      expect(artifact).toContain("DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x456");
    }
  });

  it.each([
    ["Error", "DatabaseAtomic (default)", ""],
    ["Information", "DatabaseAtomic (default)", "2026-10-28T22:21:28.000000000Z "],
    ["Error", "default.source (00000000-0000-0000-0000-000000000001)", ""],
  ])("preserves %s records from logger %s after SQL", async (severity, logger, prefix) => {
    const errorContext = `${logger}: Code: 473. Cannot drop table: waiting for lock held by query other-id`;
    const { outputDirectory } = fixture(
      "",
      [
        "2026.10.28 22:21:27.100 [ 42 ] {sql-id} <Debug> executeQuery: SELECT 'logger-payload-secret'",
        `${prefix}2026.10.28 22:21:28.123 [ 43 ] {} <${severity}> ${errorContext}`,
        "0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x456",
        "",
      ].join("\n"),
    );
    await collectClickHouseDiagnostics({ containerId, outputDirectory });
    for (const name of ["docker-logs", "server", "server-error"]) {
      const artifact = readFileSync(join(outputDirectory, `${name}.stdout.log`), "utf8");
      expect(artifact).toContain(errorContext);
      expect(artifact).toContain("DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x456");
      expect(artifact).not.toContain("logger-payload-secret");
    }
  });

  it("does not trust log-like boundaries embedded inside structured exception strings", async () => {
    const { outputDirectory } = fixture(
      "",
      "",
      [
        "Code: 473. waiting for lock (in query: SELECT 'first-secret',",
        "2026.10.28 22:21:29.123 [ 42 ] {fake-id} <Error> fake: 'structured-payload-secret'",
        "0. DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x789",
      ].join("\n"),
    );
    await collectClickHouseDiagnostics({ containerId, outputDirectory });
    const row = JSON.parse(readFileSync(join(outputDirectory, "query-log.stdout.log"), "utf8"));
    expect(row.query_id).toBe("drop-id");
    expect(row.exception).toContain("Code: 473. waiting for lock");
    expect(row.exception).not.toContain("structured-payload-secret");
    expect(row.exception).toContain("DB::DatabaseAtomic::waitTableFinallyDropped() @ 0x789");
    expect(row.stack_trace).toBe("DB::DatabaseAtomic::waitTableFinallyDropped()");
  });
});
