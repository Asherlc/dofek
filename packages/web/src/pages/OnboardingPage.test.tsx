// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "./OnboardingPage.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    activeOptions: _activeOptions,
    activeProps: _activeProps,
    children,
    to,
    ...props
  }: {
    activeOptions?: unknown;
    activeProps?: unknown;
    children: ReactNode;
    to: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../components/PrimaryGoalSelector.tsx", () => ({
  PrimaryGoalSelector: () => (
    <div>
      <h2>Primary goal</h2>
      <button type="button">Race preparation</button>
      <button type="button">Sleep consistency</button>
      <button type="button">Strength progression</button>
      <button type="button">Weight trend</button>
    </div>
  ),
}));

describe("OnboardingPage", () => {
  it("renders the first-run setup actions", () => {
    render(<OnboardingPage />);

    expect(screen.getByRole("heading", { name: "Set up Dofek with your real data" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Primary goal" })).toBeTruthy();
    expect(screen.getByText("Race preparation")).toBeTruthy();
    expect(screen.getByText("Sleep consistency")).toBeTruthy();
    expect(screen.getByText("Strength progression")).toBeTruthy();
    expect(screen.getByText("Weight trend")).toBeTruthy();
    expect(screen.getByText("Connect your sources")).toBeTruthy();
    expect(screen.getByText("Check your dashboard")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up data sources" }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(screen.getByRole("link", { name: "Open dashboard" }).getAttribute("href")).toBe(
      "/dashboard",
    );
    expect(screen.getByText("Get the iOS app")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open TestFlight invite" }).getAttribute("href")).toBe(
      "https://testflight.apple.com/join/FXywHr9c",
    );
  });
});
