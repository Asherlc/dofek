/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportDecisionSynthesis } from "./ReportDecisionSynthesis";

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
  radius: { xl: 16 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
}));

describe("ReportDecisionSynthesis", () => {
  it("renders every server-provided decision section without interpreting values", () => {
    render(
      <ReportDecisionSynthesis
        synthesis={{
          whatChanged: ["Training increased while sleep decreased."],
          likelyAssociations: ["The changes coincided; cause and effect are not established."],
          whatWorked: ["Activity consistency improved."],
          whatToTryNext: ["Hold training steady and compare recovery next week."],
          confidenceAndMissingData: [
            "Confidence is limited because only two periods are available.",
            "Missing current-period data: resting heart rate.",
          ],
        }}
      />,
    );

    expect(screen.getByText("What changed")).toBeTruthy();
    expect(screen.getByText("Likely associations")).toBeTruthy();
    expect(screen.getByText("What worked")).toBeTruthy();
    expect(screen.getByText("What to try next")).toBeTruthy();
    expect(screen.getByText("Confidence and missing data")).toBeTruthy();
    expect(screen.getByText("Training increased while sleep decreased.")).toBeTruthy();
    expect(screen.getByText("Missing current-period data: resting heart rate.")).toBeTruthy();
  });

  it("renders repeated server strings without duplicate React keys", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ReportDecisionSynthesis
        synthesis={{
          whatChanged: ["Repeated evidence.", "Repeated evidence."],
          likelyAssociations: [],
          whatWorked: [],
          whatToTryNext: [],
          confidenceAndMissingData: [],
        }}
      />,
    );

    expect(screen.getAllByText("Repeated evidence.")).toHaveLength(2);
    expect(
      consoleError.mock.calls.some(
        ([message]) => typeof message === "string" && message.includes("same key"),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });
});
