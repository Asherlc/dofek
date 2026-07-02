import { useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryErrorBoundary } from "../components/QueryErrorBoundary.tsx";
import { AuthProvider, useAuth } from "../lib/auth-context.tsx";
import { removeWebQueryCache, WebQueryPersistenceProvider } from "../lib/query-persistence.ts";

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
  const { user, isLoading, bootstrapError, logout, retryBootstrap } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const isPublic = PUBLIC_PATHS.has(location.pathname);
  const previousUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousUserId = previousUserIdRef.current;
    const currentUserId = user?.id ?? null;
    if (previousUserId && previousUserId !== currentUserId) {
      removeWebQueryCache(previousUserId);
      queryClient.clear();
    }
    previousUserIdRef.current = currentUserId;
  }, [queryClient, user?.id]);

  useEffect(() => {
    if (!isLoading && !bootstrapError && !user && !isPublic) {
      const returnTo = typeof location.href === "string" ? location.href : location.pathname;
      navigate({ to: "/login", search: { returnTo } });
    }
    if (!isLoading && user && location.pathname === "/login") {
      navigate({ to: "/dashboard" });
    }
  }, [isLoading, bootstrapError, user, isPublic, location.href, location.pathname, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center px-6">
        <div className="max-w-md border border-red-500/40 bg-red-500/10 rounded-lg p-5">
          <h1 className="text-base font-semibold text-foreground mb-2">
            Could not verify your session
          </h1>
          <p className="text-sm text-red-200">{bootstrapError}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
              onClick={() => void retryBootstrap()}
            >
              Try again
            </button>
            <button
              type="button"
              className="rounded-md border border-red-400/50 px-3 py-2 text-sm font-semibold text-red-100 transition-colors hover:bg-red-500/15"
              onClick={() => void logout()}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user && !isPublic) {
    return null;
  }

  const content = (
    <PageTransition>
      <QueryErrorBoundary>
        <Outlet />
      </QueryErrorBoundary>
    </PageTransition>
  );

  if (!user) return content;

  return (
    <WebQueryPersistenceProvider queryClient={queryClient} userId={user.id}>
      {content}
    </WebQueryPersistenceProvider>
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
  ): { newUser?: boolean; providerGuide?: boolean; returnTo?: string } => ({
    newUser: search.newUser === true || search.newUser === "true" || undefined,
    providerGuide: search.providerGuide === true || search.providerGuide === "true" || undefined,
    returnTo: parseReturnTo(search.returnTo),
  }),
  component: () => (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ),
});
