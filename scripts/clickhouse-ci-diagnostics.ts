import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureException } from "../src/lib/error-reporting.ts";
import { safeErrorCode } from "../src/test/ci-diagnostic-fields.ts";

const commandTimeoutMs = 15_000;
const outputLimitBytes = 8 * 1024 * 1024;
const logTailLines = 4_000;
const inspectFormat = `{
  "id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},
  "restartCount":{{json .RestartCount}},
  "state":{"status":{{json .State.Status}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"oomKilled":{{json .State.OOMKilled}},"dead":{{json .State.Dead}},"pid":{{json .State.Pid}},"exitCode":{{json .State.ExitCode}},"error":{{json .State.Error}},"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}}},
  "health":{{if .State.Health}}{"status":{{json .State.Health.Status}},"failingStreak":{{json .State.Health.FailingStreak}}}{{else}}null{{end}},
  "resources":{"memory":{{json .HostConfig.Memory}},"memorySwap":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"cpuQuota":{{json .HostConfig.CpuQuota}},"cpuPeriod":{{json .HostConfig.CpuPeriod}},"cpusetCpus":{{json .HostConfig.CpusetCpus}},"pidsLimit":{{json .HostConfig.PidsLimit}}}
}`;

const queries = [
  ["version", "SELECT version() AS version, uptime() AS uptime_seconds"],
  [
    "processes",
    "SELECT query_id, initial_query_id, elapsed, is_cancelled, read_rows, read_bytes, memory_usage, thread_ids FROM system.processes ORDER BY elapsed DESC LIMIT 100",
  ],
  [
    "drop-stacks",
    "SELECT query_id, thread_id, thread_name, trace FROM system.stack_trace WHERE thread_id IN (SELECT arrayJoin(thread_ids) FROM system.processes WHERE query_kind = 'Drop' LIMIT 100) LIMIT 100",
  ],
  [
    "query-log",
    "SELECT event_time_microseconds, query_start_time_microseconds, type, query_id, initial_query_id, query_kind, query_duration_ms, exception_code, exception, stack_trace FROM system.query_log WHERE event_time >= now() - INTERVAL 20 MINUTE ORDER BY event_time_microseconds DESC LIMIT 500",
  ],
  [
    "query-log-drops-errors",
    "SELECT event_time_microseconds, query_start_time_microseconds, type, query_id, initial_query_id, query_kind, query_duration_ms, exception_code, exception, stack_trace FROM system.query_log WHERE event_time >= now() - INTERVAL 20 MINUTE AND (query_kind = 'Drop' OR exception_code != 0) ORDER BY event_time_microseconds DESC LIMIT 1000",
  ],
  [
    "dropped-tables",
    "SELECT index, database, table, uuid, engine, metadata_dropped_path, table_dropped_time FROM system.dropped_tables ORDER BY index LIMIT 1000",
  ],
  [
    "merges",
    "SELECT database, table, elapsed, progress, num_parts, total_size_bytes_compressed, memory_usage FROM system.merges ORDER BY elapsed DESC LIMIT 100",
  ],
  [
    "mutations",
    "SELECT database, table, mutation_id, create_time, parts_to_do, is_done, latest_failed_part, latest_fail_time, latest_fail_reason FROM system.mutations ORDER BY create_time DESC LIMIT 100",
  ],
  [
    "settings",
    "SELECT name, value, changed FROM system.settings WHERE name IN ('log_queries', 'log_queries_min_type', 'log_queries_probability', 'max_execution_time', 'max_memory_usage', 'database_atomic_wait_for_drop_and_detach_synchronously', 'send_progress_in_http_headers') ORDER BY name",
  ],
  [
    "server-settings",
    "SELECT name, value FROM system.server_settings WHERE name IN ('database_atomic_delay_before_drop_table_sec', 'max_server_memory_usage', 'max_server_memory_usage_to_ram_ratio') ORDER BY name",
  ],
] as const;

