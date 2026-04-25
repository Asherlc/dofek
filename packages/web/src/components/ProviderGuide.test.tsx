// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderGuide } from "./ProviderGuide.tsx";

// Mock TanStack Router Link
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const mockProviders = [
  { id: "strava", name: "Strava", authorized: false },
  { id: "garmin", name: "Garmin", authorized: false },
  { id: "oura", name: "Oura", authorized: false },
  { id: "whoop", name: "WHOOP", authorized: false },
  { id: "cronometer-csv", name: "Cronometer", authorized: false },
  { id: "withings", name: "Withings", authorized: false },
  { id: "fitbit", name: "Fitbit", authorized: false },
  { id: "ultrahuman", name: "Ultrahuman", authorized: false },
];

afterEach(() => cleanup());

describe("ProviderGuide", () => {
  it("renders welcome heading", () => {
    render(<ProviderGuide onDismiss={vi.fn()} providers={mockProviders} />);
    expect(screen.getByText("Welcome to Dofek")).toBeTruthy();
  });

  it("renders description text", () => {
    render(<ProviderGuide onDismiss={vi.fn()} providers={mockProviders} />);
    expect(screen.getByText(/Connect your health and fitness accounts/)).toBeTruthy();
  });

  it("renders category titles for categories with available providers", () => {
    render(<ProviderGuide onDismiss={vi.fn()} providers={mockProviders} />);
    expect(screen.getByText("Activity Tracking")).toBeTruthy();
    expect(screen.getByText("Sleep & Recovery")).toBeTruthy();
    expect(screen.getByText("Health Metrics")).toBeTruthy();
  });

  it("renders the set up data sources link pointing to /providers", () => {
    render(<ProviderGuide onDismiss={vi.fn()} providers={mockProviders} />);
    const link = screen.getByText("Set up data sources");
    expect(link.closest("a")?.getAttribute("href")).toBe("/providers");
  });

  it("renders skip button", () => {
    render(<ProviderGuide onDismiss={vi.fn()} providers={mockProviders} />);
    expect(screen.getByText("Skip for now")).toBeTruthy();
  });

  it("calls onDismiss when skip button is clicked", () => {
    const onDismiss = vi.fn();
    render(<ProviderGuide onDismiss={onDismiss} providers={mockProviders} />);
    fireEvent.click(screen.getByText("Skip for now"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides categories with no available providers", () => {
    // Only provide strava — no nutrition providers
    const limitedProviders = [{ id: "strava", name: "Strava", authorized: false }];
    render(<ProviderGuide onDismiss={vi.fn()} providers={limitedProviders} />);
    expect(screen.queryByText("Nutrition")).toBeNull();
  });

  it("shows provider logos for available providers in each category", () => {
    render(<ProviderGuide onDismiss={vi.fn()} providers={mockProviders} />);
    // Strava should appear in Activity Tracking
    expect(screen.getByText("Strava")).toBeTruthy();
  });
});
