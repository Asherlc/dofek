import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

const { default: OnboardingScreen } = await import("./onboarding");

describe("OnboardingScreen", () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
  });

  it("renders shared goals and setup steps", () => {
    render(<OnboardingScreen />);

    expect(screen.getByText("Set up Dofek")).toBeTruthy();
    expect(screen.getByText("Understand training")).toBeTruthy();
    expect(screen.getByText("Improve recovery")).toBeTruthy();
    expect(screen.getByText("Connect your data sources")).toBeTruthy();
    expect(screen.getByText("Review your first insight")).toBeTruthy();
  });

  it("navigates to provider setup", () => {
    render(<OnboardingScreen />);

    fireEvent.click(screen.getByText("Set up data sources"));

    expect(mockRouterPush).toHaveBeenCalledWith("/providers");
  });

  it("marks a selected goal", () => {
    render(<OnboardingScreen />);

    fireEvent.click(screen.getByText("Track nutrition"));

    expect(screen.getByText("Selected: Track nutrition")).toBeTruthy();
  });
});
