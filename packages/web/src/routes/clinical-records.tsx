import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/clinical-records")({
  component: Outlet,
});
