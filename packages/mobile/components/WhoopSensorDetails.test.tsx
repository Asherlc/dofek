import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WhoopSensorDetails } from "./WhoopSensorDetails";

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