const logRecordHeader =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+)?\d{4}[.-]\d{2}[.-]\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\[\s*\d+\s*\]\s+\{[^}\r\n]*\}\s+<(Trace|Debug|Information|Warning|Error|Fatal)>\s+([^\r\n]+?):[ \t]+/;

function redact(text: string, secrets: string[], logRecords: boolean): string {
  let value = text;
  for (const secret of secrets) value = value.replaceAll(secret, "[REDACTED]");
  value = value
    .replace(/\b(?:https?|postgres(?:ql)?|clickhouse):\/\/[^\s"'<>\\]+/gi, "[URL redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "[REDACTED]")
    .replace(
      /((?:password|passwd|token|secret|authorization|api[_-]?key)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
  let sqlContinuation = false;
  return value
    .split("\n")
    .map((line) => {
      const header = logRecords ? logRecordHeader.exec(line) : null;
      if (header) sqlContinuation = false;
      if (sqlContinuation && line && !/^\s*(?:\d+\.\s|at\s)/.test(line))
        return "[SQL continuation redacted]";
      const sql = /\bquery(?:_text)?\s*[:=]\s*|\bIn scope\b\s*|\bwhile executing\b\s*/i.exec(line);
      const execution = /executeQuery:\s*(?:\([^\n)]*\)\s*)*/i.exec(line);
      const executionPayload = execution ? line.slice(execution.index + execution[0].length) : "";
      const diagnosticError =
        execution &&
        header &&
        (header[1] === "Error" || header[1] === "Information") &&
        header[2] === "executeQuery" &&
        /^(?:Code:\s*\d+|DB::Exception:)/.test(executionPayload);
      let payload = sql;
      if (execution && !diagnosticError && (!payload || execution.index < payload.index))
        payload = execution;
      if (payload) {
        sqlContinuation = true;
        return `${line.slice(0, payload.index)}[SQL payload redacted]`;
      }
      return line;
    })
    .join("\n");
}

interface Capture {
  name: string;
  status: "ok" | "failed";
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

const inputMessages = {
  usage:
    "Usage: pnpm tsx scripts/collect-clickhouse-ci-diagnostics.ts <container-id> <output-directory>",
  container: "ClickHouse diagnostics requires a Docker container ID",
  credential: "CLICKHOUSE_URL must be valid for diagnostics credential redaction",
};

/** Expected prerequisite errors contain fixed safe messages, never supplied values. */
export class ClickHouseDiagnosticsInputError extends Error {
  constructor(code: keyof typeof inputMessages) {
    super(inputMessages[code]);
  }
}

/** Carries only operation context and a bounded code, never the raw exception or path. */
export class ClickHouseDiagnosticsOperationError extends Error {
  constructor(
    operation: "create output directory" | "write capture artifact" | "write manifest",
    error: unknown,
  ) {
    super(`ClickHouse CI diagnostics could not ${operation} (${safeErrorCode(error)})`);
  }
}

async function writeArtifact(path: string, text: string, manifest = false): Promise<void> {
  try {
    await writeFile(path, text, { mode: 0o600 });
  } catch (error) {
    const safeError = new ClickHouseDiagnosticsOperationError(
      manifest ? "write manifest" : "write capture artifact",
      error,
    );
    captureException(safeError);
    throw safeError;
  }
}

function redactStructured(text: string, secrets: string[], jsonLines: boolean) {
  let invalid = false;
  const values = jsonLines ? text.trimEnd().split("\n").filter(Boolean) : text ? [text] : [];
  const output = values.map((line) => {
    try {
      return JSON.stringify(JSON.parse(line), (_key, value: unknown) =>
        typeof value === "string" ? redact(value, secrets, false) : value,
      );
    } catch {
      invalid = true;
      captureException(new Error("ClickHouse CI diagnostics returned invalid structured output"));
      return "[Invalid structured output redacted]";
    }
  });
  return { output: output.join("\n"), invalid };
}

/** Preserve bounded CI failure evidence without collecting container environment or SQL text. */
export async function collectClickHouseDiagnostics(options: {
  containerId: string;
  outputDirectory: string;
  credentialUrl?: string;
}): Promise<{ failures: string[] }> {
  const { containerId, outputDirectory } = options;
  if (!/^[a-f0-9]{12,64}$/i.test(containerId))
    throw new ClickHouseDiagnosticsInputError("container");
  const secrets: string[] = [];
  if (options.credentialUrl) {
    try {
      const password = new URL(options.credentialUrl).password;
      if (password) secrets.push(password, decodeURIComponent(password));
    } catch {
      const error = new ClickHouseDiagnosticsInputError("credential");
      captureException(error);
      throw error;
    }
  }
  try {
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    const safeError = new ClickHouseDiagnosticsOperationError("create output directory", error);
    captureException(safeError);
    throw safeError;
  }
  const captures: Capture[] = [];
  const commands: { name: string; args: string[] }[] = [
    { name: "container", args: ["inspect", "--format", inspectFormat, containerId] },
    {
      name: "stats",
      args: ["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", containerId],
    },
    {
      name: "docker-logs",
      args: ["logs", "--timestamps", "--tail", String(logTailLines), containerId],
    },
    {
      name: "server",
      args: [
        "exec",
        containerId,
        "tail",
        "-n",
        String(logTailLines),
        "/var/log/clickhouse-server/clickhouse-server.log",
      ],
    },
    {
      name: "server-error",
      args: [
        "exec",
        containerId,
        "tail",
        "-n",
        String(logTailLines),
        "/var/log/clickhouse-server/clickhouse-server.err.log",
      ],
    },
    ...queries.map(([name, query]) => ({
      name,
      args: [
        "exec",
        containerId,
        "sh",
        "-c",
        'exec clickhouse-client --password "$CLICKHOUSE_PASSWORD" --readonly=1 --max_execution_time=5 --max_memory_usage=67108864 --max_threads=1 --connect_timeout=5 --receive_timeout=10 --send_timeout=10 --format=JSONEachRow --query "$1"',
        "clickhouse-diagnostics",
        query,
      ],
    })),
  ];
  for (const { name, args } of commands) {
    const started = Date.now();
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: commandTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: outputLimitBytes,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const structured =
      name === "container" || name === "stats" || queries.some(([queryName]) => name === queryName);
    const parsed = structured
      ? redactStructured(result.stdout ?? "", secrets, name !== "container")
      : null;
    const stdout = parsed?.output ?? redact(result.stdout ?? "", secrets, true);
    const stderr = redact(result.stderr ?? "", secrets, true);
    const failed = result.status !== 0 || result.error !== undefined || parsed?.invalid === true;
    const error = result.error
      ? `Docker capture failed (${safeErrorCode(result.error)})`
      : parsed?.invalid
        ? "Invalid structured output"
        : null;
    captures.push({
      name,
      status: failed ? "failed" : "ok",
      exitCode: result.status,
      signal: result.signal,
      error,
      durationMs: Date.now() - started,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
    });
    await writeArtifact(join(outputDirectory, `${name}.stdout.log`), stdout);
    await writeArtifact(join(outputDirectory, `${name}.stderr.log`), stderr);
    if (failed) captureException(new Error(`ClickHouse CI diagnostics capture failed: ${name}`));
  }
  const failures = captures
    .filter((capture) => capture.status === "failed")
    .map((capture) => capture.name);
  await writeArtifact(
    join(outputDirectory, "manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        containerId,
        failures,
        captures,
        limits: {
          commandTimeoutMs,
          outputLimitBytes,
          logTailLines,
          queryLookbackMinutes: 20,
          queryExecutionSeconds: 5,
          queryMemoryBytes: 67108864,
        },
        privacy:
          "No container Env, health command/output or query text columns. Known URL password, credential URLs, authorization and labeled secrets are redacted. SQL log payloads/continuations are removed; unrecognized sensitive free text cannot be guaranteed absent.",
      },
      null,
      2,
    ),
    true,
  );
  return { failures };
}
