/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { Pressable, Text } from "react-native";
import { afterEach, describe, expect, it } from "vitest";
import { TrainingProgressionStatusCard } from "./TrainingProgressionStatusCard";

afterEach(cleanup);

describe("TrainingProgressionStatusCard", () => {
  it("shows the Ready to progress badge with the headline and evidence summary", () => {
    render(
      <TrainingProgressionStatusCard
        status="ready"
        headline="Bench press · Barbell"
        summary="More reps at the same weight"
      />,
    );
    expect(screen.getByText("Ready to progress")).toBeTruthy();
    expect(screen.getByText("Bench press · Barbell")).toBeTruthy();
    expect(screen.getByText("More reps at the same weight")).toBeTruthy();
  });

  it("shows the Stagnating badge", () => {
    render(
      <TrainingProgressionStatusCard
        status="stagnating"
        headline="Squat · Barbell"
        summary="Estimated strength held steady across 7 comparable sessions."
      />,
    );
    expect(screen.getByText("Stagnating")).toBeTruthy();
  });

  it("omits the badge when there is no readiness status", () => {
    render(
      <TrainingProgressionStatusCard
        status={null}
        headline="Bench press · Barbell"
        summary="More reps at the same weight"
      />,
    );
    expect(screen.queryByText("Ready to progress")).toBeNull();
    expect(screen.queryByText("Stagnating")).toBeNull();
    expect(screen.getByText("More reps at the same weight")).toBeTruthy();
  });

  it("renders disclosed evidence and an optional link action", () => {
    render(
      <TrainingProgressionStatusCard
        status="ready"
        headline="Overview"
        summary="Ready to progress"
        details={<Text>Nov 20, 2026 · 60 kg · 10 reps</Text>}
        action={
          <Pressable accessibilityRole="link" onPress={() => {}}>
            <Text>See strength evidence</Text>
          </Pressable>
        }
      />,
    );
    expect(screen.getByText("Nov 20, 2026 · 60 kg · 10 reps")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See strength evidence" })).toBeTruthy();
  });

  it("labels the heading separately so nested disclosure and link controls stay reachable", () => {
    const { container } = render(
      <TrainingProgressionStatusCard
        status="ready"
        headline="Overview"
        summary="Ready to progress"
        details={<Text>Nov 20, 2026 · 60 kg · 10 reps</Text>}
        action={
          <Pressable accessibilityRole="link" onPress={() => {}}>
            <Text>See strength evidence</Text>
          </Pressable>
        }
      />,
    );

    // The card container must not group its children into one accessibility
    // element, otherwise VoiceOver cannot reach the link or disclosure below.
    expect(container.querySelector('[data-accessible="true"]')).toBeNull();
    // Visibility and copy stay unchanged; the status context moves to the
    // heading and the badge keeps its own label.
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByLabelText("Training progression status: Overview")).toBeTruthy();
    expect(screen.getByLabelText("Training status: Ready to progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See strength evidence" })).toBeTruthy();
  });
});
