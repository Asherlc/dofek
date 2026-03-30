import {
  createRootRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../lib/auth-context.tsx";

const PUBLIC_PATHS = new Set(["/", "/login", "/privacy"]);

const LEGACY_REDIRECTS: Record<string, string> = {
  "/nutrition-analytics": "/nutrition/analytics",
};

function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [transitionKey, setTransitionKey] = useState(location.pathname);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTransitionKey(location.pathname);
    // Re-trigger the animation by removing and re-adding the class
    const el = containerRef.current;
    if (el) {
      el.classList.remove("page-enter");
      // Force reflow to restart animation
      void el.offsetHeight;
      el.classList.add("page-enter");
    }
  }, [location.pathname]);

  return (
    <div key={transitionKey} ref={containerRef} className="page-enter">
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
      navigate({ to: "/login", search: (prev) => prev });
    }
    if (!isLoading && user && location.pathname === "/login") {
      navigate({ to: "/dashboard" });
    }
  }, [isLoading, user, isPublic, location.pathname, navigate]);

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
      <Outlet />
    </PageTransition>
  );
}

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    const dest = LEGACY_REDIRECTS[location.pathname];
    if (dest) throw redirect({ to: dest });
  },
  validateSearch: (search: Record<string, unknown>): { onboarding?: boolean } => ({
    onboarding: search.onboarding === true || search.onboarding === "true" || undefined,
  }),
  component: () => (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ),
});
