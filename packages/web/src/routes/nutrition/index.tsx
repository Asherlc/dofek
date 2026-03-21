import { createFileRoute } from "@tanstack/react-router";
import { NutritionPage } from "../../pages/NutritionPage.tsx";

export const Route = createFileRoute("/nutrition/")({
  component: NutritionPage,
});
