// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseAuth = vi.hoisted(() => vi.fn());
const mockUseLocation = vi.hoisted(() => vi.fn());

// Capture the component and validateSearch passed to createRootRoute so we can
// test them directly, avoiding type assertions on the mocked Route object.
const captured = vi.hoisted(() => {
  const ref: {
    component: (() => React.ReactElement) | null;
    validateSearch:
      | ((search: Record<string, unknown>) => {
          newUser?: boolean;
          providerGuide?: boolean;
          returnTo?: string;
        })
      | null;
  } = { component: null, validateSearch: null };
  return ref;
});

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: {
    component: () => React.ReactElement;
    validateSearch?: (search: Record<string, unknown>) => {
      newUser?: boolean;
      providerGuide?: boolean;
      returnTo?: string;
    };
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

vi.mock("../lib/processing-alerts-context.tsx", () => ({
  ProcessingAlertsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useActiveProcessingAlertCount: () => 0,
}));

// Import triggers createRootRoute, which captures the component.
import "./__root.tsx";

function renderAuthGate() {
  if (!captured.component) throw new Error("Component not captured from createRootRoute");
  const Component = captured.component;
  const queryClient = new QueryClient();
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <Component />
      </QueryClientProvider>,
    ),
  };
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
    expect(validate({ providerGuide: true })).toEqual({
      newUser: undefined,
      providerGuide: true,
      returnTo: undefined,
    });
  });

  it("parses string 'true' (plain query string fallback)", () => {
    expect(validate({ providerGuide: "true" })).toEqual({
      newUser: undefined,
      providerGuide: true,
      returnTo: undefined,
    });
  });

  it("parses new user marker", () => {
    expect(validate({ newUser: "true" })).toEqual({
      newUser: true,
      providerGuide: undefined,
      returnTo: undefined,
    });
  });

  it("returns undefined for missing param", () => {
    expect(validate({})).toEqual({
      newUser: undefined,
      providerGuide: undefined,
      returnTo: undefined,
    });
  });

  it("returns undefined for false", () => {
    expect(validate({ providerGuide: false })).toEqual({
      newUser: undefined,
      providerGuide: undefined,
      returnTo: undefined,
    });
  });

  it("returns undefined for string 'false'", () => {
    expect(validate({ providerGuide: "false" })).toEqual({
      newUser: undefined,
      providerGuide: undefined,
      returnTo: undefined,
    });
  });

  it("keeps safe returnTo paths", () => {
    expect(validate({ returnTo: "/onboarding" })).toEqual({
      newUser: undefined,
      providerGuide: undefined,
      returnTo: "/onboarding",
    });
  });

  it("drops external returnTo URLs", () => {
    expect(validate({ returnTo: "https://evil.test/path" })).toEqual({
      newUser: undefined,
      providerGuide: undefined,
      returnTo: undefined,
    });
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
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    renderAuthGate();

    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/login" }));
  });

  it("preserves protected route path as login returnTo", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/onboarding" });

    renderAuthGate();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/login",
      search: { returnTo: "/onboarding" },
    });
  });

  it("does not redirect authenticated user on non-login route", () => {
    mockUseAuth.mockReturnValue({ user: authenticatedUser, isLoading: false, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does not redirect while loading", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: true,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("renders loading spinner while auth is loading", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: true,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    const { container } = renderAuthGate();

    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("shows bootstrap failure instead of redirecting to login", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: "Database unavailable",
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("Database unavailable")).toBeTruthy();
  });

  it("shows bootstrap failure on public routes", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: "Database unavailable",
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("Database unavailable")).toBeTruthy();
  });

  it("lets users retry bootstrap failures", () => {
    const retryBootstrap = vi.fn();
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: "Database unavailable",
      logout: vi.fn(),
      retryBootstrap,
    });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    renderAuthGate();
    fireEvent.click(screen.getByText("Try again"));

    expect(retryBootstrap).toHaveBeenCalledOnce();
  });

  it("lets users sign out from bootstrap failures", () => {
    const logout = vi.fn();
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: "Database unavailable",
      logout,
      retryBootstrap: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    renderAuthGate();
    fireEvent.click(screen.getByText("Sign out"));

    expect(logout).toHaveBeenCalledOnce();
  });

  it("renders outlet for authenticated user", () => {
    mockUseAuth.mockReturnValue({ user: authenticatedUser, isLoading: false, logout: vi.fn() });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    const { getByTestId } = renderAuthGate();

    expect(getByTestId("outlet")).toBeTruthy();
  });

  it("clears in-memory query data when the active user changes", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "user-1", name: "Alice", email: null },
      isLoading: false,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    const { queryClient, rerender } = renderAuthGate();
    queryClient.setQueryData(["dashboard"], { readiness: "cached" });

    mockUseAuth.mockReturnValue({
      user: { id: "user-2", name: "Bob", email: null },
      isLoading: false,
      logout: vi.fn(),
    });
    const Component = captured.component;
    if (!Component) throw new Error("Component not captured from createRootRoute");
    rerender(
      <QueryClientProvider client={queryClient}>
        <Component />
      </QueryClientProvider>,
    );

    expect(queryClient.getQueryData(["dashboard"])).toBeUndefined();
  });
});
