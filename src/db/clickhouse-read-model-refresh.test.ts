import { describe, expect, it, vi } from "vitest";
import { refreshBodyMeasurementReadModel } from "./clickhouse-read-model-refresh.ts";

describe("refreshBodyMeasurementReadModel", () => {
  it("does not issue refresh commands for the body measurement view", async () => {
    const command = vi.fn().mockResolvedValue(undefined);

    await refreshBodyMeasurementReadModel({ command });

    expect(command).not.toHaveBeenCalled();
  });
});
