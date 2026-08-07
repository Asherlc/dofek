import { fireEvent, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { describe, expect, it } from "vitest";
import { AccessibleChart } from "./AccessibleChart";

describe("AccessibleChart", () => {
  it("exposes a concise VoiceOver summary and exact values", () => {
    render(
      <AccessibleChart
        title="Heart rate"
        summary="Heart rate over the recorded sample sequence."
        rows={[{ label: "Sample 1", value: "72 beats per minute" }]}
      >
        <Text>visual-only chart</Text>
      </AccessibleChart>,
    );

    expect(
      screen.getByRole("image", {
        name: "Heart rate. Heart rate over the recorded sample sequence.",
      }),
    ).toBeDefined();
    expect(screen.getByText("Heart rate over the recorded sample sequence.")).toBeDefined();
    expect(screen.getByText("visual-only chart")).toBeDefined();
  });

  it("reveals exact values through an operable list", () => {
    render(
      <AccessibleChart
        title="Heart rate"
        summary="Heart rate over the recorded sample sequence."
        rows={[
          { label: "Sample 1", value: "72 beats per minute" },
          { label: "Sample 2", value: "74 beats per minute" },
        ]}
      >
        <Text>chart</Text>
      </AccessibleChart>,
    );

    const button = screen.getByRole("button", { name: "View Heart rate data" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("72 beats per minute")).toBeNull();

    fireEvent.click(button);

    expect(
      screen
        .getByRole("button", {
          name: "Hide Heart rate data",
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("Sample 1")).toBeDefined();
    expect(screen.getByText("72 beats per minute")).toBeDefined();
    expect(screen.getByText("Sample 2")).toBeDefined();
    expect(screen.getByText("74 beats per minute")).toBeDefined();
  });
});
