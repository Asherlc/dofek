import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: capture }));

import {
  diagnosticOperationId,
  projectDiagnosticError,
  queryLogDiagnostic,
  safeErrorCode,
} from "./ci-diagnostic-fields.ts";

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

const emptyRecord = {
  name: "UNKNOWN",
  code: "UNKNOWN",
  syscall: "UNKNOWN",
  aborted: false,
  locations: [],
};
function withStack(stack: unknown) {
  return projectDiagnosticError({ stack });
}
function stackResult(stack: string) {
  return withStack(stack);
}

describe("diagnostic field contracts", () => {
  it("preserves the ancestry of dependencies nested under root node_modules", () => {
    const root = mkdtempSync(path.join(tmpdir(), "diagnostic-dependency-"));
    const file = path.join(root, "node_modules/outer/node_modules/inner/index.js");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(
        projectDiagnosticError({ stack: `Error\n    at ${file}:12:3` }).errors[0]?.locations,
      ).toEqual(["node_modules/outer/node_modules/inner/index.js:12:3"]);
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("assigns sequential numeric operation IDs", () => {
    const first = diagnosticOperationId();
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(diagnosticOperationId()).toBe(first + 1);
  });
  it.each([
    [null, "UNKNOWN"],
    [undefined, "UNKNOWN"],
    [3, "UNKNOWN"],
    [() => {}, "UNKNOWN"],
    [Object.assign(() => {}, { code: "EPIPE" }), "UNKNOWN"],
    [{ code: { toString: () => "EPIPE" } }, "UNKNOWN"],
    [{}, "UNKNOWN"],
    [{ code: 3 }, "UNKNOWN"],
    [{ code: "EPIPE" }, "EPIPE"],
    [{ code: "1CODE" }, "UNKNOWN"],
    [{ code: "lower" }, "UNKNOWN"],
    [{ code: "E-PIPE" }, "UNKNOWN"],
    [{ code: "A".repeat(40) }, "A".repeat(40)],
    [{ code: "A".repeat(41) }, "UNKNOWN"],
    [{ code: " EPIPE" }, "UNKNOWN"],
    [{ code: "EPIPE!" }, "UNKNOWN"],
  ])("applies the bounded collector code contract", (value, expected) => {
    expect(safeErrorCode(value)).toBe(expected);
  });
  it("handles missing, non-string, and unreadable stacks safely", () => {
    expect(withStack(undefined)).toEqual({ errors: [emptyRecord], truncated: false });
    expect(withStack(42)).toEqual({ errors: [emptyRecord], truncated: false });
    const error = new Error("private message");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("private getter");
      },
    });
    capture.mockClear();
    expect(projectDiagnosticError(error)).toEqual({
      errors: [{ ...emptyRecord, name: "Error" }],
      truncated: false,
    });
    expect(capture).toHaveBeenCalledWith(new Error("CI diagnostic stack could not be read"));
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private");
  });
  it("validates frame grammar and bounds", () => {
    const file = path.join(process.cwd(), "src/db/seed-dev-db.integration.test.ts");
    const prefix = "src/db/seed-dev-db.integration.test.ts";
    const frame = (line: string) => `Error\n${line}`;
    expect(
      stackResult(frame(`    at fn (${file}:123:45)\n    at ${file}:12345678:87654321`)),
    ).toEqual({
      errors: [{ ...emptyRecord, locations: [`${prefix}:123:45`, `${prefix}:12345678:87654321`] }],
      truncated: false,
    });
    for (const bad of [
      `${file}:123456789:1`,
      `${file}:1:123456789`,
      `${file}:1:2junk`,
      `${file}:a:2`,
      `${file}?token=secret:1:2`,
      `${file}#secret:1:2`,
      `${file}\\secret:1:2`,
    ]) {
      expect(stackResult(frame(`    at ${bad}`))).toEqual({
        errors: [emptyRecord],
        truncated: false,
      });
    }
    const accepted = `Error\n${"x".repeat(65530)}`;
    expect(accepted.length).toBe(65536);
    expect(stackResult(accepted).truncated).toBe(false);
    expect(stackResult(`${accepted}x`).truncated).toBe(true);
    expect(stackResult(`${accepted}\n    at ${file}:1:2`)).toEqual({
      errors: [emptyRecord],
      truncated: true,
    });
    expect(stackResult(`Error\n${Array(100).fill("bad").join("\n")}`).truncated).toBe(false);
    expect(stackResult(`Error\n${Array(101).fill("bad").join("\n")}\n    at ${file}:1:2`)).toEqual({
      errors: [emptyRecord],
      truncated: true,
    });
  });
  it("normalizes existing origins and bounds location count", () => {
    const dir = mkdtempSync(path.join(process.cwd(), "src/test/diagnostic-paths-"));
    const outside = mkdtempSync(path.join(tmpdir(), "diagnostic-paths-"));
    const unsupported = mkdtempSync(path.join(process.cwd(), "diagnostic-source-"));
    try {
      const paths = [
        "a.mjs",
        "b.cjs",
        "c.tsx",
        "node_modules/pkg/index.js",
        "node_modules/.pnpm/pkg@1/node_modules/pkg/index.js",
        "data.txt",
        "data.ts.secret",
      ].map((name) => path.join(dir, name));
      for (const file of paths) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "");
      }
      const unsupportedFile = path.join(unsupported, "src/file.ts");
      mkdirSync(path.dirname(unsupportedFile), { recursive: true });
      writeFileSync(unsupportedFile, "");
      const outsideFile = path.join(outside, "node_modules/pkg/index.js");
      mkdirSync(path.dirname(outsideFile), { recursive: true });
      writeFileSync(outsideFile, "");
      const base = path.join(dir, "a".repeat(180), "b".repeat(180));
      mkdirSync(base, { recursive: true });
      const nameLength = 512 - base.length - 1 - 3;
      const boundary = path.join(base, `${"c".repeat(nameLength)}.ts`);
      const tooLong = path.join(base, `${"c".repeat(nameLength + 1)}.ts`);
      writeFileSync(boundary, "");
      writeFileSync(tooLong, "");
      expect(boundary.length).toBe(512);
      expect(tooLong.length).toBe(513);
      expect(
        stackResult(`Error\n    at ${boundary}:1:2\n    at ${tooLong}:3:4`).errors[0]?.locations,
      ).toEqual([`${path.relative(process.cwd(), boundary)}:1:2`]);
      const [a, b, c, dep, pnpm, text, suffix] = paths;
      const result = stackResult(
        `Error\n    at ${a}:1:2\n    at ${b}:3:4\n    at ${c}:5:6\n    at ${dep}:7:8\n    at ${pnpm}:9:10\n    at node:internal/streams/writable:11:12\n    at ${outsideFile}:1:2\n    at ${text}:1:2\n    at ${suffix}:1:2\n    at ${unsupportedFile}:1:2\n    at relative.ts:1:2\n    at ${dir}/missing.ts:1:2`,
      );
      expect(result.errors[0]?.locations).toEqual([
        `${path.relative(process.cwd(), a ?? "")}:1:2`,
        `${path.relative(process.cwd(), b ?? "")}:3:4`,
        `${path.relative(process.cwd(), c ?? "")}:5:6`,
        "node_modules/pkg/index.js:7:8",
        "node_modules/pkg/index.js:9:10",
        "node:internal/streams/writable:11:12",
      ]);
      for (const count of [11, 12, 13]) {
        const bounded = stackResult(`Error\n${Array(count).fill(`    at ${a}:1:2`).join("\n")}`);
        expect(bounded.errors[0]?.locations).toHaveLength(Math.min(count, 12));
        expect(bounded.truncated).toBe(count >= 12);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(unsupported, { recursive: true, force: true });
    }
  });
  it("traverses causes, cycles, and aggregate breadth in order", () => {
    for (const value of [null, undefined, 4, () => {}])
      expect(projectDiagnosticError(value)).toEqual({ errors: [], truncated: false });
    const cycle: { code: string; cause?: unknown } = { code: "EPIPE" };
    cycle.cause = cycle;
    expect(projectDiagnosticError(cycle)).toEqual({
      errors: [{ ...emptyRecord, code: "EPIPE" }],
      truncated: true,
    });
    const chain = (count: number) => {
      let result: unknown;
      for (let i = 0; i < count; i++) result = { code: "EPIPE", cause: result };
      return result;
    };
    expect(projectDiagnosticError(chain(8))).toEqual({
      errors: Array(8).fill({ ...emptyRecord, code: "EPIPE" }),
      truncated: false,
    });
    expect(projectDiagnosticError(chain(9))).toEqual({
      errors: Array(8).fill({ ...emptyRecord, code: "EPIPE" }),
      truncated: true,
    });
    const aggregate = (values: unknown[]) =>
      Object.assign(new AggregateError(values), { stack: undefined });
    expect(projectDiagnosticError(aggregate([{ code: "EPIPE" }, { code: "ECONNRESET" }]))).toEqual({
      errors: [
        { ...emptyRecord, name: "AggregateError" },
        { ...emptyRecord, code: "EPIPE" },
        { ...emptyRecord, code: "ECONNRESET" },
      ],
      truncated: false,
    });
    expect(projectDiagnosticError(aggregate([1, 2]))).toEqual({
      errors: [{ ...emptyRecord, name: "AggregateError" }],
      truncated: false,
    });
    expect(projectDiagnosticError(aggregate(Array(8).fill(1))).truncated).toBe(false);
    expect(projectDiagnosticError(aggregate([...Array(8).fill(1), new Error("secret")]))).toEqual({
      errors: [{ ...emptyRecord, name: "AggregateError" }],
      truncated: true,
    });
  });
  it.each([99, 100, 200, 599, 600, 200.5, "200", undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "only accepts bounded integer HTTP status",
    (status) => {
      const record = projectDiagnosticError({ status }).errors[0];
      const accepted =
        typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
      expect(record).toEqual({ ...emptyRecord, ...(accepted ? { status } : {}) });
    },
  );
  it("uses exact metadata allowlists, precedence and abort rules", () => {
    for (const name of ["Error", "TypeError", "AbortError", "AggregateError", "TimeoutError"])
      expect(projectDiagnosticError({ name }).errors[0]?.name).toBe(name);
    for (const code of [
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
    ])
      expect(projectDiagnosticError({ code }).errors[0]?.code).toBe(code);
    for (const syscall of ["write", "read", "connect", "getaddrinfo", "open", "close"])
      expect(projectDiagnosticError({ syscall }).errors[0]?.syscall).toBe(syscall);
    expect(projectDiagnosticError({ name: 1, code: 3, syscall: false })).toEqual({
      errors: [emptyRecord],
      truncated: false,
    });
    expect(
      projectDiagnosticError({
        name: "secret",
        code: "secret",
        syscall: "secret",
        statusCode: 201,
        status: 500,
      }),
    ).toEqual({ errors: [{ ...emptyRecord, status: 201 }], truncated: false });
    expect(projectDiagnosticError({ statusCode: null, status: 202 }).errors[0]).toEqual({
      ...emptyRecord,
      status: 202,
    });
    expect(projectDiagnosticError(new TypeError()).errors[0]?.name).toBe("TypeError");
    for (const input of [
      { code: "ABORT_ERR" },
      { name: "AbortError" },
      { name: "AbortError", code: "ABORT_ERR" },
    ])
      expect(projectDiagnosticError(input).errors[0]?.aborted).toBe(true);
    expect(projectDiagnosticError({}).errors[0]?.aborted).toBe(false);
  });
  it.each([
    [undefined, false, false],
    [{}, true, false],
    [{ read_rows: null }, true, false],
    [{ read_rows: 0 }, true, true],
    [{ read_rows: "private" }, true, true],
  ])("observes query row presence without values", (row, rowPresent, readRowsPresent) => {
    const id = "00000000-0000-4000-8000-000000000001";
    const result = queryLogDiagnostic(id, row);
    expect(result).toMatchObject({
      event: "query_log.result",
      queryId: id,
      type: "QueryFinish",
      rowPresent,
      readRowsPresent,
    });
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    expect(Number.isSafeInteger(result.operationId)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(() => queryLogDiagnostic(`x${id}`, row)).toThrow("Invalid diagnostic query ID");
    expect(() => queryLogDiagnostic(`${id}x`, row)).toThrow("Invalid diagnostic query ID");
  });
});
