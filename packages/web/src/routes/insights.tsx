import { createFileRoute } from "@tanstack/react-router";
import { InsightsPage } from "../pages/InsightsPage.tsx";

export const Route = createFileRoute("/insights")({
  component: InsightsPage,
});
