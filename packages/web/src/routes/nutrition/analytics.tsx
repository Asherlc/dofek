import { createFileRoute } from "@tanstack/react-router";
import { NutritionAnalyticsPage } from "../../pages/NutritionAnalyticsPage.tsx";

export const Route = createFileRoute("/nutrition/analytics")({
  component: NutritionAnalyticsPage,
});
