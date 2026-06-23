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

describe("OnboardingPage", () => {
  it("renders the first-run setup actions", () => {
    render(<OnboardingPage />);

    expect(screen.getByRole("heading", { name: "Set up Dofek with your real data" })).toBeTruthy();
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
