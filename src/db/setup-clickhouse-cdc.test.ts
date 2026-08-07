import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./clickhouse-cdc.ts", () => ({
  setupClickHouseCdcFromEnv: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

import { logger } from "../logger.ts";
import { setupClickHouseCdcFromEnv } from "./clickhouse-cdc.ts";
import { main } from "./setup-clickhouse-cdc.ts";

const mockSetupClickHouseCdcFromEnv = vi.mocked(setupClickHouseCdcFromEnv);
const mockLogger = vi.mocked(logger);

describe("setup-clickhouse-cdc main()", () => {
  beforeEach(() => {
    mockSetupClickHouseCdcFromEnv.mockReset().mockResolvedValue(undefined);
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
  });

  it("configures PeerDB CDC and logs success", async () => {
    await main();

    expect(mockSetupClickHouseCdcFromEnv).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[clickhouse-cdc] PeerDB raw analytics CDC mirrors are configured",
    );
  });

  it("propagates errors from setupClickHouseCdcFromEnv", async () => {
    mockSetupClickHouseCdcFromEnv.mockRejectedValue(new Error("setup failed"));

    await expect(main()).rejects.toThrow("setup failed");
  });
});
