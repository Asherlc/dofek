import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth-context.tsx";
import { LandingPage } from "../pages/LandingPage.tsx";

function IndexPage() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard" search={(previous) => previous} />;
  }

  return <LandingPage />;
}

export const Route = createFileRoute("/")({
  component: IndexPage,
});
