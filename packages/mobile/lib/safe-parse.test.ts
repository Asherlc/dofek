import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mockCaptureException = vi.fn();
vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { safeParseData, safeParseRows } from "./safe-parse";

const testSchema = z.object({
  id: z.string(),
  value: z.number(),
});

describe("safeParseRows", () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
  });

  it("returns parsed data on success", () => {
    const result = safeParseRows(testSchema, [{ id: "a", value: 1 }], "test");
    expect(result.data).toEqual([{ id: "a", value: 1 }]);
    expect(result.error).toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("returns empty array and error on parse failure", () => {
    const result = safeParseRows(testSchema, [{ id: 123, value: "bad" }], "test");
    expect(result.data).toEqual([]);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("test: Zod parse failed");
  });

  it("reports parse failures to Sentry", () => {
    safeParseRows(testSchema, [{ id: 123 }], "myContext");
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(mockCaptureException.mock.calls[0][1]).toHaveProperty("context", "myContext");
  });

  it("reports null input as a parse failure", () => {
    const result = safeParseRows(testSchema, null, "test");
    expect(result.data).toEqual([]);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("test: Zod parse failed");
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("handles empty array input", () => {
    const result = safeParseRows(testSchema, [], "test");
    expect(result.data).toEqual([]);
    expect(result.error).toBeNull();
  });
});

describe("safeParseData", () => {
  it("returns one parsed object on success", () => {
    const result = safeParseData(testSchema, { id: "a", value: 1 }, "test");

    expect(result.data).toEqual({ id: "a", value: 1 });
    expect(result.error).toBeNull();
  });

  it("reports an invalid object and returns no data", () => {
    const result = safeParseData(testSchema, { id: 123, value: "bad" }, "test");

    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(Error);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
