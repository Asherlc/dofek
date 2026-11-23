import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StrengthProgressionEvidence } from "./StrengthProgressionEvidence";
import { repImprovementRow } from "./training-progression-fixture";

afterEach(cleanup);

it("keeps dated recorded sets behind a disclosure until opened", () => {
  render(
    <StrengthProgressionEvidence row={repImprovementRow} units={new UnitConverter("metric")} />,
  );
  expect(screen.queryByText(/Nov 20, 2026/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "See recorded sets" }));

  expect(screen.getByText(/Nov 20, 2026 · 10 reps at 60.0 kg/)).toBeTruthy();
  expect(screen.getByText(/Nov 3, 2026 · 8 reps at 60.0 kg/)).toBeTruthy();
  expect(screen.getAllByText(/WHOOP \(Cloud\)/).length).toBe(2);
});

it("marks the disclosure expanded so assistive technology can follow it", () => {
  render(
    <StrengthProgressionEvidence row={repImprovementRow} units={new UnitConverter("metric")} />,
  );
  const toggle = screen.getByRole("button", { name: "See recorded sets" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(
    screen.getByRole("button", { name: "See recorded sets" }).getAttribute("aria-expanded"),
  ).toBe("true");
});
