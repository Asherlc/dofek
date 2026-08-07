import { createLazyFileRoute } from "@tanstack/react-router";
import { AdminPage } from "../../pages/AdminPage.tsx";

export const Route = createLazyFileRoute("/admin/")({
  component: AdminPage,
});
