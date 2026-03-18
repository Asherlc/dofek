import { createFileRoute } from "@tanstack/react-router";
import { CorrelationExplorerPage } from "../pages/CorrelationExplorerPage.tsx";

export const Route = createFileRoute("/correlation")({
  component: CorrelationExplorerPage,
});
