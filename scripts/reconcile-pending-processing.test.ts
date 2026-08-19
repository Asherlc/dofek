import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import {
  createProcessingReconciliationDatabaseFromEnv,
  reconcilePendingProcessingOperations,
} from "../src/processing/processing-reconciler.ts";
import { main } from "./reconcile-pending-processing.ts";

vi.mock("../src/db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: vi.fn(),
}));

vi.mock("../src/processing/processing-reconciler.ts", () => ({
  createProcessingReconciliationDatabaseFromEnv: vi.fn(),
  reconcilePendingProcessingOperations: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  init: vi.fn(),
}));

const mockedCreateClickHouseClientFromEnv = vi.mocked(createClickHouseClientFromEnv);
const mockedCreateProcessingReconciliationDatabaseFromEnv = vi.mocked(
  createProcessingReconciliationDatabaseFromEnv,
);
const mockedReconcilePendingProcessingOperations = vi.mocked(reconcilePendingProcessingOperations);
const mockedSentryCaptureException = vi.mocked(Sentry.captureException);
const mockedSentryClose = vi.mocked(Sentry.close);
const mockedSentryInit = vi.mocked(Sentry.init);

describe("reconcile-pending-processing", () => {
  let clickHouseClient: ClickHouseClient;
  let reconciliationDatabase: ReturnType<typeof createProcessingReconciliationDatabaseFromEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => undefined);
    clickHouseClient = {
      close: vi.fn().mockResolvedValue(undefined),
      command: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }),
    };
    reconciliationDatabase = { execute: vi.fn() };
    mockedCreateClickHouseClientFromEnv.mockReturnValue(clickHouseClient);
    mockedCreateProcessingReconciliationDatabaseFromEnv.mockReturnValue(reconciliationDatabase);
    mockedReconcilePendingProcessingOperations.mockResolvedValue({
      checked: 2,
      completed: 1,
      waiting: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports successful reconciliation after the bounded CDC check has persisted success", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main()).resolves.toBeUndefined();

    expect(mockedReconcilePendingProcessingOperations).toHaveBeenCalledWith({
      clickHouseClient,
      database: reconciliationDatabase,
    });
    expect(consoleLog).toHaveBeenCalledWith(
      "[processing-reconciliation] checked 2, completed 1, waiting 1",
    );
    expect(clickHouseClient.close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("reports reconciliation failures without changing CDC health state", async () => {
    const reconciliationError = new Error("ClickHouse query failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockedReconcilePendingProcessingOperations.mockRejectedValue(reconciliationError);

    await expect(main()).resolves.toBeUndefined();

    expect(mockedSentryCaptureException).toHaveBeenCalledWith(reconciliationError);
    expect(consoleError).toHaveBeenCalledWith(
      "[processing-reconciliation] Error: ClickHouse query failed",
    );
    expect(mockedSentryClose).toHaveBeenCalledWith(2_000);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("reports ClickHouse initialization failures", async () => {
    const initializationError = new Error("CLICKHOUSE_URL is required");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockedCreateClickHouseClientFromEnv.mockImplementation(() => {
      throw initializationError;
    });

    await expect(main()).resolves.toBeUndefined();

    expect(mockedSentryCaptureException).toHaveBeenCalledWith(initializationError);
    expect(consoleError).toHaveBeenCalledWith(
      "[processing-reconciliation] Error: CLICKHOUSE_URL is required",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("initializes Sentry when configured", async () => {
    process.env.SENTRY_DSN = "dsn";

    await expect(main()).resolves.toBeUndefined();

    expect(mockedSentryInit).toHaveBeenCalledWith({
      dsn: "dsn",
      skipOpenTelemetrySetup: true,
    });
  });
});
