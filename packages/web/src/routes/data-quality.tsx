import { createFileRoute } from "@tanstack/react-router";
import { DataQualityPage } from "../pages/DataQualityPage.tsx";

export const Route = createFileRoute("/data-quality")({
  component: DataQualityPage,
});
