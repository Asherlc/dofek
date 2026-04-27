// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage, LandingPageView } from "./LandingPage.tsx";

const mockUsableProvidersQuery = vi.hoisted(() =>
  vi.fn(() => ({
    data: [
      { id: "apple_health", name: "Apple Health", authType: "file-import", importOnly: true },
      { id: "strava", name: "Strava", authType: "oauth", importOnly: false },
      { id: "peloton", name: "Peloton", authType: "credential", importOnly: false },
      { id: "strong-csv", name: "Strong CSV", authType: "file-import", importOnly: true },
    ],
    isLoading: false,
  })),
);

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    sync: {
      usableProviders: { useQuery: mockUsableProvidersQuery },
    },
  },
}));

afterEach(cleanup);

describe("LandingPage", () => {
  it("does not render the self-hosted privacy section", () => {
    render(<LandingPage />);
    expect(screen.queryByText("Your data. Your server. Period.")).toBeNull();
  });

  it("does not market the hosted product as self-hosted or free", () => {
    render(<LandingPage />);

    expect(screen.queryByText(/self-hosted/i)).toBeNull();
    expect(screen.queryByText(/open source health data platform/i)).toBeNull();
    expect(screen.queryByText(/free and open source/i)).toBeNull();
  });

  it("does not make broad integration or availability claims", () => {
    render(<LandingPage />);

    expect(screen.queryAllByText(/30\+/i)).toHaveLength(0);
    expect(screen.queryAllByText(/7 reverse-engineered/i)).toHaveLength(0);
    expect(screen.queryAllByText(/every metric/i)).toHaveLength(0);
    expect(screen.queryAllByText(/every device/i)).toHaveLength(0);
    expect(screen.queryAllByText(/all your health data/i)).toHaveLength(0);
    expect(screen.queryAllByText(/everything you already use/i)).toHaveLength(0);
    expect(screen.queryAllByText(/probably supports/i)).toHaveLength(0);
    expect(screen.queryAllByText(/24\/7/i)).toHaveLength(0);
  });

  it("only shows provider icons returned as usable by the server", () => {
    render(<LandingPage />);

    expect(screen.getByAltText("Strava")).toBeTruthy();
    expect(screen.getByAltText("Strong")).toBeTruthy();
    expect(screen.getByAltText("Apple Health")).toBeTruthy();
    expect(screen.queryByAltText("WHOOP")).toBeNull();
    expect(screen.getByAltText("Peloton")).toBeTruthy();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getByText("Usable integrations")).toBeTruthy();
  });

  it("leads with the scattered app problem and a demo call to action", () => {
    render(<LandingPage />);

    expect(screen.getByText(/health apps don't talk to each other/i)).toBeTruthy();
    const demoLinks = screen.getAllByRole("link", { name: /view demo/i });
    expect(demoLinks.length).toBeGreaterThan(0);
    expect(demoLinks.every((link) => link.getAttribute("href") === "#demo")).toBe(true);
    expect(screen.queryByRole("link", { name: /view on github/i })).toBeNull();
  });

  it("shows concrete insight examples in the demo preview", () => {
    render(<LandingPage />);

    expect(screen.getByText(/late meals correlate with lower sleep consistency/i)).toBeTruthy();
    expect(screen.getByText(/training load is rising faster than recovery/i)).toBeTruthy();
    expect(screen.getByText(/resting heart rate has been elevated for 4 days/i)).toBeTruthy();
  });

  it("shows live provider connection method badges", () => {
    render(<LandingPage />);

    expect(screen.getByText("OAuth")).toBeTruthy();
    expect(screen.getAllByText("File import").length).toBeGreaterThan(0);
    expect(screen.getByText("Credential sync")).toBeTruthy();
  });

  it("includes before-after, week one, trust, and pricing sections", () => {
    render(<LandingPage />);

    expect(screen.getByText("Before Dofek")).toBeTruthy();
    expect(screen.getByText("After Dofek")).toBeTruthy();
    expect(screen.getByText("What you get in week one")).toBeTruthy();
    expect(screen.getByText("Hosted without the creepy parts")).toBeTruthy();
    expect(screen.getByText("Simple hosted plan")).toBeTruthy();
  });

  it("renders the empty usable provider state without claiming integrations are available", () => {
    render(<LandingPageView usableProviders={[]} />);

    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/No integrations are currently configured on this server/i),
    ).toBeTruthy();
  });
});
