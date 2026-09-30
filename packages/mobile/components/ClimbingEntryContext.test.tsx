import { climbingContextSchema } from "@dofek/training/climbing-context";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { colors } from "../theme.ts";
import { ClimbingEntryContext } from "./ClimbingEntryContext";

const context = climbingContextSchema.parse({
  providerId: "kaya",
  locationPath: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
    name,
    externalId: null,
    kind: null,
  })),
  board: { name: "Training Board", externalId: "board-1" },
  wallAngle: { value: -20, unit: null },
  climbStyle: "top-rope",
  resultStyle: "Fell/Hung",
});
describe("ClimbingEntryContext", () => {
  it("renders full locations, board, method, result and unknown angle units", () => {
    render(<ClimbingEntryContext context={context} sent={false} />);
    expect(screen.getByText("Country > State > Region > Park > Crag > Wall")).toBeTruthy();
    expect(screen.getByText("Board: Training Board")).toBeTruthy();
    expect(screen.getByText("Top rope")).toBeTruthy();
    expect(screen.getByText("Fell or hung")).toBeTruthy();
    expect(screen.getByText("Wall angle: −20 (units unknown)")).toBeTruthy();
    expect(screen.getByText("Fell or hung")).toHaveStyle({ color: colors.textSecondary });
  });
  it("renders recorded Frenchfree with unknown send status", () => {
    render(
      <ClimbingEntryContext context={{ ...context, resultStyle: "Frenchfree" }} sent={null} />,
    );
    expect(screen.getByText("Frenchfree")).toHaveStyle({ color: colors.textSecondary });
  });
  it("renders a known zero-degree angle and a successful qualifier", () => {
    render(
      <ClimbingEntryContext
        context={{ ...context, wallAngle: { value: 0, unit: "degrees" }, resultStyle: "Flash" }}
        sent={true}
      />,
    );
    expect(screen.getByText("Wall angle: 0°")).toBeTruthy();
    expect(screen.getByText("Flash")).toHaveStyle({ color: colors.positive });
  });
  it("makes a missing result explicit", () => {
    render(
      <ClimbingEntryContext
        context={{
          providerId: "openbeta",
          locationPath: [],
          board: null,
          wallAngle: null,
          climbStyle: null,
          resultStyle: null,
        }}
        sent={null}
      />,
    );
    expect(screen.getByText("Result unknown")).toBeTruthy();
  });
});

import "@testing-library/jest-dom/vitest";
