import { createFileRoute } from "@tanstack/react-router";
import { AlertsPage } from "../pages/AlertsPage.tsx";

export const Route = createFileRoute("/alerts")({
  component: AlertsPage,
});
