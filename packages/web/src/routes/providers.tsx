import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/providers")({
  component: ProvidersLayout,
});

function ProvidersLayout() {
  return <Outlet />;
}
