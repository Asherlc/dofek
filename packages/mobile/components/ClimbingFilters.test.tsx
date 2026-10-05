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
  expect(screen.queryByText("Protection")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All climbing" }));
  fireEvent.click(screen.getByRole("button", { name: "Lead" }));
  fireEvent.click(screen.getByRole("button", { name: "Trad" }));
  fireEvent.click(screen.getByRole("button", { name: "Outdoor" }));
  expect(screen.getByRole("status").textContent).toBe(
    '{"style":"lead","protection":"trad","setting":"outdoor"}',
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove Trad filter" }));
  expect(screen.getByRole("status").textContent).toBe('{"style":"lead","setting":"outdoor"}');
});
