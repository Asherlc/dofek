import {
  createRootRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "../lib/auth-context.tsx";

const PUBLIC_PATHS = new Set(["/login", "/privacy"]);

const LEGACY_REDIRECTS: Record<string, string> = {
  "/nutrition-analytics": "/nutrition/analytics",
};

function AuthGate() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isPublic = PUBLIC_PATHS.has(location.pathname);

  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      navigate({ to: "/login", search: (prev) => prev });
    }
  }, [isLoading, user, isPublic, navigate]);

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

  return <Outlet />;
}

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    const dest = LEGACY_REDIRECTS[location.pathname];
    if (dest) throw redirect({ to: dest });
  },
  validateSearch: (search: Record<string, unknown>): { onboarding?: boolean } => ({
    onboarding: search.onboarding === "true" || undefined,
  }),
  component: () => (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ),
});
