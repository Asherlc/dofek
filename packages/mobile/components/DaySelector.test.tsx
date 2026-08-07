// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) => React.createElement("div", {}, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", {}, children),
  TouchableOpacity: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    children?: React.ReactNode;
    onPress?: () => void;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "aria-checked": accessibilityState?.checked,
        onClick: onPress,
        role: accessibilityRole,
      },
      children,
    ),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
}));

vi.mock("../theme", () => ({
  colors: {
    surface: "#1a1a1a",
    accent: "#0af",
    text: "#fff",
    textSecondary: "#999",
  },
}));

import { DaySelector, DEFAULT_DAY_OPTIONS } from "./DaySelector";

describe("DaySelector", () => {
  it("renders all default options", () => {
    render(<DaySelector days={30} description="Recent changes." onChange={vi.fn()} />);
    for (const opt of DEFAULT_DAY_OPTIONS) {
      expect(screen.getByText(opt.label)).toBeTruthy();
    }
  });

  it("calls onChange with the selected value", () => {
    const onChange = vi.fn();
    render(<DaySelector days={30} description="Recent changes." onChange={onChange} />);
    fireEvent.click(screen.getByText("7d"));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("exposes the selected range as a checked radio", () => {
    render(<DaySelector days={30} description="Recent changes." onChange={vi.fn()} />);

    expect(screen.getByRole("radio", { name: "30d" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "7d" }).getAttribute("aria-checked")).toBe("false");
  });

  it("renders custom options when provided", () => {
    const options = [
      { label: "1w", value: 7 },
      { label: "1m", value: 30 },
    ];
    render(
      <DaySelector days={7} description="Recent changes." onChange={vi.fn()} options={options} />,
    );
    expect(screen.getByText("1w")).toBeTruthy();
    expect(screen.getByText("1m")).toBeTruthy();
    expect(screen.queryByText("14d")).toBeNull();
  });

  it("visibly explains why the selected domain uses its default period", () => {
    render(
      <DaySelector
        days={90}
        description="Recommended default: 90 days balances recent training changes with enough history."
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Recommended default: 90 days balances recent training changes with enough history.",
      ),
    ).toBeTruthy();
  });
});
