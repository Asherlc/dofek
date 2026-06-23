import {
  createRootRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { QueryErrorBoundary } from "../components/QueryErrorBoundary.tsx";
import { AuthProvider, useAuth } from "../lib/auth-context.tsx";

const PUBLIC_PATHS = new Set(["/", "/login", "/privacy", "/reset-password"]);

const LEGACY_REDIRECTS: Record<string, string> = {
  "/nutrition-analytics": "/nutrition/analytics",
};

function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  return (
    <div key={location.pathname} className="page-enter">
      {children}
    </div>
  );
}

function AuthGate() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isPublic = PUBLIC_PATHS.has(location.pathname);

  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      const returnTo = typeof location.href === "string" ? location.href : location.pathname;
      navigate({ to: "/login", search: { returnTo } });
    }
    if (!isLoading && user && location.pathname === "/login") {
      navigate({ to: "/dashboard" });
    }
  }, [isLoading, user, isPublic, location.href, location.pathname, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user && !isPublic) {
    return null;
  }

  return (
    <PageTransition>
      <QueryErrorBoundary>
        <Outlet />
      </QueryErrorBoundary>
    </PageTransition>
  );
}

function parseReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
}

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    const dest = LEGACY_REDIRECTS[location.pathname];
    if (dest) throw redirect({ to: dest });
  },
  validateSearch: (
    search: Record<string, unknown>,
  ): { providerGuide?: boolean; returnTo?: string } => ({
    providerGuide: search.providerGuide === true || search.providerGuide === "true" || undefined,
    returnTo: parseReturnTo(search.returnTo),
  }),
  component: () => (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ),
});
