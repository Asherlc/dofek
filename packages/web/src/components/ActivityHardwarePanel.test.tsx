/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityHardwarePanel } from "./ActivityHardwarePanel.tsx";

const data = {
  items: [
    {
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
    },
  ],
  power: [],
};
describe("ActivityHardwarePanel", () => {
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
    expect(screen.getByText("Source details")).toBeTruthy();
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
    expect(screen.getByText(/Workout app/)).toBeTruthy();
    const disclosure = screen.getByText("Device details");
    expect(disclosure.closest("details")?.open).toBe(false);
    fireEvent.click(disclosure);
    expect(disclosure.closest("details")?.open).toBe(true);
    expect(screen.getByText("ABC")).toBeTruthy();
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
