import { createFileRoute } from "@tanstack/react-router";
import { DeveloperIntegrationsPage } from "../../pages/DeveloperIntegrationsPage.tsx";

export const Route = createFileRoute("/developer-integrations/")({
  component: DeveloperIntegrationsPage,
});
