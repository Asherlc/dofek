import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hypnogram } from "./Hypnogram";

describe("Hypnogram", () => {
  it("provides a VoiceOver summary and exact sleep-stage intervals", () => {
    render(
      <Hypnogram
        data={[
          {
            stage: "deep",
            started_at: "2026-07-01T22:00:00",
            ended_at: "2026-07-01T22:30:00",
          },
          {
            stage: "rem",
            started_at: "2026-07-01T22:30:00",
            ended_at: "2026-07-01T23:00:00",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("image", {
        name: "Sleep stages. Sleep stages over the recorded sleep period.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Sleep stages data" }));
    expect(screen.getAllByText("Deep").length).toBeGreaterThan(0);
    expect(screen.getByText(/10:00 PM to 10:30 PM/)).toBeDefined();
    expect(screen.getAllByText("REM").length).toBeGreaterThan(0);
    expect(screen.getByText(/10:30 PM to 11:00 PM/)).toBeDefined();
  });
});
