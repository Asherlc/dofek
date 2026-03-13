import { createFileRoute } from "@tanstack/react-router";
import { ActivityDetailPage } from "../pages/ActivityDetailPage.tsx";

export const Route = createFileRoute("/activity/$id")({
  component: ActivityDetailPage,
});
