// @vitest-environment jsdom

import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TouchableOpacity: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean; selected?: boolean };
  }) => (
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
it("combines primary climbing and setting choices without opening advanced filters", () => {
  function Harness() {
    const [value, onChange] = useState<Filters>({ solo: false });
    return (
      <>
        <ClimbingFilters value={value} onChange={onChange} />
        <output>{JSON.stringify(value)}</output>
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Bouldering" }));
  fireEvent.click(screen.getByRole("button", { name: "Outdoor" }));
  fireEvent.click(screen.getByRole("button", { name: "Lead" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
    solo: false,
    climbKind: "route",
    ropeMethod: "lead",
    setting: "outdoor",
  });
  fireEvent.click(screen.getByRole("button", { name: "All climbing" }));
  expect(JSON.parse(screen.getByRole("status").textContent ?? "")).toEqual({
    solo: false,
    setting: "outdoor",
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("status").textContent).toBe("{}");
});
it("starts compact, combines dimensions, and removes individual filters", () => {
  function Harness() {
    const [value, onChange] = useState<Filters>({});
    return (
      <>
        <ClimbingFilters value={value} onChange={onChange} />
        <output>{JSON.stringify(value)}</output>
      </>
    );
  }
  render(<Harness />);
  expect(screen.queryByText("Protection used")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  fireEvent.click(screen.getByRole("button", { name: "Rope method: Lead" }));
  fireEvent.click(screen.getByRole("button", { name: "Protection used: Trad" }));
  fireEvent.click(screen.getByRole("button", { name: "Outdoor" }));
  expect(screen.getByRole("status").textContent).toBe(
    '{"ropeMethod":"lead","protectionUsed":"trad","setting":"outdoor"}',
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove Protection used: Trad filter" }));
  expect(screen.getByRole("status").textContent).toBe('{"ropeMethod":"lead","setting":"outdoor"}');
});

it("retains explicit false and unknown solo selections and clears only that dimension", () => {
  function Harness() {
    const [value, onChange] = useState<Filters>({ ropeMethod: "lead", routeProtection: "sport" });
    return (
      <>
        <ClimbingFilters value={value} onChange={onChange} />
        <output>{JSON.stringify(value)}</output>
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "More filters" }));
  fireEvent.click(screen.getByRole("button", { name: "Solo status: With a belayer" }));
  expect(screen.getByRole("status").textContent).toContain('"solo":false');
  expect(screen.getByRole("button", { name: "All Solo status" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "Solo status: Unknown solo status" }));
  expect(screen.getByRole("status").textContent).toContain('"solo":null');
  expect(screen.getByRole("button", { name: "All Solo status" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: "All Solo status" }));
  expect(screen.getByRole("status").textContent).toBe(
    '{"ropeMethod":"lead","routeProtection":"sport"}',
  );
  for (const name of [
    "Climb kind",
    "Discipline",
    "Attempt scope",
    "Rope method",
    "Solo status",
    "Protection used",
    "Route protection",
    "Setting",
  ])
    expect(screen.getByText(name)).toBeTruthy();
});
