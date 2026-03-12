import { createFileRoute } from "@tanstack/react-router";
import { ProvidersPage } from "../pages/ProvidersPage.tsx";

export const Route = createFileRoute("/providers")({
  component: ProvidersPage,
});
