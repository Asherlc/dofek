import { createFileRoute } from "@tanstack/react-router";
import { AdminPage } from "../pages/AdminPage.tsx";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});
