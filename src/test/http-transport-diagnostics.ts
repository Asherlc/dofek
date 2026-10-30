import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { captureException } from "../lib/error-reporting.ts";
import { diagnosticOperationId, projectDiagnosticError } from "./ci-diagnostic-fields.ts";

type Transport = "local";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "OTHER";
type Context = {
  transport: Transport;
  operation: string;
  method: Method;
  operationId: number;
  started: number;
};
function safeMethod(value: unknown): Method {
  switch (value) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return value;
    default:
      return "OTHER";
  }
}
const routes: Array<[RegExp, string]> = [
  [/^\/_ping$/, "docker.ping"],
  [/^\/version$/, "docker.version"],
  [/^\/info$/, "docker.info"],
  [/^\/images\/[^/]+\/json$/, "docker.image_inspect"],
  [/^\/images\/create$/, "docker.image_create"],
  [/^\/containers\/create$/, "docker.container_create"],
  [/^\/containers\/[^/]+\/start$/, "docker.container_start"],
  [/^\/containers\/[^/]+\/json$/, "docker.container_inspect"],
  [/^\/containers\/[^/]+\/exec$/, "docker.container_exec"],
  [/^\/exec\/[^/]+\/start$/, "docker.exec_start"],
  [/^\/exec\/[^/]+\/json$/, "docker.exec_inspect"],
];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function metadata(request: Record<string, unknown>): Context | undefined {
  if (
    typeof request.host !== "string" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(request.host.toLowerCase())
  )
    return undefined;
  const transport = "local";
  const method = safeMethod(request.method);
  const path =
    typeof request.path === "string"
      ? (request.path.split("?", 1)[0]?.replace(/^\/v\d+\.\d+(?=\/)/, "") ?? "")
      : "";
  const operation = routes.find(([pattern]) => pattern.test(path))?.[1] ?? "local.http";
  return {
    transport,
    operation,
    method,
    operationId: diagnosticOperationId(),
    started: performance.now(),
  };
}
export function startHttpTransportDiagnostics(): () => void {
  const created = channel("http.client.request.created");
  const failed = channel("http.client.request.error");
  const requests = new WeakMap<object, Context>();
  let observed = 0;
  let errors = 0;
  let stopped = false;
  const reportFailure = (error: unknown) =>
    captureException(new Error("HTTP transport diagnostics failed"), {
      extra: { diagnostic: projectDiagnosticError(error) },
    });
  const onCreated = (message: unknown) => {
    try {
      if (!isRecord(message) || !isRecord(message.request)) return;
      const context = metadata(message.request);
      if (!context) return;
      requests.set(message.request, context);
      observed++;
    } catch (error) {
      reportFailure(error);
    }
  };
  const onError = (message: unknown) => {
    try {
      if (!isRecord(message) || !isRecord(message.request)) return;
      const context = requests.get(message.request);
      if (!context) return;
      errors++;
      fs.writeSync(
        1,
        `${JSON.stringify({ event: "http.request.error", timestamp: new Date().toISOString(), elapsedMs: Math.max(0, performance.now() - context.started), operationId: context.operationId, transport: context.transport, method: context.method, operation: context.operation, error: projectDiagnosticError(message.error) })}\n`,
      );
    } catch (error) {
      reportFailure(error);
    }
  };
  created.subscribe(onCreated);
  failed.subscribe(onError);
  return () => {
    if (stopped) return;
    stopped = true;
    created.unsubscribe(onCreated);
    failed.unsubscribe(onError);
    try {
      fs.writeSync(1, `${JSON.stringify({ event: "http.request.summary", observed, errors })}\n`);
    } catch (error) {
      reportFailure(error);
    }
  };
}
