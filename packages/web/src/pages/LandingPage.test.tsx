// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { LandingPage, LandingPageView } from "./LandingPage.tsx";

interface MockUsableProvidersQuery {
  data: Array<{ id: string; name: string; authType: string; importOnly: boolean }>;
  isLoading: boolean;
  error: Error | null;
}

const mockUsableProvidersQuery = vi.hoisted(() =>
  vi.fn<() => MockUsableProvidersQuery>(() => ({
    data: [
      { id: "apple_health", name: "Apple Health", authType: "file-import", importOnly: true },
      { id: "strava", name: "Strava", authType: "oauth", importOnly: false },
      { id: "peloton", name: "Peloton", authType: "credential", importOnly: false },
      { id: "strong-csv", name: "Strong CSV", authType: "file-import", importOnly: true },
    ],
    isLoading: false,
    error: null,
  })),
);

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
    ...props
  }: {
    children: ReactNode;
    search?: Record<string, string>;
    to: string;
  }) => (
    <a
      href={search ? `${to}?${new URLSearchParams(Object.entries(search)).toString()}` : to}
      {...props}
    >
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
  it("shows a provider availability error instead of an empty supported-source state", () => {
    mockUsableProvidersQuery.mockReturnValueOnce({
      data: [],
      isLoading: false,
      error: new Error("Supported sources are temporarily unavailable"),
    });

    render(<LandingPage />);

    expect(screen.getByText("Supported sources are temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText(/No supported sources are currently available/i)).toBeNull();
  });

  it("keeps cached supported sources visible when their background refresh fails", () => {
    mockUsableProvidersQuery.mockReturnValueOnce({
      data: [{ id: "strava", name: "Strava", authType: "oauth", importOnly: false }],
      isLoading: false,
      error: new Error("Supported sources refresh failed"),
    });

    render(<LandingPage />);

    expect(screen.getByAltText("Strava")).toBeTruthy();
    expect(screen.getByText("Supported sources refresh failed")).toBeTruthy();
  });

  it("does not render the self-hosted privacy section", () => {
    render(<LandingPage />);
    expect(screen.queryByText("Your data. Your server. Period.")).toBeNull();
  });

  it("does not market the hosted product as self-hosted or free", () => {
    render(<LandingPage />);

    expect(screen.queryByText(/self-hosted/i)).toBeNull();
    expect(screen.queryByText(/open source health data platform/i)).toBeNull();
    expect(screen.queryByText(/free and open source/i)).toBeNull();
    expect(screen.queryByText(/\bhosted\b/i)).toBeNull();
  });

  it("does not make broad or technical integration claims", () => {
    render(<LandingPage />);

    expect(screen.queryAllByText(/30\+/i)).toHaveLength(0);
    expect(screen.queryAllByText(/7 reverse-engineered/i)).toHaveLength(0);
    expect(screen.queryAllByText(/file import/i)).toHaveLength(0);
    expect(screen.queryAllByText(/oauth/i)).toHaveLength(0);
    expect(screen.queryAllByText(/credential sync/i)).toHaveLength(0);
    expect(screen.queryAllByText(/guided auth/i)).toHaveLength(0);
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
    expect(screen.getAllByText("Supported sources").length).toBeGreaterThan(0);
  });

  it("leads with plain product copy and no demo call to action", () => {
    render(<LandingPage />);

    expect(screen.getByRole("heading", { name: /your health data, in one place/i })).toBeTruthy();
    expect(screen.getByText(/connect the apps and devices you use/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /view demo/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /view on github/i })).toBeNull();
  });

  it("sends get started links to login with the onboarding return path", () => {
    render(<LandingPage />);

    const getStartedLinks = screen.getAllByRole("link", { name: /get started/i });

    expect(getStartedLinks.length).toBeGreaterThan(0);
    expect(
      getStartedLinks.every(
        (link) => link.getAttribute("href") === "/login?returnTo=%2Fonboarding",
      ),
    ).toBe(true);
  });

  it("links to the public account deletion status and disclosure page", () => {
    render(<LandingPage />);

    expect(screen.getByRole("link", { name: "Account deletion" })).toHaveAttribute(
      "href",
      "/account-deletion",
    );
  });

  it("shows concrete analysis examples in the product preview", () => {
    render(<LandingPage />);

    expect(screen.getByText("Daily summary")).toBeTruthy();
    expect(screen.getByText("Today's recovery picture")).toBeTruthy();
    expect(screen.getByText("Health monitor")).toBeTruthy();
    expect(screen.getByText("Key correlation")).toBeTruthy();
    expect(screen.getByText("Recent trend")).toBeTruthy();
    expect(screen.queryByText("Compare sources")).toBeNull();
    expect(screen.queryByText("Connected source coverage")).toBeNull();
    expect(screen.getByText(/late dinners show up next to less consistent sleep/i)).toBeTruthy();
    expect(screen.getAllByText(/training load vs sleep/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/resting heart rate is up/i)).toBeTruthy();
    expect(screen.getByText(/log food from Slack/i)).toBeTruthy();
    expect(screen.getAllByText(/web and iPhone/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/export confidence/i)).toBeNull();

    const dailySummary = screen.getByText("Daily summary");
    const overviewRange = screen.getByText("Apr 28 - May 27");
    expect(
      dailySummary.compareDocumentPosition(overviewRange) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("formats preview units through the unit system", () => {
    render(<LandingPage />);

    expect(screen.getByText("bpm average")).toBeTruthy();
    expect(screen.getByText("407 kcal")).toBeTruthy();
    expect(screen.getByText("36.2°C")).toBeTruthy();
    expect(screen.queryByText("beats/min average")).toBeNull();
    expect(screen.queryByText("407 calories")).toBeNull();
    expect(screen.queryByText("36.2 Celsius")).toBeNull();
  });

  it("uses imperial preview temperature when the unit context is imperial", () => {
    render(
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <LandingPageView usableProviders={[]} />
      </UnitContext.Provider>,
    );

    expect(screen.getByText("97.2°F")).toBeTruthy();
    expect(screen.queryByText("36.2°C")).toBeNull();
  });

  it("shows the iPhone app with direct WHOOP strap capture", () => {
    render(<LandingPage />);

    expect(screen.getByText("iPhone app included")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /capture WHOOP strap data from iPhone/i }),
    ).toBeTruthy();
    expect(screen.getByText(/Pair a WHOOP strap over Bluetooth/i)).toBeTruthy();
    expect(screen.getByText(/does not require routing through a WHOOP membership/i)).toBeTruthy();
    expect(screen.getByText("WHOOP direct")).toBeTruthy();
    expect(screen.getByText("Motion")).toBeTruthy();
    expect(screen.getByText("Background")).toBeTruthy();
  });

  it("shows supported providers without connection method badges", () => {
    render(<LandingPage />);

    expect(screen.getAllByText("Supported").length).toBeGreaterThan(0);
    expect(screen.queryByText("OAuth")).toBeNull();
    expect(screen.queryByText("File import")).toBeNull();
    expect(screen.queryByText("Credential sync")).toBeNull();
  });

  it("includes inspection, mobile, trust, and pricing sections", () => {
    render(<LandingPage />);

    expect(screen.getByText("What you can check")).toBeTruthy();
    expect(screen.getByText("iPhone app included")).toBeTruthy();
    expect(screen.getByText("Your data stays yours")).toBeTruthy();
    expect(screen.getByText("One managed plan")).toBeTruthy();
  });

  it("renders the empty usable provider state without claiming integrations are available", () => {
    render(<LandingPageView usableProviders={[]} />);

    expect(screen.getByText(/No supported sources are currently available/i)).toBeTruthy();
  });

  it("shows public fatsecret attribution without requiring login", () => {
    render(<LandingPageView usableProviders={[]} />);

    expect(screen.getByText("Powered by fatsecret Platform API")).toBeTruthy();
  });
});
