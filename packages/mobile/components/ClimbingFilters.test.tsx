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

it("offers board choices before More filters and preserves independent facts", () => {
  const facts: Filters = { types: ["bouldering"], setting: ["indoor"], solo: [false] };
  render(<Harness initial={facts} />);
  open();
  const all = screen.getByRole("checkbox", { name: "All Board" });
  const recorded = screen.getByRole("checkbox", { name: "Board climbs" });
  const notRecorded = screen.getByRole("checkbox", { name: "No board recorded" });
  expect(all.getAttribute("aria-checked")).toBe("true");
  expect(recorded.getAttribute("aria-checked")).toBe("true");
  expect(notRecorded.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(notRecorded);
  expect(value()).toEqual({ ...facts, board: ["recorded"] });
  expect(all.getAttribute("aria-checked")).toBe("mixed");
  expect(recorded.getAttribute("aria-checked")).toBe("true");
  expect(notRecorded.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("checkbox", { name: "Outdoor" }));
  expect(value()).toEqual({ ...facts, setting: ["indoor", "outdoor"], board: ["recorded"] });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Bouldering · Indoor + Outdoor · Board climbs")).toBeTruthy();
});

it("selects or clears all board choices and retains an empty individual selection", () => {
  render(<Harness />);
  open();
  const all = screen.getByRole("checkbox", { name: "All Board" });
  const recorded = screen.getByRole("checkbox", { name: "Board climbs" });
  const notRecorded = screen.getByRole("checkbox", { name: "No board recorded" });
  fireEvent.click(recorded);
  expect(value()).toEqual({ board: ["not_recorded"] });
  expect(all.getAttribute("aria-checked")).toBe("mixed");
  fireEvent.click(notRecorded);
  expect(value()).toEqual({ board: [] });
  expect(all.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(all);
  expect(value()).toEqual({});
  expect(all.getAttribute("aria-checked")).toBe("true");
  expect(recorded.getAttribute("aria-checked")).toBe("true");
  expect(notRecorded.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(all);
  expect(value()).toEqual({ board: [] });
  expect(recorded.getAttribute("aria-checked")).toBe("false");
  expect(notRecorded.getAttribute("aria-checked")).toBe("false");
});

it("clears a board restriction with the other filters and restores combined choices", () => {
  render(<Harness initial={{ types: ["bouldering"], board: ["not_recorded"] }} />);
  expect(screen.getByText("Bouldering · All settings · No board recorded")).toBeTruthy();
  open();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(value()).toEqual({});
  expect(screen.getByRole("checkbox", { name: "All Board" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(screen.getByRole("checkbox", { name: "Board climbs" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(
    screen.getByRole("checkbox", { name: "No board recorded" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("All climbing · All settings")).toBeTruthy();
});

it("combines protection choices using the same mixed checkbox behavior as settings", () => {
  render(<Harness />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Protection used: Unknown" }));
  expect(value()).toEqual({ protectionUsed: ["sport", "trad"] });
  expect(
    screen.getByRole("checkbox", { name: "All Protection used" }).getAttribute("aria-checked"),
  ).toBe("mixed");
  fireEvent.click(screen.getByRole("checkbox", { name: "Protection used: Sport" }));
  expect(value()).toEqual({ protectionUsed: ["trad"] });
  fireEvent.click(screen.getByRole("checkbox", { name: "All Protection used" }));
  expect(value()).toEqual({});
  fireEvent.click(screen.getByRole("checkbox", { name: "All Protection used" }));
  expect(value()).toEqual({ protectionUsed: [] });
});
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
  render(<Harness initial={{ types: ["bouldering", "lead", "top_rope"] }} />);
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
  fireEvent.click(screen.getByRole("checkbox", { name: "All Solo status" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Solo status: With a belayer" }));
  expect(value()).toEqual({ types: ["lead"], setting: ["outdoor"], solo: [false] });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Solo status: With a belayer filter" }),
  );
  expect(value()).toEqual({ types: ["lead"], setting: ["outdoor"] });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(value()).toEqual({});
});
it("keeps active advanced filters visible and removable after closing the modal", () => {
  render(<Harness initial={{ solo: [false] }} />);
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
