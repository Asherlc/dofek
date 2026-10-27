// @vitest-environment jsdom

import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Modal: ({ children, visible }: { children: ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TouchableOpacity: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: "button" | "checkbox";
    accessibilityState?: { expanded?: boolean; selected?: boolean; checked?: boolean | "mixed" };
  }) =>
    accessibilityRole === "checkbox" ? (
      <input
        type="checkbox"
        aria-label={accessibilityLabel}
        aria-checked={accessibilityState?.checked}
        checked={accessibilityState?.checked === true}
        onChange={onPress}
      />
    ) : (
      <button
        type="button"
        onClick={onPress}
        aria-label={accessibilityLabel}
        aria-expanded={accessibilityState?.expanded}
        aria-pressed={accessibilityState?.selected}
      >
        {children}
      </button>
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));

import { ClimbingFilters } from "./ClimbingFilters";

afterEach(cleanup);
function Harness({ initial = {} }: { initial?: Filters }) {
  const [value, onChange] = useState(initial);
  return (
    <>
      <ClimbingFilters value={value} onChange={onChange} />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Filters ⌄" }));
}
function value() {
  return JSON.parse(screen.getByRole("status").textContent ?? "");
}
it("combines types and settings and retains them after closing", () => {
  render(<Harness />);
  expect(screen.queryByRole("checkbox", { name: "Bouldering" })).toBeNull();
  open();
  fireEvent.click(screen.getByRole("checkbox", { name: "Top rope" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Unknown setting" }));
  expect(value()).toEqual({ types: ["bouldering", "lead"], setting: ["indoor", "outdoor"] });
  expect(screen.getByRole("checkbox", { name: "All climbing" }).getAttribute("aria-checked")).toBe(
    "mixed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Bouldering + Lead · Indoor + Outdoor")).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "Bouldering" })).toBeNull();
  open();
  expect(screen.getByRole("checkbox", { name: "Lead" }).getAttribute("aria-checked")).toBe("true");
});
it("selects and clears all settings, and exposes the mixed state", () => {
  render(<Harness />);
  open();
  const all = screen.getByRole("checkbox", { name: "All settings" });
  expect(all.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("checkbox", { name: "Unknown setting" }));
  expect(all.getAttribute("aria-checked")).toBe("mixed");
  fireEvent.click(all);
  expect(value()).toEqual({});
  fireEvent.click(all);
  expect(value()).toEqual({ setting: [] });
  expect(all.getAttribute("aria-checked")).toBe("false");
});
it("keeps advanced facts independent of the primary selection and clears all filters", () => {
  render(<Harness initial={{ types: ["lead"], setting: ["outdoor"] }} />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  fireEvent.click(screen.getByRole("button", { name: "Solo status: With a belayer" }));
  expect(value()).toEqual({ types: ["lead"], setting: ["outdoor"], solo: false });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Solo status: With a belayer filter" }),
  );
  expect(value()).toEqual({ types: ["lead"], setting: ["outdoor"] });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(value()).toEqual({});
});
it("keeps active advanced filters visible and removable after closing the modal", () => {
  render(<Harness initial={{ solo: false }} />);
  expect(
    screen.getByRole("button", { name: "Remove Solo status: With a belayer filter" }),
  ).toBeTruthy();
  open();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Solo status: With a belayer filter" }),
  );
  expect(value()).toEqual({});
});
