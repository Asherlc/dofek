// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityExportDropdown } from "./ActivityExportDropdown.tsx";

afterEach(cleanup);

describe("ActivityExportDropdown", () => {
  it("disables GPS-only exports when an activity has no route", () => {
    render(<ActivityExportDropdown activityId="activity-1" hasGps={false} />);

    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(exportButton);

    expect(screen.getByRole("menu", { name: "Export activity" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "GPX" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "TCX" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "GPX" })).toHaveAttribute(
      "title",
      "This activity has no GPS track points for this format.",
    );
    expect(screen.getByRole("menuitem", { name: "CSV" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "FIT" })).toBeEnabled();
  });

  it("closes the menu when the trigger is toggled or the user clicks elsewhere", () => {
    render(<ActivityExportDropdown activityId="activity-1" hasGps />);

    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.click(exportButton);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(exportButton);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(exportButton);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(exportButton);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
