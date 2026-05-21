import { describe, expect, it, vi } from "vitest";
import { refreshBodyMeasurementReadModel } from "./clickhouse-read-model-refresh.ts";

describe("refreshBodyMeasurementReadModel", () => {
  it("refreshes and waits for the body measurement read model", async () => {
    const command = vi.fn().mockResolvedValue(undefined);

    await refreshBodyMeasurementReadModel({ command });

    expect(command).toHaveBeenNthCalledWith(1, {
      query: "SYSTEM REFRESH VIEW analytics.v_body_measurement",
    });
    expect(command).toHaveBeenNthCalledWith(2, {
      query: "SYSTEM WAIT VIEW analytics.v_body_measurement",
    });
  });
});
