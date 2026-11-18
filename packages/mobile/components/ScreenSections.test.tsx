import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScreenSections } from "./ScreenSections";

vi.mock("react-native", async () => {
  const web = await vi.importActual<typeof import("react-native")>("react-native-web");
  return { ...web };
});

const sections = [
  { id: "heartRate", title: "Heart Rate" },
  { id: "power", title: "Power" },
  { id: "speed", title: "Speed" },
] as const;

describe("ScreenSections compact selector", () => {
  it("opens an accessible metric dialog with a capped menu and predictable Cancel", () => {
    const onSelect = vi.fn();
    render(
      <ScreenSections
        label="Performance metrics"
        sections={sections}
        selected="heartRate"
        compact
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Performance metrics: Heart Rate" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    screen.getByRole("dialog", { name: "Performance metrics" });
    expect(screen.getByRole("radio", { name: "Heart Rate" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
