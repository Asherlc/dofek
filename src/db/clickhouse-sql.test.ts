import { describe, expect, it, vi } from "vitest";

const fileReadMock = vi.hoisted(() =>
  vi.fn((_fileUrl: URL, _encoding: BufferEncoding) => "SELECT {{ value }}"),
);

vi.mock("node:fs", () => ({
  readFileSync: fileReadMock,
}));

const { loadClickHouseSql } = await import("./clickhouse-sql.ts");

describe("loadClickHouseSql", () => {
  it("caches SQL templates after the first read", () => {
    expect(loadClickHouseSql("query.sql", { value: "1" })).toBe("SELECT 1");
    expect(loadClickHouseSql("query.sql", { value: "2" })).toBe("SELECT 2");
    expect(fileReadMock).toHaveBeenCalledTimes(1);
  });
});
