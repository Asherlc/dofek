// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockUseAuth = vi.hoisted(() => vi.fn());
const mockUseLocation = vi.hoisted(() => vi.fn());
const mockInstallAccountPurgeListener = vi.hoisted(() => vi.fn(() => vi.fn()));

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

vi.mock("../lib/account-erasure-purge.ts", () => ({
  installWebAccountPurgeListener: mockInstallAccountPurgeListener,
}));

vi.mock("../lib/processing-alerts-context.tsx", () => ({
  ProcessingAlertsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useActiveProcessingAlertCount: () => 0,
}));

vi.mock("../components/UnitProvider.tsx", () => ({
  UnitProvider: ({
    children,
    settingsEnabled,
  }: {
    children: React.ReactNode;
    settingsEnabled: boolean;
  }) => (
    <div data-testid="unit-provider" data-settings-enabled={String(settingsEnabled)}>
      {children}
    </div>
  ),
}));

vi.mock("../components/DashboardLayoutProvider.tsx", () => ({
  DashboardLayoutProvider: ({
    children,
    settingsEnabled,
  }: {
    children: React.ReactNode;
    settingsEnabled: boolean;
  }) => (
    <div data-testid="dashboard-layout-provider" data-settings-enabled={String(settingsEnabled)}>
      {children}
    </div>
  ),
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

  it.each([
    "/privacy",
    "/support",
    "/terms",
  ])("allows an unauthenticated user to read the legal route %s", (pathname) => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname });

    const { getByTestId } = renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getByTestId("outlet")).toBeTruthy();
  });

  it("allows an unauthenticated tokenized health report link", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({
      pathname: "/health-report",
      href: "/health-report?token=shared-token",
    });

    const { getByTestId } = renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getByTestId("outlet")).toBeTruthy();
  });

  it("allows the public account deletion status route without a session", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/account-deletion", href: "/account-deletion" });

    const { getByTestId } = renderAuthGate();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getByTestId("outlet")).toBeTruthy();
  });

  it("keeps an unauthenticated health report management route protected", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({
      pathname: "/health-report",
      href: "/health-report",
    });

    renderAuthGate();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/login",
      search: { returnTo: "/health-report" },
    });
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

  it("does not expose routed login content while accepted deletion cleanup is running", () => {
    mockUseAuth.mockReturnValue({
      accountErasureCleanupInProgress: true,
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/login", href: "/login" });

    const view = renderAuthGate();

    expect(view.getByText("Finishing account deletion cleanup…")).toBeTruthy();
    expect(view.queryByTestId("outlet")).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
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

  it("loads user settings only after authentication", () => {
    mockUseAuth.mockReturnValue({
      user: authenticatedUser,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/dashboard" });

    const view = renderAuthGate();

    expect(view.getByTestId("unit-provider").dataset.settingsEnabled).toBe("true");
    expect(view.getByTestId("dashboard-layout-provider").dataset.settingsEnabled).toBe("true");
  });

  it("keeps protected settings disabled on signed-out public pages", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/login" });

    const view = renderAuthGate();

    expect(view.getByTestId("unit-provider").dataset.settingsEnabled).toBe("false");
    expect(view.getByTestId("dashboard-layout-provider").dataset.settingsEnabled).toBe("false");
  });

  it("remounts user settings contexts when the auth identity changes", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "user-1", name: "Alice", email: null },
      isLoading: false,
      logout: vi.fn(),
    });
    mockUseLocation.mockReturnValue({ pathname: "/" });

    const { getByTestId, queryClient, rerender } = renderAuthGate();
    const userOneUnitProvider = getByTestId("unit-provider");
    const userOneLayoutProvider = getByTestId("dashboard-layout-provider");
    const Component = captured.component;
    if (!Component) throw new Error("Component not captured from createRootRoute");

    mockUseAuth.mockReturnValue({
      user: null,
      isLoading: false,
      bootstrapError: null,
      logout: vi.fn(),
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <Component />
      </QueryClientProvider>,
    );

    const publicUnitProvider = getByTestId("unit-provider");
    const publicLayoutProvider = getByTestId("dashboard-layout-provider");
    expect(publicUnitProvider).not.toBe(userOneUnitProvider);
    expect(publicLayoutProvider).not.toBe(userOneLayoutProvider);
    expect(publicUnitProvider.dataset.settingsEnabled).toBe("false");

    mockUseAuth.mockReturnValue({
      user: { id: "user-2", name: "Bob", email: null },
      isLoading: false,
      logout: vi.fn(),
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <Component />
      </QueryClientProvider>,
    );

    expect(getByTestId("unit-provider")).not.toBe(publicUnitProvider);
    expect(getByTestId("dashboard-layout-provider")).not.toBe(publicLayoutProvider);
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
