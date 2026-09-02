import type { ProviderDataDeletionRequestStatus } from "dofek/db/provider-data-deletion";
import { describe, expect, it, vi } from "vitest";
import { readProviderDataDeletionStatus } from "./provider-data-deletion-status.ts";

const baseRequest: ProviderDataDeletionRequestStatus = {
  eventId: "30000000-0000-4000-8000-000000000001",
  failureReason: null,
  generation: 1,
  providerId: "strava",
  status: "dispatched",
  userId: "00000000-0000-4000-8000-000000000001",
};

describe("readProviderDataDeletionStatus", () => {
  it("maps durable pending, completed, and failed states without reading BullMQ", async () => {
    const getJob = vi.fn();

    await expect(
      readProviderDataDeletionStatus({ ...baseRequest, status: "pending" }, getJob),
    ).resolves.toEqual({
      status: "queued",
      message: "Provider data deletion is pending...",
    });
    await expect(
      readProviderDataDeletionStatus({ ...baseRequest, status: "completed" }, getJob),
    ).resolves.toEqual({
      status: "completed",
      percentage: 100,
      message: "Provider data deleted",
    });
    await expect(
      readProviderDataDeletionStatus(
        {
          ...baseRequest,
          failureReason: "Provider credentials were rejected",
          status: "failed",
        },
        getJob,
      ),
    ).resolves.toEqual({
      status: "failed",
      message: "Provider credentials were rejected",
    });
    expect(getJob).not.toHaveBeenCalled();
  });

  it("returns active BullMQ progress for a dispatched deletion", async () => {
    const getJob = vi.fn().mockResolvedValue({
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("active"),
      progress: { percentage: 50, message: "Checked 10,000 metric stream rows..." },
    });

    await expect(readProviderDataDeletionStatus(baseRequest, getJob)).resolves.toEqual({
      status: "running",
      percentage: 50,
      message: "Checked 10,000 metric stream rows...",
    });
  });

  it("preserves a terminal BullMQ failure while the durable failure is being recorded", async () => {
    const getJob = vi.fn().mockResolvedValue({
      failedReason: "ClickHouse batch failed",
      getState: vi.fn().mockResolvedValue("failed"),
      progress: { message: "Checking metric stream rows..." },
    });

    await expect(readProviderDataDeletionStatus(baseRequest, getJob)).resolves.toEqual({
      status: "failed",
      message: "ClickHouse batch failed",
    });
  });

  it("keeps a dispatched deletion running when its completed root job has a continuation", async () => {
    const getJob = vi.fn().mockResolvedValue({
      failedReason: undefined,
      getState: vi.fn().mockResolvedValue("completed"),
      progress: { message: "Checked 1,000 metric stream rows; deleted 1,000..." },
    });

    await expect(readProviderDataDeletionStatus(baseRequest, getJob)).resolves.toEqual({
      status: "running",
      message: "Checked 1,000 metric stream rows; deleted 1,000...",
    });
  });

  it("reports a dispatched request as queued until its BullMQ job is visible", async () => {
    await expect(
      readProviderDataDeletionStatus(baseRequest, vi.fn().mockResolvedValue(undefined)),
    ).resolves.toEqual({
      status: "queued",
      message: "Provider data deletion is pending...",
    });
  });
});
