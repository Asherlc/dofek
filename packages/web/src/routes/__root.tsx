import { createRootRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "../lib/auth-context.tsx";

const PUBLIC_PATHS = new Set(["/login", "/privacy"]);

function AuthGate() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isPublic = PUBLIC_PATHS.has(location.pathname);

  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      navigate({ to: "/login" });
    }
  }, [isLoading, user, isPublic, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-zinc-600 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user && !isPublic) {
    return null;
  }

  return <Outlet />;
}

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { onboarding?: boolean } => ({
    onboarding: search.onboarding === "true" || undefined,
  }),
  component: () => (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ),
});
