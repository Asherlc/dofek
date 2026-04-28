import { createFileRoute } from "@tanstack/react-router";
import { AdminUserDetailPage } from "../../../pages/AdminUserDetailPage.tsx";

export const Route = createFileRoute("/admin/users/$userId")({
  component: AdminUserDetailPage,
});
