import { createClient } from "@clickhouse/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn(),
}));

const mockCreateClient = vi.mocked(createClient);

describe("createClickHouseClientFromEnv", () => {
  beforeEach(() => {
    mockCreateClient.mockReset();
  });

  it("uses a request timeout long enough for production refresh waits", () => {
    createClickHouseClientFromEnv({
      CLICKHOUSE_URL: "http://default:secret@clickhouse:8123",
    });

    expect(mockCreateClient).toHaveBeenCalledWith({
      url: "http://default:secret@clickhouse:8123",
      request_timeout: 120_000,
      clickhouse_settings: {
        allow_experimental_nullable_tuple_type: 1,
      },
    });
  });

  it("fails loudly when CLICKHOUSE_URL is missing", () => {
    expect(() => createClickHouseClientFromEnv({})).toThrow(
      "CLICKHOUSE_URL environment variable is required",
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
