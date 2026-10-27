// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryContext } from "./ClimbingLogEntryContext.tsx";

it("renders the recorded board with unknown angle units", () => {
  const entry = climbingLogEntryFixture({
    climb: climbingClimbFixture(),
    board: { name: "Training Board", externalId: null },
    wallAngle: { value: -20, unit: null },
  });
  render(<ClimbingLogEntryContext entry={entry} />);
  expect(screen.getByText("Board: Training Board")).toBeTruthy();
  expect(screen.getByText("Wall angle: −20 (units unknown)")).toBeTruthy();
});
it("renders a recorded zero-degree angle", () => {
  render(
    <ClimbingLogEntryContext
      entry={climbingLogEntryFixture({ wallAngle: { value: 0, unit: "degrees" } })}
    />,
  );
  expect(screen.getByText("Wall angle: 0°")).toBeTruthy();
});
