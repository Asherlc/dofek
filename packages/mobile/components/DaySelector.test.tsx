// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) => React.createElement("div", {}, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", {}, children),
  TouchableOpacity: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
    React.createElement("button", { type: "button", onClick: onPress }, children),
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
    render(<DaySelector days={30} onChange={vi.fn()} />);
    for (const opt of DEFAULT_DAY_OPTIONS) {
      expect(screen.getByText(opt.label)).toBeTruthy();
    }
  });

  it("calls onChange with the selected value", () => {
    const onChange = vi.fn();
    render(<DaySelector days={30} onChange={onChange} />);
    fireEvent.click(screen.getByText("7d"));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("renders custom options when provided", () => {
    const options = [
      { label: "1w", value: 7 },
      { label: "1m", value: 30 },
    ];
    render(<DaySelector days={7} onChange={vi.fn()} options={options} />);
    expect(screen.getByText("1w")).toBeTruthy();
    expect(screen.getByText("1m")).toBeTruthy();
    expect(screen.queryByText("14d")).toBeNull();
  });
});
