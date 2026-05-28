// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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
  it("renders goals and the setup checklist", () => {
    render(<OnboardingPage />);

    expect(screen.getByRole("heading", { name: "Set up Dofek" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /understand training/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /improve recovery/i })).toBeTruthy();
    expect(screen.getByText("Connect your data sources")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up data sources" }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(screen.getByRole("link", { name: "Open dashboard" }).getAttribute("href")).toBe(
      "/dashboard",
    );
  });

  it("marks a selected goal", () => {
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole("button", { name: /track nutrition/i }));

    expect(screen.getByText("Selected: Track nutrition")).toBeTruthy();
  });
});
