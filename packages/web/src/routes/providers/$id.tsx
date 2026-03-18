import { createFileRoute } from "@tanstack/react-router";
import { ProviderDetailPage } from "../../pages/ProviderDetailPage.tsx";

export const Route = createFileRoute("/providers/$id")({
  component: ProviderDetailPage,
});
