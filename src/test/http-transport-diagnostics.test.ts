import { channel } from "node:diagnostics_channel";
import fs, { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupServer } from "msw/node";
import { afterEach, describe, expect, it, vi } from "vitest";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: capture }));

import { startHttpTransportDiagnostics } from "./http-transport-diagnostics.ts";

const created = channel("http.client.request.created");
const failed = channel("http.client.request.error");
function publish(
  request: object,
  error: unknown = Object.assign(new Error("private message"), { code: "EPIPE", syscall: "write" }),
) {
  created.publish({ request });
  failed.publish({ request, error });
}
function output() {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(fs, "writeSync").mockImplementation((_fd, text) => {
    events.push(JSON.parse(String(text)));
    return String(text).length;
  });
  return events;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("HTTP transport diagnostics", () => {
  it.each([
    ["GET", "/v1.49/_ping?token=private", "docker.ping"],
    ["GET", "/version", "docker.version"],
    ["GET", "/v1.42/info", "docker.info"],
    ["GET", "/v1.42/images/private/json", "docker.image_inspect"],
    ["POST", "/images/create?fromImage=private", "docker.image_create"],
    ["POST", "/containers/create?name=private", "docker.container_create"],
    ["POST", "/containers/private/start", "docker.container_start"],
    ["GET", "/containers/private/json", "docker.container_inspect"],
    ["POST", "/containers/private/exec", "docker.container_exec"],
    ["POST", "/exec/private/start", "docker.exec_start"],
    ["GET", "/exec/private/json", "docker.exec_inspect"],
    ["PATCH", "/private/unknown", "local.http"],
  ])(
    "classifies allowed local operation without exposing request data",
    (method, requestPath, operation) => {
      const events = output();
      const stop = startHttpTransportDiagnostics();
      try {
        publish({
          host: "localhost",
          path: requestPath,
          method,
          headers: { authorization: "private" },
          body: "private",
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          event: "http.request.error",
          transport: "local",
          method,
          operation,
          error: { errors: [{ code: "EPIPE", syscall: "write" }] },
        });
        expect(JSON.stringify(events)).not.toMatch(/private|token|socket|authorization/);
      } finally {
        stop();
      }
    },
  );
  it("observes local HTTP, excludes external requests, and preserves other subscribers on teardown", () => {
    const events = output();
    const listener = vi.fn();
    created.subscribe(listener);
    const stop = startHttpTransportDiagnostics();
    try {
      publish({ host: "127.0.0.1", path: "/private?token=private", method: "BESPOKE" });
      publish({ host: "external.example", path: "/private", method: "GET" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        transport: "local",
        operation: "local.http",
        method: "OTHER",
      });
      const liveRequest = { host: "localhost", path: "/private", method: "GET" };
      created.publish({ request: liveRequest });
      stop();
      stop();
      const count = events.length;
      failed.publish({ request: liveRequest, error: new Error("private") });
      publish({ host: "localhost", path: "/private", method: "GET" });
      expect(events).toHaveLength(count);
      expect(listener).toHaveBeenCalledTimes(4);
      expect(events.at(-1)).toMatchObject({
        event: "http.request.summary",
        observed: 2,
        errors: 1,
      });
    } finally {
      stop();
      created.unsubscribe(listener);
    }
  });
  it("counts a created request without logging successful request details", () => {
    const events = output();
    const stop = startHttpTransportDiagnostics();
    created.publish({ request: { host: "localhost", path: "/private", method: "GET" } });
    expect(events).toEqual([]);
    stop();
    expect(events).toEqual([{ event: "http.request.summary", observed: 1, errors: 0 }]);
  });
  it("reports observer getter failures without exposing their data", () => {
    output();
    const stop = startHttpTransportDiagnostics();
    try {
      const request = {
        get host(): never {
          throw new Error("private token");
        },
      };
      expect(() => created.publish({ request })).not.toThrow();
      expect(capture.mock.calls[0]?.[0]).toEqual(new Error("HTTP transport diagnostics failed"));
      expect(JSON.stringify(capture.mock.calls)).not.toMatch(/private|token/);
    } finally {
      stop();
    }
  });
  it("contains sink failure without changing the published error", () => {
    output();
    const stop = startHttpTransportDiagnostics();
    try {
      vi.mocked(fs.writeSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("private token"), { code: "EPIPE" });
      });
      const error = new Error("original private request error");
      expect(() =>
        publish({ host: "localhost", path: "/_ping", method: "GET" }, error),
      ).not.toThrow();
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]?.[0]).toEqual(new Error("HTTP transport diagnostics failed"));
      expect(JSON.stringify(capture.mock.calls)).not.toMatch(/private|token/);
    } finally {
      stop();
    }
  });
  it("observes a real Unix request failure with MSW active without changing the caller error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dofek-http-"));
    const socketPath = path.join(dir, "listener.sock");
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const msw = setupServer();
    msw.listen({ onUnhandledRequest: "bypass" });
    const events = output();
    const observedErrors: unknown[] = [];
    const observer = (message: unknown) => {
      if (typeof message === "object" && message !== null && "error" in message)
        observedErrors.push(message.error);
    };
    failed.subscribe(observer);
    const stop = startHttpTransportDiagnostics();
    try {
      const callerErrors: NodeJS.ErrnoException[] = [];
      await new Promise<void>((resolve) => {
        const req = http.request({
          socketPath,
          method: "POST",
          path: "/v1.49/containers/private/exec?token=private",
          headers: { authorization: "private" },
        });
        req.on("error", (error: NodeJS.ErrnoException) => callerErrors.push(error));
        req.once("close", resolve);
        req.end("private-body");
      });
      expect(callerErrors.length).toBeGreaterThan(0);
      expect(events).toHaveLength(callerErrors.length);
      for (const [index, error] of callerErrors.entries()) {
        expect(observedErrors[index]).toBe(error);
        expect(events[index]).toMatchObject({
          event: "http.request.error",
          transport: "local",
          operation: "docker.container_exec",
          method: "POST",
          error: {
            errors: [
              expect.objectContaining({ code: error.code === "EPIPE" ? "EPIPE" : "UNKNOWN" }),
            ],
          },
        });
      }
      expect(events.every((event) => event.operationId === events[0]?.operationId)).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/private|token|authorization|listener/);
    } finally {
      stop();
      failed.unsubscribe(observer);
      msw.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
