import { createFileRoute } from "@tanstack/react-router";
import { PredictionsPage } from "../pages/PredictionsPage.tsx";

export const Route = createFileRoute("/predictions")({
  component: PredictionsPage,
});
