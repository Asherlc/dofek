import { createRootRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "../lib/auth-context.tsx";

function AuthGate() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !user && location.pathname !== "/login") {
      navigate({ to: "/login" });
    }
  }, [isLoading, user, location.pathname, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-zinc-600 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user && location.pathname !== "/login") {
    return null;
  }

  return <Outlet />;
}

export const Route = createRootRoute({
  component: () => (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  ),
});
