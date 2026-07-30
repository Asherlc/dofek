import { createFileRoute } from "@tanstack/react-router";
import { MorePage } from "../pages/MorePage.tsx";

export const Route = createFileRoute("/more")({
  component: MorePage,
});
