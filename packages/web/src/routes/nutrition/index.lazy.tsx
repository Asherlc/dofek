import { createLazyFileRoute } from "@tanstack/react-router";
import { NutritionPage } from "../../pages/NutritionPage.tsx";

export const Route = createLazyFileRoute("/nutrition/")({
  component: NutritionPage,
});
