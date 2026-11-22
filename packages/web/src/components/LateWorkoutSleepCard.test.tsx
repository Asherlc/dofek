/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LateWorkoutSleepCard } from "./LateWorkoutSleepCard.tsx";
import { emptyLateWorkoutSleep, matchedLateWorkoutSleep } from "./late-workout-sleep-fixtures.ts";

describe("LateWorkoutSleepCard", () => {
  it("opens the latest matched night and shows timing-only evidence on selection", () => {
    render(<LateWorkoutSleepCard data={matchedLateWorkoutSleep} />);
    expect(screen.getByText("2 matched nights · 1 with measured load")).toBeTruthy();
    expect(screen.getByText(/Nov 8.*Nov 21/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View nights" }));
    expect(screen.getByText(/Night ending.*Nov 15/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Nov 10/ }));
    expect(screen.getByText("Heart-rate samples are incomplete.")).toBeTruthy();
    expect(screen.queryByText(/points/)).toBeNull();
    expect(screen.getByText("8:15 PM")).toBeTruthy();
    fireEvent.click(screen.getByText("Source records and reference nights"));
    expect(screen.getByText(/Nov 9.*Polar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Nov 18/ }));
    expect(screen.getByText("This sleep source does not provide a verified onset.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide nights" }));
    expect(screen.queryByText("This sleep source does not provide a verified onset.")).toBeNull();
  });

  it("shows a shared timing and load reason once", () => {
    const context = matchedLateWorkoutSleep.nights.find(
      (night) => night.status === "onset_unavailable",
    );
    if (!context?.reason) throw new Error("Missing the context-night reason");
    const night = { ...context, load: { ...context.load, reason: context.reason } };
    render(<LateWorkoutSleepCard data={{ ...emptyLateWorkoutSleep, nights: [night] }} />);

    fireEvent.click(screen.getByRole("button", { name: "View nights" }));
    expect(screen.getAllByText(context.reason)).toHaveLength(1);
  });

  it("makes two episodes ending on the same date distinguishable before selection", () => {
    const original = matchedLateWorkoutSleep.nights[1];
    if (!original) throw new Error("Missing the matched-night fixture");
    const alternative = {
      ...original,
      episodeId: "other-episode",
      actualOnset: "2026-11-14T23:20:00Z",
    };
    const context = {
      ...original,
      episodeId: "in-bed-episode",
      sleepProvider: "apple_health",
      status: "onset_unavailable" as const,
      actualOnset: null,
    };
    render(
      <LateWorkoutSleepCard
        data={{
          ...matchedLateWorkoutSleep,
          nights: [original, alternative, context],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View nights" }));
    expect(screen.getByRole("button", { name: /Nov 15.*10:30 PM/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Nov 15.*11:20 PM/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Nov 15.*Apple Health/ })).toBeTruthy();
  });

  it("distinguishes loading, empty, error and a refresh with usable evidence", () => {
    const { rerender } = render(<LateWorkoutSleepCard isLoading />);
    expect(screen.getByText("Loading late workout evidence.")).toBeTruthy();
    rerender(<LateWorkoutSleepCard data={emptyLateWorkoutSleep} />);
    expect(screen.getByText("No nights with sleep evidence in this period.")).toBeTruthy();
    rerender(<LateWorkoutSleepCard error={new Error("Sleep evidence is unavailable.")} />);
    expect(screen.getByText("Sleep evidence is unavailable.")).toBeTruthy();
    rerender(<LateWorkoutSleepCard data={matchedLateWorkoutSleep} isFetching />);
    expect(screen.getByText("Refreshing night evidence…")).toBeTruthy();
    expect(screen.getByText("2 matched nights · 1 with measured load")).toBeTruthy();
  });
});
