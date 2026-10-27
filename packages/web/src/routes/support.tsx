import { createFileRoute } from "@tanstack/react-router";
import { SupportPage } from "../pages/SupportPage.tsx";

export const Route = createFileRoute("/support")({
  component: SupportPage,
});
