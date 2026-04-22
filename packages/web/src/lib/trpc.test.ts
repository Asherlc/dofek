import { beforeEach, describe, expect, it, vi } from "vitest";

const httpBatchStreamLinkMock = vi.fn((options: unknown) => ({
  type: "stream",
  options,
}));
const httpBatchLinkMock = vi.fn((options: unknown) => ({
  type: "batch",
  options,
}));
const splitLinkMock = vi.fn((options: unknown) => ({
  type: "split",
  options,
}));
const createClientMock = vi.fn(() => ({
  __type: "mock-client",
}));

vi.mock("@trpc/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@trpc/client")>();
  return {
    ...original,
    httpBatchStreamLink: httpBatchStreamLinkMock,
    httpBatchLink: httpBatchLinkMock,
    splitLink: splitLinkMock,
  };
});

vi.mock("@trpc/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@trpc/react-query")>();
  return {
    ...original,
    createTRPCReact: vi.fn(() => ({ createClient: createClientMock })),
  };
});

describe("createTRPCClient", () => {
  beforeEach(() => {
    httpBatchStreamLinkMock.mockClear();
    httpBatchLinkMock.mockClear();
    splitLinkMock.mockClear();
    createClientMock.mockClear();
  });

  it("routes mutations through non-stream batching", async () => {
    const { createTRPCClient } = await import("./trpc.ts");

    createTRPCClient();

    expect(httpBatchStreamLinkMock).toHaveBeenCalledTimes(1);
    expect(httpBatchLinkMock).toHaveBeenCalledTimes(1);
    expect(splitLinkMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);

    const splitOptions = splitLinkMock.mock.calls[0]?.[0];
    expect(splitOptions).toMatchObject({
      true: { type: "batch" },
      false: { type: "stream" },
    });

    const condition =
      typeof splitOptions === "object" && splitOptions !== null
        ? Reflect.get(splitOptions, "condition")
        : undefined;
    expect(typeof condition).toBe("function");
    if (typeof condition !== "function") {
      throw new Error("splitLink condition must be a function");
    }
    expect(condition({ type: "mutation" })).toBe(true);
    expect(condition({ type: "query" })).toBe(false);
  });
});
