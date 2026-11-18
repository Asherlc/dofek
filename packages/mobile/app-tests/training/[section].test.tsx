// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TrainingSectionScreen from "../../app/training/[section]";

const routeParams = vi.hoisted(() => ({ section: "hiking" }));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useIsFocused: () => true,
  useLocalSearchParams: () => routeParams,
}));

vi.mock("../../app/strain", () => ({
  TrainingAnalysis: ({ section }: { section: string }) => section,
}));

describe("Training section route", () => {
  it("opens the analysis for a supported section", () => {
    routeParams.section = "hiking";
    render(<TrainingSectionScreen />);
    expect(screen.getByText("hiking")).toBeTruthy();
  });

  it("shows an unavailable message for unknown sections", () => {
    routeParams.section = "unknown-section";
    render(<TrainingSectionScreen />);
    expect(screen.getByText("Training section unavailable")).toBeTruthy();
    expect(screen.queryByText("unknown-section")).toBeNull();
  });
});
