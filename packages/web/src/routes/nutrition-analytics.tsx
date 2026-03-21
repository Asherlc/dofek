import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/nutrition-analytics")({
  beforeLoad: () => {
    throw redirect({ to: "/nutrition/analytics" });
  },
});
