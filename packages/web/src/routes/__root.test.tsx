// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseAuth = vi.hoisted(() => vi.fn());
const mockUseLocation = vi.hoisted(() => vi.fn());

// Capture the component and validateSearch passed to createRootRoute so we can
// test them directly, avoiding type assertions on the mocked Route object.
const captured = vi.hoisted(() => {
  const ref: {
    component: (() => React.ReactElement) | null;
    validateSearch: ((search: Record<string, unknown>) => { onboarding?: boolean }) | null;
  } = { component: null, validateSearch: null };
  return ref;
});

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: {
    component: () => React.ReactElement;
    validateSearch?: (search: Record<string, unknown>) => { onboarding?: boolean };
  }) => {
    captured.component = options.component;
    captured.validateSearch = options.validateSearch ?? null;
    return {};
  },
  Outlet: () => <div data-testid="outlet" />,
  redirect: vi.fn(),
  useLocation: mockUseLocation,
  useNavigate: () => mockNavigate,
}));

vi.mock("../lib/auth-context.tsx", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: mockUseAuth,
}));

// Import triggers createRootRoute, which captures the component.
import "./__root.tsx";

function renderAuthGate() {
  if (!captured.component) throw new Error("Component not captured from createRootRoute");
  const Component = captured.component;
  return render(<Component />);
}

const authenticatedUser = { id: "u1", name: "Alice", email: null };

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
});

describe("validateSearch", () => {
  function validate(search: Record<string, unknown>) {
    if (!captured.validateSearch) throw new Error("validateSearch not captured");
    return captured.validateSearch(search);
  }

  it("parses boolean true (TanStack Router default JSON parser)", () => {
    expect(validate({ onboarding: true })).toEqual({ onboarding: true });
  });

  it("parses string 'true' (plain query string fallback)", () => {
    expect(validate({ onboarding: "true" })).toEqual({ onboarding: true });
  });

  it("returns undefined for missing param", () => {
    expect(validate({})).toEqual({ onboarding: undefined });
  });

  it("returns undefined for false", () => {
    expect(validate({ onboarding: false })).toEqual({ onboarding: undefined });
  });

  it("returns undefined for string 'false'", () => {
    expect(validate({ onboarding: "false" })).toEqual({ onboarding: undefined });
  });
});

describe("AuthGate", () => {
  it("redirects authenticated user from /login to /dashboard", () => {
    mockUseAuth.mockReturnValue({ user: authenticatedUser, isLoading: false, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    renderAuthGate();

    expect(mockNavigate).toHaveBeenCalledWith({ to: "/dashboard" });
  });

  it("redirects unauthenticated user from protected route to /login", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: false, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    renderAuthGate();

    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/login" }));
  });

  it("does not redirect authenticated user on non-login route", () => {
    mockUseAuth.mockReturnValue({ user: authenticatedUser, isLoading: false, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does not redirect while loading", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("renders loading spinner while auth is loading", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    const { container } = renderAuthGate();

    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders outlet for authenticated user", () => {
    mockUseAuth.mockReturnValue({ user: authenticatedUser, isLoading: false, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    renderAuthGate();

    expect(screen.getByTestId("outlet")).toBeTruthy();
  });
});
