// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WhoopSensorDetails } from "./WhoopSensorDetails.tsx";

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
  it("keeps temperature visible during a failed refresh and discloses raw values on demand", () => {
    render(
      <WhoopSensorDetails
        data={data}
        isLoading={false}
        error="Upload status unavailable; try again."
      />,
    );
    expect(screen.getByText(/32.2/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Upload status unavailable; try again.",
    );
    const button = screen.getByRole("button", { name: "Raw sensor records" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("WHOOP MG")).toBeTruthy();
    expect(screen.getByText(/Thermal channel A: 294 raw/)).toBeTruthy();
  });

  it("keeps a raw-only record distinct from a measured zero temperature", () => {
    const reading = data.records[0];
    if (!reading) throw new Error("Missing sensor fixture");
    render(
      <WhoopSensorDetails
        data={{
          ...data,
          skinTemperatureC: null,
          records: [
            {
              ...reading,
              skinTemperatureC: null,
              measuredAt: null,
              layout: 22,
              fields: [],
            },
          ],
        }}
        isLoading={false}
        error={null}
      />,
    );
    expect(screen.getByText("Skin temperature unavailable")).toBeTruthy();
  });

  it("distinguishes waiting for upload from loading", () => {
    render(
      <WhoopSensorDetails
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
