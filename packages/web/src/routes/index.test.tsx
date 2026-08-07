// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseAuth = vi.hoisted(() => vi.fn());
const mockUseSearch = vi.hoisted(() => vi.fn());

const captured = vi.hoisted(() => {
  const ref: { component: (() => React.ReactElement) | null } = { component: null };
  return ref;
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => {
    captured.component = options.component;
    return {};
  },
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  useSearch: mockUseSearch,
}));

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../pages/LandingPage.tsx", () => ({
  LandingPage: () => <div>Landing page</div>,
}));

import "./index.tsx";

function renderIndexPage() {
  if (!captured.component) throw new Error("Index route component not captured");
  const IndexPage = captured.component;
  return render(<IndexPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Index route", () => {
  it("sends authenticated new users to onboarding", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "user-1", name: "New User", email: "new@example.com" },
      isLoading: false,
    });
    mockUseSearch.mockReturnValue({ newUser: true });

    renderIndexPage();

    expect(screen.getByTestId("navigate").textContent).toBe("/onboarding");
  });

  it("sends returning authenticated users to the dashboard", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "user-1", name: "User", email: "user@example.com" },
      isLoading: false,
    });
    mockUseSearch.mockReturnValue({ newUser: undefined });

    renderIndexPage();

    expect(screen.getByTestId("navigate").textContent).toBe("/dashboard");
  });

  it("shows the landing page for signed-out users", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });
    mockUseSearch.mockReturnValue({ newUser: true });

    renderIndexPage();

    expect(screen.getByText("Landing page")).toBeTruthy();
  });
});
