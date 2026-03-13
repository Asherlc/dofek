import { createFileRoute } from "@tanstack/react-router";
import { TrackingPage } from "../pages/TrackingPage.tsx";

export const Route = createFileRoute("/tracking")({
  component: TrackingPage,
});
