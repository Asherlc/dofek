/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityHardwarePanel } from "./ActivityHardwarePanel";

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
  it("discloses device facts with an accessible button", () => {
    render(<ActivityHardwarePanel data={data} />);
    expect(screen.getByText("My Watch")).toBeTruthy();
    expect(screen.queryByText("Serial number: ABC")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Device details for My Watch" }));
    expect(screen.getByText("Serial number: ABC")).toBeTruthy();
  });
  it("retains cached hardware and the server error during refetch", () => {
    render(
      <ActivityHardwarePanel data={data} error={new Error("Reconnect your provider")} loading />,
    );
    expect(screen.getByText("My Watch")).toBeTruthy();
    expect(screen.getByText("Reconnect your provider")).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });
  it("distinguishes empty and loading states", () => {
    const view = render(<ActivityHardwarePanel loading />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(<ActivityHardwarePanel data={{ items: [], power: [] }} />);
    expect(screen.getByText("No device metadata reported.")).toBeTruthy();
  });
});
