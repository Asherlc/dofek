/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { recognizedWatches } from "./ActivityHardwarePanel.fixtures.ts";
import { ActivityHardwarePanel } from "./ActivityHardwarePanel.tsx";

const watch = {
  id: "watch",
  activityId: "activity",
  providerId: "apple_health",
  sourceName: "Workout app",
  role: "recorder" as const,
  label: "My Watch",
  model: "Watch",
  manufacturer: "Apple",
  evidence: "Reported hardware",
  details: [{ label: "Serial number", value: "ABC" }],
};
const data = {
  items: [watch],
  power: [],
};
describe("ActivityHardwarePanel", () => {
  it("renders a source model token readably without using the token as its display label", () => {
    render(
      <ActivityHardwarePanel data={{ ...data, items: [{ ...watch, sourceName: "fr955" }] }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Device and sensor details" }));
    expect(screen.getByText("Source").nextElementSibling?.textContent).toBe("Forerunner 955");
  });
  it("shows recognized watch models and discloses personal names and software versions", () => {
    render(<ActivityHardwarePanel data={recognizedWatches} />);
    expect(screen.getByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toBeTruthy();
    expect(screen.getByText("Garmin Forerunner 955")).toBeTruthy();
    expect(screen.queryByText("Asher’s Apple Watch")).toBeNull();

    const disclosure = screen.getByRole("button", { name: "Device and sensor details" });
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Software").nextElementSibling?.textContent).toBe("26.6");
    expect(screen.getByText("Firmware").nextElementSibling?.textContent).toBe("21.19");
    expect(screen.getByText("Device name").nextElementSibling?.textContent).toBe(
      "Asher’s Apple Watch",
    );
    expect(screen.getByText("Source").nextElementSibling?.textContent).toBe("Workout");
    expect(screen.getAllByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toHaveLength(1);
    expect(screen.getAllByText("Garmin Forerunner 955")).toHaveLength(1);

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toBeTruthy();
    expect(screen.getByText("Garmin Forerunner 955")).toBeTruthy();
  });
  it("distinguishes source apps and coarse equipment categories", () => {
    const view = render(
      <ActivityHardwarePanel
        data={{
          ...data,
          items: data.items.map((item) => ({ ...item, role: "source" as const, label: "Zepp" })),
        }}
      />,
    );
    expect(screen.getByText(/Reported source/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    view.rerender(
      <ActivityHardwarePanel
        data={{
          ...data,
          items: data.items.map((item) => ({ ...item, role: "category" as const, label: "bike" })),
        }}
      />,
    );
    expect(screen.getByText(/Equipment category/)).toBeTruthy();
  });
  it("labels FIT file creators without claiming that they recorded the activity", () => {
    render(
      <ActivityHardwarePanel
        data={{
          ...data,
          items: data.items.map((item) => ({
            ...item,
            role: "creator" as const,
            label: "Export platform",
          })),
        }}
      />,
    );
    expect(screen.getByText(/FIT file creator/)).toBeTruthy();
    expect(screen.getByText("Export platform")).toBeTruthy();
  });
  it("shows concise hardware and discloses identifiers accessibly", () => {
    render(<ActivityHardwarePanel data={data} />);
    expect(screen.getByText("My Watch")).toBeTruthy();
    const disclosure = screen.getByRole("button", { name: "Device and sensor details" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("ABC")).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("ABC")).toBeTruthy();
    expect(screen.getByText("Workout app")).toBeTruthy();
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("ABC")).toBeNull();
  });
  it("uses one disclosure for every device and keeps matching source names concise", () => {
    render(
      <ActivityHardwarePanel
        data={{
          items: [
            { ...watch, sourceName: "My Watch" },
            {
              ...watch,
              id: "strap",
              label: "Heart rate strap",
              sourceName: "Apple Health",
              details: [{ label: "Firmware", value: "2.0" }],
            },
          ],
          power: [],
        }}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Device and sensor details" }));
    expect(screen.getAllByText("My Watch")).toHaveLength(1);
    expect(screen.getByText("ABC")).toBeTruthy();
    expect(screen.getByText("2.0")).toBeTruthy();
  });
  it("retains cached hardware while displaying a refetch error", () => {
    render(
      <ActivityHardwarePanel data={data} error={new Error("Reconnect your provider")} loading />,
    );
    expect(screen.getByText("My Watch")).toBeTruthy();
    expect(screen.getByText("Reconnect your provider")).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });
  it("distinguishes loading, empty, and errors", () => {
    const view = render(<ActivityHardwarePanel loading />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(<ActivityHardwarePanel data={{ items: [], power: [] }} />);
    expect(screen.getByText("No device metadata reported.")).toBeTruthy();
    view.rerender(<ActivityHardwarePanel error={new Error("Hardware unavailable")} />);
    expect(screen.getByText("Hardware unavailable")).toBeTruthy();
    expect(screen.queryByText("No device metadata reported.")).toBeNull();
  });
});
