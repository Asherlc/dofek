import { UnitConverter } from "@dofek/format/units";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWhoopCaptureStats } from "../lib/whoop-ble-test-helpers";
import { getDataPathStats } from "../modules/whoop-ble";
import { WhoopSensorDetails, WhoopSensorPanel } from "./WhoopSensorDetails";

const snapshotError = vi.hoisted<{ value: Error | null }>(() => ({ value: null }));

vi.mock("../lib/units", () => ({ useUnitConverter: () => new UnitConverter("metric") }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    whoopBleSync: {
      sensorSnapshot: {
        useQuery: () => ({
          data: {
            latestReceivedAt: null,
            latestMeasuredAt: null,
            skinTemperatureC: null,
            records: [],
          },
          isLoading: false,
          error: snapshotError.value,
        }),
      },
    },
  },
}));

const data = {
  latestReceivedAt: "2026-10-30T12:00:00.000Z",
  latestMeasuredAt: "2026-03-29T15:28:11.430Z",
  skinTemperatureC: 32.18,
  records: [
    {
      captureId: "1087b7ac-fc32-4c29-8b31-72e366dc974d",
      deviceId: "strap-a",
      deviceInfo: { name: "WHOOP MG" },
      receivedAt: "2026-10-30T12:00:00.000Z",
      measuredAt: "2026-03-29T15:28:11.430Z",
      packetType: 47,
      layout: 18,
      skinTemperatureC: 32.18,
      interpretation: "Temperature calibration unverified.",
      rawFrameHex: "aa01",
      fields: [{ label: "Thermal channel A", value: 294, unit: "raw" }],
    },
  ],
};

describe("WHOOP background sensor details", () => {
  afterEach(() => {
    vi.useRealTimers();
    snapshotError.value = null;
  });

  it("shows both the snapshot server error and the independent local queue error", async () => {
    snapshotError.value = new Error("Sensor records could not be loaded. Pull to refresh.");
    vi.mocked(getDataPathStats).mockImplementationOnce(() => {
      throw new Error("Queue unavailable");
    });
    render(<WhoopSensorPanel />);

    expect(await screen.findByText(/Local sensor queue could not be read/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(snapshotError.value.message);
    expect(screen.getByRole("alert").textContent).toContain(
      "Local sensor queue could not be read. Retrying automatically.",
    );
  });

  it("reports automatic retries after a local queue read failure and recovers", async () => {
    vi.useFakeTimers();
    vi.mocked(getDataPathStats).mockImplementationOnce(() => {
      throw new Error("Queue unavailable");
    });
    render(<WhoopSensorPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByText("Local sensor queue could not be read. Retrying automatically."),
    ).toBeTruthy();

    const stats = makeWhoopCaptureStats();
    stats.buffers.sensorRecords.receivedCount = 11;
    vi.mocked(getDataPathStats).mockReturnValueOnce(stats);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText(/Captured on this phone: 11/)).toBeTruthy();
    expect(
      screen.queryByText("Local sensor queue could not be read. Retrying automatically."),
    ).toBeNull();
  });
  it("retains temperature on refresh error and reveals raw sensor records", () => {
    render(
      <WhoopSensorDetails
        units={new UnitConverter("metric")}
        data={data}
        isLoading={false}
        error="Upload status unavailable; try again."
      />,
    );
    expect(screen.getByText(/32.2/)).toBeTruthy();
    expect(screen.getByText("Upload status unavailable; try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Raw sensor records" }));
    expect(screen.getByText("WHOOP MG")).toBeTruthy();
    expect(screen.getByText(/Thermal channel A: 294 raw/)).toBeTruthy();
  });

  it("reads capture progress from the native queue", async () => {
    const stats = makeWhoopCaptureStats();
    stats.buffers.sensorRecords.receivedCount = 9;
    stats.buffers.sensorRecords.count = 4;
    stats.buffers.sensorRecords.confirmedCount = 5;
    vi.mocked(getDataPathStats).mockReturnValueOnce(stats);
    render(<WhoopSensorPanel />);
    expect(
      await screen.findByText("Captured on this phone: 9 · Queued: 4 · Uploaded: 5"),
    ).toBeTruthy();
  });

  it("shows locally captured and queued records before the first upload", () => {
    render(
      <WhoopSensorDetails
        units={new UnitConverter("metric")}
        data={{
          latestReceivedAt: null,
          latestMeasuredAt: null,
          skinTemperatureC: null,
          records: [],
        }}
        isLoading={false}
        error={null}
        localCapture={{ receivedCount: 7, count: 7, confirmedCount: 0 }}
      />,
    );
    expect(screen.getByText("Captured on this phone: 7 · Queued: 7 · Uploaded: 0")).toBeTruthy();
    expect(screen.getByText("No background sensor records uploaded yet.")).toBeTruthy();
  });

  it("shows an empty upload state without a loading indicator", () => {
    render(
      <WhoopSensorDetails
        units={new UnitConverter("metric")}
        data={{
          latestReceivedAt: null,
          latestMeasuredAt: null,
          skinTemperatureC: null,
          records: [],
        }}
        isLoading={false}
        error={null}
      />,
    );
    expect(screen.getByText("No background sensor records uploaded yet.")).toBeTruthy();
  });
});
