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

  it("renders first-run setup actions", () => {
    render(<OnboardingScreen />);

    expect(screen.getByText("Set up Dofek with your real data")).toBeTruthy();
    expect(screen.getByText("Connect your sources")).toBeTruthy();
    expect(screen.getByText("Check your dashboard")).toBeTruthy();
  });

  it("exposes setup navigation as named accessibility actions", () => {
    render(<OnboardingScreen />);

    const setupButton = screen.getByRole("button", { name: "Set up data sources" });
    const dashboardButton = screen.getByRole("button", { name: "Open dashboard" });

    expect(setupButton.getAttribute("aria-label")).toBe("Set up data sources");
    expect(dashboardButton.getAttribute("aria-label")).toBe("Open dashboard");
  });

  it("navigates to provider setup", () => {
    render(<OnboardingScreen />);

    fireEvent.click(screen.getByText("Set up data sources"));

    expect(mockRouterPush).toHaveBeenCalledWith("/providers");
  });
});
