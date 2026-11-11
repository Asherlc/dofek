import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { captureException } from "../lib/error-reporting.ts";

let nextOperationId = 0;
export function diagnosticOperationId(): number {
  return ++nextOperationId;
}

/** Existing collector contract: bounded uppercase error codes. */
export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "UNKNOWN";
}

const codes = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const allowedSystemCalls = new Set(["write", "read", "connect", "getaddrinfo", "open", "close"]);
const names = new Set(["Error", "TypeError", "AbortError", "AggregateError", "TimeoutError"]);
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function errorStack(value: object): unknown {
  try {
    return value instanceof Error ? value.stack : own(value, "stack");
  } catch {
    captureException(new Error("CI diagnostic stack could not be read"));
    return undefined;
  }
}
function stackLocations(stack: unknown): { locations: string[]; truncated: boolean } {
  if (typeof stack !== "string") return { locations: [], truncated: false };
  const result: string[] = [];
  const lines = stack.slice(0, 65536).split("\n");
  let truncated = stack.length > 65536 || lines.length > 101;
  for (const line of lines.slice(1, 101)) {
    const match = /(?:\(|\s)([^\s()]+):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const [, raw, row, column] = match;
    if (
      !raw ||
      raw.length > 512 ||
      !row ||
      !column ||
      row.length > 8 ||
      column.length > 8 ||
      /[?#%\\]/.test(raw)
    )
      continue;
    let file: string;
    if (
      [
        "node:internal/streams/writable",
        "node:internal/streams/readable",
        "node:internal/streams/destroy",
        "node:internal/process/task_queues",
        "node:internal/deps/undici/undici",
        "node:internal/net",
        "node:internal/http",
      ].includes(raw)
    )
      file = raw;
    else if (isAbsolute(raw) && existsSync(raw)) {
      const rel = relative(process.cwd(), raw);
      if (rel.startsWith("../") || isAbsolute(rel)) continue;
      const dependency = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(.+)$/.exec(rel);
      file = dependency ? `node_modules/${dependency[1]}` : rel;
    } else continue;
    if (
      !/^(?:node:internal\/[a-zA-Z0-9_./-]+|(?:src|scripts|packages|node_modules)\/[a-zA-Z0-9_@./+-]+\.(?:[cm]?[jt]s|tsx))$/.test(
        file,
      ) ||
      file.includes("..")
    )
      continue;
    result.push(`${file}:${row}:${column}`);
    if (result.length === 12) {
      truncated = true;
      break;
    }
  }
  return { locations: result, truncated };
}
function projectDiagnosticErrorFields(error: unknown) {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  const errors: Array<{
    name: string;
    code: string;
    syscall: string;
    status?: number;
    aborted: boolean;
    locations: string[];
  }> = [];
  let truncated = false;
  while (queue.length && errors.length < 8) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    if (seen.has(item)) {
      truncated = true;
      continue;
    }
    seen.add(item);
    const code = own(item, "code");
    const syscall = own(item, "syscall");
    const rawName =
      own(item, "name") ??
      (item instanceof AggregateError
        ? "AggregateError"
        : item instanceof TypeError
          ? "TypeError"
          : item instanceof Error
            ? "Error"
            : undefined);
    const status = own(item, "statusCode") ?? own(item, "status");
    const stack = stackLocations(errorStack(item));
    if (stack.truncated) truncated = true;
    errors.push({
      name: typeof rawName === "string" && names.has(rawName) ? rawName : "UNKNOWN",
      code: typeof code === "string" && codes.has(code) ? code : "UNKNOWN",
      syscall: typeof syscall === "string" && allowedSystemCalls.has(syscall) ? syscall : "UNKNOWN",
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? { status }
        : {}),
      aborted: code === "ABORT_ERR" || rawName === "AbortError",
      locations: stack.locations,
    });
    const cause = own(item, "cause");
    if (cause !== undefined) queue.push(cause);
    const aggregate = own(item, "errors");
    if (Array.isArray(aggregate)) {
      queue.push(...aggregate.slice(0, 8));
      if (aggregate.length > 8) truncated = true;
    }
  }
  if (queue.length) truncated = true;
  return { errors, truncated };
}
export function projectDiagnosticError(error: unknown) {
  try {
    return projectDiagnosticErrorFields(error);
  } catch {
    captureException(new Error("CI diagnostic error could not be projected"));
    return { errors: [], truncated: true };
  }
}
export function queryLogDiagnostic(queryId: string, row: { read_rows?: unknown } | undefined) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(queryId))
    throw new Error("Invalid diagnostic query ID");
  return {
    event: "query_log.result",
    timestamp: new Date().toISOString(),
    operationId: diagnosticOperationId(),
    queryId,
    type: "QueryFinish",
    rowPresent: row !== undefined,
    readRowsPresent: row?.read_rows != null,
  };
}
