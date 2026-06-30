import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  devicePriority,
  providerPriority,
  providerPriorityAudit,
  sensorDevicePriority,
  sensorProviderPriority,
} from "./schema/reference.ts";

describe("provider priority schema", () => {
  it("defines DB-owned priority tables", () => {
    expect(getTableName(providerPriority)).toBe("provider_priority");
    expect(getTableName(devicePriority)).toBe("device_priority");
    expect(getTableName(sensorProviderPriority)).toBe("sensor_provider_priority");
    expect(getTableName(sensorDevicePriority)).toBe("sensor_device_priority");
    expect(getTableName(providerPriorityAudit)).toBe("provider_priority_audit");
  });
});
