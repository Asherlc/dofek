import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../pages/Dashboard.tsx";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
});
