import { createFileRoute } from "@tanstack/react-router";
import { DeveloperClientDetailPage } from "../../pages/DeveloperClientDetailPage.tsx";

export const Route = createFileRoute("/developer-integrations/$clientId")({
  component: DeveloperClientDetailPage,
});
