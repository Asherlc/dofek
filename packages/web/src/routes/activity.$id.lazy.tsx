import { createLazyFileRoute } from "@tanstack/react-router";
import { ActivityDetailPage } from "../pages/ActivityDetailPage.tsx";

export const Route = createLazyFileRoute("/activity/$id")({
  component: ActivityDetailPage,
});
