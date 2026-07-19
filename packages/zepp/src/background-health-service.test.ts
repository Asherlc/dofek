import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  append: vi.fn(),
  collect: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  loggerLog: vi.fn(),
  loggerError: vi.fn(),
  onPerMinute: vi.fn(),
}));

vi.mock("@zos/sensor", () => ({
  BloodOxygen: class {},
  BodyTemperature: class {},
  HeartRate: class {},
  Stress: class {},
  Workout: class {},
  Time: class {
    onPerMinute(callback: () => void): void {
      serviceMocks.onPerMinute(callback);
    }
  },
}));
vi.mock("@zos/utils", () => ({
  BloodOxygen: class {},
  BodyTemperature: class {},
  HeartRate: class {},
  Stress: class {},
  Workout: class {},
  Time: class {
    onPerMinute(callback: () => void): void {
      serviceMocks.onPerMinute(callback);
    }
  },
  log: {
    getLogger: () => ({ log: serviceMocks.loggerLog, error: serviceMocks.loggerError }),
  },
}));
vi.mock("./background-health.ts", () => ({
  appendBackgroundHealthSample: serviceMocks.append,
  collectBackgroundHealthSample: serviceMocks.collect,
}));
vi.mock("./background-health-storage.ts", () => ({
  readBackgroundHealthBuffer: serviceMocks.read,
  writeBackgroundHealthBuffer: serviceMocks.write,
}));

interface ServiceConfiguration {
  onInit(): void;
  onDestroy(): void;
}

let configuration: ServiceConfiguration | undefined;

beforeAll(async () => {
  vi.stubGlobal("AppService", (value: ServiceConfiguration) => {
    configuration = value;
  });
  await import("../app-service/imu_service.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("background health app service", () => {
  it("rereads, appends, and persists the durable buffer every minute", () => {
    if (!configuration) throw new Error("app service configuration was not registered");
    const collected = { sample: { recordedAt: "now" }, activities: [] };
    const current = { samples: [], activities: [] };
    const updated = { samples: [collected.sample], activities: [] };
    serviceMocks.collect.mockReturnValue(collected);
    serviceMocks.read.mockReturnValue(current);
    serviceMocks.append.mockReturnValue(updated);

    configuration.onInit();
    expect(serviceMocks.onPerMinute).toHaveBeenCalledOnce();
    serviceMocks.onPerMinute.mock.calls[0]?.[0]();

    expect(serviceMocks.collect).toHaveBeenCalledOnce();
    expect(serviceMocks.read).toHaveBeenCalledOnce();
    expect(serviceMocks.append).toHaveBeenCalledWith(current, collected);
    expect(serviceMocks.write).toHaveBeenCalledWith(updated);
  });

  it("reports collection failures and logs shutdown", () => {
    if (!configuration) throw new Error("app service configuration was not registered");
    serviceMocks.collect.mockImplementation(() => {
      throw new Error("sensor unavailable");
    });
    configuration.onInit();
    serviceMocks.onPerMinute.mock.calls[0]?.[0]();
    expect(serviceMocks.loggerError).toHaveBeenCalled();

    configuration.onDestroy();
    expect(serviceMocks.loggerLog).toHaveBeenCalledWith("imu_service onDestroy");
  });
});
