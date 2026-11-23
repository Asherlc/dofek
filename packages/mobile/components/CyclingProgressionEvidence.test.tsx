import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CyclingProgressionEvidence } from "./CyclingProgressionEvidence";
import { cyclingProgressionFixture } from "./CyclingProgressionEvidence.stories";

afterEach(cleanup);

it("keeps both dated rides behind an accessible disclosure until opened", () => {
  render(<CyclingProgressionEvidence result={cyclingProgressionFixture} />);
  expect(screen.queryByText(/Selected ride/)).toBeNull();

  const toggle = screen.getByRole("button", { name: "See interval evidence" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);

  expect(
    screen.getByRole("button", { name: "See interval evidence" }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.getByText(/Selected ride/)).toBeTruthy();
  expect(screen.getByText(/Comparison ride/)).toBeTruthy();
  expect(screen.getAllByText(/Session effort: 4\/10/)).toHaveLength(2);
  expect(screen.getAllByText(/220 W/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Measured power:/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/2m 0s/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/2m 5s/).length).toBeGreaterThan(0);
});
