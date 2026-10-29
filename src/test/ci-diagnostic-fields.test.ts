import { describe, expect, it } from "vitest";
import { projectDiagnosticError, queryLogDiagnostic } from "./ci-diagnostic-fields.ts";

describe("CI diagnostic fields", () => {
  it("projects only allowed causal fields and bounded source locations", () => {
    const cause = Object.assign(new Error("password=secret"), {
      code: "EPIPE",
      syscall: "write",
      stack: `Error: token=secret\n    at secret (/private/password?token=secret:1:2)\n    at secret (${process.cwd()}/src/db/seed-dev-db.integration.test.ts:42:3)\n    at secret (node:internal/streams/writable:12:3)`,
    });
    const root = Object.assign(new Error("https://secret.invalid"), {
      code: "SECRET_TOKEN",
      syscall: "secret",
      cause,
    });
    const result = projectDiagnosticError(root);
    expect(result.errors[0]).toMatchObject({ code: "UNKNOWN", syscall: "UNKNOWN" });
    expect(result.errors[1]).toMatchObject({ code: "EPIPE", syscall: "write" });
    expect(JSON.stringify(result)).not.toMatch(/password|token|secret|https|private/);
    expect(result.errors[1]?.locations).toContain("src/db/seed-dev-db.integration.test.ts:42:3");
    expect(result.errors[1]?.locations).toContain("node:internal/streams/writable:12:3");
  });
  it("marks oversized stacks as truncated", () => {
    const error = new Error("secret");
    error.stack = `Error: secret\n${"x".repeat(70000)}`;
    const result = projectDiagnosticError(error);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("fails closed on a hostile error proxy", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("secret");
        },
      },
    );
    const result = projectDiagnosticError(hostile);
    expect(result).toEqual({ errors: [], truncated: true });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("bounds cyclic aggregate causes", () => {
    const error = new AggregateError([], "secret");
    error.errors.push(error, ...Array.from({ length: 30 }, () => new Error("secret")));
    const result = projectDiagnosticError(error);
    expect(result.truncated).toBe(true);
    expect(result.errors.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("emits only validated generated query IDs and presence", () => {
    expect(queryLogDiagnostic("00000000-0000-4000-8000-000000000001", undefined)).toMatchObject({
      event: "query_log.result",
      queryId: "00000000-0000-4000-8000-000000000001",
      type: "QueryFinish",
      rowPresent: false,
      readRowsPresent: false,
    });
    expect(() => queryLogDiagnostic("secret", { read_rows: "secret" })).toThrow();
  });
});
